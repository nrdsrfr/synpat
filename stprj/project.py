"""Decompressed Syntakt project image: pattern and kit access, cross-version copy.

Byte layout and generation tables: layout.py. Format conversion: convert.py.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, replace

from .container import FormatError, Payload, StprjFile
from .convert import convert_kit, convert_pattern
from .layout import (
    KIT_BASE, KIT_COUNT, KIT_NAME, KIT_SIZE, KIT_SOUNDS, LOCK_BASE, LOCK_SLOT_SIZE, LOCK_SLOTS,
    GEN_B, MAGIC, NAME_LEN, PAT_KIT, PAT_NAME, PAT_TEMPO, PATTERN_BASE, PATTERN_COUNT, PATTERN_SIZE,
    PROJECT_GENERATIONS, STEP_COUNT, TRACK_BASE, TRACK_COUNT, TRACK_SIZE,
)

BANKS = "ABCDEFGH"


class CopyError(ValueError):
    pass


def slot_label(index: int) -> str:
    return f"{BANKS[index // 16]}{index % 16 + 1:02d}"


def parse_slot(text: str) -> int:
    """'A01'..'H16' (case-insensitive) or a 0-based integer."""
    text = text.strip().upper()
    if text.isdigit():
        index = int(text)
    elif len(text) in (2, 3) and text[0] in BANKS and text[1:].isdigit() and 1 <= int(text[1:]) <= 16:
        index = BANKS.index(text[0]) * 16 + int(text[1:]) - 1
    else:
        raise ValueError(f"bad slot {text!r}: use A01..H16 or 0..127")
    if not 0 <= index < PATTERN_COUNT:
        raise ValueError(f"slot {index} out of range 0..127")
    return index


def _cstr(raw: bytes) -> str:
    return raw.split(b"\0", 1)[0].decode("ascii", "replace")


def _u32(buf: bytes, offset: int) -> int:
    return struct.unpack_from(">I", buf, offset)[0]


@dataclass(frozen=True)
class PatternInfo:
    index: int
    name: str
    kit: int
    tempo: float
    trigs: int
    locks: int

    @property
    def label(self) -> str:
        return slot_label(self.index)

    @property
    def empty(self) -> bool:
        return self.trigs == 0 and self.locks == 0 and not self.name


@dataclass(frozen=True)
class Project:
    file: StprjFile

    @property
    def data(self) -> bytes:
        return self.file.payload.data

    @property
    def version(self) -> int:
        return self.file.payload.version

    @property
    def name(self) -> str:
        return _cstr(self.data[8:8 + NAME_LEN])

    def _pattern_range(self, index: int) -> tuple[int, int]:
        if not 0 <= index < PATTERN_COUNT:
            raise IndexError(f"pattern {index} out of range")
        start = PATTERN_BASE + index * PATTERN_SIZE
        return start, start + PATTERN_SIZE

    def _kit_range(self, index: int) -> tuple[int, int]:
        if not 0 <= index < KIT_COUNT:
            raise IndexError(f"kit {index} out of range")
        start = KIT_BASE + index * KIT_SIZE
        return start, start + KIT_SIZE

    def pattern_bytes(self, index: int) -> bytes:
        start, end = self._pattern_range(index)
        return self.data[start:end]

    def kit_bytes(self, index: int) -> bytes:
        start, end = self._kit_range(index)
        return self.data[start:end]

    def structure_versions(self) -> tuple[int, int, int]:
        """(pattern, kit, sound) versions; every slot must agree."""
        pattern_versions = {_u32(self.pattern_bytes(i), 0) for i in range(PATTERN_COUNT)}
        kit_versions = {_u32(self.kit_bytes(i), 0) for i in range(KIT_COUNT)}
        first_sound = self.kit_bytes(0)[KIT_SOUNDS:KIT_SOUNDS + 8]
        if first_sound[:4] != MAGIC:
            raise FormatError("kit 0 does not start with a sound")
        if len(pattern_versions) != 1 or len(kit_versions) != 1:
            raise FormatError(f"mixed versions: patterns {pattern_versions}, kits {kit_versions}")
        return pattern_versions.pop(), kit_versions.pop(), _u32(first_sound, 4)

    def validate(self) -> None:
        if self.data[:4] != MAGIC or _u32(self.data, 4) != self.version:
            raise FormatError("project image header does not match payload header")
        expected = PROJECT_GENERATIONS.get(self.version)
        if expected is None:
            if self.version == 0x08:
                raise FormatError("project version 0x08 (pattern v7 / kit v7 / sound v5) is not supported: "
                                  "it uses a different pattern layout (980-byte tracks)")
            raise FormatError(f"unknown project version 0x{self.version:02X}")
        actual = self.structure_versions()
        if actual != expected:
            raise FormatError(f"project 0x{self.version:02X} has structure versions {actual}, expected {expected}")

    def pattern_info(self, index: int) -> PatternInfo:
        pat = self.pattern_bytes(index)
        trigs = 0
        for track in range(TRACK_COUNT):
            base = TRACK_BASE + track * TRACK_SIZE
            trigs += sum(pat[base + 2 * step + 1] & 1 for step in range(STEP_COUNT))
        locks = sum(pat[LOCK_BASE + slot * LOCK_SLOT_SIZE] != 0xFF for slot in range(LOCK_SLOTS))
        tempo = struct.unpack_from(">H", pat, PAT_TEMPO)[0] / 120
        return PatternInfo(index=index, name=_cstr(pat[PAT_NAME:PAT_NAME + NAME_LEN]),
                           kit=pat[PAT_KIT], tempo=tempo, trigs=trigs, locks=locks)

    def kit_name(self, index: int) -> str:
        kit = self.kit_bytes(index)
        return _cstr(kit[KIT_NAME:KIT_NAME + NAME_LEN])

    def with_slots(self, pattern_index: int, pattern: bytes, kit_index: int, kit: bytes) -> Project:
        if len(pattern) != PATTERN_SIZE or len(kit) != KIT_SIZE:
            raise ValueError("pattern or kit has wrong size")
        data = bytearray(self.data)
        p0, p1 = self._pattern_range(pattern_index)
        k0, k1 = self._kit_range(kit_index)
        data[p0:p1] = pattern
        data[k0:k1] = kit
        payload = Payload(header=self.file.payload.header, data=bytes(data))
        return Project(file=replace(self.file, payload=payload))


def copy_pattern_with_kit(src: Project, src_index: int, dst: Project, dst_index: int,
                          kit_index: int | None = None, force: bool = False) -> tuple[Project, list[str]]:
    """Copy pattern `src_index` and the kit it references into `dst`.

    The pattern goes to `dst_index`; its kit goes to `kit_index` (default: the
    same slot number as the pattern) and the pattern's kit field is rewritten.
    Returns the new destination project and warnings. Refuses, unless `force`,
    to overwrite a non-empty pattern or a kit used by another non-empty pattern.
    """
    src.validate()
    dst.validate()
    src_gen = PROJECT_GENERATIONS[src.version]
    dst_gen = PROJECT_GENERATIONS[dst.version]

    kit_index = dst_index if kit_index is None else kit_index
    src_info = src.pattern_info(src_index)
    warnings: list[str] = []
    problems: list[str] = []

    dst_info = dst.pattern_info(dst_index)
    if not dst_info.empty:
        problems.append(f"destination pattern {dst_info.label} is not empty "
                        f"({dst_info.trigs} trigs, {dst_info.locks} lock slots, name {dst_info.name!r})")

    users = [dst.pattern_info(i) for i in range(PATTERN_COUNT)
             if i != dst_index and dst.pattern_bytes(i)[PAT_KIT] == kit_index]
    used_by = [p.label for p in users if not p.empty]
    if used_by:
        problems.append(f"destination kit {kit_index + 1} is used by pattern(s) {', '.join(used_by)}")
    empty_users = [p.label for p in users if p.empty]
    if empty_users:
        warnings.append(f"destination kit {kit_index + 1} is also referenced by {len(empty_users)} empty pattern(s)")
    warnings.append(f"destination kit {kit_index + 1} ({dst.kit_name(kit_index) or 'unnamed'}) is replaced "
                    f"by source kit {src_info.kit + 1} ({src.kit_name(src_info.kit) or 'unnamed'})")

    if problems and not force:
        raise CopyError("; ".join(problems) + " (use force to overwrite)")
    warnings.extend(f"overwriting: {p}" for p in problems)

    pattern = src.pattern_bytes(src_index)
    kit = src.kit_bytes(src_info.kit)
    if src_gen != dst_gen:
        pattern, pattern_notes = convert_pattern(pattern, src_gen, dst_gen)
        kit, kit_notes = convert_kit(kit, src_gen, dst_gen)
        losses = pattern_notes + kit_notes
        # Only downgrade notes are gating losses; upgrade notes are informational.
        gating = losses if src_gen == GEN_B else []
        if gating and not force:
            raise CopyError(f"conversion from v{src_gen[0]} to v{dst_gen[0]} is lossy or uncertain: "
                            + "; ".join(gating) + " (use force to allow)")
        warnings.append(f"converted pattern/kit from v{src_gen[0]} to v{dst_gen[0]} "
                        f"(project 0x{src.version:02X} -> 0x{dst.version:02X})")
        warnings.extend(f"conversion: {n}" for n in losses)
    pattern = bytearray(pattern)
    pattern[PAT_KIT] = kit_index
    return dst.with_slots(dst_index, bytes(pattern), kit_index, kit), warnings
