import { Midi } from './midi.js';
import { esc, rich, folderIcon, deviceIcon } from './icons.js';
const $ = id => document.getElementById(id);
const BANKS = 'ABCDEFGH';
const lbl = i => `${BANKS[i >> 4]}${String(i % 16 + 1).padStart(2, '0')}`;
const state = { src: null, srcFile: null, srcSel: null, dstSel: null, session: null, deviceSlot: null, pendingForce: null };

// kind: 'dev' (operation on the Syntakt) or 'local' (file on this computer) prefixes the matching icon;
// {dev}/{dir} tokens inside msg are expanded to icons too.
function log(msg, cls = '', kind = '') {
  const d = document.createElement('div'); if (cls) d.className = cls;
  const pre = kind === 'dev' ? deviceIcon : kind === 'local' ? folderIcon : '';
  d.innerHTML = `<span class="ts">${new Date().toLocaleTimeString()}</span> ${pre}${rich(msg)}`;
  $('log').prepend(d);
}
const projOf = id => state.projects?.find(p => p.id === id);
const outName = () => (state.outputDir || 'OUTPUT').split('/').filter(Boolean).pop();
const whereHtml = (id, extra = '') => {
  const p = projOf(id);
  return `${folderIcon}<span><b>${esc(p ? p.dir : '?')}</b> / ${esc(p ? p.file : id.split('/').slice(1).join('/'))}</span>${extra}`;
};
async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.data = j; e.status = r.status; throw e; }
  return j;
}
const verText = v => `v0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

// ---------- grids ----------
const DEVICE_BADGE = '<svg class="ico dev badge" role="img" aria-label="On Syntakt: pattern currently selected on the device"><title>On Syntakt: pattern currently selected on the device</title><use href="#i-device"/></svg>';
function buildGrid(el, side) {
  el.innerHTML = '';
  for (let i = 0; i < 128; i++) {
    const c = document.createElement('div'); c.className = 'cell'; c.dataset.i = i; c.dataset.side = side;
    c.innerHTML = '<div class="l"></div><div class="n"></div><div class="t"></div>' + DEVICE_BADGE;
    c.draggable = side === 'src';
    el.appendChild(c);
  }
}
function paint(el, slots, sel, side) {
  [...el.children].forEach((c, i) => {
    const s = slots?.[i];
    c.querySelector('.l').textContent = `${BANKS[i >> 4]}${String(i % 16 + 1).padStart(2, '0')}`;
    c.querySelector('.n').textContent = s ? s.name : '';
    c.querySelector('.t').textContent = s && !s.empty ? `${s.trigs}t` : '';
    c.title = s ? `${s.label} "${s.name}" kit ${s.kit} ${s.kitName} · ${s.tempo} BPM · ${s.trigs} trigs · ${s.locks} locks` : '';
    c.classList.toggle('empty', !s || s.empty);
    c.classList.toggle('sel', sel === i);
    c.classList.toggle('changed', !!(s && s.changed));
    c.classList.toggle('device', state.deviceSlot === i);
  });
}
function repaint() {
  paint($('src-grid'), state.src?.slots, state.srcSel, 'src');
  paint($('dst-grid'), state.session?.dest.slots, state.dstSel, 'dst');
  const s = state.session;
  $('dst-ver').textContent = s ? `${s.dest.name} · ${verText(s.dest.version)}` : 'no working copy';
  $('src-ver').textContent = state.src ? `${state.src.name} · ${verText(state.src.version)}` : '';
  $('undo').disabled = !s || !s.undoDepth;
  $('save').disabled = !s || !s.undoDepth;
  $('discard').disabled = !s;
  $('apply').disabled = !(s && state.src && state.srcSel !== null && state.dstSel !== null);
  $('session-info').textContent = s ? `${s.undoDepth} change(s)` : '';
  $('src-where').innerHTML = state.srcFile ? whereHtml(state.srcFile) : '';
  $('dst-where').innerHTML = s ? whereHtml(s.file, ` <span class="tag">working copy</span>${s.undoDepth ? ' <span class="unsaved" title="Not saved to a file yet">● unsaved</span>' : ''}`) : '';
  if (s && state.src && s.dest.version !== state.src.version) {
    $('dst-ver').textContent += ` ⚠ source is ${verText(state.src.version)} (cross-version copy converts)`;
  }
}

// ---------- preview ----------
async function showPreview(side, i) {
  if (side === 'src' ? !state.srcFile : !state.session) return;
  try {
    const p = side === 'src'
      ? await api(`preview?file=${encodeURIComponent(state.srcFile)}&slot=${i}`)
      : await api(`session/preview?slot=${i}`);
    drawPreview(p, side);
  } catch (e) { /* preview is best-effort */ }
}
function drawPreview(p, side) {
  $('preview-title').textContent = `Preview (${side === 'src' ? 'source' : 'destination'}) ${p.label} "${p.name}" · ${p.trigs} trigs`;
  const cv = $('preview'), g = cv.getContext('2d'), cw = 10, ch = 14;
  g.clearRect(0, 0, cv.width, cv.height);
  p.tracks.forEach((row, t) => row.forEach((on, s) => {
    g.fillStyle = on ? '#e8a33d' : (s % 4 === 0 ? '#2b303a' : '#1d2129');
    g.fillRect(s * cw, t * ch, cw - 1, ch - 1);
  }));
}
let hoverTimer;
function hover(e) {
  const c = e.target.closest('.cell'); if (!c) return;
  clearTimeout(hoverTimer);
  if (c.dataset.side === 'dst' && !state.session) return;
  if (c.dataset.side === 'src' && !state.src) return;
  hoverTimer = setTimeout(() => showPreview(c.dataset.side, +c.dataset.i), 120);
}

// ---------- apply ----------
async function apply(force = false) {
  if (!state.session || !state.src || state.srcSel === null || state.dstSel === null) return;
  const req = { srcFile: state.srcFile, srcSlot: state.srcSel, dstSlot: state.dstSel, kit: $('kit').value, force };
  try {
    const r = await api('session/apply', req);
    state.session = r;
    log(`Applied ${lbl(state.srcSel)} → ${lbl(state.dstSel)}`, 'ok', 'local');
    (r.warnings || []).forEach(w => log('warning: ' + w, 'warn', 'local'));
    repaint(); showPreview('dst', state.dstSel);
  } catch (e) {
    log('refused: ' + e.message, 'err', 'local');
    if (e.data?.refusal && !force && confirm(e.message + '\n\nForce the copy anyway?')) return apply(true);
  }
}

// ---------- projects ----------
async function loadProjects(quiet = false) {
  const r = await api('projects');
  state.outputDir = r.output; state.projects = r.projects;
  for (const sel of [$('src-pick'), $('dst-pick')]) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">— choose project —</option>';
    for (const p of r.projects) {
      const o = document.createElement('option'); o.value = p.id;
      o.textContent = p.supported ? `[${p.dir}] ${p.file} — ${p.name} (${verText(p.version)})` : `[${p.dir}] ${p.file} — UNSUPPORTED`;
      o.disabled = !p.supported; if (!p.supported) o.title = p.error;
      sel.appendChild(o);
    }
    sel.value = keep;
  }
  if (quiet) return;
  const bad = r.projects.filter(p => !p.supported);
  log(`${r.projects.length} local projects found, ${bad.length} unsupported (${bad.map(p => p.file + ': ' + p.error).join(' | ').slice(0, 400)})`, '', 'local');
}
async function pickSource() {
  state.srcFile = $('src-pick').value; state.srcSel = null;
  if (!state.srcFile) { state.src = null; return repaint(); }
  try { state.src = await api('project?file=' + encodeURIComponent(state.srcFile)); }
  catch (e) { log(e.message, 'err', 'local'); state.src = null; }
  repaint();
}
async function openDest() {
  const f = $('dst-pick').value; if (!f) return;
  if (state.session?.undoDepth && !confirm('Discard unsaved changes in the current working copy?')) return;
  try { state.session = await api('session/open', { file: f }); state.dstSel = null; log('Opened working copy of ' + f, '', 'local'); }
  catch (e) { log(e.message, 'err', 'local'); }
  repaint();
}

// ---------- events ----------
for (const side of ['src', 'dst']) {
  const g = $(side + '-grid'); buildGrid(g, side);
  g.addEventListener('mouseover', hover);
  g.addEventListener('click', e => {
    const c = e.target.closest('.cell'); if (!c) return;
    const i = +c.dataset.i;
    if (side === 'src') state.srcSel = i; else state.dstSel = i;
    state.lastSel = i;
    repaint(); showPreview(side, i);
  });
}
$('src-grid').addEventListener('dragstart', e => {
  const c = e.target.closest('.cell'); if (!c) return;
  state.srcSel = +c.dataset.i; e.dataTransfer.setData('text/plain', c.dataset.i); repaint();
});
$('dst-grid').addEventListener('dragover', e => { if (e.target.closest('.cell')) { e.preventDefault(); } });
$('dst-grid').addEventListener('drop', e => {
  const c = e.target.closest('.cell'); if (!c) return; e.preventDefault();
  state.dstSel = +c.dataset.i; repaint(); apply(false);
});
$('src-pick').onchange = pickSource;
$('dst-open').onclick = openDest;
$('apply').onclick = () => apply(false);
$('undo').onclick = async () => { try { state.session = await api('session/undo', {}); log('Undid last apply', '', 'local'); repaint(); } catch (e) { log(e.message, 'err', 'local'); } };
$('discard').onclick = async () => { if (confirm('Discard the working copy?')) { state.session = await api('session/discard', {}); log('Working copy discarded', '', 'local'); repaint(); } };
$('save').onclick = async () => {
  try { const r = await api('session/save', { name: $('save-name').value }); state.session = r; log('Saved ' + r.saved, 'ok', 'local'); repaint(); }
  catch (e) { log('save failed: ' + e.message, 'err', 'local'); }
};

// ---------- MIDI ----------
const midi = new Midi({
  onStatus: t => { $('midi-status').textContent = 'MIDI: ' + t; },
  onProgram: (p, ch) => { state.deviceSlot = p; log(`Device Program Change ${p} (${lbl(p)}) on ch ${ch}`, '', 'dev'); repaint(); },
});
function fillPorts() {
  const { inputs, outputs } = midi.ports();
  const fill = (sel, list, cur) => {
    sel.innerHTML = '<option value="">(none)</option>' + list.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    const pick = list.find(p => p.id === cur) || Midi.pickDefault(list);
    if (pick) sel.value = pick.id;
  };
  fill($('midi-out'), outputs, midi.out?.id); fill($('midi-in'), inputs, midi.inp?.id);
  midi.selectOutput($('midi-out').value); midi.selectInput($('midi-in').value);
}
function audition() {
  const sel = state.lastSel;
  if (sel === null || sel === undefined) return log('Select a pattern first', 'warn');
  try { midi.programChange(sel); log(`Sent Program Change ${sel} (${lbl(sel)}) on ch ${midi.channel}`, '', 'dev'); }
  catch (e) { log('audition: ' + e.message, 'err', 'dev'); }
}
$('midi-ch').innerHTML = Array.from({ length: 16 }, (_, i) => `<option${i === 9 ? ' selected' : ''}>${i + 1}</option>`).join('');
$('midi-ch').onchange = () => midi.setChannel(+$('midi-ch').value);
$('midi-out').onchange = () => midi.selectOutput($('midi-out').value);
$('midi-in').onchange = () => midi.selectInput($('midi-in').value);
$('audition').onclick = audition;
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); audition(); }
});
midi.onPorts = fillPorts;
midi.requestAccess({ sysex: false }).then(ok => { if (ok) fillPorts(); else $('audition').disabled = true; });

repaint();
loadProjects().catch(e => log(e.message, 'err', 'local'));

// ---------- Device panel (read-only SysEx) ----------
let rpc = null, rpcMod = null, devName = 'Device', devFirmware = '', devBusy = false;
const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
function setDevBusy(b) {
  devBusy = b;
  $('dev-connect').disabled = b; $('dev-refresh').disabled = b || !rpc;
  document.querySelectorAll('#dev-table button.backup, #dev-table button.load').forEach(x => { x.disabled = b; });
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
async function backupSlot(slot, name) {
  if (devBusy || !rpc) return;
  if (typeof rpc.readProject !== 'function') {
    setDev('this build of elektron-rpc.js has no readProject()', true); log('readProject() is not available', 'err', 'dev'); return;
  }
  setDevBusy(true); setDev(`backing up {dev} slot ${pad3(slot)} → {dir} ${outName()}…`); showProgress(0, null);
  try {
    log(`{dev} slot ${pad3(slot)} "${name}" → {dir} ${outName()} (reading, device is not modified)…`);
    const res = await rpc.readProject(slot, { onProgress: (done, total) => setDev(`backing up {dev} slot ${pad3(slot)} → {dir} ${outName()}… ${showProgress(done, total)}`) });
    if (!(res?.bytes instanceof Uint8Array) || !res.bytes.length) throw new Error('device returned no data');
    setDev(`saving {dev} slot ${pad3(slot)} → {dir} ${outName()} (${fmtBytes(res.bytes.length)})…`);
    const r = await api('device/backup', { slot, name: res.name || name, firmware: devFirmware || undefined, payload_b64: toBase64(res.bytes) });
    log(`Backed up {dev} slot ${pad3(slot)} → {dir} ${r.file}`, 'ok');
    await loadProjects(true);
    setDev(`backed up {dev} slot ${pad3(slot)} → {dir} ${r.file}`);
    if (r.id && confirm(`Saved ${r.file}\n\nOpen it as the SOURCE project?`)) { $('src-pick').value = r.id; await pickSource(); }
  } catch (e) {
    setDev(`backup of {dev} slot ${pad3(slot)} failed: ${e.message}`, true); log(`Backup of slot ${pad3(slot)} failed: ${e.message}`, 'err', 'dev');
  } finally { $('dev-progress').hidden = true; setDevBusy(false); }
}
function setDev(text, bad = false) { const el = $('dev-status'); el.innerHTML = rich(text); el.style.color = bad ? 'var(--bad)' : ''; }

const normName = t => String(t || '').trim().toLowerCase();
const stripNum = t => t.replace(/^\d+\s+/, '');
// Backup files are "NNN NAME.stprj" with NNN = device slot. Return exact matches (slot number AND name)
// when there are any, else name-only matches (flagged so the UI can say so).
function localMatches(slot, name) {
  const n = normName(name);
  if (!n || !state.projects) return { exact: [], nameOnly: [] };
  const exact = [], nameOnly = [];
  for (const p of state.projects) {
    if (!p.supported) continue;
    const stem = p.file.replace(/\.stprj$/i, '');
    const m = /^(\d+)\s+(.*)$/.exec(stem);
    const fileName = normName(m ? m[2] : stem), projName = normName(p.name);
    if (n !== fileName && n !== projName) continue;
    (m && +m[1] === slot ? exact : nameOnly).push(p);
  }
  return { exact, nameOnly };
}
const matchLinks = (m, tag) => `<a data-id="${esc(m.id)}" data-role="src">src</a><a data-id="${esc(m.id)}" data-role="dst">dst</a>${folderIcon}<b>${esc(m.dir)}</b> / ${esc(m.file)}${tag}`;
function renderDeviceTable(list) {
  const tb = $('dev-table').querySelector('tbody'); tb.innerHTML = '';
  for (const p of list) {
    const tr = document.createElement('tr'); if (p.empty) tr.className = 'empty';
    let links = '';
    if (!p.empty) {
      const { exact, nameOnly } = localMatches(p.slot, p.name);
      links = exact.length ? exact.map(m => matchLinks(m, '')).join('<br>')
        : nameOnly.map(m => matchLinks(m, ' <span class="ver">(name only)</span>')).join('<br>');
    }
    tr.innerHTML = `<td class="slot">${deviceIcon}${p.slot}</td><td>${esc(p.name)}</td><td>${p.empty ? 'empty' : 'occupied'}</td><td>${p.empty ? `<button class="load" data-slot="${p.slot}" title="Write a local project into empty device slot ${pad3(p.slot)}"${devBusy ? ' disabled' : ''}>Load… ${folderIcon}<span class="arrow">→</span>${deviceIcon}</button>` : `<button class="backup" data-slot="${p.slot}" data-name="${esc(p.name)}" title="Back up device slot ${pad3(p.slot)} → ${esc(outName())} (reads only; the device is not modified)"${devBusy ? ' disabled' : ''}>Back up ${deviceIcon}<span class="arrow">→</span>${folderIcon}</button>`}</td><td>${links}</td>`;
    tb.appendChild(tr);
  }
}
$('dev-table').addEventListener('click', e => {
  const btn = e.target.closest('button.backup');
  if (btn) return backupSlot(+btn.dataset.slot, btn.dataset.name);
  const ld = e.target.closest('button.load');
  if (ld) return loadToSlot(+ld.dataset.slot);
  const a = e.target.closest('a[data-id]'); if (!a) return;
  if (a.dataset.role === 'src') { $('src-pick').value = a.dataset.id; pickSource(); }
  else { $('dst-pick').value = a.dataset.id; openDest(); }
});

async function refreshDevice() {
  if (!rpc) return;
  setDevBusy(true); setDev('reading…');
  try {
    const [ver, uid, space] = await Promise.allSettled([rpc.softwareVersion(), rpc.deviceUid(), rpc.storageSpace()]);
    for (const r of [ver, uid]) if (r.status === 'rejected') throw r.reason;
    let storTxt = 'n/a';
    if (space.status === 'fulfilled') storTxt = `${fmtBytes(Number(space.value.a))} / ${fmtBytes(Number(space.value.b))} (unconfirmed meaning)`;
    else if (!/not supported/i.test(space.reason?.message || '')) {
      storTxt = 'error'; log('storage space: ' + space.reason?.message, 'warn', 'dev');
    }
    const uidTxt = typeof uid.value.uid === 'number' ? '0x' + uid.value.uid.toString(16).toUpperCase().padStart(8, '0') : '?';
    const v = ver.value;
    devFirmware = v.version || '';
    $('dev-info').innerHTML = `${esc(devName)} · software <b>${esc(v.version || '?')}</b>${v.build ? ' (build ' + esc(v.build) + ')' : ''} · UID <b>${esc(uidTxt)}</b> · storage <b>${esc(storTxt)}</b>`;
    const list = await rpc.listProjects();
    renderDeviceTable(list);
    setDev(`connected · ${list.filter(p => !p.empty).length} of ${list.length} slots used`);
    log(`read ${list.length} project slots`, 'ok', 'dev');
  } catch (e) {
    setDev('error: ' + e.message, true); log('error: ' + e.message, 'err', 'dev');
  } finally { setDevBusy(false); }
}
$('dev-connect').onclick = async () => {
  let mod;
  try { mod = rpcMod = await import('./elektron-rpc.js'); }
  catch (e) { setDev('device protocol module (elektron-rpc.js) is not available', true); log('cannot load elektron-rpc.js: ' + e.message, 'err', 'dev'); return; }
  if (!midi.supported) { setDev('Web MIDI unavailable in this browser (use Chrome or Edge)', true); return; }
  if (!await midi.requestSysexAccess()) { setDev('SysEx permission denied or MIDI unavailable', true); log('SysEx access not granted', 'err', 'dev'); return; }
  fillPorts();
  if (!midi.out || !midi.inp) { setDev('select the Syntakt MIDI In and Out above (none auto-detected)', true); return; }
  try { rpc?.stop(); rpc = new mod.ElektronRpc({ input: midi.inp, output: midi.out, timeoutMs: 3000, log: m => devBusy || log('rpc: ' + (m.length > 110 ? m.slice(0, 110) + ` … (${m.length} chars)` : m), '', 'dev') }); rpc.start(); }
  catch (e) { setDev('error: ' + e.message, true); log(e.message, 'err', 'dev'); return; }
  setDev('connecting…');
  try { devName = (await rpc.ping()).name || 'Device'; } catch (e) {
    setDev('no response: ' + e.message + ' (is Elektron Transfer closed?)', true); log('ping failed: ' + e.message, 'err', 'dev');
    $('dev-refresh').disabled = false; return;
  }
  await refreshDevice();
};

// ---------- Load to device slot (EMPTY slots only; never overwrites) ----------
const pad3 = n => String(n).padStart(3, '0');
function pickLoadSource(slot) {
  return new Promise(resolve => {
    const dlg = $('load-dialog'), list = $('load-list');
    const items = [];
    if (state.session) {
      const d = state.session.dest;
      items.push({ value: 'session', html: `${folderIcon}<span>working copy <span class="unsaved">● unsaved edits</span> — ${esc(d.name)}, ${verText(d.version)}</span>` });
    }
    for (const p of state.projects || []) if (p.supported) {
      items.push({ value: 'file:' + p.id, html: `${folderIcon}<span><b>${esc(p.dir)}</b> / ${esc(p.file)} — ${esc(p.name)} (${verText(p.version)})</span>` });
    }
    const def = state.session ? 'session' : (state.srcFile ? 'file:' + state.srcFile : items[0]?.value);
    list.innerHTML = items.map((it, i) => `<label><input type="radio" name="load-src" value="${esc(it.value)}" ${it.value === def ? 'checked' : ''}>${it.html}</label>`).join('');
    $('load-title').innerHTML = `Load a local project <span class="arrow">→</span> ${deviceIcon} slot ${pad3(slot)} <span class="tag">(empty)</span>`;
    const done = v => { dlg.close(); resolve(v); };
    $('load-go').onclick = () => done(list.querySelector('input:checked')?.value || null);
    $('load-cancel').onclick = () => done(null);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    list.querySelector('input:checked')?.scrollIntoView({ block: 'nearest' });
  });
}
async function fetchPayload(choice) {
  const url = choice === 'session' ? '/api/session/payload' : '/api/payload?file=' + encodeURIComponent(choice.slice(5));
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return {
    bytes: new Uint8Array(await r.arrayBuffer()),
    name: decodeURIComponent(r.headers.get('X-Project-Name') || ''),
    version: +r.headers.get('X-Project-Version'),
    file: choice === 'session' ? 'working copy' : decodeURIComponent(r.headers.get('X-Project-File') || ''),
  };
}
async function loadToSlot(slot) {
  if (devBusy || !rpc) return;
  if (typeof rpc.writeProject !== 'function' || typeof rpcMod?.validatePayload !== 'function') {
    setDev('this build of elektron-rpc.js cannot write projects (writeProject/validatePayload missing)', true);
    log('writeProject() is not available', 'err', 'dev'); return;
  }
  const choice = await pickLoadSource(slot);
  if (!choice) return;
  setDevBusy(true); setDev(`preparing slot ${pad3(slot)}…`);
  let result = null, failedWrite = false, errStatus = '';
  try {
    const src = await fetchPayload(choice);
    const ver = '0x' + src.version.toString(16).toUpperCase().padStart(2, '0');
    if (!confirm(`Write ${src.name} (${src.file}, v${ver}) to device slot ${pad3(slot)}?\n\nSlot ${pad3(slot)} is empty. The device keeps its other projects.`)) {
      setDev('load cancelled'); return;
    }
    rpcMod.validatePayload(src.bytes);
    log(`Writing {dir} "${src.name}" (${src.file}, ${fmtBytes(src.bytes.length)}) → {dev} slot ${pad3(slot)}…`);
    showProgress(0, src.bytes.length, 'sent');
    result = await rpc.writeProject(slot, src.bytes, {
      onProgress: (done, total) => setDev(`writing slot ${pad3(slot)}… ${showProgress(done, total || src.bytes.length, 'sent')}`) });
  } catch (e) {
    errStatus = `load to slot ${pad3(slot)} failed: ${e.message}${e.partialWrite ? ' — PARTIAL WRITE: check the slot on the device' : ''}`;
    setDev(errStatus, true); log(`Load to slot ${pad3(slot)} failed: ${e.message}`, 'err', 'dev');
    if (e.partialWrite) {
      log(`Slot ${pad3(slot)}: partial write — slot may hold an incomplete project; check it on the device${e.closeSent ? ' (WriteClose was sent)' : ''}${e.closeError ? '; close error: ' + e.closeError : ''}`, 'err', 'dev');
      failedWrite = true;
    } else if (e.writeCompleted) {
      log(`Slot ${slot}: write completed but read-back failed — the project was written but could not be verified`, 'warn', 'dev');
      failedWrite = true;
    }
  } finally { $('dev-progress').hidden = true; setDevBusy(false); }
  if (failedWrite) { await refreshDevice(); setDev(errStatus, true); }
  if (!result) return;
  await refreshDevice();
  if (result.verified === true) { setDev(`slot ${pad3(slot)} written · verified ✓`); log(`Slot ${pad3(slot)} written and verified ✓ (${result.name || ''})`, 'ok', 'dev'); }
  else if (result.verified === false) {
    const msg = `slot ${pad3(slot)} written but VERIFY FAILED: ${result.mismatches?.length ?? "?"} mismatch(es)`;
    setDev(msg, true); log(msg + (result.mismatches?.length ? ' at ' + result.mismatches.slice(0, 20).join(',') : ''), 'err', 'dev');
  } else { setDev(`slot ${pad3(slot)} written (not verified)`); log(`Slot ${pad3(slot)} written, not verified`, 'warn', 'dev'); }
}
$('dev-refresh').onclick = refreshDevice;
