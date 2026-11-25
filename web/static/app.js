// Pattern mover UI: pick a source and a base (destination) project -- each a local file or a Syntakt slot --
// queue many pattern copies, validate the whole queue on the server, then run it once.
import { Midi } from './midi.js';
import { esc, icon, folderIcon, deviceIcon, ui } from './icons.js';
import { $, BANKS, lbl, pad3, verText, state, hooks, log, api, projOf, outName, fileOf, deviceOrigin, TEMPLATE_NOTE } from './common.js';
import * as D from './device.js';

const TEMPLATE_ID = 'template';
// Same rule as web/blank.py: 1-15 characters from A-Z 0-9 space - = #, no leading or trailing space.
const validTemplateName = n => typeof n === 'string' && /^[A-Z0-9 =#-]{1,15}$/.test(n) && n === n.trim();
const isTemplate = () => plan.dest?.kind === 'template';
const destRequest = () => ({ destFileId: plan.dest.fileId, ...(isTemplate() ? { templateName: plan.dest.name } : {}) });

const plan = {
  src: null, srcFile: null, srcKind: 'local', srcSel: null, dstSel: null,
  dest: null,        // the base project the queue is applied to: { fileId, kind: 'local' | 'device' } for a file, or
                     // { fileId: 'template', kind: 'template', slot, name }: a blank project for the EMPTY device slot `slot`
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
function destLabel() {
  if (isTemplate()) return `a new blank project "${plan.dest.name}"${plan.dest.slot ? ` for empty slot ${pad3(plan.dest.slot)}` : ''}`;
  return sourceLabel(plan.dest.fileId, plan.dest.kind);
}
function templateWhereHtml(extra) {
  const d = plan.dest, row = d.slot && state.devList?.find(p => p.slot === d.slot);
  const taken = row && !row.empty ? ' <span class="unsaved" title="The device list shows this slot as occupied now; it cannot be written again">slot is no longer empty</span>' : '';
  return `${deviceIcon}<span><b>New</b> blank project ${d.slot ? `for empty slot <b>${pad3(d.slot)}</b>` : ''}</span><span class="tag">blank template</span>${taken}${extra}`;
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
    if (!cur.text || !r.ok) cur.text = `${r.ok ? "←" : "✗"} #${i + 1}`;
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
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
let queueErr = '';  // last validation/run refusal, shown as a banner above the queue
function opRowHtml(op, i, r, locked) {
  const kind = op.sourceKind === 'device' ? 'device' : 'folder';
  const cls = locked ? 'ok' : !r ? '' : r.ok ? 'ok' : `bad${r.forceable ? ' needforce' : ''}`;
  const status = locked ? `<span class="st">${ui('check')}applied</span>`
    : !r ? '<span class="st">validating…</span>'
    : r.ok ? (r.warnings.length ? `<span class="st wn">${ui('warn')}${plural(r.warnings.length, 'warning')}</span>` : `<span class="st">${ui('check')}ok</span>`)
    : `<span class="st err">${ui('x')}can't apply</span>`;
  const controls = locked ? '' : `
    <span class="opts"><label>kit <input class="kit" name="kit-${i}" aria-label="Kit slot for operation ${i + 1}" type="number" min="1" max="128" value="${Number(op.kitSlot) + 1}" data-i="${i}"></label>
    <label class="force" title="Override refusals (non-empty destination, shared/duplicate kit or slot, lossy conversion)"><input type="checkbox" class="force" name="force-${i}" data-i="${i}" ${op.force ? 'checked' : ''}> force</label></span>`;
  const buttons = locked ? '' : `<span class="btns"><button data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move operation ${i + 1} up">${ui('up')}</button><button data-act="down" data-i="${i}" ${i === plan.queue.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move operation ${i + 1} down">${ui('down')}</button><button data-act="rm" data-i="${i}" title="Remove from queue" aria-label="Remove operation ${i + 1} from the queue">${ui('x')}</button></span>`;
  const msgs = locked || !r ? '' : (r.ok ? r.warnings.map(w => `<div class="msg warn">${ui('warn')}<span>${esc(w)}</span></div>`)
    : [`<div class="msg err">${ui('x')}<span>${esc(r.error)}${r.forceable && !/force/i.test(r.error) ? ' Tick “force” to apply it anyway.' : ''}</span></div>`]).join('');
  return `<li class="${cls}"><span class="n">${i + 1}</span>`
    + `<span class="route" title="${esc(op.sourceLabel)}"><b>${lbl(op.srcSlot)}</b> <span class="pn">${esc(op.patName)}</span><span class="arrow">→</span><b>${lbl(op.dstSlot)}</b>${locked ? ` <span class="tag">kit ${Number(op.kitSlot) + 1}</span>` : ''}</span>`
    + `<span class="srcname" title="${esc(op.sourceLabel)}">${icon(kind)}<span>${esc(op.sourceLabel)}</span></span>${controls}${status}${buttons}${msgs}</li>`;
}
function renderQueue() {
  const locked = !!plan.session, ops = locked ? plan.ranOps : plan.queue;
  $('queue-list').innerHTML = ops.map((op, i) => opRowHtml(op, i, plan.sim?.results[i], locked)).join('');
  const bad = plan.sim ? plan.sim.results.filter(r => !r.ok).length : 0;
  $('queue-count').textContent = ops.length ? `${plural(ops.length, 'operation')}${locked ? ' — run' : bad ? ` — ${plural(bad, 'error')}` : ''}` : '';
  $('queue-note').hidden = ops.length > 0 || locked;
  const eb = $('queue-error');
  eb.hidden = !queueErr || locked;
  eb.innerHTML = queueErr ? `${ui('x')}<span>${esc(queueErr)}</span>` : '';
}
let warnsOpen = null;  // the user's choice for the folded warnings, kept across re-renders
$('run-summary').addEventListener('toggle', e => { if (e.target.matches('details.warns')) warnsOpen = e.target.open; }, true);
function renderSummary() {
  const s = plan.summary, box = $('run-summary');
  box.hidden = !s;
  if (!s) return;
  const line = (cls, icon_, html) => `<div class="line ${cls}">${icon_}<span>${html}</span></div>`;
  const lines = [line('good', ui('check'), `${plural(s.ops, 'operation')} applied to the working copy${s.warnings.length ? `, ${plural(s.warnings.length, 'warning')}` : ''}`)];
  const warnLines = s.warnings.map(w => line('warn', ui('warn'), esc(w)));
  if (s.save) lines.push(s.save.error ? line('bad', folderIcon, `not saved: ${esc(s.save.error)}`) : line('good', folderIcon, `saved: <b>${esc(s.save.file)}</b>`));
  if (s.device) {
    const d = s.device;
    lines.push(d.cancelled ? line('', deviceIcon, `device write to slot ${pad3(d.slot)} cancelled`)
      : d.partialWrite ? line('bad', deviceIcon, `PARTIAL write — check slot ${pad3(d.slot)} on the device (it may hold an incomplete project): ${esc(d.error)}`)
      : d.writeCompleted ? line('bad', deviceIcon, `written to slot ${pad3(d.slot)}, NOT verified (read-back failed): ${esc(d.error)}`)
      : d.error ? line('bad', deviceIcon, `device write failed (nothing written): ${esc(d.error)}`)
      : d.verified === true ? line('good', deviceIcon, `written to Syntakt slot <b>${pad3(d.slot)}</b> · verified ${ui('check')}${d.rawIdentical === false ? ' (device re-compressed the file; project contents identical)' : ''}`)
      : d.verified === false && d.imageError ? line('bad', deviceIcon, `written to slot ${pad3(d.slot)} but the read-back could not be compared (${esc(d.imageError)}; read back ${d.readbackSize ?? '?'} bytes)`)
      : d.verified === false ? line('bad', deviceIcon, `written to slot ${pad3(d.slot)} but VERIFY FAILED (${d.mismatches.length} difference(s) in the project contents)`)
      : line('', deviceIcon, `written to slot ${pad3(d.slot)} (not verified)`));
  }
  // Outcomes first; the (informational) warnings follow, folded away when there are many.
  if (warnLines.length) lines.push(`<details class="warns"${(warnsOpen ?? warnLines.length <= 2) ? ' open' : ''}><summary class="warn">${ui('warn')}${plural(warnLines.length, 'warning')}</summary>${warnLines.join('')}</details>`);
  lines.push('<div class="tag">Undo run reverts only the local working copy; saved files and device writes are not undone.</div>');
  box.innerHTML = lines.join('');
}
function updateButtons() {
  const busy = D.dev.busy || plan.outputsBusy, locked = !!plan.session;
  $('run').disabled = busy || locked || !plan.dest || !plan.queue.length || !plan.sim?.ok;
  $('run').hidden = locked;
  $('clear-queue').disabled = busy || !plan.queue.length; $('clear-queue').hidden = locked;
  for (const id of ['undo-run', 'outputs', 'new-queue']) { $(id).hidden = !locked; $(id).disabled = busy; }
  $('outputs').classList.toggle('primary', locked);
  const blocked = !locked && plan.queue.length && plan.sim && !plan.sim.ok;
  const hint = $('queue-hint');
  hint.textContent = locked ? 'The result is a working copy. Use Outputs… to save it or write it to the Syntakt.'
    : !plan.dest ? 'Choose a destination project first.' : blocked ? 'Fix or force the operations marked “can’t apply” to enable Run.' : '';
  hint.classList.toggle('bad', !!blocked);
  for (const side of ['src', 'dst']) $(`${side}-dev-read`).disabled = busy || !D.connected() || !$(`${side}-dev`).value;
  $('dst-tpl-name').disabled = busy;
}
function render() {
  paint($('src-grid'), plan.src?.slots, plan.srcSel);
  paint($('dst-grid'), destSlots(), plan.dstSel, plannedCells());
  const dv = destVersion();
  const cross = plan.src && dv && plan.src.version !== dv ? ` <span class="tag" title="Pattern and kit are converted when copied">⚠ ${verText(plan.src.version)} → ${verText(dv)} converted</span>` : '';
  $('src-where').innerHTML = plan.srcFile ? whereHtml(plan.srcFile, plan.srcKind, `<span class="ver">${plan.src ? esc(plan.src.name) + ' · ' + verText(plan.src.version) : ''}</span>${cross}`) : '';
  const state_ = plan.session ? ` <span class="tag">working copy (run result)</span>${plan.savedAs ? '' : ' <span class="unsaved" title="Not saved to a file yet">● unsaved</span>'}`
    : plan.queue.length ? ' <span class="tag">+ planned changes (not written)</span>' : '';
  const dstExtra = `<span class="ver">${dv ? verText(dv) : ''}</span>${state_}`;
  $('dst-where').innerHTML = !plan.dest ? '' : isTemplate() ? templateWhereHtml(dstExtra) : whereHtml(plan.dest.fileId, plan.dest.kind, dstExtra);
  $('dst-head').innerHTML = isTemplate() ? `${deviceIcon} NEW: ${esc(plan.dest.name)}${plan.dest.slot ? ` → slot ${pad3(plan.dest.slot)}` : ''}` : '';
  $('src-empty').hidden = !!plan.src; $('dst-empty').hidden = !!destSlots();
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
    const r = await api('plan/validate', { ...destRequest(), ops: plan.queue });
    if (seq !== valSeq) return;
    plan.sim = r; plan.view = r;
  } catch (e) {
    if (seq !== valSeq) return;
    plan.sim = null; queueErr = 'Validation failed: ' + e.message; log('validation failed: ' + e.message, 'err', 'local');
  }
  render();
}
function queueChanged() { plan.sim = null; queueErr = ''; render(); revalidate(); persist(); }

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
async function setDest(fileId, kind, extra = {}) {
  if (plan.session && !confirm('Leave the run result? The working copy is discarded (saved files and device writes stay).')) { $('dst-pick').value = isTemplate() ? '' : plan.dest.fileId; return; }
  if (plan.session) await discardSession();
  plan.dest = fileId ? { fileId, kind, ...extra } : null; plan.dstSel = null; plan.sim = null; plan.view = null; queueErr = '';
  if (fileId && kind === 'local') $('dst-pick').value = fileId;
  if (fileId) setMode('dst', kind === 'template' ? 'device' : kind);
  updateDstDevUi(); render(); await revalidate(); persist();
}
function setMode(side, mode) {
  document.querySelector(`input[name="${side}-mode"][value="${mode}"]`).checked = true;
  $(`${side}-local-row`).hidden = mode !== 'local'; $(`${side}-dev-row`).hidden = mode !== 'device';
  if (side === 'dst') updateDstDevUi();
}
function populateDevSelects() {
  const opt = (p, empty) => `<option value="${p.slot}" data-empty="${empty ? 1 : 0}" data-name="${esc(p.name)}">${pad3(p.slot)} ${empty ? '— new project (blank template)' : esc(p.name)}</option>`;
  const list = state.devList;
  const sel = $('src-dev'), keep = sel.value;
  sel.innerHTML = list ? '<option value="">— choose an occupied slot —</option>' + list.filter(p => !p.empty).map(p => opt(p, false)).join('')
    : '<option value="">— connect to the Syntakt in the Device panel first —</option>';
  sel.value = keep;
  const dsel = $('dst-dev'), dkeep = dsel.value;
  dsel.innerHTML = list ? '<option value="">— choose a slot —</option>'
    + `<optgroup label="Occupied: read the project and back it up">${list.filter(p => !p.empty).map(p => opt(p, false)).join('')}</optgroup>`
    + `<optgroup label="Empty: start a new blank project">${list.filter(p => p.empty).map(p => opt(p, true)).join('')}</optgroup>`
    : '<option value="">— connect to the Syntakt in the Device panel first —</option>';
  dsel.value = dkeep;
  updateDstDevUi();
}
/** Destination "Syntakt" row: an occupied slot is read and backed up; an empty slot starts a blank project. */
function updateDstDevUi() {
  const sel = $('dst-dev'), o = sel.selectedOptions[0], empty = !!o && o.dataset.empty === '1' && !!sel.value;
  $('dst-tpl-name').hidden = !empty;
  $('dst-dev-read').textContent = empty ? 'Create blank project' : 'Read & back up';
  $('dst-dev-read').title = empty ? 'Start a new blank project for this empty slot. Nothing is written until you run the queue and choose "Write to Syntakt".'
    : 'Reads the project from the device (the device is not modified) and saves a local backup that is used as the base';
  // For a template destination the hint describes plan.dest (the project that will be written), not the dropdown.
  const hint = $('dst-hint');
  hint.hidden = $('dst-dev-row').hidden || !(isTemplate() || empty);
  if (isTemplate()) hint.textContent = plan.dest.slot
    ? `New project "${plan.dest.name}" in slot ${pad3(plan.dest.slot)} (blank template). Running the queue can write it only into this empty slot (re-checked right before writing).`
    : `New project "${plan.dest.name}" (blank template). Its slot is unknown (the page was reloaded): create the blank project again to write it to the device. It can still be saved to a file.`;
  else if (empty) hint.textContent = `Create a blank project for empty slot ${pad3(+sel.value)}. Running the queue can then write it only into that slot (re-checked right before writing).`;
  updateButtons();
}
async function readDevicePick(side) {
  const sel = $(`${side}-dev`), slot = +sel.value; if (!slot) return;
  if (side === 'dst' && sel.selectedOptions[0].dataset.empty === '1') return createTemplate(slot);
  const r = await D.readSlot(slot, sel.selectedOptions[0].dataset.name);
  if (!r?.id) return;
  if (side === 'src') await setSource(r.id, 'device'); else await setDest(r.id, 'device');
}
async function createTemplate(slot) {
  const input = $('dst-tpl-name'), name = input.value;
  input.classList.toggle('bad', !validTemplateName(name));
  if (!validTemplateName(name)) return log('Project name: 1-15 characters from A-Z 0-9 space - = #, no leading or trailing space.', 'err', 'dev');
  const row = state.devList?.find(p => p.slot === slot);
  if (!row?.empty) return log(`Slot ${pad3(slot)} is not empty; only empty slots can receive a new project.`, 'err', 'dev');
  await setDest(TEMPLATE_ID, 'template', { slot, name });
  if (plan.dest?.kind === 'template') log(`New blank project "${name}" for empty slot ${pad3(slot)} (nothing is written until you run the queue)`, 'ok', 'dev');
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
    if (s % 4 === 0) {  // beat marker (steps 1, 5, 9, ...): the grid's inner frame, drawn at 1.5 canvas px because the canvas is shown at about half size
      g.strokeStyle = on ? '#fff2d2' : '#5f687a'; g.lineWidth = 1.5;
      g.strokeRect(s * cw + 1, t * ch + 1, cw - 3, ch - 3);
    }
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
  $(`${side}-dev`).onchange = updateDstDevUi;
  $(`${side}-dev-read`).onclick = () => readDevicePick(side);
}
$('dst-tpl-name').addEventListener('input', e => {
  const el = e.target, v = el.value.toUpperCase();
  if (v !== el.value) el.value = v;
  el.classList.toggle('bad', !validTemplateName(el.value));
});
$('dst-tpl-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('dst-dev-read').click(); } });
$('src-pick').onchange = () => setSource($('src-pick').value, 'local');
$('dst-pick').onchange = () => setDest($('dst-pick').value, 'local');

// ---------- run ----------
function runDialog(mode) {
  return new Promise(resolve => {
    const dlg = $('run-dialog'), isRun = mode === 'run';
    const tpl = isTemplate(), locked = tpl && plan.dest.slot ? plan.dest.slot : null, lostSlot = tpl && !locked;
    const o = plan.dest && !tpl && deviceOrigin(plan.dest.fileId);
    $('run-title').textContent = isRun ? 'Run queue' : 'Outputs for the working copy';
    $('run-desc').innerHTML = isRun ? `${plan.queue.length} operation${plan.queue.length === 1 ? '' : 's'} will be applied to ${esc(destLabel())}. Choose what to do with the result; untick both to only apply it to the working copy.`
      : 'Choose what to do with the working copy:';
    $('out-dir').textContent = outName();
    $('out-save').checked = true; $('save-name').value = '';
    const empties = (state.devList || []).filter(p => p.empty);
    let why;
    if (locked) {
      const row = state.devList?.find(p => p.slot === locked);
      why = !D.connected() ? 'connect to the Syntakt in the Device panel first' : !D.canWrite() ? 'this elektron-rpc.js cannot write'
        : !row ? `slot ${pad3(locked)} is not in the device list` : !row.empty ? `slot ${pad3(locked)} is not empty any more` : '';
      $('out-slot').innerHTML = `<option value="${locked}">${pad3(locked)}</option>`;
    } else {
      why = lostSlot ? 'the slot of this new project was lost on reload: create the blank project again to write it to the device'
        : !D.connected() ? 'connect to the Syntakt in the Device panel first' : !D.canWrite() ? 'this elektron-rpc.js cannot write' : !empties.length ? 'no empty slot on the device' : '';
      $('out-slot').innerHTML = lostSlot ? '' : empties.map(p => `<option value="${p.slot}">${pad3(p.slot)}</option>`).join('');
    }
    $('out-dev').checked = false; $('out-dev').disabled = !!why;  // never pre-ticked: the user opts in to a device write
    $('out-slot').disabled = !!why || !!locked;  // a blank project goes only into the slot it was created for
    $('out-dev-why').textContent = why || (locked ? `locked to slot ${pad3(locked)}, the slot this new project was created for` : '');
    $('out-orig').textContent = tpl ? ' The new project goes only into the slot shown; no other slot is touched.'
      : plan.dest?.kind === 'device' && o ? ` Your original stays untouched in slot ${pad3(o.slot)}.` : ' Your original project stays untouched.';
    $('run-go').textContent = isRun ? 'Run' : 'Save / write';
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
      if (isTemplate() && !plan.dest.slot) throw new Error('the slot of this new project is unknown; create the blank project again. Nothing was written');
      if (isTemplate() && opts.devSlot !== plan.dest.slot) throw new Error(`a new project for slot ${pad3(plan.dest.slot)} can only be written to that slot; nothing was written`);
      const rev = plan.session.revision;
      const src = await D.fetchPayload('session', rev.id);  // 409 if the working copy no longer is the validated result
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', src.bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== rev.sha) throw new Error(`payload does not match the validated result (sha256 ${digest.slice(0, 12)} ≠ ${rev.sha.slice(0, 12)}); nothing was written`);
      const ver = '0x' + src.version.toString(16).toUpperCase().padStart(2, '0');
      const tplNote = isTemplate() ? `\n\n${TEMPLATE_NOTE}` : '';
      if (!confirm(`Write ${src.name} (rev ${rev.n} · ${rev.sha.slice(0, 8)}, v${ver}) to slot ${pad3(opts.devSlot)}?\n\nSlot ${pad3(opts.devSlot)} is empty. The device keeps its other projects.${tplNote}`)) {
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
  try { r = await api('plan/run', { ...destRequest(), ops: plan.queue }); }
  catch (e) {
    queueErr = 'Run refused, nothing was applied: ' + e.message; log('run refused: ' + e.message, 'err', 'local');
    if (e.data?.results) plan.sim = { ok: false, results: e.data.results, project: (plan.sim ?? plan.view)?.project };
    render(); revalidate(); return;
  }
  plan.session = r; plan.ranOps = plan.queue; plan.queue = []; plan.sim = null; plan.savedAs = null; warnsOpen = null;
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
  onStatus: t => { $('midi-status').textContent = t; },
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
  templateSession: () => (plan.session && isTemplate() ? { slot: plan.dest.slot || 0 } : null),
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

const isTemplateDest = d => d?.kind === 'template';
/** A destination loaded from storage: a known project file, or a blank template with a valid name and slot. */
function sanitizeDest(d) {
  if (!d || typeof d.fileId !== 'string') return null;
  if (d.fileId === TEMPLATE_ID) {
    const slot = toInt(d.slot);
    if (!validTemplateName(d.name)) return null;
    return { fileId: TEMPLATE_ID, kind: 'template', slot: slot >= 1 && slot <= 128 ? slot : null, name: d.name };
  }
  return projOf(d.fileId) ? { fileId: d.fileId, kind: d.kind === 'device' ? 'device' : 'local' } : null;
}

async function restore() {
  const [{ plan: saved, rev }, sess] = await Promise.all([api('plan'), api('session')]);
  planRev = rev ?? 0;
  const savedDest = sanitizeDest(saved?.dest);
  plan.session = sess.open ? sess : null; plan.summary = null; plan.sim = null; plan.view = null;
  plan.queue = sanitizeOps(saved?.queue); plan.ranOps = sanitizeOps(saved?.ranOps); plan.savedAs = saved?.savedAs || null;
  if (sess.open) {
    // The open working copy is authoritative: the destination must be the file it was run on.
    const same = savedDest?.fileId === sess.file && (!isTemplateDest(savedDest) || savedDest.name === sess.template?.name);
    plan.dest = same ? savedDest : sess.file === TEMPLATE_ID ? { fileId: TEMPLATE_ID, kind: 'template', slot: null, name: sess.template?.name || 'NEW PROJECT' }
      : { fileId: sess.file, kind: 'local' };
    if (!same) { plan.queue = []; plan.ranOps = []; plan.savedAs = null; }
  } else plan.dest = savedDest;
  if (plan.dest) { setMode('dst', plan.dest.kind === 'template' ? 'device' : plan.dest.kind); if (plan.dest.kind === 'local') $('dst-pick').value = plan.dest.fileId; }
  if (saved?.srcFile && typeof saved.srcFile === 'string' && projOf(saved.srcFile)) await setSource(saved.srcFile, saved.srcKind === 'device' ? 'device' : 'local', true);
  if (plan.dest?.kind === 'template' && !plan.dest.slot) log('Restored a blank project whose slot was not stored: it cannot be written to the device. Create the blank project again to write it (saving to a file still works).', 'warn', 'dev');
  if (plan.queue.length || sess.open) log(sess.open ? 'Restored the run result (working copy) from the server' : `Restored a queue of ${plan.queue.length} operation(s) from the server`, '', 'local');
  render(); await revalidate();
}
render();
loadProjects().then(restore).catch(e => log(e.message, 'err', 'local'));
