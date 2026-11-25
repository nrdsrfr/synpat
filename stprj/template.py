"""Blank Syntakt projects: the destination for patterns that go into an empty device slot.

    blank_project(donor, name)    a new project of the donor's version with factory-default content
    template_donor(projects)      the project whose version the blank should have (newest supported)

The result depends only on the donor's VERSION (plus its payload header and manifest, which carry the firmware build):
the project image comes from a template embedded in the library (template_data.py), so nothing the donor contains
(name, patterns, kits, sounds, songs, settings) can leak into the blank project.

Where the defaults come from (all backups of one Syntakt; evidence gathered by tests/test_template.py and
stprj/template_derive.py, which regenerates the embedded data):

Ground truth for 0x0A is the device-made, never-touched project "026 NEW PROJECT". Its image is the 0x0A template.
It differs from the seven used 0x0A projects only where a project has been used: every pattern's kit reference is 0
(used projects: kit = own slot), the 4 byte ID after the name is 0 (used: a random-looking value), the sound pool
header is 0 (used: 6), pool sounds have byte 174 = 1 (used: 0) and 67 bytes in a 240 byte block of the settings area
are zero (used: a filled, sound-like block). Untouched patterns, all kits and the rest of the 512 byte header are
identical across all eight 0x0A projects; 79 bytes of the settings area vary between the used ones (user state).

0x0C and 0x0D have no never-touched example, so they are derived (template_derive.py):
  * pattern: NEW PROJECT's pattern with the v11 structure version. Verified against the real projects: the most
    common untouched pattern of every project that was created on the v11 firmware is exactly this, kit byte aside.
    Projects the device upgraded from 0x0A have 000000 instead of 3f3f3f in each track's last three settings bytes
    (convert.py zeroes them on upgrade); that is an upgrade artifact and not the default.
  * pattern kit reference = the pattern's own slot, as in every real 0x0C/0x0D project (NEW PROJECT's 0 is the
    never-touched state; the kits are all identical, so this does not change the sound).
  * kit: convert_kit() of NEW PROJECT's kit; identical to the most common kit of every real 0x0C/0x0D project.
  * pool: all 128 sounds identical, header 7, as in all real v11 projects.
  * settings and songs: per byte, NEW PROJECT's value where that value is common (>= 20 %) among the real v11
    projects, else their most common value (63 of 319,616 bytes differ from NEW PROJECT's); 0x0D additionally takes
    every byte on which the real 0x0D projects agree with each other and differ from 0x0C (232 bytes: new per-song
    and project settings).

Unknown, and chosen as above rather than understood:
  * the 4 byte ID after the name (image offsets 24..27): 0 in NEW PROJECT, so 0 in all templates. Real projects have
    a different value each. Whether the device assigns one later (or cares) is not known.
  * a block of about 75 project-level setting bytes near the start of the settings area (tempo 120 BPM is part of it)
    and several hundred per-song bytes hold user state in real projects; they are defaulted by the rule above.
  * kit settings byte 3336 is 1 in every real 0x0C/0x0D project except the only fresh 0x0D one (0). The templates use 1.
"""

from __future__ import annotations

import base64
import functools
import json
import zlib
from typing import Iterable

from .container import OFF_SLOT, FormatError, Payload, StprjFile
from .project import Project
from .template_data import IMAGES

DEFAULT_NAME = "NEW PROJECT"
NAME_OFFSET = 8
MAX_NAME_LEN = 15                      # the 16 byte name field always keeps a terminating zero
TEMPLATE_VERSIONS = frozenset(IMAGES)


@functools.lru_cache(maxsize=len(IMAGES))
def _image(version: int) -> bytes:
    return zlib.decompress(base64.b64decode("".join(IMAGES[version])))


def check_name(name: str) -> None:
    if not name or len(name) > MAX_NAME_LEN or not all(0x20 <= ord(c) <= 0x7E for c in name):
        raise ValueError(f"project name must be 1..{MAX_NAME_LEN} printable ASCII characters, got {name!r}")


def _manifest_for(donor_manifest: bytes, name: str) -> bytes:
    """The donor's manifest with only the payload name replaced, keeping its layout byte for byte otherwise."""
    manifest = json.loads(donor_manifest)
    old = manifest.get("Payload")
    if not isinstance(old, str):
        raise FormatError("donor manifest has no Payload name")
    old_text, new_text = json.dumps(old, ensure_ascii=False), json.dumps(name, ensure_ascii=False)
    raw = donor_manifest.decode("utf-8")
    if raw.count(f'"Payload": {old_text}') != 1:
        raise FormatError("cannot rewrite the donor manifest's Payload name")
    return raw.replace(f'"Payload": {old_text}', f'"Payload": {new_text}').encode("utf-8")


def blank_project(donor: Project, name: str = DEFAULT_NAME) -> Project:
    """A blank project with the donor's version: all 128 patterns and kits at factory defaults, empty sound pool and
    songs, default settings, `name` as the project name and slot field 0. Only the donor's version (and the
    firmware identification in its payload header and manifest) is used; see the module docstring."""
    version = donor.version
    if version not in IMAGES:
        raise FormatError(f"no blank project template for project version 0x{version:02X}")
    check_name(name)
    data = bytearray(_image(version))
    data[NAME_OFFSET:NAME_OFFSET + len(name)] = name.encode("ascii")
    header = bytearray(donor.file.payload.header)
    header[OFF_SLOT:OFF_SLOT + 4] = bytes(4)
    payload = Payload(header=bytes(header), data=bytes(data))
    file = StprjFile(manifest_raw=_manifest_for(donor.file.manifest_raw, name), payload_name=name, payload=payload)
    return Project(file=file)


def template_donor(projects: Iterable[Project]) -> Project | None:
    """The first project of the newest supported version (0x0D, else 0x0C, else 0x0A); None when there is none.
    Projects that fail validate() are skipped."""
    best: Project | None = None
    for project in projects:
        if project.version not in TEMPLATE_VERSIONS or (best is not None and project.version <= best.version):
            continue
        try:
            project.validate()
        except FormatError:
            continue
        best = project
    return best
