"""Run from the repo root: python3 -m unittest discover tests

Uses the real backups (see tests/datadir.py: $SYNPAT_DATA, else the repo parent); tests are skipped when they are absent.
"""

import io
import os
import tempfile
import unittest
import zipfile

from datadir import OLD_BACKUP, PROJECTS
from stprj import CopyError, Project, copy_pattern_with_kit, read_stprj, write_raw_stprj, write_stprj
from stprj.container import FormatError, decode_payload
from stprj.lz4block import compress_block, decompress_into
from stprj.convert import convert_kit, convert_pattern
from stprj.layout import GEN_A, GEN_B, KIT_BASE, KIT_SIZE, PAT_KIT, PATTERN_BASE, PATTERN_SIZE



def load(directory: str, name: str) -> Project:
    path = os.path.join(directory, name + ".stprj")
    if not os.path.exists(path):
        raise unittest.SkipTest(f"missing {path}")
    return Project(read_stprj(path))


def project(name: str) -> Project:
    path = os.path.join(PROJECTS, name + ".stprj")
    if not os.path.exists(path):
        raise unittest.SkipTest(f"missing {path}")
    return Project(read_stprj(path))


class RawWriteTest(unittest.TestCase):
    def test_raw_write_keeps_payload_and_manifest_bytes(self):
        src = os.path.join(PROJECTS, "028 BORN SLIPPY.stprj")
        if not os.path.exists(src):
            self.skipTest(f"missing {src}")
        with zipfile.ZipFile(src) as zf:
            manifest = zf.read("manifest.json")
            raw = zf.read("BORN SLIPPY")
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "raw.stprj")
            payload = write_raw_stprj(out, manifest, "BORN SLIPPY", raw)
            with zipfile.ZipFile(out) as zf:
                self.assertEqual(zf.namelist(), ["manifest.json", "BORN SLIPPY"])
                self.assertEqual(zf.read("BORN SLIPPY"), raw)
                self.assertEqual(zf.read("manifest.json"), manifest)
            self.assertEqual(payload.data, read_stprj(out).payload.data)
            with self.assertRaises(FileExistsError):
                write_raw_stprj(out, manifest, "BORN SLIPPY", raw)
            bad = bytearray(raw)
            bad[100] ^= 1
            with self.assertRaises(FormatError):
                write_raw_stprj(os.path.join(tmp, "bad.stprj"), manifest, "BORN SLIPPY", bytes(bad))
            self.assertFalse(os.path.exists(os.path.join(tmp, "bad.stprj")))


class LZ4Test(unittest.TestCase):
    def test_round_trip_edge_inputs(self):
        cases = [b"", b"a", b"abc" * 3, bytes(40000), bytes(range(256)) * 200, b"xy" * 7 + b"tail12345"]
        for data in cases:
            out = bytearray()
            decompress_into(out, compress_block(data), 0, len(compress_block(data)))
            self.assertEqual(bytes(out), data)


class CopyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = project("028 BORN SLIPPY")   # v0x0C, A03 uses kit 3
        cls.dst = project("027 PPRFC TOUR")    # v0x0C
        cls.old = project("026 NEW PROJECT")   # v0x0A

    def test_copy_changes_only_target_pattern_and_kit(self):
        result, _ = copy_pattern_with_kit(self.src, 2, self.dst, 127)
        before, after = self.dst.data, result.data
        pattern = (PATTERN_BASE + 127 * PATTERN_SIZE, PATTERN_BASE + 128 * PATTERN_SIZE)
        kit = (KIT_BASE + 127 * KIT_SIZE, KIT_BASE + 128 * KIT_SIZE)
        self.assertEqual(before[:pattern[0]], after[:pattern[0]])
        self.assertEqual(before[pattern[1]:kit[0]], after[pattern[1]:kit[0]])
        self.assertEqual(before[kit[1]:], after[kit[1]:])

        copied = bytearray(self.src.pattern_bytes(2))
        copied[PAT_KIT] = 127
        self.assertEqual(result.pattern_bytes(127), bytes(copied))
        self.assertEqual(result.kit_bytes(127), self.src.kit_bytes(2))

    def test_written_file_reads_back(self):
        result, _ = copy_pattern_with_kit(self.src, 2, self.dst, 127)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "out.stprj")
            write_stprj(path, result.file)
            again = Project(read_stprj(path))
            with zipfile.ZipFile(path) as zf:
                self.assertEqual(zf.namelist(), ["manifest.json", self.dst.file.payload_name])
                self.assertEqual(zf.read("manifest.json"), self.dst.file.manifest_raw)
            with self.assertRaises(FileExistsError):
                write_stprj(path, result.file)
        self.assertEqual(again.data, result.data)
        self.assertEqual(again.file.payload.header, self.dst.file.payload.header)
        self.assertEqual(again.pattern_info(127).trigs, self.src.pattern_info(2).trigs)

    def test_refuses_non_empty_destination_pattern(self):
        with self.assertRaises(CopyError):
            copy_pattern_with_kit(self.src, 2, self.src, 0)
        copy_pattern_with_kit(self.src, 2, self.src, 0, force=True)

    def test_refuses_kit_shared_with_other_pattern(self):
        # BORN SLIPPY A01 uses kit 1; putting a copy into H16 with kit slot 1 would change A01's sound.
        with self.assertRaises(CopyError):
            copy_pattern_with_kit(self.src, 2, self.src, 127, kit_index=0)

    def test_corrupt_crc_is_rejected(self):
        path = os.path.join(PROJECTS, "027 PPRFC TOUR.stprj")
        raw = bytearray(zipfile.ZipFile(path).read("PPRFC TOUR"))
        raw[100] ^= 0xFF
        with self.assertRaisesRegex(ValueError, "CRC"):
            decode_payload(bytes(raw))


def changed_ranges_ok(before: bytes, after: bytes, pattern_index: int, kit_index: int) -> bool:
    p0 = PATTERN_BASE + pattern_index * PATTERN_SIZE
    k0 = KIT_BASE + kit_index * KIT_SIZE
    spans = [(p0, p0 + PATTERN_SIZE), (k0, k0 + KIT_SIZE)]
    return all(any(lo <= i < hi for lo, hi in spans)
               for i in range(len(before)) if before[i] != after[i])


class ConvertTest(unittest.TestCase):
    def test_upgrade_matches_device_output(self):
        jun = load(OLD_BACKUP, "020 DECISIVE FOODIE")
        nov = load(OLD_BACKUP, "020 DECISIVE FOODIE(2)")
        self.assertEqual((jun.version, nov.version), (0x0A, 0x0C))
        for i in range(128):
            if i != 1:
                self.assertEqual(convert_pattern(jun.pattern_bytes(i), GEN_A, GEN_B)[0],
                                 nov.pattern_bytes(i), f"pattern {i}")
            if i not in (0, 1):
                self.assertEqual(convert_kit(jun.kit_bytes(i), GEN_A, GEN_B)[0],
                                 nov.kit_bytes(i), f"kit {i}")

    def test_round_trip_is_lossless(self):
        for name in ("024 FUNKY GOSPEL", "016 JUNGLE-ISH"):
            proj = load(PROJECTS, name)
            self.assertEqual(proj.version, 0x0A)
            for i in range(128):
                pat, kit = proj.pattern_bytes(i), proj.kit_bytes(i)
                up_p, notes_p = convert_pattern(pat, GEN_A, GEN_B)
                up_k, notes_k = convert_kit(kit, GEN_A, GEN_B)
                down_p, down_notes_p = convert_pattern(up_p, GEN_B, GEN_A)
                down_k, down_notes_k = convert_kit(up_k, GEN_B, GEN_A)
                self.assertEqual((down_p, down_k), (pat, kit), f"{name} slot {i}")
                self.assertEqual(down_notes_p + down_notes_k, [])

    def test_same_generation_is_identity(self):
        proj = load(PROJECTS, "027 PPRFC TOUR")
        pat, kit = proj.pattern_bytes(1), proj.kit_bytes(1)
        self.assertEqual(convert_pattern(pat, GEN_B, GEN_B), (pat, []))
        self.assertEqual(convert_kit(kit, GEN_B, GEN_B), (kit, []))

    def test_wrong_version_rejected(self):
        proj = load(PROJECTS, "027 PPRFC TOUR")
        with self.assertRaises(ValueError):
            convert_pattern(proj.pattern_bytes(1), GEN_A, GEN_B)
        with self.assertRaises(ValueError):
            convert_kit(proj.kit_bytes(1), GEN_A, GEN_B)


class CrossVersionCopyTest(unittest.TestCase):
    def test_upgrade_copy(self):
        src = load(PROJECTS, "024 FUNKY GOSPEL")   # 0x0A
        dst = load(PROJECTS, "027 PPRFC TOUR")     # 0x0C
        result, warnings = copy_pattern_with_kit(src, 0, dst, 17)
        result.validate()
        self.assertTrue(any("converted" in w for w in warnings))
        self.assertTrue(changed_ranges_ok(dst.data, result.data, 17, 17))
        self.assertEqual(result.pattern_bytes(17)[PAT_KIT], 17)
        expected, _ = convert_kit(src.kit_bytes(src.pattern_info(0).kit), GEN_A, GEN_B)
        self.assertEqual(result.kit_bytes(17), expected)
        self.assertEqual(result.pattern_info(17).trigs, src.pattern_info(0).trigs)

    def test_upgrade_notes_are_warnings_not_refusals(self):
        src = load(PROJECTS, "021 TUT AMBIENT WAV")  # 0x0A, A01 has non-default track settings tails
        dst = load(PROJECTS, "027 PPRFC TOUR")
        result, warnings = copy_pattern_with_kit(src, 0, dst, 17)  # no force
        result.validate()
        resets = [w for w in warnings if "reset to 000000" in w]
        self.assertTrue(any("track 11 settings bytes 42433d" in w for w in resets))
        self.assertTrue(all(w.startswith("conversion:") for w in resets))

    def test_lossy_downgrade_needs_force(self):
        src = load(PROJECTS, "033 SET - HOUSE")    # 0x0C, A02 kit has non-default settings byte
        dst = load(PROJECTS, "026 NEW PROJECT")    # 0x0A
        with self.assertRaisesRegex(CopyError, "lossy"):
            copy_pattern_with_kit(src, 1, dst, 16)
        result, warnings = copy_pattern_with_kit(src, 1, dst, 16, force=True)
        result.validate()
        self.assertTrue(any("conversion:" in w for w in warnings))
        self.assertTrue(changed_ranges_ok(dst.data, result.data, 16, 16))

    def test_lossless_downgrade_copy(self):
        src = load(PROJECTS, "033 SET - HOUSE")
        dst = load(PROJECTS, "026 NEW PROJECT")
        result, _ = copy_pattern_with_kit(src, 2, dst, 17)  # A03, lossless kit
        result.validate()
        self.assertEqual(result.pattern_info(17).trigs, src.pattern_info(2).trigs)

    def test_0c_to_0d_is_byte_copy(self):
        src = load(PROJECTS, "033 SET - HOUSE")    # 0x0C
        dst = load(PROJECTS, "014 JRC HOUSE")      # 0x0D
        self.assertEqual((src.version, dst.version), (0x0C, 0x0D))
        result, warnings = copy_pattern_with_kit(src, 2, dst, 127)
        self.assertFalse(any("converted" in w for w in warnings))
        pattern = bytearray(src.pattern_bytes(2))
        pattern[PAT_KIT] = 127
        self.assertEqual(result.pattern_bytes(127), bytes(pattern))
        self.assertEqual(result.kit_bytes(127), src.kit_bytes(src.pattern_info(2).kit))
        self.assertTrue(changed_ranges_ok(dst.data, result.data, 127, 127))


if __name__ == "__main__":
    unittest.main()
