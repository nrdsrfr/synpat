"""Local web GUI server for moving patterns between .stprj backups.

Run from synpat/:  python3 -m web.server [--projects DIR]... [--output DIR] [--port N]
Binds to 127.0.0.1 only. Source files are never modified.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import mimetypes
import struct
import sys
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from stprj import (FormatError, Payload, Project, StprjFile,  # noqa: E402
                   parse_slot, read_stprj, slot_label, write_raw_stprj, write_stprj)
from web.plan import PlanError, parse_ops, simulate  # noqa: E402
from stprj.container import MANIFEST_NAME, decode_payload, encode_payload  # noqa: E402
from stprj.layout import PATTERN_COUNT, STEP_COUNT, TRACK_BASE, TRACK_COUNT, TRACK_SIZE  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
MAX_BODY = 1 << 20
MAX_BACKUP_BODY = 12 << 20  # base64 of up to 8 MB payload
MAX_BACKUP_PAYLOAD = 8 << 20
DEFAULT_FIRMWARE = "1.42"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
MAX_PLAN_JSON = 512 << 10  # persisted queue (opaque client JSON)
MAX_SIMS = 4  # validated simulations kept for planned-slot previews
MAX_CACHED = 8  # decoded projects (~4 MB each) kept in memory


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.extra = status, extra


class Store:
    """Project directories, decoded-project cache keyed by (path, mtime), working session."""

    def __init__(self, dirs: list[Path], output: Path):
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.dirs = [d.resolve() for d in dirs]
        if self.output not in self.dirs:  # new backups/edits must show up in the project list
            self.dirs.append(self.output)
        self._lock = threading.RLock()  # guards the working session (held across API mutations)
        self._cache_lock = threading.Lock()  # guards only the cache dicts; never held while taking another lock
        self._cache: dict[tuple[Path, int], tuple[Project | None, str | None]] = {}
        self._load_lock = threading.Lock()
        self.meta: dict[tuple[Path, int], tuple[tuple[str, int] | None, str | None]] = {}
        self.session: dict | None = None  # working copy: result of the last plan run (undo/save/payload)
        self.plan: dict | None = None  # queue as the client last stored it (opaque JSON; survives page reloads)
        self.plan_rev = 0  # bumped on every stored plan; stale writes (other tab) are rejected
        self.sims: dict[str, Project] = {}  # validated simulations by key (dest file + ops), for planned-slot previews
        self.rev_counter = 0  # session revisions

    # ---- file ids: "<dir index>/<file name>" ----
    def resolve(self, file_id: str) -> Path:
        try:
            idx, _, name = file_id.partition("/")
            i = int(idx)
            if not idx.isdigit() or not 0 <= i < len(self.dirs):
                raise IndexError(idx)
            base = self.dirs[i]
        except (ValueError, IndexError):
            raise ApiError(400, f"bad file id {file_id!r}")
        path = (base / name).resolve()
        if path.parent != base or path.suffix.lower() != ".stprj":
            raise ApiError(400, "path outside project directories")
        if not path.is_file():
            raise ApiError(404, f"no such file: {name}")
        return path

    def file_ids(self) -> list[tuple[str, Path]]:
        out = []
        for i, d in enumerate(self.dirs):
            if d.is_dir():
                out += [(f"{i}/{p.name}", p) for p in sorted(d.glob("*.stprj"))]
        return out

    def load(self, path: Path) -> tuple[Project | None, str | None]:
        key = (path, path.stat().st_mtime_ns)
        with self._cache_lock:
            hit = self._cache.get(key)
        if hit:
            return hit
        with self._load_lock:  # one decode at a time keeps memory/CPU bounded
            with self._cache_lock:
                hit = self._cache.get(key)
            if hit:
                return hit
            try:
                proj = Project(read_stprj(path))
                proj.validate()
                result: tuple[Project | None, str | None] = (proj, None)
            except (FormatError, OSError, ValueError, KeyError, IndexError) as e:
                result = (None, str(e))
            with self._cache_lock:
                for k in [k for k in self._cache if k[0] == path]:
                    del self._cache[k]
                self._cache[key] = result
                self.meta[key] = ((result[0].name, result[0].version) if result[0] else None, result[1])
                loaded = [k for k, v in self._cache.items() if v[0] is not None]
                for k in loaded[:-MAX_CACHED]:  # evict oldest decoded projects
                    del self._cache[k]
            return result

    def project(self, file_id: str) -> Project:
        proj, err = self.load(self.resolve(file_id))
        if proj is None:
            raise ApiError(422, f"unsupported project: {err}")
        return proj

    def list_projects(self) -> list[dict]:
        items = self.file_ids()

        def one(item):
            fid, path = item
            key = (path, path.stat().st_mtime_ns)
            if key not in self.meta:
                self.load(path)
            info, err = self.meta[key]
            entry = {"id": fid, "file": path.name, "dir": path.parent.name, "supported": info is not None}
            if info is not None:
                entry.update(name=info[0], version=info[1])
            else:
                entry["error"] = err
            return entry

        with ThreadPoolExecutor(max_workers=4) as ex:
            return list(ex.map(one, items))


def manifest_bytes(payload_name: str, firmware: str) -> bytes:
    """manifest.json exactly as Transfer writes it: 2-space indent, CRLF line ends, no trailing newline."""
    manifest = {"FormatVersion": "1.0", "ProductType": ["33"], "Payload": payload_name,
                "FileType": "Project", "FirmwareVersion": firmware}
    return json.dumps(manifest, indent=2).replace("\n", "\r\n").encode("ascii")


_UNSAFE = re.compile(r'[\x00-\x1f/\\:*?"<>|]')


def clean_name(name: str) -> str:
    return _UNSAFE.sub("_", name).strip().strip(".")


def device_backup(store: "Store", body: dict) -> dict:
    slot = body.get("slot")
    if not isinstance(slot, int) or isinstance(slot, bool) or not 1 <= slot <= 128:
        raise ApiError(400, "slot must be an integer 1..128")
    firmware = body.get("firmware") or DEFAULT_FIRMWARE
    if not isinstance(firmware, str) or not re.fullmatch(r"[0-9A-Za-z._-]{1,16}", firmware):
        raise ApiError(400, "invalid firmware string")
    try:
        raw = base64.b64decode(body.get("payload_b64") or "", validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise ApiError(422, "payload_b64 is not valid base64")
    if not raw or len(raw) > MAX_BACKUP_PAYLOAD:
        raise ApiError(422, f"payload must be 1..{MAX_BACKUP_PAYLOAD} bytes")
    try:
        payload = decode_payload(raw)
    except (FormatError, ValueError, IndexError, struct.error) as e:
        raise ApiError(422, f"invalid project payload: {e}")
    name = clean_name(str(body.get("name") or "")) or clean_name(Project(StprjFile(b"", "", payload)).name) or "UNNAMED"
    name = name[:64]
    stamp = time.strftime("%Y-%m-%d %H%M%S")
    target = (store.output / f"{slot:03d} {name} (device backup {stamp}).stprj").resolve()
    if target.parent != store.output:
        raise ApiError(400, "invalid output name")
    try:
        write_raw_stprj(target, manifest_bytes(name, firmware), name, raw)
    except FileExistsError:
        raise ApiError(409, f"{target.name} already exists; retry in a second")
    try:
        file_id = f"{store.dirs.index(store.output)}/{target.name}"
    except ValueError:
        file_id = None
    return {"saved": str(target), "file": target.name, "id": file_id, "version": payload.version,
            "size": target.stat().st_size}


def plan_request(store: "Store", body: dict):
    """Parse {destFileId, ops}; returns (dest Project, ops)."""
    dest = store.project(str(body.get("destFileId") or ""))
    try:
        return dest, parse_ops(body.get("ops", []))
    except PlanError as e:
        raise ApiError(400, str(e))


def plan_simulate(store: "Store", dest: Project, ops):
    def load(file_id: str) -> Project:
        try:
            return store.project(file_id)
        except ApiError as e:
            raise PlanError(str(e))
    return simulate(dest, ops, load)


def sim_key(store: "Store", file_id: str, ops) -> str:
    """Identifies one simulation: destination file (+ mtime) and the exact op list."""
    dest_path = store.resolve(file_id)
    blob = json.dumps([file_id, dest_path.stat().st_mtime_ns, [list(vars(o).values()) for o in ops]])
    return hashlib.sha256(blob.encode()).hexdigest()[:20]


def make_revision(store: "Store", project: Project):
    """Encode the working copy once; its revision ties a device write to exactly these bytes."""
    encoded = encode_payload(project.file.payload)
    with store._cache_lock:
        store.rev_counter += 1
        n = store.rev_counter
    sha = hashlib.sha256(encoded).hexdigest()
    return encoded, {"n": n, "sha": sha, "id": f"{n}-{sha[:12]}"}


def results_json(results) -> list[dict]:
    return [{"ok": r.ok, "warnings": r.warnings, "error": r.error, "forceable": r.forceable} for r in results]


def slots_json(proj: Project, original: Project | None = None) -> list[dict]:
    out = []
    for i in range(PATTERN_COUNT):
        info = proj.pattern_info(i)
        kit = proj.kit_name(info.kit) if 0 <= info.kit < 128 else ""
        out.append({"index": i, "label": slot_label(i), "name": info.name, "kit": info.kit + 1,
                    "kitName": kit, "tempo": round(info.tempo, 2), "trigs": info.trigs,
                    "locks": info.locks, "empty": info.empty,
                    "changed": original is not None and (
                        proj.pattern_bytes(i) != original.pattern_bytes(i)
                        or proj.kit_bytes(info.kit) != original.kit_bytes(info.kit))})
    return out


def project_json(proj: Project, original: Project | None = None) -> dict:
    return {"name": proj.name, "version": proj.version, "slots": slots_json(proj, original)}


def preview_json(proj: Project, index: int) -> dict:
    pat = proj.pattern_bytes(index)
    tracks = []
    for t in range(TRACK_COUNT):
        base = TRACK_BASE + t * TRACK_SIZE
        tracks.append([pat[base + 2 * s + 1] & 1 for s in range(STEP_COUNT)])
    info = proj.pattern_info(index)
    return {"index": index, "label": info.label, "name": info.name, "trigs": info.trigs, "tracks": tracks}


def parse_index(value) -> int:
    try:
        return parse_slot(str(value))
    except ValueError as e:
        raise ApiError(400, str(e))


class Handler(BaseHTTPRequestHandler):
    store: Store
    server_version = "synpat"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj):
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _guard(self, fn):
        try:
            self._json(200, fn())
        except ApiError as e:
            self._json(e.status, {"error": str(e), **e.extra})
        except Exception as e:  # noqa: BLE001 - report instead of dropping the connection
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _binary(self, fn):
        try:
            body, headers = fn()
        except ApiError as e:
            return self._json(e.status, {"error": str(e), **e.extra})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def payload_file(self, file_id: str):
        """Raw payload entry of a listed .stprj, validated with decode_payload."""
        path = self.store.resolve(file_id)
        try:
            with zipfile.ZipFile(path) as zf:
                manifest = json.loads(zf.read(MANIFEST_NAME))
                raw = zf.read(manifest["Payload"])
            payload = decode_payload(raw)
        except (FormatError, zipfile.BadZipFile, KeyError, ValueError, OSError, struct.error) as e:
            raise ApiError(422, f"invalid project file: {e}")
        return raw, payload, path.name

    def payload_headers(self, payload: Payload, file_name: str) -> dict:
        return {"X-Project-Name": quote(Project(StprjFile(b"", "", payload)).name),
                "X-Project-Version": str(payload.version), "X-Project-File": quote(file_name)}

    def do_GET(self):
        url = urlparse(self.path)
        if not self._host_ok():
            return self._json(403, {"error": "unexpected Host header; use http://localhost:PORT"})
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/payload":
            def one():
                raw, payload, name = self.payload_file(q.get("file", ""))
                return raw, self.payload_headers(payload, name)
            return self._binary(one)
        if url.path == "/api/session/payload":
            def cur():
                sess = self.session()
                project, encoded, rev = sess["snap"]  # one immutable tuple: project, bytes and revision always agree
                want = q.get("rev")
                if want is not None and want != rev["id"]:
                    raise ApiError(409, f"working copy changed (revision {rev['id']}, requested {want}); rebuild before writing")
                headers = self.payload_headers(project.file.payload, "working copy")
                headers["X-Project-Revision"] = rev["id"]
                return encoded, headers
            return self._binary(cur)
        if url.path.startswith("/api/"):
            return self._guard(lambda: self.api_get(url.path, q))
        rel = "index.html" if url.path == "/" else url.path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype + ("; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype else ""))

    def _host_ok(self) -> bool:
        """Only answer requests addressed to a loopback name (blocks DNS rebinding), also behind `-p 127.0.0.1:N:8765`."""
        host = urlparse("//" + (self.headers.get("Host") or "")).hostname
        return host in LOOPBACK_HOSTS

    def do_POST(self):
        url = urlparse(self.path)
        if not self._host_ok():
            return self._json(403, {"error": "unexpected Host header; use http://localhost:PORT"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "invalid Content-Length"})
        if length < 0:
            return self._json(400, {"error": "invalid Content-Length"})
        limit = MAX_BACKUP_BODY if url.path == "/api/device/backup" else MAX_BODY
        if length > limit:
            return self._json(413, {"error": "body too large"})
        if self.headers.get("Origin") and urlparse(self.headers["Origin"]).netloc != self.headers.get("Host"):
            return self._json(403, {"error": "cross-origin request refused"})
        raw = self.rfile.read(length) if length else b""
        if len(raw) != length:
            return self._json(400, {"error": "request body shorter than Content-Length"})
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._json(400, {"error": "invalid JSON"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "JSON body must be an object"})
        self._guard(lambda: self.api_post(url.path, body))

    # ---- routes ----
    def api_get(self, path: str, q: dict):
        s = self.store
        if path == "/api/projects":
            return {"projects": s.list_projects(), "output": str(s.output)}
        if path == "/api/project":
            return project_json(s.project(q.get("file", "")))
        if path == "/api/preview":
            return preview_json(s.project(q.get("file", "")), parse_index(q.get("slot", "")))
        if path == "/api/plan":
            return {"plan": s.plan, "rev": s.plan_rev}
        if path == "/api/plan/preview":
            with s._cache_lock:
                sim = s.sims.get(q.get("key", ""))
            if sim is None:
                raise ApiError(409, "that plan is no longer validated; the queue changed")
            return preview_json(sim, parse_index(q.get("slot", "")))
        if path == "/api/session":
            return self.session_state()
        if path == "/api/session/preview":
            return preview_json(self.session()["current"], parse_index(q.get("slot", "")))
        raise ApiError(404, "unknown endpoint")

    def session(self) -> dict:
        if self.store.session is None:
            raise ApiError(409, "no working session: open a destination project first")
        return self.store.session

    def session_state(self, **extra) -> dict:
        sess = self.store.session
        if sess is None:
            return {"open": False, **extra}
        return {"open": True, "file": sess["file"], "dest": project_json(sess["current"], sess["original"]),
                "undoDepth": len(sess["stack"]), "applied": sess["applied"], "revision": sess["snap"][2], **extra}

    def api_post(self, path: str, b: dict):
        s = self.store
        if path == "/api/device/backup":
            return device_backup(s, b)
        if path == "/api/plan/validate":
            dest, ops = plan_request(s, b)
            key = sim_key(s, b["destFileId"], ops)
            result, results = plan_simulate(s, dest, ops)
            with s._cache_lock:
                s.sims.pop(key, None)
                s.sims[key] = result
                while len(s.sims) > MAX_SIMS:
                    del s.sims[next(iter(s.sims))]
            return {"ok": all(r.ok for r in results), "results": results_json(results), "key": key,
                    "project": project_json(result, dest)}
        if path == "/api/plan/store":
            plan = b.get("plan")
            if plan is not None and (not isinstance(plan, dict) or len(json.dumps(plan)) > MAX_PLAN_JSON):
                raise ApiError(400, "plan must be a JSON object under 512 KB")
            with s._lock:
                if b.get("rev") != s.plan_rev:
                    raise ApiError(409, "the queue was changed elsewhere (another tab?); reload to see it", rev=s.plan_rev)
                s.plan = plan
                s.plan_rev += 1
                return {"stored": plan is not None, "rev": s.plan_rev}
        if path == "/api/plan/run":
            dest, ops = plan_request(s, b)
            if not ops:
                raise ApiError(409, "the queue is empty")
            result, results = plan_simulate(s, dest, ops)
            if not all(r.ok for r in results):
                raise ApiError(409, "the queue has errors; fix or force the failing operations", results=results_json(results))
            encoded, rev = make_revision(s, result)
            with s._lock:
                s.session = {"file": b["destFileId"], "path": s.resolve(b["destFileId"]), "original": dest,
                             "current": result, "stack": [(dest, [])], "snap": (result, encoded, rev),
                             "applied": [f"{len(ops)} operation(s) from queue"]}
                return self.session_state(results=results_json(results),
                                          warnings=[w for r in results for w in r.warnings])
        with s._lock:
            if path == "/api/session/discard":
                s.session = None
                return self.session_state()
            sess = self.session()
            if path == "/api/session/undo":
                if not sess["stack"]:
                    raise ApiError(409, "nothing to undo")
                sess["current"], sess["applied"] = sess["stack"].pop()
                sess["snap"] = (sess["current"], *make_revision(s, sess["current"]))
                return self.session_state()
            if path == "/api/session/save":
                if not sess["stack"]:
                    raise ApiError(409, "no changes to save")
                name = Path(str(b.get("name") or "")).name
                if not name:
                    name = f"{sess['path'].stem} edited {time.strftime('%Y%m%d-%H%M%S')}.stprj"
                if not name.lower().endswith(".stprj"):
                    name += ".stprj"
                target = (s.output / name).resolve()
                if target.parent != s.output:
                    raise ApiError(400, "invalid output name")
                try:
                    write_stprj(target, sess["current"].file)
                except FileExistsError:
                    raise ApiError(409, f"{name} already exists; choose another name")
                return self.session_state(saved=str(target))
        raise ApiError(404, "unknown endpoint")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--projects", action="append", type=Path, help="directory of .stprj files (repeatable)")
    ap.add_argument("--output", type=Path, default=ROOT.parent / "OUTPUT")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default 127.0.0.1; use 0.0.0.0 inside a container and publish with -p 127.0.0.1:...)")
    args = ap.parse_args(argv)
    dirs = args.projects or [ROOT.parent / "PROJECTS", ROOT.parent / "OLD BACKUP"]
    Handler.store = Store(dirs, args.output)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"serving http://{args.host}:{args.port}/  projects={[str(d) for d in Handler.store.dirs]} "
          f"output={Handler.store.output}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
