// Read-mostly client for the Elektron "midi_rpc" SysEx protocol (Syntakt), for WebMIDI: read-only requests plus one
// guarded write path (writeProject into an EMPTY slot).
// Recovered by static analysis of Elektron Transfer 1.10.4 and confirmed against a real Syntakt
// (firmware strings "0097" / "1.42"): the read-only requests, project reads, a single-chunk write into empty slot 128
// (read back identical except the header slot field 0x15..0x18) and a 2-chunk write into empty slot 127. The device
// decompresses and re-compresses on store, so stored bytes can differ from written ones: verification compares decoded images.
//
// Frame: F0 00 20 3C 10 00 + pack7([u16 A, u16 B, u8 opcode, ...args]) + F7
//  - request: A = host message counter, B = 0
//  - reply:   A = device's own counter, B = ECHO OF THE REQUEST'S A  (match replies on B), opcode = request | 0x80
//
// SAFETY: request() only sends READ_ONLY_OPCODES. The three write opcodes (WRITE_OPCODES) can only be sent from
// writeProject() via a module-private token, for one exact /projects/<slot> open, its returned handle and consistent chunks.
// Uses input.addEventListener('midimessage', ...) only (never onmidimessage).

export const OP = Object.freeze({
  PING: 0x01, SOFTWARE_VERSION: 0x02, DEVICE_UID: 0x03, QUERY: 0x09, DATA_LIST: 0x53,
  DATA_READ_OPEN: 0x54, DATA_READ_PARTIAL: 0x55, DATA_READ_CLOSE: 0x56,
  DATA_WRITE_OPEN: 0x57, DATA_WRITE_PARTIAL: 0x58, DATA_WRITE_CLOSE: 0x59,
});
export const READ_ONLY_OPCODES = new Set([0x01, 0x02, 0x03, 0x09, 0x53, 0x54, 0x55, 0x56]);
export const WRITE_OPCODES = new Set([0x57, 0x58, 0x59]);
const WRITE_TOKEN = Symbol('elektron-rpc.write'); // never exported: only writeProject can authorise write opcodes
export const MAX_SLOT = 128;
export const DEFAULT_WRITE_CHUNK = 0x8000;
const WRITE_TIMEOUT_MS = 15000; // the device needed 2 s to store one 28 KB chunk
const PAYLOAD_HEADER_SIZE = 0x1F;
const MAX_IMAGE_SIZE = 64 * 1024 * 1024;
const MAX_REPORTED_MISMATCHES = 32;
const PAYLOAD_TRAILER_SIZE = 12;
export const DEFAULT_READ_CHUNK = 0x800; // Transfer hard-codes 2048

// Transfer's _e_crc32(0xFFFFFFFF, data) == zlib.crc32(data, 0xFFFFFFFF) (verified on 15 device chunks)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32e(data) { let c = 0; for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8); return (~c) >>> 0; }
export const HEADER = Uint8Array.of(0xF0, 0x00, 0x20, 0x3C, 0x10, 0x00);

// Observed: DataList("/projects") entries carry the slot number 1..128 (same as the number in
// "028 BORN SLIPPY" backups and the device UI), so no offset is needed.
export const SLOT_INDEX_OFFSET = 0;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

// ------------------------------------------------------------------ 7-bit packing
export function pack7(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const n = Math.min(7, bytes.length - i);
    let hdr = 0;
    for (let k = 0; k < n; k++) hdr |= (bytes[i + k] >> 7) << (6 - k);
    out.push(hdr);
    for (let k = 0; k < n; k++) out.push(bytes[i + k] & 0x7f);
  }
  return Uint8Array.from(out);
}

export function unpack7(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const hdr = bytes[i];
    const n = Math.min(8, bytes.length - i) - 1;
    for (let k = 0; k < n; k++) out.push(((hdr << (k + 1)) & 0x80) | (bytes[i + 1 + k] & 0x7f));
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ framing
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u32be = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const cstr = (s) => concat(enc.encode(s), Uint8Array.of(0));

function buildFrameUnchecked(seq, opcode, args = new Uint8Array(0)) {
  const body = concat(Uint8Array.of((seq >> 8) & 255, seq & 255, 0, 0, opcode), args);
  return concat(HEADER, pack7(body), Uint8Array.of(0xF7));
}

// Public frame builder: read-only opcodes only. (Write frames are built only inside the guarded write path.)
export function buildFrame(seq, opcode, args = new Uint8Array(0)) {
  if (!READ_ONLY_OPCODES.has(opcode)) throw new Error(`opcode 0x${opcode.toString(16)} is not read-only; refusing`);
  return buildFrameUnchecked(seq, opcode, args);
}

export function hasRpcPrefix(b) {
  if (b.length < 7 || b[b.length - 1] !== 0xF7) return false;
  for (let i = 0; i < HEADER.length; i++) if (b[i] !== HEADER[i]) return false;
  return true;
}

// Returns { a, b, seq, field2, opcode, payload }. For replies, `b` (alias `echo`) is the request's seq.
export function parseFrame(frame) {
  if (!hasRpcPrefix(frame)) throw new Error('not an Elektron RPC frame');
  const body = unpack7(frame.subarray(6, frame.length - 1));
  if (body.length < 5) throw new Error('RPC body shorter than 5-byte header');
  const a = (body[0] << 8) | body[1];
  const b = (body[2] << 8) | body[3];
  return { a, b, echo: b, seq: a, field2: b, opcode: body[4], payload: body.subarray(5) };
}

export const argsQuery = (key) => cstr(key);
export const argsReadOpen = (path, chunkSize = DEFAULT_READ_CHUNK, flag = true) => concat(cstr(path), u32be(chunkSize), Uint8Array.of(flag ? 1 : 0));
export const argsReadPartial = (handle, index) => concat(u32be(handle), u32be(index));
export const argsReadClose = (handle) => u32be(handle);
// Observed: cstr path, u32 from, u32 to, u8 bool. (0, 0, false) lists everything (what DataList(path) sends);
// (n, n+1) selects slot n (Transfer's single-slot lookup); the reply echoes the range.
export const argsDataList = (path, a = 0, b = 0, flag = false) =>
  concat(cstr(path), u32be(a), u32be(b), Uint8Array.of(flag ? 1 : 0));

// ---- write request builders (bytes only; sending them requires the private write auth inside writeProject)
export const argsWriteOpen = (path, size) => concat(u32be(size), cstr(path));
export const argsWritePartial = (handle, index, data) => concat(u32be(handle), u32be(index), u32be(crc32e(data)), u32be(data.length), data);
export const argsWriteClose = (handle, count) => concat(u32be(handle), u32be(count));

const readU32 = (b, o) => ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Project payload envelope: 31-byte header (magic AC11D303, version @0x11, 0-based slot @0x15, decompressed size @0x19),
// chained LZ4 blocks [u32 BE len][block] ending with len 0 ("area"), then u32 crc32e(area), u32 area length, magic AAA1DAAA.
// Throws unless the envelope is intact; returns { version, slot0, decompressedSize }. (The name is not in the header.)
export function validatePayload(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('payload must be a Uint8Array');
  const n = bytes.length;
  if (n < PAYLOAD_HEADER_SIZE + 4 + PAYLOAD_TRAILER_SIZE) throw new Error(`payload too short (${n} bytes)`);
  if (readU32(bytes, 0) !== 0xAC11D303) throw new Error('bad payload header magic (expected AC11D303)');
  if (readU32(bytes, n - 4) !== 0xAAA1DAAA) throw new Error('bad payload trailer magic (expected AAA1DAAA)');
  const area = bytes.subarray(PAYLOAD_HEADER_SIZE, n - PAYLOAD_TRAILER_SIZE);
  if (readU32(bytes, n - 8) !== area.length) throw new Error(`payload area length field ${readU32(bytes, n - 8)} != ${area.length}`);
  const crc = crc32e(area);
  if (readU32(bytes, n - 12) !== crc) throw new Error(`payload CRC mismatch (stored ${readU32(bytes, n - 12).toString(16)}, computed ${crc.toString(16)})`);
  let pos = 0;
  for (;;) { // walk the LZ4 block chain to the zero terminator, which must end the area exactly
    if (pos + 4 > area.length) throw new Error('payload block chain is truncated');
    const len = readU32(area, pos); pos += 4;
    if (len === 0) break;
    pos += len;
  }
  if (pos !== area.length) throw new Error('payload block chain does not end at the area end');
  return { version: readU32(bytes, 0x11), slot0: readU32(bytes, 0x15), decompressedSize: readU32(bytes, 0x19) };
}

// Chained LZ4 blocks share one output buffer (matches may reach into earlier blocks). Decodes src[start,end) into out
// at position `o`; returns the new output position.
function lz4DecompressInto(out, o, src, start, end) {
  let pos = start;
  while (pos < end) {
    const token = src[pos++];
    let lit = token >> 4;
    if (lit === 15) { let x; do { if (pos >= end) throw new Error('lz4: truncated length'); x = src[pos++]; lit += x; } while (x === 255); }
    if (pos + lit > end || o + lit > out.length) throw new Error('lz4: literal run out of range');
    out.set(src.subarray(pos, pos + lit), o); o += lit; pos += lit;
    if (pos === end) return o;
    if (pos + 2 > end) throw new Error('lz4: truncated match offset');
    const offset = src[pos] | (src[pos + 1] << 8); pos += 2;
    if (offset === 0 || offset > o) throw new Error(`lz4: invalid match offset ${offset}`);
    let m = token & 15;
    if (m === 15) { let x; do { if (pos >= end) throw new Error('lz4: truncated length'); x = src[pos++]; m += x; } while (x === 255); }
    m += 4;
    if (o + m > out.length) throw new Error('lz4: output overrun');
    if (offset >= m) { out.copyWithin(o, o - offset, o - offset + m); o += m; } else { for (let k = 0; k < m; k++, o++) out[o] = out[o - offset]; }
  }
  throw new Error('lz4: block ended inside a sequence');
}

// Validates the payload envelope (see validatePayload) and returns the decompressed project image. The output buffer is
// allocated once from the header's decompressed size (4,089,348 bytes for a Syntakt project); sizes above 64 MiB are refused.
export function decodePayloadImage(bytes) {
  const info = validatePayload(bytes);
  if (bytes[0x1D] !== 1) throw new Error(`unsupported compression flag ${bytes[0x1D]}`);
  if (info.decompressedSize === 0 || info.decompressedSize > MAX_IMAGE_SIZE) throw new Error(`implausible decompressed size ${info.decompressedSize}`);
  const out = new Uint8Array(info.decompressedSize);
  const areaEnd = bytes.length - PAYLOAD_TRAILER_SIZE;
  let pos = PAYLOAD_HEADER_SIZE; let o = 0;
  for (;;) {
    const len = readU32(bytes, pos); pos += 4;
    if (len === 0) break;
    if (pos + len > areaEnd) throw new Error('block runs past block area');
    o = lz4DecompressInto(out, o, bytes, pos, pos + len);
    pos += len;
  }
  if (o !== out.length) throw new Error(`decompressed ${o} bytes, header says ${out.length}`);
  return out;
}

// Offsets where two project images differ (capped at `cap`; a length difference counts the excess as mismatches).
export function diffImages(a, b, cap = MAX_REPORTED_MISMATCHES) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < cap; i++) if (i >= a.length || i >= b.length || a[i] !== b[i]) out.push(i);
  return out;
}

// Offsets (outside the header slot field 0x15..0x18) where written and read-back bytes differ; a length difference
// counts every offset beyond the shorter buffer as a mismatch.
export function diffIgnoringSlotField(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i >= 0x15 && i <= 0x18) continue;
    if (i >= a.length || i >= b.length || a[i] !== b[i]) out.push(i);
  }
  return out;
}

// Per-call write permission: exact open (path + size, once), then only that handle with self-consistent chunks.
function makeWriteContext(path, size) {
  const expectOpen = argsWriteOpen(path, size);
  return {
    handle: null, opened: false,
    allows(opcode, args) {
      if (opcode === OP.DATA_WRITE_OPEN) { if (this.opened || !sameBytes(args, expectOpen)) return false; this.opened = true; return true; }
      if (this.handle === null || args.length < 8 || readU32(args, 0) !== this.handle) return false;
      if (opcode === OP.DATA_WRITE_CLOSE) return args.length === 8;
      if (opcode !== OP.DATA_WRITE_PARTIAL || args.length < 16) return false;
      const data = args.subarray(16);
      return readU32(args, 12) === data.length && readU32(args, 8) === crc32e(data);
    },
  };
}

// ------------------------------------------------------------------ payload decoding
class Reader {
  constructor(d) { this.d = d; this.p = 0; }
  left() { return this.d.length - this.p; }
  u8() { if (this.left() < 1) throw new RangeError('truncated'); return this.d[this.p++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() * 0x1000000) + (this.u8() << 16) + (this.u8() << 8) + this.u8()); }
  u64() { const hi = BigInt(this.u32()); return (hi << 32n) | BigInt(this.u32()); }
  raw(n) { const v = this.d.subarray(this.p, this.p + n); this.p += v.length; return v; }
  cstr() {
    let e = this.d.indexOf(0, this.p);
    if (e < 0) e = this.d.length;
    const s = dec.decode(this.d.subarray(this.p, e));
    this.p = Math.min(e + 1, this.d.length);
    return s;
  }
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const toNumber = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

// 0x81 [observed]: u8 (0x1e, meaning unknown), u8 n, n opcode bytes (the opcodes the device implements), cstr name
export function decodePing(p) {
  const r = new Reader(p);
  const byte0 = r.u8();
  const supportedOpcodes = Array.from(r.raw(r.u8()));
  const name = r.left() ? r.cstr() : '';
  return { byte0, supportedOpcodes, name };
}
// 0x82 [observed]: cstr, cstr -> "0097", "1.42". INFERRED: first = build/revision, second = version.
export function decodeSoftwareVersion(p) {
  const r = new Reader(p);
  const first = r.cstr();
  const second = r.left() ? r.cstr() : '';
  return { version: second || first, build: second ? first : '', strings: [first, second] };
}
// 0x83 [observed]: u32 (big-endian)
export function decodeDeviceUid(p) { const uid = new Reader(p).u32(); return { uid }; }
// 0x85: not implemented by the Syntakt and not whitelisted; layout from Transfer's parser only (unused).
export function decodeStorageSpace(p) {
  const r = new Reader(p);
  const byte0 = r.u8();
  const a = r.u64();
  const b = r.u64();
  return { byte0, a, b };
}
// 0xD4 [observed]: u8 ok; ok -> u32 handle, u32 chunk size (echo of the requested 0x800), u8 flag (echo); !ok -> cstr error
export function decodeReadOpen(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  const handle = r.u32(), chunkSize = r.u32();
  return { ok: true, handle, chunkSize, flag: r.left() ? r.u8() !== 0 : null };
}
// 0xD5 [observed]: u8 ok; ok -> u32 handle, u32 b, u32 c, u8 last, u32 crc32e(data), u32 len, data[len]
//   chunk 0 is empty (len 0, b and c look like floats); for i >= 1, b = chunk index; c is a slowly increasing
//   counter of unknown meaning (993..1000 on slot 28).
export function decodeReadPartial(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  const handle = r.u32(), b = r.u32(), c = r.u32(), last = r.u8() !== 0, crc = r.u32(), len = r.u32();
  const data = Uint8Array.from(r.raw(len));
  if (data.length !== len) throw new RangeError('truncated chunk');
  return { ok: true, handle, b, c, last, crc, len, data };
}
// 0xD6 [observed]: u8 ok; ok -> u32 handle echo, u32 total bytes of the file
export function decodeReadClose(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  return { ok: true, handle: r.u32(), total: r.u32() };
}
// ---- write replies [observed on slot 128 write]
// 0xD7: u8 ok; ok -> u32 handle; !ok -> cstr error
export function decodeWriteOpen(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  return { ok: true, handle: r.u32() };
}
// 0xD8: u8 ok; ok -> u32 handle echo, u32 chunk index echo, u32 CUMULATIVE bytes received so far (incl. this chunk); !ok -> cstr error
export function decodeWritePartial(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  return { ok: true, handle: r.u32(), index: r.u32(), len: r.u32() };
}
// 0xD9: u8 ok; ok -> u32 handle echo, u32 total bytes written; !ok -> cstr error
export function decodeWriteClose(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '' };
  return { ok: true, handle: r.u32(), total: r.u32() };
}
// 0x89 [observed types 0, 3, 4]: u8 type; 0 = key unknown (no more bytes), 3 = u64 integer, 4 = cstr.
// type 1 (bool) and 2 (u64) come from Transfer's parser only.
export function decodeQuery(p) {
  const r = new Reader(p);
  const type = r.u8();
  let value = null;
  if (type === 1) value = r.u8() !== 0;
  else if (type === 2 || type === 3) value = toNumber(r.u64());
  else if (type === 4) value = r.cstr();
  return { ok: type !== 0, type, value };
}
// 0xD3 [observed]: u8 ok; ok -> u32 a, u32 b, u32 count, count entries; !ok -> cstr error.
//   (a, b) echo the requested range; for (0,0) b = last index + 1 and count = number of entries (all of them).
// entry: cstr name, u8 flag18, u8 type (2 = slot entry), then for type 2:
//   u32 index (1-based slot number), u32 capacity (4194304 = 4 MiB, NOT the used size),
//   u16 flags (126 normal, 18 on slots 1 and 6 of this device; meaning unknown), u8 used, u8 used2.
// Empty slot: name "" and used = used2 = 0. Type 1 is not seen on the Syntakt (u32 only; meaning unknown).
export function decodeDataList(p) {
  const r = new Reader(p);
  if (!r.u8()) return { ok: false, error: r.left() ? r.cstr() : '', entries: [], a: 0, b: 0, count: 0 };
  const a = r.u32(), b = r.u32(), count = r.u32();
  const entries = [];
  for (let i = 0; i < count && r.left() > 0; i++) {
    const e = { name: r.cstr(), flag18: r.u8() !== 0, type: r.u8(), size: null };
    if (e.type === 1) { e.v20 = r.u32(); e.size = e.v20; }
    else if (e.type === 2) {
      e.v20 = r.u32(); e.v24 = r.u32(); e.flags28 = r.u16(); e.b2a = r.u8() !== 0; e.b2b = r.left() ? r.u8() !== 0 : false;
      e.index = e.v20; e.capacity = e.v24; e.used = e.b2a;
    }
    e.flags = e.flags28 ?? 0;
    entries.push(e);
  }
  return { ok: true, a, b, count, entries };
}

// ------------------------------------------------------------------ client
export class ElektronRpc {
  constructor({ input, output, timeoutMs = 3000, log = () => {} }) {
    this.input = input; this.output = output; this.timeoutMs = timeoutMs; this.log = log;
    this._seq = 0; this._pending = null; this._chain = Promise.resolve(); this._buf = null; this._started = false;
    this.supportedOpcodes = null; // filled by ping()
    this._onMsg = (ev) => this._feed(ev.data);
  }

  start() {
    if (this._started) return;
    this.input.addEventListener('midimessage', this._onMsg);
    this._started = true;
  }
  stop() {
    if (!this._started) return;
    this.input.removeEventListener('midimessage', this._onMsg);
    this._started = false;
    this._buf = null;
    if (this._pending) { clearTimeout(this._pending.timer); this._pending.reject(new Error('stopped')); this._pending = null; }
  }

  // Assemble SysEx that may arrive split across events; ignore all non-SysEx and non-RPC messages.
  _feed(data) {
    if (!data || !data.length) return;
    if (data[0] === 0xF0) this._buf = [];
    else if (!this._buf) return; // not sysex, not a continuation
    for (const b of data) {
      if (b >= 0xF8) continue; // realtime
      if (b === 0xF0) { this._buf = [b]; continue; }
      if (!this._buf) return;
      this._buf.push(b);
      if (b === 0xF7) { const f = Uint8Array.from(this._buf); this._buf = null; this._onFrame(f); }
      else if ((b & 0x80) && this._buf.length > 1) { this._buf = null; return; }
    }
  }

  _onFrame(frame) {
    if (!hasRpcPrefix(frame)) return; // someone else's sysex (the Syntakt also emits e.g. F0 7E 00 7C 00 F7)
    let m;
    try { m = parseFrame(frame); } catch (e) { this.log(`rpc: bad frame ${e.message}`); return; }
    this.log(`rx ${hex(frame)}`);
    const p = this._pending;
    if (!p || m.echo !== p.seq) return;
    clearTimeout(p.timer);
    this._pending = null;
    if (m.opcode !== (p.opcode | 0x80)) p.reject(Object.assign(new Error(`unexpected reply opcode 0x${m.opcode.toString(16)}`), { frame }));
    else p.resolve({ ...m, raw: frame });
  }

  _nextSeq() { this._seq = (this._seq % 0xFFFF) + 1; return this._seq; }

  // Rejects for any opcode outside READ_ONLY_OPCODES, before anything is built or sent. Write opcodes are accepted
  // only with the module-private `auth` created inside writeProject (not forgeable from outside this module), and then
  // only for the exact /projects/<slot> open, the handle that open returned, and a self-consistent chunk.
  // Also rejects (without sending) opcodes the device did not list in its Ping reply, once ping() has run.
  request(opcode, args = new Uint8Array(0), auth = null, timeoutMs = this.timeoutMs) {
    if (WRITE_OPCODES.has(opcode)) {
      if (!auth || auth.token !== WRITE_TOKEN || !auth.ctx || !auth.ctx.allows(opcode, args)) {
        return Promise.reject(new Error(`opcode 0x${opcode.toString(16)} is a write opcode; refusing`));
      }
    } else if (!READ_ONLY_OPCODES.has(opcode)) {
      return Promise.reject(new Error(`opcode 0x${Number(opcode).toString(16)} is not in READ_ONLY_OPCODES; refusing`));
    }
    if (this.supportedOpcodes && opcode !== OP.PING && !this.supportedOpcodes.includes(opcode)) {
      return Promise.reject(new Error(`opcode 0x${opcode.toString(16)} is not supported by this device`));
    }
    const run = () => new Promise((resolve, reject) => {
      const seq = this._nextSeq();
      const frame = buildFrameUnchecked(seq, opcode, args);
      const timer = setTimeout(() => {
        if (this._pending && this._pending.seq === seq) this._pending = null;
        reject(new Error(`timeout waiting for reply to opcode 0x${opcode.toString(16)}`));
      }, timeoutMs);
      this._pending = { seq, opcode, resolve, reject, timer };
      this.log(`tx ${hex(frame.length > 64 ? frame.subarray(0, 64) : frame)}${frame.length > 64 ? ` ... (${frame.length} bytes)` : ''}`);
      try { this.output.send(frame); } catch (e) { clearTimeout(timer); this._pending = null; reject(e); }
    });
    const next = this._chain.then(run, run); // strictly one request in flight
    this._chain = next.catch(() => {});
    return next;
  }

  async ping() {
    const m = await this.request(OP.PING);
    const d = decodePing(m.payload);
    this.supportedOpcodes = d.supportedOpcodes;
    return { raw: m.raw, ...d };
  }
  async softwareVersion() { const m = await this.request(OP.SOFTWARE_VERSION); return { ...decodeSoftwareVersion(m.payload), raw: m.raw }; }
  async deviceUid() { const m = await this.request(OP.DEVICE_UID); return { ...decodeDeviceUid(m.payload), raw: m.raw }; }
  // StorageSpace (0x05) is not implemented by the Syntakt and is no longer in READ_ONLY_OPCODES: always rejects.
  async storageSpace() { return Promise.reject(new Error('StorageSpace (opcode 0x05) is not supported by this device and is not whitelisted')); }
  async query(key) { const m = await this.request(OP.QUERY, argsQuery(key)); return { ...decodeQuery(m.payload), raw: m.raw }; }

  // DataList(path, 0, 0): everything under `path` in one reply (verified for /projects: 128 of 128 slots,
  // reply range a=0, b=129, count=128). `page` reports the reply's range for callers that care.
  async listDir(path) {
    const m = await this.request(OP.DATA_LIST, argsDataList(path, 0, 0, false));
    const d = decodeDataList(m.payload);
    if (!d.ok) throw new Error(`DataList ${path} failed: ${d.error}`);
    return { entries: d.entries, page: { a: d.a, b: d.b, count: d.count }, raw: m.raw };
  }

  // slot is 1-based (device UI / backup file prefix). `size` is null: the device reports only slot capacity
  // (4 MiB, in `capacity`), not the used size. empty = unused slot (name "" and not used).
  async listProjects() {
    const { entries } = await this.listDir('/projects');
    return entries.filter((e) => e.type === 2).map((e) => ({
      slot: e.index + SLOT_INDEX_OFFSET,
      path: `/projects/${e.index}`,
      name: e.name,
      size: null,
      capacity: e.capacity,
      empty: !e.used && e.name === '',
    }));
  }

  // ---- file reads (Transfer's sequence: ReadOpen -> ReadPartial(handle, i) for i = 0.. until `last` -> ReadClose).
  // Verified live on /projects/28 (byte-identical to Transfer's backup): chunk 0 is an empty "prepare" chunk,
  // data chunks are `chunkSize` bytes (2048 = what Transfer requests), every chunk carries a CRC32.
  // DataReadClose is always sent for an opened handle. Total size is unknown until ReadClose, so onProgress
  // gets total = null while reading and (n, n) at the end.
  async readFile(path, { onProgress, chunkSize = DEFAULT_READ_CHUNK, maxChunks = 100000 } = {}) {
    const open = decodeReadOpen((await this.request(OP.DATA_READ_OPEN, argsReadOpen(path, chunkSize, true))).payload);
    if (!open.ok) throw new Error(`DataReadOpen ${path} failed: ${open.error}`);
    const parts = [];
    let done = 0;
    let primary = null;
    try {
      let last = false;
      for (let i = 0; i < maxChunks && !last; i++) {
        const m = await this.request(OP.DATA_READ_PARTIAL, argsReadPartial(open.handle, i));
        const c = decodeReadPartial(m.payload);
        if (!c.ok) throw new Error(`DataReadPartial[${i}] failed: ${c.error}`);
        if (c.handle !== open.handle) throw new Error(`chunk ${i}: handle echo ${c.handle} != ${open.handle}`);
        const crc = crc32e(c.data);
        if (crc !== c.crc) throw new Error(`chunk ${i}: CRC mismatch (device ${c.crc.toString(16)}, computed ${crc.toString(16)})`);
        if (c.data.length) { parts.push(c.data); done += c.data.length; }
        last = c.last;
        if (onProgress) onProgress(done, null);
      }
      if (!last) throw new Error(`no last-chunk flag after ${maxChunks} chunks`);
    } catch (e) {
      primary = e;
    }
    let close = null;
    let closeErr = null;
    try { close = decodeReadClose((await this.request(OP.DATA_READ_CLOSE, argsReadClose(open.handle))).payload); } catch (e) { closeErr = e; }
    if (primary) throw primary;
    if (closeErr) throw new Error(`DataReadClose failed: ${closeErr.message}`);
    if (!close.ok) throw new Error(`DataReadClose failed: ${close.error}`);
    if (close.total !== done) throw new Error(`size mismatch: read ${done} bytes, device reports ${close.total}`);
    if (onProgress) onProgress(done, done);
    return concat(...parts);
  }

  // slot is 1-based. The name comes from a single-slot DataList(/projects, slot, slot+1) (Transfer's own paging args).
  async readProject(slot, { onProgress } = {}) {
    if (!Number.isInteger(slot) || slot < 1) throw new Error(`invalid slot ${slot}`);
    const m = await this.request(OP.DATA_LIST, argsDataList('/projects', slot, slot + 1, false));
    const d = decodeDataList(m.payload);
    const e = d.ok ? d.entries.find((x) => x.type === 2 && x.index === slot) : null;
    if (!e) throw new Error(`slot ${slot} not found${d.ok ? '' : `: ${d.error}`}`);
    if (!e.used) throw new Error(`slot ${slot} is empty`);
    const path = `/projects/${slot}`;
    const bytes = await this.readFile(path, { onProgress });
    return { slot, path, name: e.name, bytes };
  }

  // ---- guarded write of a project backup into ONE EMPTY slot (the only write path in this module).
  // Mirrors Transfer's upload (WriteOpen(size, path) -> WritePartial(handle, i, crc, len, data)* -> WriteClose(handle, 1))
  // with these deliberate differences: the slot must be empty (re-listed right before), the payload is validated first,
  // WriteClose is ALWAYS sent once a handle is open (Transfer does not close after an error), and there are no retries.
  // The device rewrites the header slot field (0x15..0x18) with the 0-based slot, so verification ignores it.
  async writeProject(slot, bytes, { onProgress, verify = true } = {}) {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) throw new Error(`invalid slot ${slot} (1..${MAX_SLOT})`);
    if (!(bytes instanceof Uint8Array)) throw new Error('bytes must be a Uint8Array');
    validatePayload(bytes); // throws before anything is sent
    const size = bytes.length;
    const path = `/projects/${slot}`;
    const ping = await this.ping();
    for (const op of WRITE_OPCODES) {
      if (!ping.supportedOpcodes.includes(op)) throw new Error(`device does not support opcode 0x${op.toString(16)}`);
    }
    const q = await this.query('midi.rpc_file_chunk_size_max');
    const chunk = q.ok && typeof q.value === 'number' && q.value > 0 ? q.value : DEFAULT_WRITE_CHUNK;
    const before = decodeDataList((await this.request(OP.DATA_LIST, argsDataList('/projects', slot, slot + 1))).payload);
    const e0 = before.ok ? before.entries.find((x) => x.type === 2 && x.index === slot) : null;
    if (!e0) throw new Error(`slot ${slot} not found${before.ok ? '' : `: ${before.error}`}`);
    if (e0.used || e0.name !== '') throw new Error(`slot ${slot} is not empty ("${e0.name}"); refusing to overwrite`);

    const ctx = makeWriteContext(path, size);
    const auth = { token: WRITE_TOKEN, ctx };
    const wt = Math.max(this.timeoutMs, WRITE_TIMEOUT_MS);
    const open = decodeWriteOpen((await this.request(OP.DATA_WRITE_OPEN, argsWriteOpen(path, size), auth, wt)).payload);
    if (!open.ok) throw new Error(`DataWriteOpen ${path} rejected: ${open.error}`);
    ctx.handle = open.handle;

    let primary = null;
    let sent = 0;
    try {
      for (let idx = 0, off = 0; off < size; idx++, off += chunk) {
        const part = bytes.subarray(off, Math.min(off + chunk, size));
        const r = decodeWritePartial((await this.request(OP.DATA_WRITE_PARTIAL, argsWritePartial(open.handle, idx, part), auth, wt)).payload);
        if (!r.ok) throw new Error(`DataWritePartial[${idx}] rejected: ${r.error}`);
        // Observed on hardware: the reply's len is the CUMULATIVE number of bytes received after this chunk.
        sent += part.length;
        if (r.handle !== open.handle || r.index !== idx || r.len !== sent) {
          throw new Error(`DataWritePartial[${idx}]: unexpected reply (handle ${r.handle}, index ${r.index}, len ${r.len}, expected cumulative ${sent})`);
        }
        if (onProgress) onProgress(sent, size);
      }
    } catch (e) { primary = e; }
    let closeErr = null;
    try {
      const c = decodeWriteClose((await this.request(OP.DATA_WRITE_CLOSE, argsWriteClose(open.handle, 1), auth, wt)).payload);
      if (!c.ok) closeErr = new Error(`DataWriteClose rejected: ${c.error}`);
      else if (c.handle !== open.handle || c.total !== size) closeErr = new Error(`DataWriteClose: unexpected reply (handle ${c.handle}, total ${c.total}, expected total bytes ${size})`);
    } catch (e) { closeErr = e; }
    if (primary) {
      primary.closeSent = true; primary.closeError = closeErr ? closeErr.message : null; primary.partialWrite = true;
      if (closeErr) primary.message += ` (DataWriteClose also failed: ${closeErr.message})`;
      throw primary;
    }
    if (closeErr) throw Object.assign(closeErr, { closeSent: true, partialWrite: true });
    if (onProgress) onProgress(size, size);

    const after = decodeDataList((await this.request(OP.DATA_LIST, argsDataList('/projects', slot, slot + 1))).payload);
    const e1 = after.ok ? after.entries.find((x) => x.type === 2 && x.index === slot) : null;
    if (!e1 || !e1.used) throw new Error(`slot ${slot} does not show as used after the write`);

    let verified = null;
    let mismatches = [];
    let rawIdentical = null;
    if (verify) {
      let back;
      try { back = await this.readFile(path); } catch (e) { throw Object.assign(new Error(`wrote slot ${slot} but read-back failed: ${e.message}`), { writeCompleted: true }); }
      // The device decompresses and re-compresses on store, so the stored bytes can legitimately differ from the
      // written ones. Fast path: raw-equal ignoring the slot field; otherwise compare the decoded project images.
      rawIdentical = diffIgnoringSlotField(bytes, back).length === 0;
      if (rawIdentical) verified = true;
      else {
        let imgA; let imgB;
        try { imgA = decodePayloadImage(bytes); imgB = decodePayloadImage(back); } catch (e) {
          return { slot, path, name: e1.name, size, verified: false, mismatches: [], rawIdentical, readbackSize: back.length, imageError: e.message };
        }
        mismatches = diffImages(imgA, imgB);
        verified = mismatches.length === 0;
      }
    }
    return { slot, path, name: e1.name, size, verified, mismatches, rawIdentical };
  }
}
