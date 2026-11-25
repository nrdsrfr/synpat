"""Derive the blank-project templates (stprj/template_data.py) from real backups.

Development tool: nothing at runtime imports this. Regenerate the data with

    python3 -m stprj.template_derive --write stprj/template_data.py       # backups from $SYNPAT_DATA

tests/test_template.py re-derives the templates from the backups and compares them with the embedded data.

Policy (the evidence is in the module docstring of template.py):

* 0x0A  The device-made, never-touched project "NEW PROJECT" is the ground truth: its image is the template, name cleared.
* 0x0C  Built from NEW PROJECT converted to the 0x0C structure generation and then corrected against the real 0x0C/0x0D
        projects: each byte takes NEW PROJECT's value when that value is common among the real v11 projects (>= 20 %),
        otherwise the most common real value. Pattern kit references follow the real projects (kit = own slot).
* 0x0D  The 0x0C template, then every tail byte on which all real 0x0D projects agree with each other and not with
        0x0C takes the 0x0D value (0x0D introduced new settings bytes).
"""

from __future__ import annotations

import argparse
import base64
import collections
import hashlib
import os
import struct
import sys
import zlib
from typing import Iterable, Mapping, Sequence

from .container import FormatError
from .convert import convert_kit
from .layout import (
    GEN_A, GEN_B, KIT_BASE, KIT_COUNT, KIT_SIZE, PAT_KIT, PATTERN_BASE, PATTERN_COUNT, PATTERN_SIZE, SOUND_SIZE,
    SOUNDS_PER_KIT,
)

HEADER_SIZE = 512
ID_OFFSET, ID_END = 24, 28            # 4 bytes after the name; differs per project, constant across backups of a state
POOL_COUNT = 128
TAIL_BASE = KIT_BASE + KIT_COUNT * KIT_SIZE
POOL_SOUND = {GEN_A: SOUND_SIZE[GEN_A[2]], GEN_B: SOUND_SIZE[GEN_B[2]]}
COMMON_SHARE = 0.20                   # NEW PROJECT's value is kept when at least this share of real projects has it
VERSIONS = (0x0A, 0x0C, 0x0D)


def _pool_end(gen) -> int:
    return 4 + POOL_COUNT * SOUND_SIZE[gen[2]]


def _u32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">I", buf, off)[0]


def check_pristine(image: bytes) -> None:
    """The never-touched 0x0A project must be uniform: that is what makes it usable as ground truth."""
    if _u32(image, 4) != 0x0A:
        raise FormatError("pristine project must be version 0x0A")
    pats = {image[PATTERN_BASE + i * PATTERN_SIZE:PATTERN_BASE + (i + 1) * PATTERN_SIZE][:PAT_KIT]
            + image[PATTERN_BASE + i * PATTERN_SIZE:PATTERN_BASE + (i + 1) * PATTERN_SIZE][PAT_KIT + 1:]
            for i in range(PATTERN_COUNT)}
    kits = {image[KIT_BASE + i * KIT_SIZE:KIT_BASE + (i + 1) * KIT_SIZE] for i in range(KIT_COUNT)}
    size = SOUND_SIZE[GEN_A[2]]
    pool = {image[TAIL_BASE + 4 + i * size:TAIL_BASE + 4 + (i + 1) * size] for i in range(POOL_COUNT)}
    if len(pats) != 1 or len(kits) != 1 or len(pool) != 1:
        raise FormatError("pristine project is not uniform: it has edited patterns, kits or pool sounds")


def _mode(counter: collections.Counter, prefer: int | None = None) -> int:
    best = max(counter.values())
    tied = sorted(v for v, c in counter.items() if c == best)
    return prefer if prefer in tied else tied[0]


def _base_v11(pristine: bytes, corpus: Sequence[bytes]) -> bytearray:
    """0x0C image: NEW PROJECT converted, corrected against the real v11 projects."""
    n = len(pristine)
    out = bytearray(n)
    out[0:4] = pristine[0:4]
    struct.pack_into(">I", out, 4, 0x0C)
    out[ID_OFFSET:ID_END] = pristine[ID_OFFSET:ID_END]
    # patterns: NEW PROJECT's default with the v11 structure version; kit reference = own slot (all real v11 projects)
    pat = bytearray(pristine[PATTERN_BASE:PATTERN_BASE + PATTERN_SIZE])
    struct.pack_into(">I", pat, 0, GEN_B[0])
    for i in range(PATTERN_COUNT):
        pat[PAT_KIT] = i
        out[PATTERN_BASE + i * PATTERN_SIZE:PATTERN_BASE + (i + 1) * PATTERN_SIZE] = pat
    kit, _ = convert_kit(pristine[KIT_BASE:KIT_BASE + KIT_SIZE], GEN_A, GEN_B)
    for i in range(KIT_COUNT):
        out[KIT_BASE + i * KIT_SIZE:KIT_BASE + (i + 1) * KIT_SIZE] = kit
    # tail
    head = collections.Counter(img[TAIL_BASE:TAIL_BASE + 4] for img in corpus).most_common(1)[0][0]
    out[TAIL_BASE:TAIL_BASE + 4] = head
    size = SOUND_SIZE[GEN_B[2]]
    sounds = collections.Counter(img[TAIL_BASE + 4 + i * size:TAIL_BASE + 4 + (i + 1) * size]
                                 for img in corpus for i in range(POOL_COUNT))
    sound = sounds.most_common(1)[0][0]
    for i in range(POOL_COUNT):
        out[TAIL_BASE + 4 + i * size:TAIL_BASE + 4 + (i + 1) * size] = sound
    end11, end9 = _pool_end(GEN_B), _pool_end(GEN_A)
    rest11 = n - TAIL_BASE - end11
    if any(pristine[TAIL_BASE + end9 + rest11:]):
        raise FormatError("pristine project has data past the v11 settings area")
    for j in range(rest11):
        want = pristine[TAIL_BASE + end9 + j]
        seen = collections.Counter(img[TAIL_BASE + end11 + j] for img in corpus)
        keep = seen.get(want, 0) / len(corpus) >= COMMON_SHARE
        out[TAIL_BASE + end11 + j] = want if keep else _mode(seen, prefer=want)
    return out


def derive(corpus: Mapping[int, Iterable[bytes]], pristine: bytes) -> dict[int, bytes]:
    """Template image (name cleared) for each of VERSIONS. `corpus[version]` = distinct real project images."""
    check_pristine(pristine)
    v11 = list(corpus.get(0x0C, ())) + list(corpus.get(0x0D, ()))
    v13 = list(corpus.get(0x0D, ()))
    if not v11 or not v13:
        raise FormatError("need real 0x0C and 0x0D projects to derive the 0x0C/0x0D templates")
    a = bytearray(pristine)
    a[8:24] = bytes(16)
    c = _base_v11(pristine, v11)
    d = bytearray(c)
    struct.pack_into(">I", d, 4, 0x0D)
    for o in range(TAIL_BASE, len(d)):
        first = v13[0][o]
        if first != c[o] and all(img[o] == first for img in v13):
            d[o] = first
    return {0x0A: bytes(a), 0x0C: bytes(c), 0x0D: bytes(d)}


# ---- data module ---------------------------------------------------------------------------------------------------

def render_module(images: Mapping[int, bytes]) -> str:
    lines = [
        '"""GENERATED by `python3 -m stprj.template_derive --write stprj/template_data.py`; do not edit.',
        '',
        'zlib-compressed, base64-encoded blank-project images (project name cleared) per project version.',
        'Derivation and evidence: see stprj/template.py and stprj/template_derive.py.',
        '"""',
        '',
        'IMAGES = {',
    ]
    for version in sorted(images):
        blob = base64.b64encode(zlib.compress(images[version], 9)).decode("ascii")
        lines.append(f'    0x{version:02X}: (')
        for i in range(0, len(blob), 100):
            lines.append(f'        "{blob[i:i + 100]}"')
        lines.append('    ),')
    lines.append('}')
    return "\n".join(lines) + "\n"


def load_corpus(directories: Iterable[str]) -> tuple[dict[int, list[bytes]], dict[str, bytes]]:
    """Distinct, validating project images by version, plus the images by file name (for tests and reports)."""
    from .container import read_stprj
    from .project import Project
    corpus: dict[int, list[bytes]] = collections.defaultdict(list)
    named: dict[str, bytes] = {}
    seen: set[str] = set()
    for directory in directories:
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".stprj"):
                continue
            try:
                project = Project(read_stprj(os.path.join(directory, name)))
                project.validate()
            except (FormatError, ValueError, OSError):
                continue
            digest = hashlib.md5(project.data).hexdigest()
            named[name] = project.data
            if digest not in seen:
                seen.add(digest)
                corpus[project.version].append(project.data)
    return dict(corpus), named


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", default=os.environ.get("SYNPAT_DATA"), help="folder with PROJECTS and OLD BACKUP")
    parser.add_argument("--pristine", default="026 NEW PROJECT.stprj", help="file name of the never-touched 0x0A project")
    parser.add_argument("--write", metavar="PATH", help="write the data module here (default: print a summary)")
    args = parser.parse_args(argv)
    if not args.data:
        parser.error("set SYNPAT_DATA or pass --data")
    corpus, named = load_corpus([os.path.join(args.data, "PROJECTS"), os.path.join(args.data, "OLD BACKUP")])
    if args.pristine not in named:
        parser.error(f"{args.pristine} not found in the backups")
    images = derive(corpus, named[args.pristine])
    for version, image in sorted(images.items()):
        print(f"0x{version:02X}: {len(image)} bytes, {len(zlib.compress(image, 9))} compressed; corpus {len(corpus.get(version, []))}")
    if args.write:
        with open(args.write, "w", encoding="ascii") as fh:
            fh.write(render_module(images))
        print("wrote", args.write)
    return 0


if __name__ == "__main__":
    sys.exit(main())
