"""LZ4 block format codec (pure Python, no dependencies).

Elektron payloads are a sequence of LZ4 blocks compressed in streaming mode:
a match may reach back into earlier blocks (64 KiB window). The decoder
therefore appends every block to one shared output buffer. The encoder emits
independent blocks, which every streaming decoder also accepts.
"""

MIN_MATCH = 4
MAX_OFFSET = 0xFFFF
# LZ4 end-of-block rules: the last match starts at least 12 bytes before the
# end of the block, and the last 5 bytes are always literals.
MF_LIMIT = 12
LAST_LITERALS = 5


class LZ4Error(ValueError):
    pass


def _read_length(src: bytes, pos: int, end: int, base: int) -> tuple[int, int]:
    length = base
    if base == 15:
        while True:
            if pos >= end:
                raise LZ4Error("truncated length")
            extra = src[pos]
            pos += 1
            length += extra
            if extra != 255:
                break
    return length, pos


def decompress_into(out: bytearray, src: bytes, start: int, end: int) -> None:
    """Decode one block src[start:end], appending to out (which holds the
    previously decoded blocks of the same stream)."""
    pos = start
    while pos < end:
        token = src[pos]
        pos += 1
        literal_len, pos = _read_length(src, pos, end, token >> 4)
        if pos + literal_len > end:
            raise LZ4Error("literal run past block end")
        out += src[pos:pos + literal_len]
        pos += literal_len
        if pos == end:
            return  # final sequence carries literals only
        if pos + 2 > end:
            raise LZ4Error("truncated match offset")
        offset = src[pos] | (src[pos + 1] << 8)
        pos += 2
        if offset == 0 or offset > len(out):
            raise LZ4Error(f"invalid match offset {offset}")
        match_len, pos = _read_length(src, pos, end, token & 15)
        match_len += MIN_MATCH
        begin = len(out) - offset
        if offset >= match_len:
            out += out[begin:begin + match_len]
        else:  # overlapping copy repeats the last `offset` bytes
            pattern = bytes(out[begin:])
            whole, rest = divmod(match_len, offset)
            out += pattern * whole + pattern[:rest]
    raise LZ4Error("block ended inside a sequence")


def _write_length(out: bytearray, remainder: int) -> None:
    while remainder >= 255:
        out.append(255)
        remainder -= 255
    out.append(remainder)


def _emit(out: bytearray, src: bytes, lit_start: int, lit_end: int, offset: int, match_len: int) -> None:
    literal_len = lit_end - lit_start
    extra_match = match_len - MIN_MATCH if match_len else 0
    out.append((min(literal_len, 15) << 4) | min(extra_match, 15))
    if literal_len >= 15:
        _write_length(out, literal_len - 15)
    out += src[lit_start:lit_end]
    if match_len:
        out += offset.to_bytes(2, "little")
        if extra_match >= 15:
            _write_length(out, extra_match - 15)


def compress_block(src: bytes) -> bytes:
    """Greedy single-block LZ4 compressor; output references only src itself."""
    n = len(src)
    out = bytearray()
    table: dict[bytes, int] = {}
    anchor = pos = 0
    match_limit = n - MF_LIMIT
    literal_limit = n - LAST_LITERALS
    while pos < match_limit:
        key = src[pos:pos + MIN_MATCH]
        candidate = table.get(key)
        table[key] = pos
        if candidate is None or pos - candidate > MAX_OFFSET:
            pos += 1
            continue
        length = MIN_MATCH
        while pos + length < literal_limit and src[candidate + length] == src[pos + length]:
            length += 1
        _emit(out, src, anchor, pos, pos - candidate, length)
        pos += length
        anchor = pos
    _emit(out, src, anchor, n, 0, 0)
    return bytes(out)
