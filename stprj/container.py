"""`.stprj` file container: ZIP (manifest.json + payload) and the Elektron
payload envelope (header, chained LZ4 blocks, CRC trailer).

Payload layout (all integers big-endian):
    0x00  u32  magic 0xAC11D303
    0x04  ...  constant fields, kept verbatim
    0x11  u32  project structure version
    0x15  u32  project slot (0-based)
    0x19  u32  decompressed size
    0x1D  u8   1 = LZ4 compressed
    0x1E  u8   compression level (12)
    0x1F  [u32 length][LZ4 block] ... repeated, terminated by length 0
    then  u32  CRC-32 of the block area including the terminator,
               computed as zlib.crc32(area, 0xFFFFFFFF) (Transfer's e_crc32)
          u32  byte length of that block area
          u32  magic 0xAAA1DAAA
"""

from __future__ import annotations

import io
import json
import struct
import zipfile
import zlib
from dataclasses import dataclass

from . import lz4block

HEADER_SIZE = 0x1F
HEADER_MAGIC = 0xAC11D303
TRAILER_MAGIC = 0xAAA1DAAA
OFF_VERSION = 0x11
OFF_SLOT = 0x15
OFF_SIZE = 0x19
OFF_COMPRESSED = 0x1D
BLOCK_SIZE = 32768
MANIFEST_NAME = "manifest.json"


class FormatError(ValueError):
    pass


def _u32(buf: bytes, offset: int) -> int:
    return struct.unpack_from(">I", buf, offset)[0]


@dataclass(frozen=True)
class Payload:
    header: bytes  # 31 raw header bytes
    data: bytes    # decompressed project image

    @property
    def version(self) -> int:
        return _u32(self.header, OFF_VERSION)

    @property
    def slot(self) -> int:
        return _u32(self.header, OFF_SLOT)


def decode_payload(raw: bytes) -> Payload:
    if len(raw) < HEADER_SIZE + 16:
        raise FormatError("payload too short")
    if _u32(raw, 0) != HEADER_MAGIC:
        raise FormatError("bad header magic")
    if _u32(raw, len(raw) - 4) != TRAILER_MAGIC:
        raise FormatError("bad trailer magic")
    if raw[OFF_COMPRESSED] != 1:
        raise FormatError(f"unsupported compression flag {raw[OFF_COMPRESSED]}")
    stored_crc = _u32(raw, len(raw) - 12)
    stored_len = _u32(raw, len(raw) - 8)
    area_end = HEADER_SIZE + stored_len
    if area_end != len(raw) - 12:
        raise FormatError("block area length does not match file size")
    crc = zlib.crc32(raw[HEADER_SIZE:area_end], 0xFFFFFFFF)
    if crc != stored_crc:
        raise FormatError(f"CRC mismatch: stored {stored_crc:08x}, computed {crc:08x}")

    out = bytearray()
    pos = HEADER_SIZE
    while True:
        if pos + 4 > area_end:
            raise FormatError("missing block terminator")
        length = _u32(raw, pos)
        pos += 4
        if length == 0:
            break
        if pos + length > area_end:
            raise FormatError("block runs past block area")
        lz4block.decompress_into(out, raw, pos, pos + length)
        pos += length
    if pos != area_end:
        raise FormatError("data after block terminator")
    expected = _u32(raw, OFF_SIZE)
    if len(out) != expected:
        raise FormatError(f"decompressed {len(out)} bytes, header says {expected}")
    return Payload(header=bytes(raw[:HEADER_SIZE]), data=bytes(out))


def encode_payload(payload: Payload) -> bytes:
    header = bytearray(payload.header)
    struct.pack_into(">I", header, OFF_SIZE, len(payload.data))
    area = bytearray()
    for start in range(0, len(payload.data), BLOCK_SIZE):
        block = lz4block.compress_block(payload.data[start:start + BLOCK_SIZE])
        area += struct.pack(">I", len(block)) + block
    area += b"\0\0\0\0"
    crc = zlib.crc32(area, 0xFFFFFFFF)
    return bytes(header) + bytes(area) + struct.pack(">III", crc, len(area), TRAILER_MAGIC)


@dataclass(frozen=True)
class StprjFile:
    manifest_raw: bytes  # kept byte-exact
    payload_name: str
    payload: Payload

    @property
    def manifest(self) -> dict:
        return json.loads(self.manifest_raw)


def read_stprj(path: str) -> StprjFile:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if MANIFEST_NAME not in names:
            raise FormatError("manifest.json missing")
        manifest_raw = zf.read(MANIFEST_NAME)
        manifest = json.loads(manifest_raw)
        if manifest.get("FileType") != "Project":
            raise FormatError(f"not a project file: {manifest.get('FileType')!r}")
        payload_name = manifest.get("Payload")
        if payload_name not in names:
            raise FormatError(f"payload entry {payload_name!r} missing")
        payload = decode_payload(zf.read(payload_name))
    return StprjFile(manifest_raw=manifest_raw, payload_name=payload_name, payload=payload)


def _zip_bytes(manifest_raw: bytes, payload_name: str, payload_raw: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_NAME, manifest_raw)
        zf.writestr(payload_name, payload_raw)
    return buf.getvalue()


def stprj_bytes(file: StprjFile) -> bytes:
    return _zip_bytes(file.manifest_raw, file.payload_name, encode_payload(file.payload))


def write_stprj(path: str, file: StprjFile) -> None:
    data = stprj_bytes(file)
    # Prove the written bytes decode back to the same project image.
    check = decode_payload(zipfile.ZipFile(io.BytesIO(data)).read(file.payload_name))
    if check.data != file.payload.data:
        raise FormatError("internal error: re-encoded payload does not round-trip")
    with open(path, "xb") as fh:  # never overwrite an existing file
        fh.write(data)


def write_raw_stprj(path: str, manifest_raw: bytes, payload_name: str, payload_raw: bytes) -> Payload:
    """Write a .stprj whose payload entry is `payload_raw` byte-for-byte (e.g. read from a device).

    The payload is validated with decode_payload first (FormatError if invalid). Never overwrites.
    The written file is re-read to confirm both entries are byte-identical; returns the decoded Payload.
    """
    payload = decode_payload(payload_raw)
    data = _zip_bytes(manifest_raw, payload_name, payload_raw)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        if zf.read(MANIFEST_NAME) != manifest_raw or zf.read(payload_name) != payload_raw:
            raise FormatError("internal error: zip entries do not round-trip")
    with open(path, "xb") as fh:  # never overwrite an existing file
        fh.write(data)
    with zipfile.ZipFile(path) as zf:  # confirm what actually reached the disk
        if zf.read(payload_name) != payload_raw or zf.read(MANIFEST_NAME) != manifest_raw:
            raise FormatError(f"{path}: written payload differs from the input")
    return payload
