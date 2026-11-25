"""Blank-project template tests (stprj/template.py).

The first group runs everywhere (the templates are embedded). The second group needs the real backups
($SYNPAT_DATA, see tests/datadir.py) and is skipped without them: it proves the invariants against real donors and
re-derives the embedded templates from the backups.
"""

import collections
import hashlib
import os
import random
import struct
import unittest

from datadir import OLD_BACKUP, PROJECTS
from stprj import FormatError, Project, blank_project, read_stprj, template_donor
from stprj.container import OFF_SLOT, OFF_VERSION, Payload, StprjFile, decode_payload, encode_payload
from stprj.convert import convert_kit, convert_pattern
from stprj.layout import (
    GEN_A, GEN_B, KIT_BASE, KIT_COUNT, KIT_SIZE, PAT_KIT, PATTERN_BASE, PATTERN_COUNT, PATTERN_SIZE, SOUND_SIZE,
    TRACK_BASE, TRACK_COUNT, TRACK_SIZE,
)
from stprj.template import DEFAULT_NAME, MAX_NAME_LEN, TEMPLATE_VERSIONS, _image
from stprj.template_derive import POOL_COUNT, TAIL_BASE, derive, load_corpus

IMAGE_SIZE = 4089348
HEADER = bytes.fromhex("ac11d303020008000d30303937000000010000000a00000019003e6604010c")
MANIFEST = (b'{\n  "FormatVersion": "1.0",\n  "ProductType": [\n    "33"\n  ],\n  "Payload": "DONOR NAME",\n'
            b'  "FileType": "Project",\n  "FirmwareVersion": "1.42"\n}')


def synthetic_donor(version: int, seed: int, slot: int = 7, name: str = "DONOR NAME") -> Project:
    """A donor full of garbage: random image, so any leak of donor bytes into a blank project shows up."""
    rng = random.Random(seed)
    data = bytearray(rng.randbytes(IMAGE_SIZE))
    data[0:4] = bytes.fromhex("beefbace")
    struct.pack_into(">I", data, 4, version)
    data[8:24] = name.encode().ljust(16, b"\0")
    header = bytearray(HEADER)
    struct.pack_into(">I", header, OFF_VERSION, version)
    struct.pack_into(">I", header, OFF_SLOT, slot)
    manifest = MANIFEST.replace(b"DONOR NAME", name.encode())
    return Project(StprjFile(manifest_raw=manifest, payload_name=name, payload=Payload(bytes(header), bytes(data))))


def patterns(image: bytes):
    return [image[PATTERN_BASE + i * PATTERN_SIZE:PATTERN_BASE + (i + 1) * PATTERN_SIZE] for i in range(PATTERN_COUNT)]


def kits(image: bytes):
    return [image[KIT_BASE + i * KIT_SIZE:KIT_BASE + (i + 1) * KIT_SIZE] for i in range(KIT_COUNT)]


def pool(image: bytes, version: int):
    size = SOUND_SIZE[GEN_A[2] if version == 0x0A else GEN_B[2]]
    return [image[TAIL_BASE + 4 + i * size:TAIL_BASE + 4 + (i + 1) * size] for i in range(POOL_COUNT)]


class EmbeddedTemplateTest(unittest.TestCase):
    def test_versions(self):
        self.assertEqual(TEMPLATE_VERSIONS, {0x0A, 0x0C, 0x0D})

    def test_blank_validates_and_round_trips(self):
        for version in sorted(TEMPLATE_VERSIONS):
            with self.subTest(version=hex(version)):
                blank = blank_project(synthetic_donor(version, 1), "TEST BLANK")
                blank.validate()
                self.assertEqual(blank.version, version)
                self.assertEqual(blank.name, "TEST BLANK")
                self.assertEqual(len(blank.data), IMAGE_SIZE)
                raw = encode_payload(blank.file.payload)
                again = decode_payload(raw)
                self.assertEqual(again.data, blank.data)
                self.assertEqual(again.header, blank.file.payload.header)

    def test_blank_does_not_depend_on_donor_content(self):
        for version in sorted(TEMPLATE_VERSIONS):
            with self.subTest(version=hex(version)):
                a = blank_project(synthetic_donor(version, 1, slot=3, name="AAAA"), "SAME")
                b = blank_project(synthetic_donor(version, 2, slot=99, name="BBBB BBBB BBBB"), "SAME")
                self.assertEqual(a.data, b.data)
                self.assertEqual(a.data, blank_project(a, "SAME").data)  # a blank as donor gives the same blank

    def test_default_content_is_uniform_and_empty(self):
        for version in sorted(TEMPLATE_VERSIONS):
            with self.subTest(version=hex(version)):
                blank = blank_project(synthetic_donor(version, 3))
                image = blank.data
                for i in range(PATTERN_COUNT):
                    info = blank.pattern_info(i)
                    self.assertTrue(info.empty and info.trigs == 0 and info.locks == 0 and info.name == "")
                # patterns identical except the kit reference: own slot for v11 projects, 0 for the never-touched 0x0A
                for i, pat in enumerate(patterns(image)):
                    expected = 0 if version == 0x0A else i
                    self.assertEqual(pat[PAT_KIT], expected)
                    self.assertEqual(pat[:PAT_KIT] + pat[PAT_KIT + 1:], patterns(image)[0][:PAT_KIT] + patterns(image)[0][PAT_KIT + 1:])
                self.assertEqual(len(set(kits(image))), 1)
                self.assertEqual(len(set(pool(image, version))), 1)
                self.assertTrue(all(blank.kit_name(i) == "" for i in range(KIT_COUNT)))
                # header: magic, version, name, ID, then zeros
                self.assertEqual(image[28:512], bytes(484))
                self.assertEqual(image[24:28], _image(0x0A)[24:28])  # one fixed ID for all templates

    def test_v11_templates_agree_with_the_documented_conversion(self):
        a, c = _image(0x0A), _image(0x0C)
        kit, _ = convert_kit(kits(a)[0], GEN_A, GEN_B)
        self.assertEqual(kits(c)[0], kit)
        self.assertEqual(struct.unpack_from(">I", patterns(c)[0], 0)[0], GEN_B[0])
        self.assertEqual(struct.unpack_from(">I", kits(c)[0], 0)[0], GEN_B[1])

    def test_0d_differs_from_0c_only_in_version_and_tail_settings(self):
        c, d = _image(0x0C), _image(0x0D)
        diff = [o for o in range(IMAGE_SIZE) if c[o] != d[o]]
        self.assertEqual(diff[0], 7)                       # header version byte
        self.assertTrue(all(o == 7 or o >= TAIL_BASE for o in diff))
        self.assertGreater(len(diff), 100)                 # 0x0D has its own default settings bytes

    def test_name_rules(self):
        donor = synthetic_donor(0x0D, 4)
        for bad in ("", "X" * (MAX_NAME_LEN + 1), "caf\u00e9", "tab\tname"):
            with self.subTest(name=bad), self.assertRaises(ValueError):
                blank_project(donor, bad)
        longest = blank_project(donor, "X" * MAX_NAME_LEN)
        self.assertEqual(longest.name, "X" * MAX_NAME_LEN)
        self.assertEqual(blank_project(donor).name, DEFAULT_NAME)

    def test_header_manifest_and_payload_name(self):
        donor = synthetic_donor(0x0C, 5, slot=41, name="OLD NAME")
        blank = blank_project(donor, "FRESH 1")
        header = blank.file.payload.header
        self.assertEqual(header[OFF_SLOT:OFF_SLOT + 4], bytes(4))                       # slot field 0
        self.assertEqual(header[:OFF_SLOT] + header[OFF_SLOT + 4:],
                         donor.file.payload.header[:OFF_SLOT] + donor.file.payload.header[OFF_SLOT + 4:])
        self.assertEqual(blank.file.payload_name, "FRESH 1")
        self.assertEqual(blank.file.manifest_raw, donor.file.manifest_raw.replace(b"OLD NAME", b"FRESH 1"))
        self.assertEqual(blank.file.manifest["Payload"], "FRESH 1")
        self.assertEqual(blank.file.manifest["FirmwareVersion"], "1.42")

    def test_unsupported_version_is_refused(self):
        with self.assertRaises(FormatError):
            blank_project(synthetic_donor(0x08, 6))
        with self.assertRaises(FormatError):
            blank_project(synthetic_donor(0x0E, 6))

    def test_template_donor_prefers_newest_supported_version(self):
        a, c, d = (synthetic_donor(v, v) for v in (0x0A, 0x0C, 0x0D))  # garbage images: validate() fails
        valid = {v: blank_project(synthetic_donor(v, 0)) for v in (0x0A, 0x0C, 0x0D)}  # real validating projects
        self.assertIsNone(template_donor([]))
        self.assertIsNone(template_donor(iter([synthetic_donor(0x08, 1)])))
        self.assertEqual(template_donor([valid[0x0A], valid[0x0C], valid[0x0D]]).version, 0x0D)
        self.assertEqual(template_donor(iter([valid[0x0A], valid[0x0C]])).version, 0x0C)  # generators work
        self.assertEqual(template_donor([valid[0x0A]]).version, 0x0A)
        first, second = valid[0x0D], blank_project(valid[0x0D], "SECOND")
        self.assertIs(template_donor([valid[0x0C], first, second]), first)                 # first of the newest
        # a donor that fails validate() is skipped
        self.assertIsNone(template_donor([a, c, d]))                                         # garbage: none validates
        self.assertIs(template_donor([d, valid[0x0C]]), valid[0x0C])


needs_data = unittest.skipUnless(os.path.isdir(PROJECTS) and os.path.isdir(OLD_BACKUP),
                                 "real backups not found (set SYNPAT_DATA)")


@needs_data
class RealBackupsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus, cls.named = load_corpus([PROJECTS, OLD_BACKUP])
        cls.new_name = "026 NEW PROJECT.stprj"
        if cls.new_name not in cls.named:
            raise unittest.SkipTest("026 NEW PROJECT.stprj missing")
        cls.projects = {}
        for directory in (PROJECTS, OLD_BACKUP):
            for name in sorted(os.listdir(directory)):
                if name.endswith(".stprj"):
                    try:
                        project = Project(read_stprj(os.path.join(directory, name)))
                        project.validate()
                    except (FormatError, ValueError):
                        continue
                    cls.projects.setdefault(name, project)

    def test_blank_of_new_project_is_new_project(self):
        new = self.projects[self.new_name]
        blank = blank_project(new, "NEW PROJECT")
        self.assertEqual(blank.data, new.data)
        self.assertEqual(blank.file.manifest_raw, new.file.manifest_raw)
        self.assertEqual(blank.file.payload_name, new.file.payload_name)
        self.assertEqual(blank.file.payload.header[:OFF_SLOT], new.file.payload.header[:OFF_SLOT])
        self.assertEqual(blank.file.payload.header[OFF_SLOT + 4:], new.file.payload.header[OFF_SLOT + 4:])
        self.assertEqual(blank.file.payload.header[OFF_SLOT:OFF_SLOT + 4], bytes(4))
        blank.validate()

    def test_blank_images_are_identical_for_every_pair_of_real_donors_of_a_version(self):
        by_version = collections.defaultdict(list)
        for project in self.projects.values():
            by_version[project.version].append(project)
        self.assertEqual(set(by_version), {0x0A, 0x0C, 0x0D})
        for version, donors in by_version.items():
            images = {hashlib.md5(blank_project(d, "X").data).hexdigest() for d in donors}
            self.assertEqual(len(images), 1, f"0x{version:02X}: {len(donors)} donors gave {len(images)} different blank images")
            self.assertGreaterEqual(len(donors), 2)

    def test_template_donor_picks_0d_from_the_real_projects(self):
        self.assertEqual(template_donor(self.projects.values()).version, 0x0D)
        self.assertEqual(template_donor(p for p in self.projects.values() if p.version != 0x0D).version, 0x0C)

    def test_embedded_templates_are_what_the_backups_derive(self):
        derived = derive(self.corpus, self.named[self.new_name])
        for version in TEMPLATE_VERSIONS:
            self.assertEqual(derived[version], _image(version), f"0x{version:02X}")

    def test_new_project_is_never_touched(self):
        image = self.named[self.new_name]
        self.assertEqual({p[PAT_KIT] for i, p in enumerate(patterns(image)) if i}, {0})  # every pattern uses kit 0
        self.assertEqual(image[TAIL_BASE:TAIL_BASE + 4], bytes(4))                         # pool header 0 (used: 6)

    def test_header_is_constant_apart_from_name_and_id(self):
        for version, images in self.corpus.items():
            self.assertEqual({img[28:512] for img in images}, {bytes(484)}, hex(version))
            self.assertEqual({img[0:8] for img in images}, {bytes.fromhex("beefbace") + struct.pack(">I", version)})

    def test_default_pattern_per_generation(self):
        """The most common untouched pattern of every real project is the template pattern (kit byte aside); projects
        the device upgraded from 0x0A carry the documented upgrade artifact (000000 track tails) instead."""
        def untouched(pat):
            trigs = sum(pat[TRACK_BASE + t * TRACK_SIZE + 2 * s + 1] & 1 for t in range(TRACK_COUNT) for s in range(64))
            locks = sum(pat[12783 + s * 130] != 0xFF for s in range(80))
            return trigs == 0 and locks == 0 and pat[23183:23199] == bytes(16)

        def norm(pat):
            return pat[:PAT_KIT] + b"\0" + pat[PAT_KIT + 1:]
        for version, images in self.corpus.items():
            template_pat = norm(patterns(_image(version))[0])
            upgraded_pat, _ = convert_pattern(norm(patterns(_image(0x0A))[0]), GEN_A, GEN_B)
            allowed = {template_pat} if version == 0x0A else {template_pat, norm(upgraded_pat)}
            kinds = collections.Counter()
            for img in images:
                modal = collections.Counter(norm(p) for p in patterns(img) if untouched(p)).most_common(1)[0][0]
                self.assertIn(modal, allowed, f"0x{version:02X}")
                kinds["default" if modal == template_pat else "upgraded"] += 1
            if version != 0x0A:
                self.assertGreater(kinds["default"], 0)
                self.assertGreater(kinds["upgraded"], 0)   # both populations exist; the template is the fresh one

    def test_untouched_patterns_reference_their_own_slot_except_in_the_never_touched_project(self):
        for name, image in self.named.items():
            if image == self.named[self.new_name]:   # the never-touched project (and its duplicate backup)
                continue
            pats = patterns(image)
            own = sum(1 for i, p in enumerate(pats) if p[PAT_KIT] == i)
            self.assertGreater(own, 100, name)

    def test_default_kit_and_pool_sound(self):
        for version, images in self.corpus.items():
            expected = kits(_image(version))[0]
            for img in images:
                modal = collections.Counter(kits(img)).most_common(1)[0][0]
                differs = [o for o in range(KIT_SIZE) if modal[o] != expected[o]]
                # the only fresh 0x0D project has kit settings byte 3336 = 0 (see template.py); nothing else may differ
                self.assertTrue(differs == [] or (version == 0x0D and differs == [3336]), f"0x{version:02X} {differs}")
        a, c = _image(0x0A), _image(0x0C)
        self.assertEqual(kits(c)[0], convert_kit(kits(a)[0], GEN_A, GEN_B)[0])
        # pool: header 7 and one sound; NEW PROJECT's pool sound upgraded as a kit sound differs only at byte 174
        # (1 in the never-touched project, 0 in every used 0x0A and every 0x0C/0x0D project)
        old, new = pool(a, 0x0A)[0], pool(c, 0x0C)[0]
        upgraded = old[:240] + bytes(12) + old[240:]
        upgraded = upgraded[:4] + struct.pack(">I", GEN_B[2]) + upgraded[8:]
        self.assertEqual([o for o in range(len(new)) if new[o] != upgraded[o]], [174])
        self.assertEqual(c[TAIL_BASE:TAIL_BASE + 4], struct.pack(">I", GEN_B[2]))

    def test_templates_are_close_to_real_fresh_projects(self):
        """A sanity bound, not a proof of defaults: the settings/songs area of the template differs from the newest
        real projects that were created fresh in only a few bytes (project-level settings the user changed)."""
        limits = {"014 JRC HOUSE.stprj": 20, "030 CONTEMPORARY IO.stprj": 30, "031 80S 90S SYNTH.stprj": 40}
        for name, limit in limits.items():
            image = self.named[name]
            template = _image(struct.unpack_from(">I", image, 4)[0])
            diff = sum(1 for o in range(TAIL_BASE, IMAGE_SIZE) if image[o] != template[o])
            self.assertLessEqual(diff, limit, f"{name}: {diff} differing tail bytes")


if __name__ == "__main__":
    unittest.main()
