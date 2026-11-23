// Run: node --test synpat/web/tests/rpc.test.mjs
// Fixtures in fixtures/syntakt-replies.json are REAL replies captured from a Syntakt (fw strings 0097/1.42)
// with /tmp/xfer-re/probe.py (read-only requests only). Request frames are byte-compared to probe.py output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import {
  READ_ONLY_OPCODES, pack7, unpack7, buildFrame, parseFrame, argsQuery, argsDataList,
  decodePing, decodeSoftwareVersion, decodeDeviceUid, decodeStorageSpace, decodeQuery, decodeDataList,
  ElektronRpc, OP, concat, HEADER, crc32e, WRITE_OPCODES, validatePayload, decodePayloadImage, diffImages, diffIgnoringSlotField, argsWriteOpen, argsWritePartial, argsWriteClose, decodeWriteOpen, decodeWritePartial, decodeWriteClose, decodeReadOpen, decodeReadPartial, decodeReadClose, argsReadOpen, argsReadPartial, argsReadClose,
} from '../static/elektron-rpc.js';

const H = (s) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const enc = new TextEncoder();
const cs = (s) => concat(enc.encode(s), Uint8Array.of(0));
const u32 = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u64 = (v) => concat(u32(Number(BigInt(v) >> 32n)), u32(Number(BigInt(v) & 0xffffffffn)));
// reply builder (response opcodes are not in the request whitelist, so build by hand)
const reply = (seq, op, payload) =>
  concat(HEADER, pack7(concat(Uint8Array.of(seq >> 8, seq & 255, 0, 0, op), payload)), Uint8Array.of(0xF7));

test('pack7/unpack7 round trip for lengths 0..40 incl. MSB patterns', () => {
  for (let n = 0; n <= 40; n++) {
    for (const f of [(i) => i * 37 + 5, () => 0xff, () => 0x00, (i) => (i % 2 ? 0x80 : 0x7f)]) {
      const src = Uint8Array.from({ length: n }, (_, i) => f(i) & 255);
      const p = pack7(src);
      assert.ok(p.every((b) => b < 0x80), 'all packed bytes are 7-bit');
      assert.equal(p.length, n + Math.ceil(n / 7));
      assert.deepEqual(unpack7(p), src);
    }
  }
});

test('pack7 known vectors (first byte carries MSBs, bit6 = byte 0)', () => {
  assert.deepEqual(pack7(H('80 00 00 00 00 00 00')), H('40 00 00 00 00 00 00 00'));
  assert.deepEqual(pack7(H('00 00 00 00 00 00 80')), H('01 00 00 00 00 00 00 00'));
  assert.deepEqual(pack7(H('ff')), H('40 7f'));
  assert.deepEqual(pack7(H('81 a3')), H('60 01 23'));
  assert.deepEqual(unpack7(H('40 01 23')), H('81 23'));
  assert.deepEqual(unpack7(H('60 01 23')), H('81 a3'));
  assert.deepEqual(unpack7(new Uint8Array(0)), new Uint8Array(0));
});

// Byte-for-byte frames produced by /tmp/xfer-re/probe.py --dry-run (seq 0x8123)
test('frame construction matches probe.py bytes', () => {
  const S = 0x8123;
  assert.equal(hex(buildFrame(S, OP.PING)), 'f0 00 20 3c 10 00 40 01 23 00 00 01 f7');
  assert.equal(hex(buildFrame(S, OP.SOFTWARE_VERSION)), 'f0 00 20 3c 10 00 40 01 23 00 00 02 f7');
  assert.equal(hex(buildFrame(S, OP.DEVICE_UID)), 'f0 00 20 3c 10 00 40 01 23 00 00 03 f7');
  assert.equal(hex(buildFrame(S, OP.QUERY, argsQuery('midi.rpc_file_chunk_size_max'))),
    'f0 00 20 3c 10 00 40 01 23 00 00 09 6d 69 00 64 69 2e 72 70 63 5f 00 66 69 6c 65 5f 63 68 00 75 6e 6b 5f 73 69 7a 00 65 5f 6d 61 78 00 f7');
  assert.equal(hex(buildFrame(S, OP.DATA_LIST, argsDataList('/projects', 0, 0, false))),
    'f0 00 20 3c 10 00 40 01 23 00 00 53 2f 70 00 72 6f 6a 65 63 74 73 00 00 00 00 00 00 00 00 00 00 00 00 f7');
});

test('parseFrame inverts buildFrame', () => {
  const m = parseFrame(buildFrame(0x8123, OP.QUERY, argsQuery('x.y')));
  assert.equal(m.seq, 0x8123); assert.equal(m.opcode, OP.QUERY); assert.equal(m.field2, 0);
  assert.deepEqual(m.payload, cs('x.y'));
});

test('whitelist is exactly the eight read-only opcodes and buildFrame refuses others', () => {
  assert.deepEqual([...READ_ONLY_OPCODES].sort((a, b) => a - b), [1, 2, 3, 9, 0x53, 0x54, 0x55, 0x56]);
  for (const op of [0x04, 0x05, 0x06, 0x07, 0x24, 0x40, 0x50, 0x51, 0x52, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x81, 0xd3]) {
    assert.throws(() => buildFrame(1, op), /refusing/);
  }
});

test('request() rejects non-whitelisted opcodes without sending', async () => {
  const sent = [];
  const rpc = new ElektronRpc({ input: fakeInput(), output: { send: (f) => sent.push(f) } });
  for (const op of [0x05, 0x57, 0x58, 0x59, 0x24, 0x50, 0x5c]) await assert.rejects(rpc.request(op), /refusing/);
  assert.equal(sent.length, 0);
});

// ---- real captured replies
const FX = Object.fromEntries(Object.entries(JSON.parse(readFileSync(new URL('./fixtures/syntakt-replies.json', import.meta.url), 'utf8')))
  .map(([k, v]) => [k, H(v)]));
// replay a captured reply for a different request seq: only the echo u16 (B) is rewritten, payload untouched
const withEcho = (frame, echo) => {
  const m = parseFrame(frame);
  return concat(HEADER, pack7(concat(Uint8Array.of(m.a >> 8, m.a & 255, echo >> 8, echo & 255, m.opcode), m.payload)), Uint8Array.of(0xF7));
};

test('real replies: header = device counter (A) + echo of request seq (B); opcode = request|0x80', () => {
  const ping = parseFrame(FX.ping);
  assert.equal(ping.opcode, 0x81); assert.equal(ping.echo, 1);
  assert.equal(parseFrame(FX.version).echo, 2); assert.equal(parseFrame(FX.uid).echo, 3);
  assert.equal(parseFrame(FX.list_projects).opcode, 0xd3);
  assert.equal(parseFrame(FX.version).a, parseFrame(FX.ping).a + 1); // device counter increments
});

test('decodePing (real): opcode list and name', () => {
  const d = decodePing(parseFrame(FX.ping).payload);
  assert.equal(d.byte0, 0x1e); assert.equal(d.name, 'Syntakt');
  assert.deepEqual(d.supportedOpcodes, [0x01, 0x02, 0x03, 0x04, 0x06, 0x07, 0x09, 0x50, 0x52, 0x51, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e]);
  assert.equal(d.supportedOpcodes.includes(0x05), false); // StorageSpace not implemented
});
test('decodeSoftwareVersion / deviceUid (real)', () => {
  const v = decodeSoftwareVersion(parseFrame(FX.version).payload);
  assert.deepEqual(v.strings, ['0097', '1.42']); assert.equal(v.version, '1.42'); assert.equal(v.build, '0097');
  assert.equal(decodeDeviceUid(parseFrame(FX.uid).payload).uid, 0x12345678);
});
test('decodeQuery (real): chunk size, unknown keys, extensions', () => {
  const q = (k) => decodeQuery(parseFrame(FX[k]).payload);
  assert.deepEqual(q('q_chunk'), { ok: true, type: 3, value: 32768 });
  for (const k of ['q_stereo', 'q_mono', 'q_rates', 'q_swap', 'q_kitext']) assert.deepEqual(q(k), { ok: false, type: 0, value: null });
  assert.deepEqual(q('q_projext'), { ok: true, type: 4, value: '.stprj' });
  assert.deepEqual(q('q_presetext'), { ok: true, type: 4, value: '.stsnd' });
});
test('decodeStorageSpace (layout from Transfer only; Syntakt never replies) [UNOBSERVED]', () => {
  const d = decodeStorageSpace(concat(Uint8Array.of(1), u64(123456789n), u64(2n ** 33n)));
  assert.equal(d.a, 123456789n); assert.equal(d.b, 2n ** 33n);
});
test('decodeQuery bool/u64 types (from Transfer parser) [UNOBSERVED]', () => {
  assert.deepEqual(decodeQuery(Uint8Array.of(1, 1)), { ok: true, type: 1, value: true });
  assert.equal(decodeQuery(concat(Uint8Array.of(2), u64(32768))).value, 32768);
});

test('decodeDataList (real /projects): 128 slots, range echo, names, empties', () => {
  const d = decodeDataList(parseFrame(FX.list_projects).payload);
  assert.equal(d.ok, true); assert.equal(d.a, 0); assert.equal(d.b, 129); assert.equal(d.count, 128); assert.equal(d.entries.length, 128);
  assert.deepEqual(d.entries.map((e) => e.index), Array.from({ length: 128 }, (_, i) => i + 1));
  const byIdx = (i) => d.entries[i - 1];
  assert.equal(byIdx(28).name, 'BORN SLIPPY'); assert.equal(byIdx(1).name, 'PRESETS'); assert.equal(byIdx(3).name, 'CAE=#');
  assert.equal(byIdx(33).name, 'SET - HOUSE'); assert.equal(byIdx(40).name, 'PPRFC TOUR');
  for (const i of [2, 13, 18, 22, 34, 128]) { assert.equal(byIdx(i).name, ''); assert.equal(byIdx(i).used, false); assert.equal(byIdx(i).b2b, false); }
  assert.ok(d.entries.every((e) => e.type === 2 && e.capacity === 4194304));
  assert.deepEqual(d.entries.filter((e) => e.flags28 === 18).map((e) => e.index), [1, 6]);
  assert.equal(d.entries.filter((e) => e.used).length, 30);
});
test('decodeDataList (real single slot): range (28,29) echoed, one entry', () => {
  const d = decodeDataList(parseFrame(FX.list_projects_28_29).payload);
  assert.deepEqual([d.a, d.b, d.count], [28, 29, 1]);
  assert.equal(d.entries[0].name, 'BORN SLIPPY'); assert.equal(d.entries[0].index, 28);
});
test('decodeDataList error reply', () => {
  const r = decodeDataList(concat(Uint8Array.of(0), cs('nope')));
  assert.equal(r.ok, false); assert.equal(r.error, 'nope');
});
test('single-slot request frame (Transfer paging args n, n+1)', () => {
  assert.equal(hex(buildFrame(1, OP.DATA_LIST, argsDataList('/projects', 28, 29))),
    'f0 00 20 3c 10 00 00 00 01 00 00 53 2f 70 00 72 6f 6a 65 63 74 73 00 00 00 00 00 1c 00 00 00 00 1d 00 f7');
});

// ---- client with fake WebMIDI
function fakeInput() {
  const L = new Set();
  return { addEventListener: (t, f) => { assert.equal(t, 'midimessage'); L.add(f); }, removeEventListener: (t, f) => L.delete(f),
    emit: (data) => L.forEach((f) => f({ data })), listeners: L };
}
// respond(parsedRequest) -> array of frames/MIDI messages to emit in answer
function rig(respond) {
  const input = fakeInput();
  const output = { sent: [], send(f) { this.sent.push(f); const m = parseFrame(f); const r = respond(m); if (r) queueMicrotask(() => r.forEach((d) => input.emit(d))); } };
  const rpc = new ElektronRpc({ input, output, timeoutMs: 200 });
  rpc.start();
  return { rpc, input, output };
}
const FOREIGN = H('f0 7e 00 7c 00 f7'); // seen on the real device right after Ping

test('start/stop use addEventListener only and never assign onmidimessage', () => {
  const input = fakeInput();
  const rpc = new ElektronRpc({ input, output: { send() {} } });
  rpc.start(); assert.equal(input.listeners.size, 1); assert.equal('onmidimessage' in input, false);
  rpc.stop(); assert.equal(input.listeners.size, 0);
});

test('ping with real reply; ignores Program Change, foreign sysex, stale echo; caches opcode list', async () => {
  const { rpc, input } = rig((m) => [Uint8Array.of(0xC0, 5), FOREIGN, withEcho(FX.ping, m.a + 7), withEcho(FX.ping, m.a)]);
  const r = await rpc.ping();
  assert.equal(r.name, 'Syntakt'); assert.equal(r.supportedOpcodes.length, 22); assert.ok(r.raw instanceof Uint8Array);
  assert.deepEqual(rpc.supportedOpcodes, r.supportedOpcodes);
  rpc.stop(); input.emit(Uint8Array.of(0xC0, 1));
});

test('softwareVersion, deviceUid, query round trips with real replies', async () => {
  const map = { 0x02: FX.version, 0x03: FX.uid };
  const { rpc } = rig((m) => [withEcho(m.opcode === 9 ? FX.q_chunk : map[m.opcode], m.a)]);
  assert.equal((await rpc.softwareVersion()).version, '1.42');
  assert.equal((await rpc.deviceUid()).uid, 0x12345678);
  assert.equal((await rpc.query('midi.rpc_file_chunk_size_max')).value, 32768);
});

test('storageSpace is refused without sending anything', async () => {
  const { rpc, output } = rig((m) => [withEcho(FX.ping, m.a)]);
  await assert.rejects(rpc.storageSpace(), /not supported by this device/);
  assert.equal(output.sent.length, 0);
});
test('opcodes the device did not list in Ping are rejected without sending (after ping)', async () => {
  const { rpc, output } = rig((m) => [withEcho(FX.ping, m.a)]);
  await rpc.ping();
  rpc.supportedOpcodes = rpc.supportedOpcodes.filter((o) => o !== 0x54);
  await assert.rejects(rpc.request(0x54, argsReadOpen('/projects/28')), /not supported by this device/);
  assert.deepEqual(output.sent.map((f) => parseFrame(f).opcode), [0x01]);
});

test('sysex split across events is reassembled', async () => {
  const { rpc } = rig((m) => { const f = withEcho(FX.uid, m.a); return [f.subarray(0, 5), f.subarray(5, 9), f.subarray(9)]; });
  assert.equal((await rpc.deviceUid()).uid, 0x12345678);
});

test('timeout rejects', async () => {
  const { rpc } = rig(() => null);
  await assert.rejects(rpc.ping(), /timeout/);
});

test('listProjects from real DataList reply: 1-based slots, names, empties; sends DataList(/projects,0,0)', async () => {
  const { rpc, output } = rig((m) => [withEcho(FX.list_projects, m.a)]);
  const list = await rpc.listProjects();
  assert.equal(list.length, 128);
  assert.deepEqual(list[27], { slot: 28, path: '/projects/28', name: 'BORN SLIPPY', size: null, capacity: 4194304, empty: false });
  assert.equal(list[0].slot, 1); assert.equal(list[127].slot, 128);
  assert.deepEqual(list.filter((p) => p.empty).length, 98);
  assert.deepEqual(list.filter((p) => !p.empty).map((p) => p.slot).slice(0, 4), [1, 3, 4, 5]);
  assert.equal(hex(output.sent[0]), hex(buildFrame(1, OP.DATA_LIST, argsDataList('/projects', 0, 0))));
});

test('error reply from DataList throws from listDir', async () => {
  const { rpc } = rig((m) => [reply(m.a, 0xd3, concat(Uint8Array.of(0), cs('no such dir')))].map((f) => withEcho(f, m.a)));
  await assert.rejects(rpc.listDir('/nope'), /no such dir/);
});

// ================= file reads (real frames from /tmp/xfer-re/probe.py --read /projects/28) =================
test('real read frames decode: open, chunk 0 (empty prepare chunk), last chunk, close', () => {
  const o = decodeReadOpen(parseFrame(FX.read_open).payload);
  assert.deepEqual(o, { ok: true, handle: 114, chunkSize: 2048, flag: true });
  const c0 = decodeReadPartial(parseFrame(FX.read_first).payload);
  assert.equal(c0.ok, true); assert.equal(c0.handle, 114); assert.equal(c0.len, 0); assert.equal(c0.last, false);
  assert.equal(c0.crc, 0xffffffff); assert.equal(crc32e(c0.data), c0.crc);
  const cl = decodeReadPartial(parseFrame(FX.read_last).payload);
  assert.equal(cl.last, true); assert.equal(cl.len, 1684); assert.equal(cl.b, 14); assert.equal(cl.c, 1000);
  assert.equal(crc32e(cl.data), cl.crc); assert.equal(cl.crc, 154726129);
  assert.equal(crc32(cl.data, 0xffffffff) >>> 0, cl.crc); // node's zlib agrees: crc32e == zlib.crc32(data, 0xFFFFFFFF)
  assert.equal(hex(cl.data.subarray(-4)), 'aa a1 da aa'); // stprj trailer magic
  assert.deepEqual(decodeReadClose(parseFrame(FX.read_close).payload), { ok: true, handle: 114, total: 28308 });
});

test('read request frames (byte-exact, seq 0x8123, same bytes as probe.py)', () => {
  assert.equal(hex(buildFrame(0x8123, OP.DATA_READ_OPEN, argsReadOpen('/projects/28'))),
    'f0 00 20 3c 10 00 40 01 23 00 00 54 2f 70 00 72 6f 6a 65 63 74 73 00 2f 32 38 00 00 00 08 00 00 01 f7');
  assert.equal(hex(buildFrame(0x8123, OP.DATA_READ_PARTIAL, argsReadPartial(7, 0))), 'f0 00 20 3c 10 00 40 01 23 00 00 55 00 00 00 00 07 00 00 00 00 f7');
  assert.equal(hex(buildFrame(0x8123, OP.DATA_READ_CLOSE, argsReadClose(7))), 'f0 00 20 3c 10 00 40 01 23 00 00 56 00 00 00 00 07 f7');
});

// 13 synthetic 2048-byte data chunks (indices 1..13) between the real chunk 0 and the real last chunk (index 14):
// 13*2048 + 1684 = 28308 = the real ReadClose total.
const synthData = (i) => Uint8Array.from({ length: 2048 }, (_, k) => (i * 31 + k * 7 + (k >> 5)) & 255);
const partialReply = (echo, i, data, { last = false, badCrc = false } = {}) => {
  const crc = (crc32(data, 0xffffffff) >>> 0) ^ (badCrc ? 1 : 0);
  const payload = concat(Uint8Array.of(1), u32(114), u32(i), u32(990 + i), Uint8Array.of(last ? 1 : 0), u32(crc >>> 0), u32(data.length), data);
  return withEcho(reply(0x4400 + i, 0xd5, payload), echo);
};
function readDevice({ failAt = -1, badCrcAt = -1, closeTotal = 28308, openOk = true } = {}) {
  const lastData = decodeReadPartial(parseFrame(FX.read_last).payload).data;
  const log = [];
  const respond = (m) => {
    log.push(m.opcode);
    if (m.opcode === 0x54) return [openOk ? withEcho(FX.read_open, m.a) : withEcho(reply(0x4400, 0xd4, concat(Uint8Array.of(0), cs('busy'))), m.a)];
    if (m.opcode === 0x56) return [m.payload.length === 4 ? withEcho(closeTotal === 28308 ? FX.read_close : reply(0x4400, 0xd6, concat(Uint8Array.of(1), u32(114), u32(closeTotal))), m.a) : null];
    if (m.opcode === 0x55) {
      const i = (m.payload[4] << 24 | m.payload[5] << 16 | m.payload[6] << 8 | m.payload[7]) >>> 0;
      if (i === failAt) return [withEcho(reply(0x4400, 0xd5, concat(Uint8Array.of(0), cs('read error'))), m.a)];
      if (i === 0) return [withEcho(FX.read_first, m.a)];
      if (i === 14) return [withEcho(FX.read_last, m.a)];
      return [partialReply(m.a, i, synthData(i), { badCrc: i === badCrcAt })];
    }
    return null;
  };
  return { respond, log, expected: concat(...Array.from({ length: 13 }, (_, k) => synthData(k + 1)), lastData) };
}

test('readFile: full verified sequence, progress, byte-exact reassembly, close sent last', async () => {
  const dev = readDevice();
  const { rpc } = rig(dev.respond);
  const prog = [];
  const bytes = await rpc.readFile('/projects/28', { onProgress: (d, t) => prog.push([d, t]) });
  assert.equal(bytes.length, 28308);
  assert.deepEqual(bytes, dev.expected);
  assert.deepEqual(dev.log, [0x54, ...Array(15).fill(0x55), 0x56]);
  assert.deepEqual(prog.at(-1), [28308, 28308]); assert.equal(prog[0][0], 0); assert.equal(prog[0][1], null);
  assert.equal(prog.at(-2)[0], 28308);
});

test('readFile: CRC mismatch aborts but still sends DataReadClose', async () => {
  const dev = readDevice({ badCrcAt: 5 });
  const { rpc } = rig(dev.respond);
  await assert.rejects(rpc.readFile('/projects/28'), /chunk 5: CRC mismatch/);
  assert.equal(dev.log.at(-1), 0x56); assert.equal(dev.log.filter((o) => o === 0x55).length, 6);
});
test('readFile: device error mid-read aborts but still closes', async () => {
  const dev = readDevice({ failAt: 3 });
  const { rpc } = rig(dev.respond);
  await assert.rejects(rpc.readFile('/projects/28'), /read error/);
  assert.equal(dev.log.at(-1), 0x56);
});
test('readFile: timeout mid-read still attempts DataReadClose', async () => {
  const dev = readDevice();
  const { rpc, output } = rig((m) => (m.opcode === 0x55 && m.payload[7] === 2 ? null : dev.respond(m)));
  await assert.rejects(rpc.readFile('/projects/28'), /timeout/);
  assert.equal(parseFrame(output.sent.at(-1)).opcode, 0x56);
});
test('readFile: ReadOpen failure sends no ReadClose (nothing was opened)', async () => {
  const dev = readDevice({ openOk: false });
  const { rpc } = rig(dev.respond);
  await assert.rejects(rpc.readFile('/projects/28'), /busy/);
  assert.deepEqual(dev.log, [0x54]);
});
test('readFile: size mismatch reported by ReadClose is an error', async () => {
  const dev = readDevice({ closeTotal: 28307 });
  const { rpc } = rig(dev.respond);
  await assert.rejects(rpc.readFile('/projects/28'), /size mismatch/);
});

test('readProject(28): single-slot DataList (28,29) then read; returns slot, path, name, bytes', async () => {
  const dev = readDevice();
  const { rpc, output } = rig((m) => (m.opcode === 0x53 ? [withEcho(FX.list_projects_28_29, m.a)] : dev.respond(m)));
  const r = await rpc.readProject(28);
  assert.deepEqual([r.slot, r.path, r.name, r.bytes.length], [28, '/projects/28', 'BORN SLIPPY', 28308]);
  assert.equal(hex(output.sent[0]), hex(buildFrame(1, OP.DATA_LIST, argsDataList('/projects', 28, 29))));
});
test('readProject: empty slot is refused before any read', async () => {
  const entry = concat(cs(''), Uint8Array.of(0, 2), u32(2), u32(4194304), Uint8Array.of(0, 126, 0, 0));
  const { rpc, output } = rig((m) => [reply(m.a, 0xd3, concat(Uint8Array.of(1), u32(2), u32(3), u32(1), entry))].map((f) => withEcho(f, m.a)));
  await assert.rejects(rpc.readProject(2), /slot 2 is empty/);
  assert.deepEqual(output.sent.map((f) => parseFrame(f).opcode), [0x53]);
});

// ================= guarded write (real frames from /tmp/xfer-re/probe_write128.txt, the slot-128 write) =================
const withSeq = (frame, seq) => {
  const m = parseFrame(frame);
  return concat(HEADER, pack7(concat(Uint8Array.of(seq >> 8, seq & 255, m.b >> 8, m.b & 255, m.opcode), m.payload)), Uint8Array.of(0xF7));
};
// the exact payload that was written on the device = data inside the real WritePartial request frame
const PAYLOAD = Uint8Array.from(parseFrame(FX.w_partial_tx).payload.subarray(16));
const READBACK = Uint8Array.from(PAYLOAD); READBACK[0x18] = 0x7f; // the device stamps slot 128 -> 0-based 127 into the header

test('write opcodes / validatePayload on the real payload', () => {
  assert.deepEqual([...WRITE_OPCODES].sort(), [0x57, 0x58, 0x59]);
  assert.equal(PAYLOAD.length, 28308);
  assert.deepEqual(validatePayload(PAYLOAD), { version: 12, slot0: 27, decompressedSize: 4089348 });
  assert.deepEqual(validatePayload(READBACK), { version: 12, slot0: 127, decompressedSize: 4089348 }); // slot field is not checksummed
});
test('validatePayload rejects bad magic, bad CRC, bad area length, truncation, broken block chain', () => {
  const mod = (f) => { const b = Uint8Array.from(PAYLOAD); f(b); return b; };
  assert.throws(() => validatePayload(mod((b) => { b[0] ^= 1; })), /header magic/);
  assert.throws(() => validatePayload(mod((b) => { b[b.length - 1] ^= 1; })), /trailer magic/);
  assert.throws(() => validatePayload(mod((b) => { b[5000] ^= 1; })), /CRC mismatch/);
  assert.throws(() => validatePayload(mod((b) => { b[b.length - 5] ^= 1; })), /area length/);
  assert.throws(() => validatePayload(PAYLOAD.subarray(0, 20)), /too short/);
  assert.throws(() => validatePayload('nope'), /Uint8Array/);
  // consistent CRC/length but chain that does not end at the terminator:
  const b = Uint8Array.from(PAYLOAD); const area = b.subarray(31, b.length - 12); area[area.length - 1] = 1; // terminator length field becomes 1
  const crc = crc32(area, 0xffffffff) >>> 0; new DataView(b.buffer).setUint32(b.length - 12, crc);
  assert.throws(() => validatePayload(b), /block chain/);
});
test('diffIgnoringSlotField ignores 0x15..0x18 only', () => {
  assert.deepEqual(diffIgnoringSlotField(PAYLOAD, READBACK), []);
  const x = Uint8Array.from(READBACK); x[0x14] ^= 1; x[0x19] ^= 1; x[100] ^= 1;
  assert.deepEqual(diffIgnoringSlotField(PAYLOAD, x), [0x14, 0x19, 100]);
  assert.deepEqual(diffIgnoringSlotField(PAYLOAD, READBACK.subarray(0, 28306)), [28306, 28307]);
});
test('write reply decoders on real replies', () => {
  assert.deepEqual(decodeWriteOpen(parseFrame(FX.w_open_rx).payload), { ok: true, handle: 115 });
  assert.deepEqual(decodeWritePartial(parseFrame(FX.w_partial_rx).payload), { ok: true, handle: 115, index: 0, len: 28308 });
  assert.deepEqual(decodeWriteClose(parseFrame(FX.w_close_rx).payload), { ok: true, handle: 115, total: 28308 });
  assert.deepEqual(decodeWritePartial(concat(Uint8Array.of(0), cs('flash full'))), { ok: false, error: 'flash full' });
});

const q8192 = (echo) => withEcho(reply(0x4400, 0x89, concat(Uint8Array.of(3), u64(8192n))), echo);
// Fake Syntakt for the slot-128 write: real frames wherever a real reply exists, synthetic only for read-back chunks 2..14
function writeDevice({ slot = 128, nonEmpty = false, partialError = null, partialEchoIndex = null, closeError = null, openError = null, chunkQuery = null, corruptRb = -1 } = {}) {
  const log = []; const rb = Uint8Array.from(READBACK); if (corruptRb >= 0) rb[corruptRb] ^= 0xff;
  let written = false; let cum = 0;
  const rbChunk = (i, echo) => {
    const data = rb.subarray((i - 1) * 2048, Math.min(i * 2048, rb.length)); const last = i === 14;
    const payload = concat(Uint8Array.of(1), u32(116), u32(i), u32(990 + i), Uint8Array.of(last ? 1 : 0), u32(crc32(data, 0xffffffff) >>> 0), u32(data.length), data);
    return withEcho(reply(0x4500 + i, 0xd5, payload), echo);
  };
  const respond = (m) => {
    log.push({ op: m.opcode, payload: m.payload });
    switch (m.opcode) {
      case 0x01: return [withEcho(FX.ping, m.a)];
      case 0x09: return [chunkQuery ? chunkQuery(m.a) : withEcho(FX.q_chunk, m.a)];
      case 0x53: return [withEcho(nonEmpty ? FX.list_projects_28_29 : (written ? FX.w_list_after : FX.w_list_before), m.a)];
      case 0x57: return [openError ? withEcho(reply(0x4400, 0xd7, concat(Uint8Array.of(0), cs(openError))), m.a) : withEcho(FX.w_open_rx, m.a)];
      case 0x58: {
        if (partialError) return [withEcho(reply(0x4400, 0xd8, concat(Uint8Array.of(0), cs(partialError))), m.a)];
        const idx = (m.payload[4] << 24 | m.payload[5] << 16 | m.payload[6] << 8 | m.payload[7]) >>> 0;
        const len = (m.payload[12] << 24 | m.payload[13] << 16 | m.payload[14] << 8 | m.payload[15]) >>> 0;
        if (m.payload.length === 16 + 28308 && !chunkQuery && partialEchoIndex === null) return [withEcho(FX.w_partial_rx, m.a)];
        return [withEcho(reply(0x4400, 0xd8, concat(Uint8Array.of(1), u32(115), u32(partialEchoIndex ?? idx), u32(cum += len))), m.a)];
      }
      case 0x59: written = true;
        return [closeError ? withEcho(reply(0x4400, 0xd9, concat(Uint8Array.of(0), cs(closeError))), m.a) : withEcho(FX.w_close_rx, m.a)];
      case 0x54: return [withEcho(FX.w_rb_open, m.a)];
      case 0x55: { const i = (m.payload[4] << 24 | m.payload[5] << 16 | m.payload[6] << 8 | m.payload[7]) >>> 0;
        return [i === 0 ? withEcho(FX.w_rb_chunk0, m.a) : (i === 1 && corruptRb < 0 ? withEcho(FX.w_rb_chunk1, m.a) : rbChunk(i, m.a))]; }
      case 0x56: return [withEcho(FX.w_rb_close, m.a)];
      default: return null;
    }
  };
  return { respond, log, ops: () => log.map((l) => l.op) };
}

test('real read-back chunk 1 agrees with the derived read-back image (header slot byte 0x7f)', () => {
  const c1 = decodeReadPartial(parseFrame(FX.w_rb_chunk1).payload);
  assert.deepEqual(c1.data, READBACK.subarray(0, 2048)); assert.equal(c1.data[0x18], 0x7f);
});

test('writeProject(128): byte-exact WriteOpen/WritePartial/WriteClose frames (seq aside), full sequence, verified', async () => {
  const dev = writeDevice();
  const { rpc, output } = rig(dev.respond);
  const prog = [];
  const r = await rpc.writeProject(128, PAYLOAD, { onProgress: (d, t) => prog.push([d, t]) });
  assert.deepEqual(r, { slot: 128, path: '/projects/128', name: 'BORN SLIPPY', size: 28308, verified: true, mismatches: [], rawIdentical: true });
  assert.deepEqual(dev.ops(), [0x01, 0x09, 0x53, 0x57, 0x58, 0x59, 0x53, 0x54, ...Array(15).fill(0x55), 0x56]);
  const frame = (op) => output.sent.find((f) => parseFrame(f).opcode === op);
  assert.equal(hex(withSeq(frame(0x57), 4)), hex(FX.w_open_tx));
  assert.equal(hex(withSeq(frame(0x58), 5)), hex(FX.w_partial_tx));
  assert.equal(hex(withSeq(frame(0x59), 6)), hex(FX.w_close_tx));
  assert.deepEqual(prog, [[28308, 28308], [28308, 28308]]);
  // pre-write checks: slot re-listed with the single-slot range (128,129)
  assert.equal(hex(output.sent[2]), hex(buildFrame(3, OP.DATA_LIST, argsDataList('/projects', 128, 129))));
});

test('writeProject verify:false does not read back; verify detects a corrupted read-back', async () => {
  const d1 = writeDevice(); const r1 = await rig(d1.respond).rpc.writeProject(128, PAYLOAD, { verify: false });
  assert.equal(r1.verified, null); assert.deepEqual(r1.mismatches, []); assert.deepEqual(d1.ops(), [0x01, 0x09, 0x53, 0x57, 0x58, 0x59, 0x53]);
  const d2 = writeDevice({ corruptRb: 5000 }); const r2 = await rig(d2.respond).rpc.writeProject(128, PAYLOAD);
  assert.equal(r2.verified, false); assert.equal(r2.rawIdentical, false); assert.match(r2.imageError, /CRC mismatch/); // corrupt read-back no longer decodes
});

test('writeProject refuses a non-empty slot: nothing but Ping/Query/DataList is sent', async () => {
  const dev = writeDevice({ nonEmpty: true });
  const { rpc, output } = rig(dev.respond);
  await assert.rejects(rpc.writeProject(28, PAYLOAD), /not empty \("BORN SLIPPY"\)/);
  assert.deepEqual(dev.ops(), [0x01, 0x09, 0x53]);
  assert.equal(output.sent.some((f) => [0x57, 0x58, 0x59].includes(parseFrame(f).opcode)), false);
});

test('writeProject refuses an invalid payload or slot before anything is sent', async () => {
  const bad = Uint8Array.from(PAYLOAD); bad[5000] ^= 1;
  for (const [slot, bytes, re] of [[128, bad, /CRC mismatch/], [128, PAYLOAD.subarray(0, 100), /too short|trailer/], [0, PAYLOAD, /invalid slot/], [129, PAYLOAD, /invalid slot/], [1.5, PAYLOAD, /invalid slot/], [128, 'x', /Uint8Array/]]) {
    const { rpc, output } = rig(() => null);
    await assert.rejects(rpc.writeProject(slot, bytes), re);
    assert.equal(output.sent.length, 0);
  }
});

test('plain request() refuses write opcodes, even with perfectly valid-looking arguments', async () => {
  const { rpc, output } = rig(() => null);
  const forged = { token: Symbol('elektron-rpc.write'), ctx: { allows: () => true } };
  await assert.rejects(rpc.request(0x57, argsWriteOpen('/projects/128', 28308)), /write opcode; refusing/);
  await assert.rejects(rpc.request(0x58, argsWritePartial(115, 0, new Uint8Array(4))), /write opcode; refusing/);
  await assert.rejects(rpc.request(0x59, argsWriteClose(115, 1)), /write opcode; refusing/);
  await assert.rejects(rpc.request(0x57, argsWriteOpen('/projects/128', 28308), forged), /write opcode; refusing/);
  assert.equal(output.sent.length, 0);
  assert.throws(() => buildFrame(1, 0x57), /refusing/);
});

test('writeProject: WriteClose is sent after a WritePartial error, with the device error string; no retry', async () => {
  const dev = writeDevice({ partialError: 'flash full' });
  const { rpc } = rig(dev.respond);
  const err = await rpc.writeProject(128, PAYLOAD).catch((e) => e);
  assert.match(err.message, /DataWritePartial\[0\] rejected: flash full/); assert.equal(err.closeSent, true); assert.equal(err.partialWrite, true);
  assert.deepEqual(dev.ops(), [0x01, 0x09, 0x53, 0x57, 0x58, 0x59]); // exactly one partial, then close, no read-back
});
test('writeProject: unexpected partial echo stops and closes; WriteOpen rejection sends no close', async () => {
  const d1 = writeDevice({ partialEchoIndex: 7 });
  await assert.rejects(rig(d1.respond).rpc.writeProject(128, PAYLOAD), /unexpected reply/);
  assert.equal(d1.ops().at(-1), 0x59);
  const d2 = writeDevice({ openError: 'no space' });
  await assert.rejects(rig(d2.respond).rpc.writeProject(128, PAYLOAD), /rejected: no space/);
  assert.deepEqual(d2.ops(), [0x01, 0x09, 0x53, 0x57]);
});
test('writeProject: WriteClose failure is an error and skips read-back', async () => {
  const dev = writeDevice({ closeError: 'close failed' });
  await assert.rejects(rig(dev.respond).rpc.writeProject(128, PAYLOAD), /DataWriteClose rejected: close failed/);
  assert.deepEqual(dev.ops(), [0x01, 0x09, 0x53, 0x57, 0x58, 0x59]);
});

test('writeProject uses the device chunk size: 8192 -> 4 WritePartials with indices 0..3, WriteClose count 1', async () => {
  const dev = writeDevice({ chunkQuery: q8192 });
  const { rpc } = rig(dev.respond);
  const r = await rpc.writeProject(128, PAYLOAD, { verify: false });
  assert.equal(r.size, 28308);
  const parts = dev.log.filter((l) => l.op === 0x58);
  assert.deepEqual(parts.map((l) => l.payload.length - 16), [8192, 8192, 8192, 3732]);
  assert.deepEqual(parts.map((l) => (l.payload[7])), [0, 1, 2, 3]);
  const close = dev.log.find((l) => l.op === 0x59).payload;
  assert.deepEqual(Array.from(close), [0, 0, 0, 115, 0, 0, 0, 1]);
  // each chunk carries crc32e of its own data
  for (const [i, l] of parts.entries()) {
    const data = l.payload.subarray(16); assert.equal(new DataView(l.payload.buffer, l.payload.byteOffset + 8, 4).getUint32(0), crc32(data, 0xffffffff) >>> 0, `chunk ${i}`);
  }
});

test('writeProject refuses when the device does not list the write opcodes', async () => {
  const noWrite = (m) => [withEcho(reply(0x4400, 0x81, concat(Uint8Array.of(0x1e, 3), Uint8Array.of(1, 2, 3), cs('Syntakt'))), m.a)];
  const { rpc, output } = rig(noWrite);
  await assert.rejects(rpc.writeProject(128, PAYLOAD), /does not support opcode 0x57/);
  assert.equal(output.sent.length, 1);
});

// ================= multi-chunk write on real hardware (slot 127, 2026-11-23) =================
// SENT = what we wrote (our own LZ4 compressor, 57233 B -> chunks 32768 + 24465); STORED = what the device holds
// afterwards (36051 B: the device decompresses and re-compresses on store). Both decode to the same 4,089,348 B image.
const MC = JSON.parse(readFileSync(new URL('./fixtures/multichunk-payloads.json', import.meta.url), 'utf8'));
const SENT = Uint8Array.from(Buffer.from(MC.sent, 'base64'));
const STORED = Uint8Array.from(Buffer.from(MC.stored, 'base64'));

test('multichunk fixtures: sizes, slot fields, validate, identical decoded images', () => {
  assert.equal(SENT.length, 57233); assert.equal(STORED.length, 36051);
  assert.equal(validatePayload(SENT).slot0, 26); assert.equal(validatePayload(STORED).slot0, 126);
  const t0 = performance.now();
  const a = decodePayloadImage(SENT), b = decodePayloadImage(STORED);
  const ms = performance.now() - t0;
  assert.equal(a.length, 4089348); assert.deepEqual(diffImages(a, b), []);
  assert.ok(ms < 2000, `two 4 MB decodes took ${ms} ms`);
  assert.ok(diffIgnoringSlotField(SENT, STORED).length > 1000); // raw bytes really differ
});
test('decodePayloadImage rejects corrupt envelopes; diffImages caps and reports', () => {
  const bad = Uint8Array.from(SENT); bad[5000] ^= 1;
  assert.throws(() => decodePayloadImage(bad), /CRC mismatch/);
  const a = new Uint8Array(100), b = new Uint8Array(100).fill(1);
  assert.equal(diffImages(a, b).length, 32); assert.equal(diffImages(a, b, 5).length, 5);
  assert.deepEqual(diffImages(new Uint8Array(3), new Uint8Array(5)), [3, 4]);
});

function listReply(echo, slot, name, used) {
  const entry = concat(cs(name), Uint8Array.of(0, 2), u32(slot), u32(4194304), Uint8Array.of(0, 126, used ? 1 : 0, used ? 1 : 0));
  return withEcho(reply(0x4400, 0xd3, concat(Uint8Array.of(1), u32(slot), u32(slot + 1), u32(1), entry)), echo);
}
function multiDevice({ cumulative = true, storedBytes = STORED, closeTotal = null } = {}) {
  const log = []; let written = false; let got = 0; const handle = 2;
  const respond = (m) => {
    log.push({ op: m.opcode, payload: m.payload });
    switch (m.opcode) {
      case 0x01: return [withEcho(FX.ping, m.a)];
      case 0x09: return [withEcho(FX.q_chunk, m.a)];
      case 0x53: return [listReply(m.a, 127, written ? 'PPRFC TOUR' : '', written)];
      case 0x57: return [withEcho(reply(0x4400, 0xd7, concat(Uint8Array.of(1), u32(handle))), m.a)];
      case 0x58: { const len = (m.payload[12] << 24 | m.payload[13] << 16 | m.payload[14] << 8 | m.payload[15]) >>> 0; got += len;
        return [withEcho(reply(0x4400, 0xd8, concat(Uint8Array.of(1), u32(handle), u32(m.payload[7]), u32(cumulative ? got : len))), m.a)]; }
      case 0x59: written = true; return [withEcho(reply(0x4400, 0xd9, concat(Uint8Array.of(1), u32(handle), u32(closeTotal ?? got))), m.a)];
      case 0x54: return [withEcho(reply(0x4400, 0xd4, concat(Uint8Array.of(1), u32(9), u32(2048), Uint8Array.of(1))), m.a)];
      case 0x55: { const i = (m.payload[4] << 24 | m.payload[5] << 16 | m.payload[6] << 8 | m.payload[7]) >>> 0;
        const data = i === 0 ? new Uint8Array(0) : storedBytes.subarray((i - 1) * 2048, i * 2048);
        const last = i > 0 && i * 2048 >= storedBytes.length;
        return [withEcho(reply(0x4500 + i, 0xd5, concat(Uint8Array.of(1), u32(9), u32(i), u32(1000 + i), Uint8Array.of(last ? 1 : 0), u32(i === 0 ? 0xffffffff : crc32(data, 0xffffffff) >>> 0), u32(data.length), data)), m.a)]; }
      case 0x56: return [withEcho(reply(0x4400, 0xd6, concat(Uint8Array.of(1), u32(9), u32(storedBytes.length))), m.a)];
      default: return null;
    }
  };
  return { respond, log, ops: () => log.map((l) => l.op) };
}

test('writeProject multi-chunk: cumulative WritePartial len accepted; verified by decoded image although raw bytes differ', async () => {
  const dev = multiDevice();
  const { rpc } = rig(dev.respond);
  const prog = [];
  const r = await rpc.writeProject(127, SENT, { onProgress: (d, t) => prog.push([d, t]) });
  assert.equal(r.verified, true); assert.deepEqual(r.mismatches, []); assert.equal(r.rawIdentical, false);
  assert.equal(r.name, 'PPRFC TOUR'); assert.equal(r.size, 57233);
  const parts = dev.log.filter((l) => l.op === 0x58);
  assert.deepEqual(parts.map((l) => l.payload.length - 16), [32768, 24465]); assert.deepEqual(parts.map((l) => l.payload[7]), [0, 1]);
  assert.deepEqual(prog.slice(0, 2), [[32768, 57233], [57233, 57233]]);
  assert.equal(dev.ops().filter((o) => o === 0x59).length, 1);
});
test('writeProject: non-cumulative WritePartial len (chunk length) on chunk 1 is rejected, close still sent', async () => {
  const dev = multiDevice({ cumulative: false });
  const err = await rig(dev.respond).rpc.writeProject(127, SENT).catch((e) => e);
  assert.match(err.message, /DataWritePartial\[1\]: unexpected reply.*len 24465.*expected cumulative 57233/); assert.equal(err.closeSent, true);
  assert.equal(dev.ops().at(-1), 0x59); assert.equal(dev.ops().includes(0x54), false);
});
test('writeProject: read-back with a different image reports verified:false with capped image-offset mismatches', async () => {
  // a valid payload with a different image: the real 028 BORN SLIPPY payload
  const dev = multiDevice({ storedBytes: PAYLOAD });
  const r = await rig(dev.respond).rpc.writeProject(127, SENT);
  assert.equal(r.verified, false); assert.ok(r.mismatches.length > 0 && r.mismatches.length <= 32);
});
test('writeProject: garbage read-back is verified:false with imageError', async () => {
  const garbage = Uint8Array.from(STORED); garbage[9000] ^= 1;
  const r = await rig(multiDevice({ storedBytes: garbage }).respond).rpc.writeProject(127, SENT);
  assert.equal(r.verified, false); assert.match(r.imageError, /CRC mismatch/); assert.equal(r.readbackSize, 36051);
});
test('writeProject: WriteClose total other than the byte count is an error', async () => {
  await assert.rejects(rig(multiDevice({ closeTotal: 5 }).respond).rpc.writeProject(127, SENT), /DataWriteClose: unexpected reply/);
});
