"""HTTP-level tests for the virtual "template" destination (a blank project built on the server).

Uses the real stprj.template (skips if it is unavailable) and the real backups (tests/datadir.py; skips without them).
"""

import http.client
import itertools
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

try:
    import stprj.template  # noqa: F401
except ImportError:
    raise unittest.SkipTest("stprj.template is not available")

from datadir import PROJECTS
from stprj import Project, read_stprj
from stprj.template import check_name
from web import server as srv
from web.blank import DEFAULT_NAME, validate_name

SRC = "0/033 SET - HOUSE.stprj"
OPS = [{"sourceFileId": SRC, "srcSlot": 1, "dstSlot": 18, "kitSlot": 18, "force": False},
       {"sourceFileId": "0/024 FUNKY GOSPEL.stprj", "srcSlot": 0, "dstSlot": 19, "kitSlot": 19, "force": False}]


class NameTest(unittest.TestCase):
    def test_server_rule_is_a_subset_of_the_library_rule(self):
        alphabet = "AZ09 =#-az!~é\0"
        names = [""] + ["".join(c) for n in (1, 2) for c in itertools.product(alphabet, repeat=n)] + ["X" * 15, "X" * 16, " X", "X "]
        for name in names:
            try:
                validate_name(name)
            except ValueError:
                continue
            check_name(name)  # a name the server accepts must never be rejected by the library (would raise)

    def test_library_errors_are_passed_through(self):
        for bad in ("", "X" * 16, "é"):
            with self.assertRaisesRegex(ValueError, r"project name must be 1\.\.15 printable ASCII"):
                validate_name(bad)
        with self.assertRaisesRegex(ValueError, "use only A-Z 0-9"):
            validate_name("lower")

    def test_valid_names(self):
        self.assertEqual(validate_name(None), DEFAULT_NAME)
        for ok in ("NEW PROJECT", "A", "A-B=#1 2", "X" * 15, "0123456789ABCDE"):
            self.assertEqual(validate_name(ok), ok)

    def test_invalid_names(self):
        for bad in ("", "new project", "X" * 16, " LEAD", "TRAIL ", "A/B", "A\\B", "É", "A\0B", "A\nB", 5, ["A"], True):
            with self.assertRaises(ValueError, msg=repr(bad)):
                validate_name(bad)


class TemplateHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(os.path.join(PROJECTS, "027 PPRFC TOUR.stprj")):
            raise unittest.SkipTest("missing backups")
        cls.tmp = tempfile.mkdtemp()
        srv.Handler.log_message = lambda *args: None
        srv.Handler.store = srv.Store([Path(PROJECTS)], Path(cls.tmp))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        entries = srv.Handler.store.list_projects()
        best = max(e["version"] for e in entries if e["supported"])
        donor = next(e for e in entries if e["supported"] and e["version"] == best)
        cls.donor = {"version": best, "name": donor["name"], "file": donor["file"]}

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        s = srv.Handler.store
        s.session, s.plan, s.plan_rev = None, None, 0

    def request(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        c.request(method, path, body, {"Content-Type": "application/json"} if body else {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, data

    def post(self, path, obj):
        status, data = self.request("POST", path, json.dumps(obj).encode())
        return status, json.loads(data), data.decode()

    def get(self, path):
        status, data = self.request("GET", path)
        return status, json.loads(data), data.decode()

    def assertNoDonor(self, text):
        self.assertNotIn(self.donor["name"], text)
        self.assertNotIn(self.donor["file"], text)

    def test_server_uses_the_real_library(self):
        self.assertEqual(srv.blank_project.__module__, "stprj.template")
        self.assertTrue(Path(sys.modules["stprj.template"].__file__).name == "template.py")

    def test_blank_matches_donor_version_and_name(self):
        status, body, _ = self.get("/api/project?file=template&name=A-B%3D%231%20Z")
        self.assertEqual((status, body["name"]), (200, "A-B=#1 Z"))
        self.assertEqual(body["version"], self.donor["version"])  # the newest supported local version (0x0D when present)

    def test_project_and_preview_endpoints(self):
        status, body, text = self.get("/api/project?file=template&name=MY%20SET")
        self.assertEqual(status, 200)
        self.assertEqual(body["name"], "MY SET")
        self.assertEqual(body["template"], {"name": "MY SET", "version": self.donor["version"], "donorVersion": self.donor["version"]})
        self.assertTrue(all(s["empty"] and s["trigs"] == 0 for s in body["slots"]) and len(body["slots"]) == 128)
        self.assertTrue(all(s["name"] == "" and s["kitName"] == "" for s in body["slots"]))  # no leftover names
        self.assertNoDonor(text)
        self.assertEqual(self.get("/api/project?file=template")[1]["name"], DEFAULT_NAME)
        status, prev, _ = self.get("/api/preview?file=template&slot=3")
        self.assertEqual((status, prev["trigs"]), (200, 0))

    def test_name_validation_returns_400(self):
        for bad in ("new%20project", "X" * 16, "%20LEAD", "A%2FB"):
            status, body, _ = self.get(f"/api/project?file=template&name={bad}")
            self.assertEqual(status, 400, bad)
            self.assertIn("project name", body["error"])
        for bad in ("new project", "X" * 16, 7, "", " X"):
            status, body, _ = self.post("/api/plan/validate", {"destFileId": "template", "templateName": bad, "ops": []})
            self.assertEqual(status, 400, repr(bad))
            self.assertEqual(self.post("/api/plan/run", {"destFileId": "template", "templateName": bad, "ops": OPS})[0], 400)

    def test_validate_with_ops(self):
        status, body, text = self.post("/api/plan/validate", {"destFileId": "template", "templateName": "NEW PROJECT", "ops": OPS})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"] and all(r["ok"] for r in body["results"]))
        self.assertEqual(body["template"]["name"], "NEW PROJECT")
        slots = body["project"]["slots"]
        self.assertEqual([s["index"] for s in slots if not s["empty"]], [18, 19])
        self.assertEqual([s["index"] for s in slots if s["changed"]], [18, 19])
        self.assertEqual(body["project"]["name"], "NEW PROJECT")
        self.assertNoDonor(text)
        status, prev, _ = self.get(f"/api/plan/preview?key={body['key']}&slot=18")
        self.assertEqual(status, 200)
        self.assertGreater(prev["trigs"], 0)
        # same ops, other name: another key (another template)
        other = self.post("/api/plan/validate", {"destFileId": "template", "templateName": "OTHER", "ops": OPS})[1]
        self.assertNotEqual(other["key"], body["key"])

    def test_template_is_never_a_source(self):
        _, body, _ = self.post("/api/plan/validate", {"destFileId": "template", "ops": [{"sourceFileId": "template", "srcSlot": 0, "dstSlot": 1}]})
        self.assertFalse(body["results"][0]["ok"])
        self.assertIn("cannot be a source", body["results"][0]["error"])

    def test_run_and_save(self):
        status, run, text = self.post("/api/plan/run", {"destFileId": "template", "templateName": "RUN TEST", "ops": OPS})
        self.assertEqual(status, 200)
        self.assertEqual((run["file"], run["template"]["name"], run["dest"]["name"]), ("template", "RUN TEST", "RUN TEST"))
        self.assertNoDonor(text)
        status, data = self.request("GET", f"/api/session/payload?rev={run['revision']['id']}")
        self.assertEqual(status, 200)
        status, saved, _ = self.post("/api/session/save", {})
        self.assertEqual(status, 200)
        path = Path(saved["saved"])
        self.assertTrue(path.name.startswith("RUN TEST new "), path.name)
        self.assertNoDonor(path.name)
        with zipfile.ZipFile(path) as zf:  # the donor's manifest / entry name must not be carried over
            names = zf.namelist()
            manifest = zf.read("manifest.json").decode()
        self.assertEqual(names, ["manifest.json", "RUN TEST"])
        self.assertIn('"Payload": "RUN TEST"', manifest)
        self.assertNoDonor(manifest)
        project = Project(read_stprj(str(path)))
        project.validate()
        self.assertEqual((project.name, project.version), ("RUN TEST", self.donor["version"]))
        self.assertEqual([i for i in range(128) if not project.pattern_info(i).empty], [18, 19])
        src = Project(read_stprj(os.path.join(PROJECTS, "033 SET - HOUSE.stprj")))
        self.assertEqual(project.pattern_info(18).trigs, src.pattern_info(1).trigs)
        self.assertEqual(self.post("/api/plan/run", {"destFileId": "template", "ops": []})[0], 409)  # empty queue

    def test_no_donor_available(self):
        empty = Path(tempfile.mkdtemp())
        try:
            store = srv.Store([empty], Path(self.tmp) / "none")
            with self.assertRaises(srv.ApiError) as cm:
                store.template("X")
            self.assertEqual(cm.exception.status, 409)
        finally:
            shutil.rmtree(empty, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
