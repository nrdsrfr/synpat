// Pattern mover UI: pick a source and a base (destination) project -- each a local file or a Syntakt slot --
// queue many pattern copies, validate the whole queue on the server, then run it once.
import { Midi } from './midi.js';
import { esc, icon, folderIcon, deviceIcon } from './icons.js';
import { $, BANKS, lbl, pad3, verText, state, hooks, log, api, projOf, outName, fileOf, deviceOrigin } from './common.js';
import * as D from './device.js';

const plan = {
  src: null, srcFile: null, srcKind: 'local', srcSel: null, dstSel: null,
  dest: null,        // { fileId, kind: 'local' | 'device' }: the base project the queue is applied to
  queue: [],         // ops: { sourceFileId, sourceKind, sourceLabel, srcProjName, patName, srcSlot, dstSlot, kitSlot, force }
  sim: null,         // last /api/plan/validate response { ok, results[], project, key }; null while revalidating
  view: null,        // last good simulated project, so the grid does not blank while revalidating
  session: null,     // working copy after a run (server session state)
  ranOps: [], savedAs: null, summary: null, outputsBusy: false,  // outputsBusy: save/device write in progress
};

// ---------- labels ----------
function sourceLabel(fileId, kind) {
  const o = deviceOrigin(fileId);
  if (kind === 'device' && o) return `${pad3(o.slot)} ${o.name} (read ${o.time})`;
  const p = projOf(fileId);
  return p ? `${p.dir} / ${p.file}` : fileOf(fileId);
}
function whereHtml(fileId, kind, extra = '') {
  const o = deviceOrigin(fileId), p = projOf(fileId);
  const where = p ? `<b>${esc(p.dir)}</b> / ${esc(p.file)}` : esc(fileOf(fileId));
  if (kind === 'device' && o) {
    return `${deviceIcon}<span><b>Syntakt</b> slot ${pad3(o.slot)} ${esc(o.name)} (read ${o.time})</span><span class="tag">${folderIcon} backup: ${where}</span>${extra}`;
  }
  return `${folderIcon}<span>${where}</span>${o ? `<span class="tag">device backup of slot ${pad3(o.slot)}</span>` : ''}${extra}`;
}
const destSlots = () => plan.session ? plan.session.dest.slots : (plan.sim ?? plan.view)?.project?.slots;
const destVersion = () => plan.session ? plan.session.dest.version : (plan.sim ?? plan.view)?.project?.version;

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
/** dst slot -> { ok, text, title } for queued ops (a failing op marks the cell as a conflict). */
function plannedCells() {
  const map = new Map();
  if (plan.session || !plan.sim) return map;
  plan.queue.forEach((op, i) => {
    const r = plan.sim.results[i]; if (!r) return;
    const cur = map.get(op.dstSlot) || { ok: true, text: '', title: [] };
    cur.ok = cur.ok && r.ok;
    if (!cur.text || !r.ok) cur.text = `${r.ok ? '←' : '✗'} #${i + 1} ${op.srcProjName}`;
    cur.title.push(`#${i + 1} ${op.sourceLabel} ${lbl(op.srcSlot)} → ${lbl(op.dstSlot)}${r.ok ? '' : ': ' + r.error}`);
    map.set(op.dstSlot, cur);
  });
  return map;
}
function paint(el, slots, sel, planned) {
  [...el.children].forEach((c, i) => {
    const s = slots?.[i], pl = planned?.get(i);
    c.querySelector('.l').textContent = lbl(i);
    c.querySelector('.n').textContent = s ? s.name : '';
    c.querySelector('.t').textContent = pl ? pl.text : (s && !s.empty ? `${s.trigs}t` : '');
    c.title = (s ? `${s.label} "${s.name}" kit ${s.kit} ${s.kitName} · ${s.tempo} BPM · ${s.trigs} trigs · ${s.locks} locks` : '') + (pl ? '\n' + pl.title.join('\n') : '');
    c.classList.toggle('empty', !s || (s.empty && !pl));
    c.classList.toggle('sel', sel === i);
    c.classList.toggle('changed', !!(s && s.changed));
    c.classList.toggle('result', !!plan.session);
    c.classList.toggle('planned', !!pl && pl.ok);
    c.classList.toggle('conflict', !!pl && !pl.ok);
    c.classList.toggle('device', state.deviceSlot === i);
  });
}

// ---------- queue ----------
function opRowHtml(op, i, r, locked) {
  const kind = op.sourceKind === 'device' ? 'device' : 'folder';
  const cls = locked ? 'ok' : !r ? '' : r.ok ? 'ok' : `bad${r.forceable ? ' needforce' : ''}`;
  const status = locked ? '<span class="st">✓ applied</span>'
    : !r ? '<span class="st">validating…</span>'
    : r.ok ? `<span class="st">✓ ok${r.warnings.length ? ` · ${r.warnings.length} warning(s)` : ''}</span>`
    : '<span class="st err">✗ not applicable</span>';
  const controls = locked ? '' : `
    <label>kit <input class="kit" name="kit-${i}" aria-label="Kit slot for operation ${i + 1}" type="number" min="1" max="128" value="${Number(op.kitSlot) + 1}" data-i="${i}"></label>
    <label class="force" title="Override refusals (non-empty destination, shared/duplicate kit or slot, lossy conversion)"><input type="checkbox" class="force" name="force-${i}" data-i="${i}" ${op.force ? 'checked' : ''}> force</label>
    <span class="btns"><button data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button><button data-act="down" data-i="${i}" ${i === plan.queue.length - 1 ? 'disabled' : ''} title="Move down">↓</button><button data-act="rm" data-i="${i}" title="Remove from queue">✕</button></span>`;
  const msgs = locked || !r ? '' : (r.ok ? r.warnings.map(w => `<div class="warn">⚠ ${esc(w)}</div>`) : [`<div class="err">${esc(r.error)}</div>`]).join('');
  return `<li class="${cls}"><span class="n">${i + 1}</span>${icon(kind)}<span class="srcname">${esc(op.sourceLabel)}</span>`
    + `<span><b>${lbl(op.srcSlot)}</b> ${esc(op.patName)} → <b>${lbl(op.dstSlot)}</b>${locked ? ` (kit ${Number(op.kitSlot) + 1})` : ''}</span>${controls}${status}${msgs}</li>`;
}
function renderQueue() {
  const locked = !!plan.session, ops = locked ? plan.ranOps : plan.queue;
  $('queue-list').innerHTML = ops.map((op, i) => opRowHtml(op, i, plan.sim?.results[i], locked)).join('');
  const bad = plan.sim ? plan.sim.results.filter(r => !r.ok).length : 0;
  $('queue-count').textContent = ops.length ? `${ops.length} operation(s)${locked ? ' — run' : bad ? ` — ${bad} with errors` : ''}` : '';
  $('queue-note').hidden = ops.length > 0 || locked;
}
function renderSummary() {
  const s = plan.summary, box = $('run-summary');
  box.hidden = !s;
  if (!s) return;
  const lines = [`<div class="good">✓ ${s.ops} operation(s) applied to the working copy${s.warnings.length ? `, ${s.warnings.length} warning(s)` : ''}</div>`];
  s.warnings.forEach(w => lines.push(`<div class="warn">⚠ ${esc(w)}</div>`));
  if (s.save) lines.push(s.save.error ? `<div class="bad">${folderIcon} not saved: ${esc(s.save.error)}</div>` : `<div class="good">${folderIcon} saved: <b>${esc(s.save.file)}</b></div>`);
  if (s.device) {
    const d = s.device;
    lines.push(d.cancelled ? `<div>${deviceIcon} device write to slot ${pad3(d.slot)} cancelled</div>`
      : d.partialWrite ? `<div class="bad">${deviceIcon} PARTIAL write — check slot ${pad3(d.slot)} on the device (it may hold an incomplete project): ${esc(d.error)}</div>`
      : d.writeCompleted ? `<div class="bad">${deviceIcon} written to slot ${pad3(d.slot)}, NOT verified (read-back failed): ${esc(d.error)}</div>`
      : d.error ? `<div class="bad">${deviceIcon} device write failed (nothing written): ${esc(d.error)}</div>`
      : d.verified === true ? `<div class="good">${deviceIcon} written to Syntakt slot <b>${pad3(d.slot)}</b> · verified ✓</div>`
      : d.verified === false ? `<div class="bad">${deviceIcon} written to slot ${pad3(d.slot)} but VERIFY FAILED (${d.mismatches.length} mismatch(es))</div>`
      : `<div>${deviceIcon} written to slot ${pad3(d.slot)} (not verified)</div>`);
  }
  lines.push('<div class="tag">Undo run reverts only the local working copy; saved files and device writes are not undone.</div>');
  box.innerHTML = lines.join('');
}
function updateButtons() {
  const busy = D.dev.busy || plan.outputsBusy, locked = !!plan.session;
  $('run').disabled = busy || locked || !plan.dest || !plan.queue.length || !plan.sim?.ok;
  $('run').hidden = locked;
  $('clear-queue').disabled = busy || !plan.queue.length; $('clear-queue').hidden = locked;
  for (const id of ['undo-run', 'outputs', 'new-queue']) { $(id).hidden = !locked; $(id).disabled = busy; }
  $('queue-hint').textContent = locked ? 'result is a working copy; use Outputs… to save or write it'
    : !plan.dest ? 'choose a destination project first' : plan.queue.length && plan.sim && !plan.sim.ok ? 'fix or force the operations marked ✗ to enable Run' : '';
  for (const side of ['src', 'dst']) $(`${side}-dev-read`).disabled = busy || !D.connected() || !$(`${side}-dev`).value;
}
function render() {
  paint($('src-grid'), plan.src?.slots, plan.srcSel);
  paint($('dst-grid'), destSlots(), plan.dstSel, plannedCells());
  const dv = destVersion();
  const cross = plan.src && dv && plan.src.version !== dv ? ` <span class="tag" title="Pattern and kit are converted when copied">⚠ ${verText(plan.src.version)} → ${verText(dv)} converted</span>` : '';
  $('src-where').innerHTML = plan.srcFile ? whereHtml(plan.srcFile, plan.srcKind, `<span class="ver">${plan.src ? esc(plan.src.name) + ' · ' + verText(plan.src.version) : ''}</span>${cross}`) : '';
  const state_ = plan.session ? ` <span class="tag">working copy (run result)</span>${plan.savedAs ? '' : ' <span class="unsaved" title="Not saved to a file yet">● unsaved</span>'}`
    : plan.queue.length ? ' <span class="tag">+ planned changes (not written)</span>' : '';
  $('dst-where').innerHTML = plan.dest ? whereHtml(plan.dest.fileId, plan.dest.kind, `<span class="ver">${dv ? verText(dv) : ''}</span>${state_}`) : '';
  renderQueue(); renderSummary(); updateButtons();
}

// ---------- validation and persistence ----------
let valSeq = 0, persistTimer, planRev = 0, persistChain = Promise.resolve();
const planSnapshot = () => ({ dest: plan.dest, queue: plan.queue, ranOps: plan.ranOps, savedAs: plan.savedAs, srcFile: plan.srcFile, srcKind: plan.srcKind });
async function sendPlan() {
  try { planRev = (await api('plan/store', { plan: planSnapshot(), rev: planRev })).rev; }
  catch (e) {
    if (e.status === 409 && e.data?.rev !== undefined) {
      log('The queue was changed in another tab; reloaded the stored one.', 'warn', 'local'); await restore();
    } else log('could not store the queue: ' + e.message, 'warn', 'local');
  }
}
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistChain = persistChain.then(sendPlan); }, 150);
}
async function revalidate() {
  const seq = ++valSeq;
  if (!plan.dest || plan.session) { plan.sim = null; plan.view = null; return render(); }
  try {
    const r = await api('plan/validate', { destFileId: plan.dest.fileId, ops: plan.queue });
    if (seq !== valSeq) return;
    plan.sim = r; plan.view = r;
  } catch (e) {
    if (seq !== valSeq) return;
    plan.sim = null; log('validation failed: ' + e.message, 'err', 'local');
  }
  render();
}
function queueChanged() { plan.sim = null; render(); revalidate(); persist(); }

// ---------- project selection ----------
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
  $('out-dir').textContent = outName();
  if (quiet) return;
  const bad = r.projects.filter(p => !p.supported);
  log(`${r.projects.length} local projects found, ${bad.length} unsupported (${bad.map(p => p.file + ': ' + p.error).join(' | ').slice(0, 400)})`, '', 'local');
}
async function setSource(fileId, kind, quiet = false) {
  plan.srcFile = fileId || null; plan.srcKind = kind; plan.srcSel = null; plan.src = null;
  if (fileId) {
    if (kind === 'local') $('src-pick').value = fileId;
    setMode('src', kind);
    try { plan.src = await api('project?file=' + encodeURIComponent(fileId)); }
    catch (e) { log(e.message, 'err', 'local'); plan.srcFile = null; }
  }
  render(); if (!quiet) persist();
}
async function setDest(fileId, kind) {
  if (plan.session && !confirm('Leave the run result? The working copy is discarded (saved files and device writes stay).')) { $('dst-pick').value = plan.dest.fileId; return; }
  if (plan.session) await discardSession();
  plan.dest = fileId ? { fileId, kind } : null; plan.dstSel = null; plan.sim = null; plan.view = null;
  if (fileId && kind === 'local') $('dst-pick').value = fileId;
  if (fileId) setMode('dst', kind);
  render(); await revalidate(); persist();
}
function setMode(side, mode) {
  document.querySelector(`input[name="${side}-mode"][value="${mode}"]`).checked = true;
  $(`${side}-local-row`).hidden = mode !== 'local'; $(`${side}-dev-row`).hidden = mode !== 'device';
  if (side === 'dst') $('dst-note').hidden = mode !== 'device';
}
function populateDevSelects() {
  for (const side of ['src', 'dst']) {
    const sel = $(`${side}-dev`), keep = sel.value;
    const occupied = (state.devList || []).filter(p => !p.empty);
    sel.innerHTML = state.devList ? '<option value="">— choose an occupied slot —</option>' + occupied.map(p => `<option value="${p.slot}" data-name="${esc(p.name)}">${pad3(p.slot)} ${esc(p.name)}</option>`).join('')
      : '<option value="">— connect to the Syntakt in the Device panel first —</option>';
    sel.value = keep;
  }
  updateButtons();
}
async function readDevicePick(side) {
  const sel = $(`${side}-dev`), slot = +sel.value; if (!slot) return;
  const r = await D.readSlot(slot, sel.selectedOptions[0].dataset.name);
  if (!r?.id) return;
  if (side === 'src') await setSource(r.id, 'device'); else await setDest(r.id, 'device');
}

// ---------- adding operations ----------
function addOp(srcSlot, dstSlot) {
  if (plan.session) return log('The queue was already run: use Undo run or New queue first.', 'warn', 'local');
  if (!plan.src || !plan.srcFile) return log('Choose a source project first.', 'warn', 'local');
  if (!plan.dest) return log('Choose a destination project first.', 'warn', 'local');
  const kit = parseInt($('kit').value, 10);
  const kitSlot = Number.isInteger(kit) && kit >= 1 && kit <= 128 ? kit - 1 : dstSlot;
  const s = plan.src.slots[srcSlot];
  plan.queue.push({ sourceFileId: plan.srcFile, sourceKind: plan.srcKind, sourceLabel: sourceLabel(plan.srcFile, plan.srcKind),
    srcProjName: plan.src.name, patName: s.name, srcSlot, dstSlot, kitSlot, force: false });
  log(`Queued #${plan.queue.length}: ${lbl(srcSlot)} ${s.name} → ${lbl(dstSlot)}`, '', plan.srcKind === 'device' ? 'dev' : 'local');
  queueChanged();
}
$('queue-list').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b || plan.session) return;
  const i = +b.dataset.i, q = plan.queue;
  if (b.dataset.act === 'rm') q.splice(i, 1);
  else { const j = b.dataset.act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= q.length) return; [q[i], q[j]] = [q[j], q[i]]; }
  queueChanged();
});
$('queue-list').addEventListener('change', e => {
  const el = e.target, op = plan.queue[+el.dataset.i]; if (!op || plan.session) return;
  if (el.classList.contains('kit')) { const v = parseInt(el.value, 10); op.kitSlot = Number.isInteger(v) ? Math.min(127, Math.max(0, v - 1)) : op.dstSlot; }
  else if (el.classList.contains('force')) op.force = el.checked;
  queueChanged();
});
$('clear-queue').onclick = () => { plan.queue = []; queueChanged(); };

// ---------- preview ----------
async function showPreview(side, i) {
  if (side === 'src' ? !plan.srcFile : !(plan.session || plan.sim)) return;
  try {
    const p = side === 'src' ? await api(`preview?file=${encodeURIComponent(plan.srcFile)}&slot=${i}`)
      : await api(plan.session ? `session/preview?slot=${i}` : `plan/preview?key=${plan.sim.key}&slot=${i}`);
    drawPreview(p, side);
  } catch (e) { /* preview is best-effort */ }
}
function drawPreview(p, side) {
  $('preview-title').textContent = `Preview (${side === 'src' ? 'source' : plan.session ? 'destination' : 'destination, planned'}) ${p.label} "${p.name}" · ${p.trigs} trigs`;
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
  hoverTimer = setTimeout(() => showPreview(c.dataset.side, +c.dataset.i), 120);
}
for (const side of ['src', 'dst']) {
  const g = $(side + '-grid'); buildGrid(g, side);
  g.addEventListener('mouseover', hover);
  g.addEventListener('click', e => {
    const c = e.target.closest('.cell'); if (!c) return;
    const i = +c.dataset.i; state.lastSel = i;
    if (side === 'src') plan.srcSel = i;
    else { plan.dstSel = i; if (plan.srcSel !== null) addOp(plan.srcSel, i); }
    render(); showPreview(side, i);
  });
}
$('src-grid').addEventListener('dragstart', e => {
  const c = e.target.closest('.cell'); if (!c) return;
  plan.srcSel = +c.dataset.i; e.dataTransfer.setData('text/plain', c.dataset.i); render();
});
$('dst-grid').addEventListener('dragover', e => { if (e.target.closest('.cell')) e.preventDefault(); });
$('dst-grid').addEventListener('drop', e => {
  const c = e.target.closest('.cell'); if (!c) return; e.preventDefault();
  plan.dstSel = +c.dataset.i; if (plan.srcSel !== null) addOp(plan.srcSel, plan.dstSel);
  render();
});

// ---------- pane controls ----------
for (const side of ['src', 'dst']) {
  document.querySelectorAll(`input[name="${side}-mode"]`).forEach(r => { r.onchange = () => setMode(side, r.value); });
  $(`${side}-dev`).onchange = updateButtons;
  $(`${side}-dev-read`).onclick = () => readDevicePick(side);
}
$('src-pick').onchange = () => setSource($('src-pick').value, 'local');
$('dst-pick').onchange = () => setDest($('dst-pick').value, 'local');

// ---------- run ----------
function runDialog(mode) {
  return new Promise(resolve => {
    const dlg = $('run-dialog'), isRun = mode === 'run';
    const o = plan.dest && deviceOrigin(plan.dest.fileId);
    $('run-title').textContent = isRun ? 'Run queue' : 'Outputs for the working copy';
    $('run-desc').innerHTML = isRun ? `${plan.queue.length} operation(s) will be applied to ${esc(sourceLabel(plan.dest.fileId, plan.dest.kind))}. Choose what to do with the result:`
      : 'Choose what to do with the working copy:';
    $('out-dir').textContent = outName();
    $('out-save').checked = true; $('save-name').value = '';
    const empties = (state.devList || []).filter(p => p.empty);
    const why = !D.connected() ? 'connect to the Syntakt in the Device panel first' : !D.canWrite() ? 'this elektron-rpc.js cannot write' : !empties.length ? 'no empty slot on the device' : '';
    $('out-slot').innerHTML = empties.map(p => `<option value="${p.slot}">${pad3(p.slot)}</option>`).join('');
    $('out-dev').checked = false; $('out-dev').disabled = !!why; $('out-slot').disabled = !!why; $('out-dev-why').textContent = why;
    $('out-orig').textContent = plan.dest?.kind === 'device' && o ? ` Your original stays untouched in slot ${pad3(o.slot)}.` : ' Your original project stays untouched.';
    $('run-go').textContent = isRun ? 'Run' : 'Go';
    const done = v => { dlg.close(); resolve(v); };
    $('run-go').onclick = () => done({ save: $('out-save').checked, name: $('save-name').value.trim(), devSlot: $('out-dev').checked ? +$('out-slot').value : null });
    $('run-cancel').onclick = () => done(null);
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}
async function doOutputs(opts, summary) {
  plan.outputsBusy = true; render();
  try { await runOutputs(opts, summary); }
  finally { plan.outputsBusy = false; plan.summary = summary; render(); persist(); }
}
async function runOutputs(opts, summary) {
  if (opts.save) {
    try {
      const r = await api('session/save', { name: opts.name });
      plan.session = r; plan.savedAs = r.saved; summary.save = { file: r.saved.split('/').pop() };
      log('Saved ' + r.saved, 'ok', 'local'); await loadProjects(true);
    } catch (e) { summary.save = { error: e.message }; log('save failed: ' + e.message, 'err', 'local'); }
  }
  if (opts.devSlot) {
    try {
      const rev = plan.session.revision;
      const src = await D.fetchPayload('session', rev.id);  // 409 if the working copy no longer is the validated result
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', src.bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== rev.sha) throw new Error(`payload does not match the validated result (sha256 ${digest.slice(0, 12)} ≠ ${rev.sha.slice(0, 12)}); nothing was written`);
      const ver = '0x' + src.version.toString(16).toUpperCase().padStart(2, '0');
      if (!confirm(`Write ${src.name} (rev ${rev.n} · ${rev.sha.slice(0, 8)}, v${ver}) to slot ${pad3(opts.devSlot)}?\n\nSlot ${pad3(opts.devSlot)} is empty. The device keeps its other projects.`)) {
        summary.device = { slot: opts.devSlot, cancelled: true };
      } else {
        const w = await D.writeSlot(opts.devSlot, src.bytes, `${src.name} (working copy, rev ${rev.n})`);
        summary.device = { slot: opts.devSlot, ...w };
      }
    } catch (e) { summary.device = { slot: opts.devSlot, error: e.message }; log('device write failed: ' + e.message, 'err', 'dev'); }
  }
}
async function runQueue() {
  if ($('run').disabled || plan.outputsBusy) return;
  const opts = await runDialog('run'); if (!opts) return;
  let r;
  try { r = await api('plan/run', { destFileId: plan.dest.fileId, ops: plan.queue }); }
  catch (e) {
    log('run refused: ' + e.message, 'err', 'local');
    if (e.data?.results) plan.sim = { ok: false, results: e.data.results, project: (plan.sim ?? plan.view)?.project };
    render(); revalidate(); return;
  }
  plan.session = r; plan.ranOps = plan.queue; plan.queue = []; plan.sim = null; plan.savedAs = null;
  log(`Queue run: ${plan.ranOps.length} operation(s) applied to the working copy`, 'ok', 'local');
  (r.warnings || []).forEach(w => log('warning: ' + w, 'warn', 'local'));
  await doOutputs(opts, { ops: plan.ranOps.length, warnings: r.warnings || [] });
}
async function discardSession() {
  try { await api('session/discard', {}); } catch (e) { log(e.message, 'err', 'local'); }
  plan.session = null; plan.summary = null; plan.savedAs = null;
}
$('run').onclick = runQueue;
$('outputs').onclick = async () => {
  if (plan.outputsBusy) return;
  const opts = await runDialog('outputs'); if (!opts) return;
  await doOutputs(opts, { ...(plan.summary || { ops: plan.ranOps.length, warnings: [] }), save: null, device: null });
};
$('undo-run').onclick = async () => {
  if (plan.outputsBusy) return;
  await discardSession();
  plan.queue = plan.ranOps; plan.ranOps = [];
  log('Run undone: working copy discarded, queue restored (saved files and device writes are not undone)', '', 'local');
  queueChanged();
};
$('new-queue').onclick = async () => {
  if (plan.outputsBusy) return;
  if (!confirm('Discard the working copy and start a new queue? (Saved files and device writes stay.)')) return;
  await discardSession(); plan.queue = []; plan.ranOps = []; queueChanged();
};

// ---------- MIDI ----------
const midi = new Midi({
  onStatus: t => { $('midi-status').textContent = 'MIDI: ' + t; },
  onProgram: (p, ch) => { state.deviceSlot = p; log(`Device Program Change ${p} (${lbl(p)}) on ch ${ch}`, '', 'dev'); render(); },
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

// ---------- boot ----------
Object.assign(hooks, {
  loadProjects,
  useLocal: (role, id) => role === 'src' ? setSource(id, 'local') : setDest(id, 'local'),
  useDevice: (role, id) => role === 'src' ? setSource(id, 'device') : setDest(id, 'device'),
  getSession: () => plan.session,
  getSrcFile: () => plan.srcFile,
  onDeviceList: populateDevSelects,
  onBusy: updateButtons,
});
D.initDevice({ midi, fillPorts });

const toInt = v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isInteger(Number(v)) ? Number(v) : NaN;
const inRange = v => v >= 0 && v <= 127;
/** Coerce an op loaded from storage; null if it is malformed (slots must be integers 0..127). */
function sanitizeOp(o) {
  if (!o || typeof o !== 'object' || typeof o.sourceFileId !== 'string') return null;
  const src = toInt(o.srcSlot), dst = toInt(o.dstSlot), kit = o.kitSlot == null ? dst : toInt(o.kitSlot);
  if (![src, dst, kit].every(inRange)) return null;
  return { sourceFileId: o.sourceFileId, sourceKind: o.sourceKind === 'device' ? 'device' : 'local', sourceLabel: String(o.sourceLabel ?? ''),
    srcProjName: String(o.srcProjName ?? ''), patName: String(o.patName ?? ''), srcSlot: src, dstSlot: dst, kitSlot: kit, force: o.force === true };
}
const sanitizeOps = list => (Array.isArray(list) ? list : []).map(sanitizeOp).filter(Boolean);

async function restore() {
  const [{ plan: saved, rev }, sess] = await Promise.all([api('plan'), api('session')]);
  planRev = rev ?? 0;
  const savedDest = saved?.dest && typeof saved.dest.fileId === 'string' && projOf(saved.dest.fileId)
    ? { fileId: saved.dest.fileId, kind: saved.dest.kind === 'device' ? 'device' : 'local' } : null;
  plan.session = sess.open ? sess : null; plan.summary = null; plan.sim = null; plan.view = null;
  plan.queue = sanitizeOps(saved?.queue); plan.ranOps = sanitizeOps(saved?.ranOps); plan.savedAs = saved?.savedAs || null;
  if (sess.open) {
    // The open working copy is authoritative: the destination must be the file it was run on.
    const same = savedDest?.fileId === sess.file;
    plan.dest = same ? savedDest : { fileId: sess.file, kind: 'local' };
    if (!same) { plan.queue = []; plan.ranOps = []; plan.savedAs = null; }
  } else plan.dest = savedDest;
  if (plan.dest) { setMode('dst', plan.dest.kind); if (plan.dest.kind === 'local') $('dst-pick').value = plan.dest.fileId; }
  if (saved?.srcFile && typeof saved.srcFile === 'string' && projOf(saved.srcFile)) await setSource(saved.srcFile, saved.srcKind === 'device' ? 'device' : 'local', true);
  if (plan.queue.length || sess.open) log(sess.open ? 'Restored the run result (working copy) from the server' : `Restored a queue of ${plan.queue.length} operation(s) from the server`, '', 'local');
  render(); await revalidate();
}
render();
loadProjects().then(restore).catch(e => log(e.message, 'err', 'local'));
