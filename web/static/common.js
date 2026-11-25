// Shared helpers and state for the UI modules (app.js, device.js).
import { rich, folderIcon, deviceIcon } from './icons.js';

export const $ = id => document.getElementById(id);
export const BANKS = 'ABCDEFGH';
export const lbl = i => `${BANKS[i >> 4]}${String(i % 16 + 1).padStart(2, '0')}`;
export const pad3 = n => String(n).padStart(3, '0');
export const verText = v => `v0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
export const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

/** projects: /api/projects list; devList: device project slots (null until connected); deviceSlot: pattern the device selected. */
export const state = { projects: null, outputDir: '', devList: null, deviceSlot: null, lastSel: null };
/** Callbacks wired up by app.js so device.js does not import it. */
export const hooks = {};

// kind: 'dev' (operation on the Syntakt) or 'local' (file on this computer) prefixes the matching icon;
// {dev}/{dir} tokens inside msg are expanded to icons too.
const logCounts = { err: 0, warn: 0 };
export function log(msg, cls = '', kind = '') {
  const d = document.createElement('div'); if (cls) d.className = cls;
  const pre = kind === 'dev' ? deviceIcon : kind === 'local' ? folderIcon : '';
  d.innerHTML = `<span class="ts">${new Date().toLocaleTimeString()}</span> ${pre}${rich(msg)}`;
  $('log').prepend(d);
  // The log is collapsed: its summary carries the latest message and error/warning counts, and an error opens it.
  if (logCounts[cls] !== undefined) logCounts[cls]++;
  const n = (c, w) => c ? `${c} ${w}${c === 1 ? '' : 's'}` : '';
  $('log-count').textContent = [n(logCounts.err, 'error'), n(logCounts.warn, 'warning')].filter(Boolean).join(', ');
  if (!msg.startsWith('rpc:')) {
    const last = $('log-last'); last.className = 'log-last' + (cls === 'err' || cls === 'warn' ? ' ' + cls : '');
    last.innerHTML = `${pre}${rich(msg)}`;
  }
  if (cls === 'err') $('log-box').open = true;
}
export async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.data = j; e.status = r.status; throw e; }
  return j;
}
export const projOf = id => state.projects?.find(p => p.id === id);
export const outName = () => (state.outputDir || 'OUTPUT').split('/').filter(Boolean).pop();
export const fileOf = id => id.split('/').slice(1).join('/');

// Device backups are written as "NNN NAME (device backup YYYY-MM-DD HHMMSS).stprj"; recover the origin from the name.
const BACKUP_NAME = /^(\d{3}) (.*) \(device backup (\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})(\d{2})\)\.stprj$/;
export function deviceOrigin(fileId) {
  const m = BACKUP_NAME.exec(fileOf(fileId));
  return m ? { slot: +m[1], name: m[2], date: m[3], time: `${m[4]}:${m[5]}` } : null;
}

/** Added to every confirm that writes a blank-template project to the device. */
export const TEMPLATE_NOTE = "This is a new project built from SynPat's blank template (derived by SynPat, first tested on hardware in slot 125). It is not a copy of an existing project.";
