// Device panel: connect over WebMIDI SysEx, list project slots, read ("Back up") and write to EMPTY slots.
// The only device writes go through rpc.writeProject (empty slots only, verified by read-back).
import { esc, rich, folderIcon, deviceIcon } from './icons.js';
import { $, state, hooks, log, api, pad3, fmtBytes, outName, verText } from './common.js';

export const dev = { rpc: null, mod: null, name: 'Device', firmware: '', busy: false };
let midi = null, fillPorts = () => {};

export function setDev(text, bad = false) { const el = $('dev-status'); el.innerHTML = rich(text); el.style.color = bad ? 'var(--bad)' : ''; }
export function setBusy(b) {
  dev.busy = b;
  $('dev-connect').disabled = b; $('dev-refresh').disabled = b || !dev.rpc;
  document.querySelectorAll('#dev-table button.backup, #dev-table button.load, #src-dev-read, #dst-dev-read').forEach(x => { x.disabled = b; });
  hooks.onBusy?.(b);
}
// Device reports onProgress(done, null) per chunk (total unknown) and onProgress(n, n) at the end,
// so show bytes read with an indeterminate <progress> until the final call.
function showProgress(done, total, verb = 'read') {
  const bar = $('dev-progress');
  bar.hidden = false;
  if (typeof total === 'number' && total > 0) { bar.max = total; bar.value = done; } else bar.removeAttribute('value');
  return total ? `${fmtBytes(done)} / ${fmtBytes(total)} ${verb}` : `${fmtBytes(done)} ${verb}`;
}
function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const connected = () => !!dev.rpc;
export const canWrite = () => !!dev.rpc && typeof dev.rpc.writeProject === 'function' && typeof dev.mod?.validatePayload === 'function';

/** Read an occupied slot (the device is not modified) and save a verified-container local backup. Returns the
 *  /api/device/backup result ({id, file, ...}) or null after reporting the error. */
export async function readSlot(slot, name) {
  if (dev.busy || !dev.rpc) return null;
  if (typeof dev.rpc.readProject !== 'function') {
    setDev('this build of elektron-rpc.js has no readProject()', true); log('readProject() is not available', 'err', 'dev'); return null;
  }
  setBusy(true); setDev(`backing up {dev} slot ${pad3(slot)} → {dir} ${outName()}…`); showProgress(0, null);
  try {
    log(`{dev} slot ${pad3(slot)} "${name}" → {dir} ${outName()} (reading, device is not modified)…`);
    const res = await dev.rpc.readProject(slot, { onProgress: (done, total) => setDev(`backing up {dev} slot ${pad3(slot)} → {dir} ${outName()}… ${showProgress(done, total)}`) });
    if (!(res?.bytes instanceof Uint8Array) || !res.bytes.length) throw new Error('device returned no data');
    setDev(`saving {dev} slot ${pad3(slot)} → {dir} ${outName()} (${fmtBytes(res.bytes.length)})…`);
    const r = await api('device/backup', { slot, name: res.name || name, firmware: dev.firmware || undefined, payload_b64: toBase64(res.bytes) });
    log(`Backed up {dev} slot ${pad3(slot)} → {dir} ${r.file}`, 'ok');
    await hooks.loadProjects(true);
    setDev(`backed up {dev} slot ${pad3(slot)} → {dir} ${r.file}`);
    return r;
  } catch (e) {
    setDev(`backup of {dev} slot ${pad3(slot)} failed: ${e.message}`, true); log(`Backup of slot ${pad3(slot)} failed: ${e.message}`, 'err', 'dev');
    return null;
  } finally { $('dev-progress').hidden = true; setBusy(false); }
}

async function backupButton(slot, name) {
  const r = await readSlot(slot, name);
  if (r?.id && confirm(`Saved ${r.file}\n\nOpen it as the SOURCE project?`)) await hooks.useDevice('src', r.id);
}

/** Write bytes into an EMPTY slot via rpc.writeProject, with progress, error/partial-write reporting and a
 *  slot-list refresh. Returns { ok, verified, mismatches, name, error }. */
export async function writeSlot(slot, bytes, label) {
  let lastErr = null;
  const fail = msg => ({ ok: false, verified: null, mismatches: [], error: msg, partialWrite: !!lastErr?.partialWrite, writeCompleted: !!lastErr?.writeCompleted });
  if (dev.busy || !dev.rpc) return fail('device is busy or not connected');
  if (!canWrite()) {
    setDev('this build of elektron-rpc.js cannot write projects (writeProject/validatePayload missing)', true);
    log('writeProject() is not available', 'err', 'dev'); return fail('writeProject() is not available');
  }
  setBusy(true); setDev(`preparing slot ${pad3(slot)}…`);
  let result = null, errMsg = '', failedWrite = false;
  try {
    dev.mod.validatePayload(bytes);
    log(`Writing {dir} "${label}" (${fmtBytes(bytes.length)}) → {dev} slot ${pad3(slot)}…`);
    showProgress(0, bytes.length, 'sent');
    result = await dev.rpc.writeProject(slot, bytes, {
      onProgress: (done, total) => setDev(`writing slot ${pad3(slot)}… ${showProgress(done, total || bytes.length, 'sent')}`) });
  } catch (e) {
    lastErr = e;
    errMsg = `load to slot ${pad3(slot)} failed: ${e.message}${e.partialWrite ? ' — PARTIAL WRITE: check the slot on the device' : ''}`;
    setDev(errMsg, true); log(`Load to slot ${pad3(slot)} failed: ${e.message}`, 'err', 'dev');
    if (e.partialWrite) {
      log(`Slot ${pad3(slot)}: partial write — slot may hold an incomplete project; check it on the device${e.closeSent ? ' (WriteClose was sent)' : ''}${e.closeError ? '; close error: ' + e.closeError : ''}`, 'err', 'dev');
      failedWrite = true;
    } else if (e.writeCompleted) {
      log(`Slot ${pad3(slot)}: write completed but read-back failed — the project was written but could not be verified`, 'warn', 'dev');
      failedWrite = true;
    }
  } finally { $('dev-progress').hidden = true; setBusy(false); }
  if (failedWrite) { await refresh(); setDev(errMsg, true); }
  if (!result) return fail(errMsg.replace(/^load to slot \d+ failed: /, '').replace(/ — PARTIAL WRITE: .*$/, ''));
  await refresh();
  if (result.verified === true) { setDev(`slot ${pad3(slot)} written · verified ✓`); log(`Slot ${pad3(slot)} written and verified ✓ (${result.name || ''})`, 'ok', 'dev'); }
  else if (result.verified === false) {
    const msg = `slot ${pad3(slot)} written but VERIFY FAILED: ${result.mismatches?.length ?? '?'} mismatch(es)`;
    setDev(msg, true); log(msg + (result.mismatches?.length ? ' at ' + result.mismatches.slice(0, 20).join(',') : ''), 'err', 'dev');
  } else { setDev(`slot ${pad3(slot)} written (not verified)`); log(`Slot ${pad3(slot)} written, not verified`, 'warn', 'dev'); }
  return { ok: true, verified: result.verified, mismatches: result.mismatches || [], name: result.name, error: null };
}

// ---------- table ----------
const normName = t => String(t || '').trim().toLowerCase();
// Backup files are "NNN NAME.stprj" with NNN = device slot. Exact matches (slot number AND name) win over name-only.
function localMatches(slot, name) {
  const n = normName(name);
  if (!n || !state.projects) return { exact: [], nameOnly: [] };
  const exact = [], nameOnly = [];
  for (const p of state.projects) {
    if (!p.supported) continue;
    const m = /^(\d+)\s+(.*)$/.exec(p.file.replace(/\.stprj$/i, ''));
    const fileName = normName(m ? m[2] : p.file.replace(/\.stprj$/i, '')), projName = normName(p.name);
    if (n !== fileName && n !== projName) continue;
    (m && +m[1] === slot ? exact : nameOnly).push(p);
  }
  return { exact, nameOnly };
}
const matchLinks = (m, tag) => `<a data-id="${esc(m.id)}" data-role="src">src</a><a data-id="${esc(m.id)}" data-role="dst">dst</a>${folderIcon}<b>${esc(m.dir)}</b> / ${esc(m.file)}${tag}`;
export function renderTable() {
  const tb = $('dev-table').querySelector('tbody'); tb.innerHTML = '';
  for (const p of state.devList || []) {
    const tr = document.createElement('tr'); if (p.empty) tr.className = 'empty';
    let links = '';
    if (!p.empty) {
      const { exact, nameOnly } = localMatches(p.slot, p.name);
      links = exact.length ? exact.map(m => matchLinks(m, '')).join('<br>')
        : nameOnly.map(m => matchLinks(m, ' <span class="ver">(name only)</span>')).join('<br>');
    }
    const dis = dev.busy ? ' disabled' : '';
    const action = p.empty
      ? `<button class="load" data-slot="${p.slot}" title="Write a local project into empty device slot ${pad3(p.slot)}"${dis}>Load… ${folderIcon}<span class="arrow">→</span>${deviceIcon}</button>`
      : `<button class="backup" data-slot="${p.slot}" data-name="${esc(p.name)}" title="Back up device slot ${pad3(p.slot)} → ${esc(outName())} (reads only; the device is not modified)"${dis}>Back up ${deviceIcon}<span class="arrow">→</span>${folderIcon}</button>`;
    tr.innerHTML = `<td class="slot">${deviceIcon}${p.slot}</td><td>${esc(p.name)}</td><td>${p.empty ? 'empty' : 'occupied'}</td><td>${action}</td><td>${links}</td>`;
    tb.appendChild(tr);
  }
}

export async function refresh() {
  if (!dev.rpc) return;
  setBusy(true); setDev('reading…');
  try {
    const [ver, uid, space] = await Promise.allSettled([dev.rpc.softwareVersion(), dev.rpc.deviceUid(), dev.rpc.storageSpace()]);
    for (const r of [ver, uid]) if (r.status === 'rejected') throw r.reason;
    let storTxt = 'n/a';
    if (space.status === 'fulfilled') storTxt = `${fmtBytes(Number(space.value.a))} / ${fmtBytes(Number(space.value.b))} (unconfirmed meaning)`;
    else if (!/not supported/i.test(space.reason?.message || '')) {
      storTxt = 'error'; log('storage space: ' + space.reason?.message, 'warn', 'dev');
    }
    const uidTxt = typeof uid.value.uid === 'number' ? '0x' + uid.value.uid.toString(16).toUpperCase().padStart(8, '0') : '?';
    const v = ver.value;
    dev.firmware = v.version || '';
    $('dev-info').innerHTML = `${esc(dev.name)} · software <b>${esc(v.version || '?')}</b>${v.build ? ' (build ' + esc(v.build) + ')' : ''} · UID <b>${esc(uidTxt)}</b> · storage <b>${esc(storTxt)}</b>`;
    state.devList = await dev.rpc.listProjects();
    renderTable(); hooks.onDeviceList?.();
    setDev(`connected · ${state.devList.filter(p => !p.empty).length} of ${state.devList.length} slots used`);
    log(`read ${state.devList.length} project slots`, 'ok', 'dev');
  } catch (e) {
    setDev('error: ' + e.message, true); log('error: ' + e.message, 'err', 'dev');
  } finally { setBusy(false); }
}

async function connect() {
  try { dev.mod = await import('./elektron-rpc.js'); }
  catch (e) { setDev('device protocol module (elektron-rpc.js) is not available', true); log('cannot load elektron-rpc.js: ' + e.message, 'err', 'dev'); return; }
  if (!midi.supported) { setDev('Web MIDI unavailable in this browser (use Chrome or Edge)', true); return; }
  if (!await midi.requestSysexAccess()) { setDev('SysEx permission denied or MIDI unavailable', true); log('SysEx access not granted', 'err', 'dev'); return; }
  fillPorts();
  if (!midi.out || !midi.inp) { setDev('select the Syntakt MIDI In and Out above (none auto-detected)', true); return; }
  try {
    dev.rpc?.stop();
    dev.rpc = new dev.mod.ElektronRpc({ input: midi.inp, output: midi.out, timeoutMs: 3000,
      log: m => dev.busy || log('rpc: ' + (m.length > 110 ? m.slice(0, 110) + ` … (${m.length} chars)` : m), '', 'dev') });
    dev.rpc.start();
  } catch (e) { setDev('error: ' + e.message, true); log(e.message, 'err', 'dev'); return; }
  setDev('connecting…');
  try { dev.name = (await dev.rpc.ping()).name || 'Device'; } catch (e) {
    setDev('no response: ' + e.message + ' (is Elektron Transfer closed?)', true); log('ping failed: ' + e.message, 'err', 'dev');
    $('dev-refresh').disabled = false; return;
  }
  await refresh();
}

// ---------- "Load…" button on an empty slot: pick a local project, confirm, write ----------
function pickLoadSource(slot) {
  return new Promise(resolve => {
    const dlg = $('load-dialog'), list = $('load-list');
    const items = [];
    const sess = hooks.getSession?.();
    if (sess) items.push({ value: 'session', html: `${folderIcon}<span>working copy <span class="unsaved">● result of the last run</span> — ${esc(sess.dest.name)}, ${verText(sess.dest.version)}</span>` });
    for (const p of state.projects || []) if (p.supported) {
      items.push({ value: 'file:' + p.id, html: `${folderIcon}<span><b>${esc(p.dir)}</b> / ${esc(p.file)} — ${esc(p.name)} (${verText(p.version)})</span>` });
    }
    const sf = hooks.getSrcFile?.();
    const def = sess ? 'session' : (sf ? 'file:' + sf : items[0]?.value);
    list.innerHTML = items.map(it => `<label><input type="radio" name="load-src" value="${esc(it.value)}" ${it.value === def ? 'checked' : ''}>${it.html}</label>`).join('');
    $('load-title').innerHTML = `Load a local project <span class="arrow">→</span> ${deviceIcon} slot ${pad3(slot)} <span class="tag">(empty)</span>`;
    const done = v => { dlg.close(); resolve(v); };
    $('load-go').onclick = () => done(list.querySelector('input:checked')?.value || null);
    $('load-cancel').onclick = () => done(null);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    list.querySelector('input:checked')?.scrollIntoView({ block: 'nearest' });
  });
}
/** Fetch a payload to send: 'session' (working copy) or 'file:<id>'. */
export async function fetchPayload(choice, rev) {
  const url = choice === 'session' ? '/api/session/payload' + (rev ? '?rev=' + encodeURIComponent(rev) : '') : '/api/payload?file=' + encodeURIComponent(choice.slice(5));
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return {
    bytes: new Uint8Array(await r.arrayBuffer()),
    name: decodeURIComponent(r.headers.get('X-Project-Name') || ''),
    version: +r.headers.get('X-Project-Version'),
    rev: r.headers.get('X-Project-Revision') || '',
    file: choice === 'session' ? 'working copy' : decodeURIComponent(r.headers.get('X-Project-File') || ''),
  };
}
async function loadToSlot(slot) {
  if (dev.busy || !dev.rpc) return;
  if (!canWrite()) {
    setDev('this build of elektron-rpc.js cannot write projects (writeProject/validatePayload missing)', true);
    log('writeProject() is not available', 'err', 'dev'); return;
  }
  const choice = await pickLoadSource(slot);
  if (!choice) return;
  let src;
  try { src = await fetchPayload(choice, choice === 'session' ? hooks.getSession?.()?.revision?.id : undefined); } catch (e) { setDev(`load to slot ${pad3(slot)} failed: ${e.message}`, true); log(`Load to slot ${pad3(slot)} failed: ${e.message}`, 'err', 'dev'); return; }
  const ver = '0x' + src.version.toString(16).toUpperCase().padStart(2, '0');
  if (!confirm(`Write ${src.name} (${src.file}${src.rev ? ', rev ' + src.rev : ''}, v${ver}) to device slot ${pad3(slot)}?\n\nSlot ${pad3(slot)} is empty. The device keeps its other projects.`)) { setDev('load cancelled'); return; }
  await writeSlot(slot, src.bytes, `${src.name} (${src.file})`);
}

export function initDevice({ midi: m, fillPorts: fp }) {
  midi = m; fillPorts = fp;
  $('dev-connect').onclick = connect;
  $('dev-refresh').onclick = refresh;
  $('dev-table').addEventListener('click', e => {
    const b = e.target.closest('button.backup');
    if (b) return backupButton(+b.dataset.slot, b.dataset.name);
    const ld = e.target.closest('button.load');
    if (ld) return loadToSlot(+ld.dataset.slot);
    const a = e.target.closest('a[data-id]'); if (!a) return;
    hooks.useLocal(a.dataset.role, a.dataset.id);
  });
}
