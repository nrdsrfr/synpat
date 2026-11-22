"""Pure pattern/kit conversion between structure generations (see layout.py).

GEN_A -> GEN_B is verified against device output (DECISIVE FOODIE Jun vs Nov).
GEN_B -> GEN_A is the inferred inverse and is NOT device-verified.
Each function returns (new bytes, notes); notes list losses/uncertainties.
"""

from __future__ import annotations

import struct

from .container import FormatError
from .layout import (
    END_MAGIC, GEN_A, GEN_B, KIT_SIZE, KIT_SOUNDS, MAGIC, PATTERN_SIZE, SOUND_SIZE,
    SOUNDS_PER_KIT, TRACK_BASE, TRACK_COUNT, TRACK_SETTINGS, TRACK_SIZE,
)

SOUND_INSERT_AT = 240
SOUND_INSERT_LEN = 12
BLOCK_BYTE = 138
BLOCK_BYTE_B = 64
BLOCK_LEN_A = 2074
BLOCK_TAIL = b"\xff\xff"
SETTINGS_TAIL = TRACK_SETTINGS + 20  # track-relative; 3 bytes
SETTINGS_TAIL_LEN = 3
GEN_A_DEFAULT = 0x3F


def _u32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">I", buf, off)[0]


def _check_gens(src_gen, dst_gen) -> bool:
    """True when conversion is needed."""
    for gen in (src_gen, dst_gen):
        if gen not in (GEN_A, GEN_B):
            raise FormatError(f"unsupported structure generation {gen}")
    return src_gen != dst_gen


def convert_pattern(pattern: bytes, src_gen, dst_gen) -> tuple[bytes, list[str]]:
    if not _check_gens(src_gen, dst_gen):
        return pattern, []
    if len(pattern) != PATTERN_SIZE:
        raise FormatError(f"pattern is {len(pattern)} bytes, expected {PATTERN_SIZE}")
    if _u32(pattern, 0) != src_gen[0]:
        raise FormatError(f"pattern version {_u32(pattern, 0)}, expected {src_gen[0]}")
    out = bytearray(pattern)
    out[0:4] = struct.pack(">I", dst_gen[0])
    notes: list[str] = []
    for t in range(TRACK_COUNT):
        a = TRACK_BASE + t * TRACK_SIZE + SETTINGS_TAIL
        tail = bytes(out[a:a + SETTINGS_TAIL_LEN])
        if src_gen == GEN_A:
            out[a:a + SETTINGS_TAIL_LEN] = bytes(SETTINGS_TAIL_LEN)  # device zeroes both 3f3f3f and 3f3f3e
            if tail != bytes([GEN_A_DEFAULT]) * SETTINGS_TAIL_LEN:
                notes.append(f"track {t + 1} settings bytes {tail.hex()} reset to 000000 "
                             "(the Syntakt does the same when it upgrades)")
        else:
            new = bytes(GEN_A_DEFAULT if b == 0 else b for b in tail)
            out[a:a + SETTINGS_TAIL_LEN] = new
            if any(b not in (0, GEN_A_DEFAULT) for b in tail):
                notes.append(f"track {t + 1} settings bytes {tail.hex()} kept as-is (meaning unknown in v{dst_gen[0]})")
    return bytes(out), notes


def _split_kit(kit: bytes, gen) -> tuple[list[bytes], bytes]:
    """Return (sound blobs, settings block + padding) after validating."""
    if len(kit) != KIT_SIZE:
        raise FormatError(f"kit is {len(kit)} bytes, expected {KIT_SIZE}")
    if _u32(kit, 0) != gen[1]:
        raise FormatError(f"kit version {_u32(kit, 0)}, expected {gen[1]}")
    size = SOUND_SIZE[gen[2]]
    sounds, pos = [], KIT_SOUNDS
    for i in range(SOUNDS_PER_KIT):
        s = kit[pos:pos + size]
        if s[:4] != MAGIC or s[-4:] != END_MAGIC or _u32(s, 4) != gen[2] or len(s) != size:
            raise FormatError(f"sound {i + 1} is malformed for sound version {gen[2]}")
        sounds.append(s)
        pos += size
    rest = kit[pos:]
    return sounds, rest


def convert_kit(kit: bytes, src_gen, dst_gen) -> tuple[bytes, list[str]]:
    if not _check_gens(src_gen, dst_gen):
        return kit, []
    sounds, rest = _split_kit(kit, src_gen)
    block_ver_src = 1 if src_gen == GEN_A else 2
    block_ver_dst = 2 if src_gen == GEN_A else 1
    if _u32(rest, 0) != block_ver_src:
        raise FormatError(f"kit settings block version {_u32(rest, 0)}, expected {block_ver_src}")
    notes: list[str] = []
    new_sounds: list[bytes] = []
    for i, s in enumerate(sounds):
        if src_gen == GEN_A:
            ns = s[:SOUND_INSERT_AT] + bytes(SOUND_INSERT_LEN) + s[SOUND_INSERT_AT:]
        else:
            gap = s[SOUND_INSERT_AT:SOUND_INSERT_AT + SOUND_INSERT_LEN]
            if any(gap):
                notes.append(f"sound {i + 1}: dropped non-zero bytes {gap.hex()} (offsets 240..251)")
            ns = s[:SOUND_INSERT_AT] + s[SOUND_INSERT_AT + SOUND_INSERT_LEN:]
        ns = ns[:4] + struct.pack(">I", dst_gen[2]) + ns[8:]
        new_sounds.append(ns)

    block_len_src = BLOCK_LEN_A if src_gen == GEN_A else BLOCK_LEN_A + len(BLOCK_TAIL)
    used, pad = rest[:block_len_src], rest[block_len_src:]
    if any(pad):
        raise FormatError("kit padding after settings block is not zero (unknown data)")
    block = bytearray(used)
    block[0:4] = struct.pack(">I", block_ver_dst)
    if src_gen == GEN_A:
        if block[BLOCK_BYTE] != 0:
            raise FormatError(f"kit settings byte {BLOCK_BYTE} is {block[BLOCK_BYTE]}, expected 0")
        block[BLOCK_BYTE] = BLOCK_BYTE_B
        block += BLOCK_TAIL
    else:
        if block[BLOCK_BYTE] != BLOCK_BYTE_B:
            notes.append(f"kit settings byte {BLOCK_BYTE} was {block[BLOCK_BYTE]} (not {BLOCK_BYTE_B}), reset to 0")
        block[BLOCK_BYTE] = 0
        tail = bytes(block[BLOCK_LEN_A:])
        if tail != BLOCK_TAIL:
            notes.append(f"kit settings tail bytes {tail.hex()} dropped (expected ffff)")
        del block[BLOCK_LEN_A:]
    body = bytearray(kit[:KIT_SOUNDS])
    body[0:4] = struct.pack(">I", dst_gen[1])
    out = bytes(body) + b"".join(new_sounds) + bytes(block)
    if len(out) > KIT_SIZE:
        raise FormatError("converted kit exceeds kit size")
    return out + bytes(KIT_SIZE - len(out)), notes
