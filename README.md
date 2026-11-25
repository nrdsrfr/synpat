# SynPat

SynPat is a local tool for copying patterns, together with the kits they use, between Elektron Syntakt projects.

- Copy patterns between project backups (`.stprj` files), including between different project versions.
- Queue many copies from several source projects into one destination project, check the whole queue, then run it once.
- Sources and destination can each be a local `.stprj` file or a project on the Syntakt, read over USB-MIDI. The destination can also be a new blank project for an empty Syntakt slot.
- Save the result as a new `.stprj` (for example to load it with Elektron Transfer), or write it directly into an empty project slot on the Syntakt.
- Back up any project slot from the device to a local `.stprj`.

It has a browser GUI (a small Python server plus plain HTML/JS, with the device talk done by WebMIDI in your browser) and a command-line tool.

## Status: what has been tested on real hardware

Tested against one Syntakt running OS 1.42:

- Reading the project slot list and reading projects. A slot read is byte-identical to the backup Elektron Transfer made of the same project.
- Writing a project into an empty slot, including a multi-chunk write (more than 32 KB), with a verified read-back. The device re-compresses what it stores, so verification compares the decoded project contents, not the raw bytes.
- The queue feature end to end: one source read from the device, one local source, a local destination, save to folder and write to an empty slot. The written project plays on the device.

- The blank-project destination: a blank 0x0D project written into an empty slot (slot 125) reads back identical in its decoded image, and loads and is empty on the device.

Cross-version copies (project versions 0x0A, 0x0C and 0x0D):

- 0x0A to 0x0C: the conversion matches what the device itself produced when it upgraded a project.
- 0x0C to 0x0A: the conversion is inferred and has not been checked against a device. It refuses lossy cases unless you force it.
- 0x0C and 0x0D share the same structure, so copies between them are byte copies.
- Version 0x08 projects (older, 980-byte tracks) are not supported. They are listed as unsupported and not touched.

## Safety

SynPat is unofficial. The file format and the SysEx protocol were reverse-engineered from backup files and from Elektron Transfer. It is not affiliated with or endorsed by Elektron.

- Writes to the device go only into EMPTY slots. The slot is checked again right before writing, you confirm the write, and the result is verified by read-back.
- SynPat never overwrites or deletes anything on the device. It never overwrites files on disk: every output is a new file and an existing name is refused.
- Reading from the device (slot list, "Back up") does not modify it.
- Close Elektron Transfer and Overbridge before connecting. They hold the MIDI port.
- Keep your own backups. **Use at your own risk.**

## Requirements

- Python 3.10 or newer, standard library only, no third-party packages. The tests pass on 3.10, 3.11, 3.12, 3.13 and 3.15; older versions are untested. The Docker image uses 3.13.
- Chrome or Edge for the device features (WebMIDI with SysEx). Safari has no WebMIDI; everything except the device features still works there.
- Node.js only to run the JavaScript tests (tried with Node 24).

## Quick start

Tell SynPat where your backups are. Create `synpat.env` in the repository root (copy `synpat.env.example`; the file is gitignored):

```
SYNPAT_DATA=/path/to/Elektron Syntakt
```

`SYNPAT_DATA` is the folder that contains `PROJECTS`, `OLD BACKUP` and `OUTPUT`. Spaces in the path are fine and quotes are optional. `./synpat` parses this file line by line (it does not execute it) and understands only `SYNPAT_DATA`; a `SYNPAT_DATA` already set in your environment takes precedence. Without it the server falls back to the repository's parent directory, and if there is no `PROJECTS` or `OLD BACKUP` folder there it stops with a hint to set `SYNPAT_DATA`. Skip this setup if you pass `--projects` and `--output` yourself.

Then, from the repository root:

```
./synpat
```

On macOS you can also double-click `SynPat.command` in Finder. The launcher starts the server (`python3 -m web.server`) and opens http://127.0.0.1:8765/ in Google Chrome (falling back to the default browser, or `xdg-open` on Linux). If a SynPat server already answers on the port, it only opens the browser. Press Ctrl-C to stop the server. It needs Python 3.10 or newer.

- `./synpat --no-browser` starts the server without opening a browser.
- Any other options go to the server, for example `./synpat --port 8800 --output /path/to/OUTPUT`. `SynPat.command` takes no options; use `./synpat` for that.

Manual alternative, with explicit directories:

```
python3 -m web.server --projects /path/to/PROJECTS --projects "/path/to/OLD BACKUP" --output /path/to/OUTPUT
```

Then open http://127.0.0.1:8765/ in Chrome or Edge. The server options:

| Option | Meaning |
|---|---|
| `--projects DIR` | Directory of `.stprj` files. Repeatable. A missing directory is ignored. Default: `$SYNPAT_DATA/PROJECTS` and `$SYNPAT_DATA/OLD BACKUP`. Without `SYNPAT_DATA` the repository's parent directory is used instead. |
| `--output DIR` | Where new files are written (created if missing). Default: `$SYNPAT_DATA/OUTPUT`. It is also listed as a project directory, so saved results and device backups appear in the pickers. |
| `--port N` | Default 8765. |
| `--host ADDR` | Default 127.0.0.1. The server has no authentication, so keep it on loopback. Requests whose Host header is not `localhost`, `127.0.0.1` or `::1` are refused, so opening the page by LAN address does not work. |

Walkthrough:

1. **Source** (left) and **Destination** (right) each have a toggle, Local file or Syntakt.
   - Local file: pick a `.stprj` from the list. Files in an unsupported format are listed as unsupported.
   - Syntakt: pick an occupied slot (after connecting, see below) and click "Read & back up". The project is read from the device and saved to the output folder as `NNN NAME (device backup YYYY-MM-DD HHMMSS).stprj`; that backup is then used as the source or base.
   - Destination only: an empty Syntakt slot can be chosen too. "Create blank project" (with a project name field, default `NEW PROJECT`) makes a new blank project for that slot. `stprj/template.py` builds it from a blank-project image embedded in the library (`stprj/template_data.py`); only the version and firmware identification of your newest local project are used, so nothing of that project (name, patterns, kits) ends up in it. The pane header then reads `NEW: <name> -> slot NNN`. The GUI accepts names of 1 to 15 characters from A-Z, 0-9, space, `-`, `=` and `#` (the characters seen in real project names); the library itself accepts any 1 to 15 printable ASCII characters.
   - Folder icons mark local files, device icons mark things on the Syntakt.
2. **Queue**: select a source pattern, then click or drop it on a destination slot. This adds an operation to the queue; nothing is written yet. The kit goes to the same slot number as the pattern by default; the "Kit slot for new ops" field and the per-operation kit field change that. Each operation can be removed, moved up or down, or forced. The destination grid shows planned cells with a dashed outline and conflicts in red. The whole queue is re-validated on the server after every change.
3. **Run queue** (the button in the bar pinned to the bottom of the window): opens a dialog with the outputs. Both can be selected together; with neither ticked the queue is only applied to the working copy.
   - Save to folder: writes a new `.stprj` to the output directory (optional file name; default `<destination> edited <timestamp>.stprj`).
   - Write to Syntakt: writes the result into an empty slot you choose. You are asked to confirm, with the project name and a revision hash. An occupied slot, including the destination's own original slot, cannot be chosen. When the destination is a blank project for an empty slot, this output is locked to that slot (the slot is checked empty again right before writing) but not pre-ticked: you tick it, and the confirm says the project is built from SynPat's blank template. The slot is stored with the working copy; if it is lost, create the blank project again to write it to the device. "Save to folder" is optional.
   After a run, the result is a working copy. "Undo run" discards that working copy and restores the queue; it does not undo saved files or device writes. "Outputs…" repeats the outputs for the working copy and "New queue" starts over.
4. **Device** (header): "Connect to Syntakt" asks the browser for MIDI SysEx permission (a browser prompt) and reads the slot list; the status shows next to it. "Refresh" re-reads it. "Slots" opens the slot list as a panel over the page (filter: all / occupied / empty; Esc or a click outside closes it). Occupied slots have "Back up" and "Source" / "Destination" buttons for matching local backups; empty slots have "Load…" (pick a local project or the working copy and write it into that slot). The "MIDI" menu holds the MIDI In/Out/channel choice and the audition setup notes.
5. **Audition** (header): sends a MIDI Program Change to select a pattern on the device. This needs "PRG CH RECEIVE" enabled on the Syntakt with a matching channel (default 10 here). It selects the pattern in the project currently loaded on the device, not the file shown in the GUI.

## Docker

```
docker build -t synpat .
docker run --rm -p 127.0.0.1:8765:8765 \
  -v "/path/to/Elektron Syntakt/PROJECTS:/data/projects:ro" \
  -v "/path/to/Elektron Syntakt/OLD BACKUP:/data/old-backup:ro" \
  -v "/path/to/Elektron Syntakt/OUTPUT:/data/output" \
  synpat
```

Open http://localhost:8765/ in Chrome. The container only runs the server. WebMIDI and SysEx access happen in the browser on your computer, so the container needs no USB or MIDI access. Publish the port on 127.0.0.1 only. The image runs as a non-root user and contains only `stprj/` and `web/` (no tests).

## Command line

Run from the repository root. Project files are never modified.

```
python3 -m stprj info FILE [--all]
python3 -m stprj verify FILE [FILE ...]
python3 -m stprj copy SRC SRC_SLOT DST DST_SLOT [--kit-slot SLOT] [-o OUTPUT] [--force]
```

- `info` lists the non-empty patterns with name, kit, tempo, trig count and parameter-lock slots; `--all` includes empty ones.
- `verify` decodes and re-encodes each file and checks that the project image round-trips.
- `copy` copies pattern `SRC_SLOT` (for example `A01`, banks A to H, 01 to 16) and the kit it uses from `SRC` into `DST` at `DST_SLOT`. The kit goes to `--kit-slot`, default the same slot as the pattern. It writes a new file (default: next to the destination, named `<dst> + <src name> <src slot> at <dst slot>.stprj`) and refuses to overwrite one. Without `--force` it refuses to overwrite a non-empty pattern or a kit used by another pattern, and refuses lossy version conversions. Warnings, including conversion notes, go to stderr.

## How it works

- A `.stprj` is a ZIP with `manifest.json` and one payload entry named after the project. SynPat keeps the manifest bytes as they are and writes new ones in the same format.
- The payload is a 31-byte header (magic, project version, slot, decompressed size), a chain of LZ4 blocks, and a trailer with a CRC-32 and a length. The codec is pure Python (`stprj/container.py`, `stprj/lz4block.py`). The decompressed project image is about 4 MB.
- The image holds 128 patterns and 128 kits at fixed offsets. The layout, with offsets and structure versions, is documented in `stprj/layout.py`. Copying a pattern copies its bytes and the bytes of the kit it references, then points the pattern at the destination kit slot (`stprj/project.py`).
- Conversion between structure generations (project 0x0A and 0x0C/0x0D) is in `stprj/convert.py`. Conversion notes become warnings; lossy ones need `--force` or the per-operation force option.
- The blank-project destination is the virtual destination id `template` in the API (`destFileId: "template"`, optional `templateName`), handled in `web/server.py` with the name rule in `web/blank.py`. The saved file for such a run is named `<name> new <timestamp>.stprj` and gets a fresh manifest.
- The queue is simulated by `web/plan.py`: operations are applied in order to an in-memory copy, a failing operation is reported and skipped, and a duplicate destination slot or kit slot is flagged. `web/server.py` serves the JSON API and the static GUI in `web/static/`.
- Device protocol, in `web/static/elektron-rpc.js` (the file header documents what was observed and what is inferred):
  - Elektron SysEx RPC: frames are `F0 00 20 3C 10 00`, 7-bit packed data, `F7`. A reply carries the request's counter and opcode with the high bit set.
  - Read-only requests: ping, software version, device UID, query, and listing a directory (`/projects` holds slots 1 to 128). Reading a file is open, partial reads and close, in 2048-byte chunks with a CRC-32 per chunk, about 20 KB/s.
  - Writing is open, partial writes and close, in chunks of up to the device's maximum (32768 bytes). The device reports the cumulative byte count in each reply.
  - The device decompresses and re-compresses a written project, so the stored bytes differ from the sent ones; verification compares decoded images.
  - The three write opcodes can only be sent from `writeProject`, which refuses non-empty slots and checks the payload container first.

## Development and tests

```
python3 -B -m unittest discover tests
node --test web/tests/rpc.test.mjs
```

The Python tests use real backups from `$SYNPAT_DATA/PROJECTS` and `$SYNPAT_DATA/OLD BACKUP` (see `tests/datadir.py`). If `SYNPAT_DATA` is not set they look in the repository's parent directory, and they skip the tests that need the backups when those are absent. `synpat.env` is read only by the `./synpat` launcher, so for the tests export the variable, for example `SYNPAT_DATA="/path/to/Elektron Syntakt" python3 -B -m unittest discover tests`. They include HTTP-level tests that start the server on a random port with a temporary output directory. The JavaScript tests cover the protocol module against recorded device replies in `web/tests/fixtures/`.

## Limitations

- Occupied device slots cannot be overwritten, and nothing can be deleted on the device.
- Only the pattern and the kit it references are copied. Anything else in a project is not handled.
- A queue has one destination project. The server keeps one queue and one working copy at a time, in memory, shared by all browser tabs; the queue survives a page reload but not a server restart.
- A queue holds at most 128 operations.
- Only project versions 0x0A, 0x0C and 0x0D are supported; 0x0C to 0x0A conversion is not checked against a device.
- Tested with one device and one firmware version (OS 1.42). Other firmware may behave differently.
- The GUI has no authentication and is meant for loopback use.

## License

MIT — see [LICENSE](LICENSE).
