// Icon helpers. The two symbols (#i-folder, #i-device) are defined once in the <svg> sprite in index.html.
// Folder = LOCAL file on this computer; device = ON THE SYNTAKT.
const KINDS = {
  folder: { cls: 'local', label: 'Local file' },
  device: { cls: 'dev', label: 'On Syntakt' },
};

export function icon(kind) {
  const k = KINDS[kind];
  return `<svg class="ico ${k.cls}" role="img" aria-label="${k.label}"><title>${k.label}</title><use href="#i-${kind}"/></svg>`;
}
export const folderIcon = icon('folder');
export const deviceIcon = icon('device');

export const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Escape text, then expand {dev} / {dir} tokens into icons (safe: tokens are only expanded after escaping). */
export const rich = t => esc(t).replace(/\{dev\}/g, deviceIcon).replace(/\{dir\}/g, folderIcon);

/** Small decorative UI glyph from the sprite (check, x, warn, up, down); always paired with text or an aria-label. */
export const ui = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
