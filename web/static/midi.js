// WebMIDI module: port access, port selection, Program Change send/receive.
// Starts with sysex:false. requestSysexAccess() upgrades to sysex:true and must only be called
// from a user click (the browser shows its own permission prompt); selected ports are re-selected by id.
// SysEx RPC lives in elektron-rpc.js, which attaches to the ports via addEventListener; this module
// keeps owning input.onmidimessage (Program Change), so the two do not clobber each other.
export class Midi {
  constructor({ onStatus, onProgram }) {
    this.onStatus = onStatus; this.onProgram = onProgram;
    this.access = null; this.sysex = false; this.out = null; this.inp = null; this.channel = 10;
  }
  /** Upgrade to SysEx access. Call ONLY from a user click (browser shows a permission prompt).
   *  Ports from the old access object are replaced; callers re-select by id (see fillPorts in app.js). */
  async requestSysexAccess() {
    if (this.sysex) return true;
    const had = this.access, outId = this.out?.id, inId = this.inp?.id;
    if (!await this.requestAccess({ sysex: true })) return false;
    if (had) { this.selectOutput(outId); this.selectInput(inId); }
    return true;
  }
  get supported() { return typeof navigator.requestMIDIAccess === 'function'; }

  async requestAccess({ sysex = false } = {}) {
    if (!this.supported) { this.onStatus('Web MIDI unavailable in this browser (use Chrome or Edge; Safari has no WebMIDI).'); return false; }
    let access;
    try { access = await navigator.requestMIDIAccess({ sysex }); }
    catch (e) { this.onStatus((sysex ? 'MIDI SysEx access denied: ' : 'MIDI access denied: ') + e.message); return false; }
    if (this.access) this.access.onstatechange = null;
    this.access = access; this.sysex = sysex;
    this.access.onstatechange = () => { this.onPorts?.(this.ports()); };
    this.onStatus('MIDI ready');
    return true;
  }
  ports() {
    if (!this.access) return { inputs: [], outputs: [] };
    return { inputs: [...this.access.inputs.values()], outputs: [...this.access.outputs.values()] };
  }
  static pickDefault(list) { return list.find(p => /syntakt/i.test(p.name)) || null; }

  selectOutput(id) { this.out = this.ports().outputs.find(p => p.id === id) || null; }
  selectInput(id) {
    if (this.inp) this.inp.onmidimessage = null;
    this.inp = this.ports().inputs.find(p => p.id === id) || null;
    if (this.inp) this.inp.onmidimessage = e => this._onMessage(e);
  }
  setChannel(ch) { this.channel = Math.min(16, Math.max(1, ch | 0)); }

  _onMessage(e) {
    const [status, d1] = e.data;
    if ((status & 0xF0) === 0xC0) this.onProgram?.(d1, (status & 0x0F) + 1);
  }
  /** Select pattern 0..127 (A01..H16) on the device. */
  programChange(program) {
    if (!this.out) throw new Error('no MIDI output selected');
    this.sendRaw([0xC0 | (this.channel - 1), program & 0x7F]);
  }
  sendRaw(bytes) { this.out.send(bytes); } // seam for future SysEx
}
