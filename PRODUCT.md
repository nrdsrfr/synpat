# Product

<!-- impeccable:product-schema 1 -->

<!-- Provenance: written from the repository (README.md, code, tests) and the brief of the person who asked for it.
     No interview round took place. Three answers later came from the owner (audience, the permanence of "never overwrite, never delete", and platform scope); anything still needing a decision from the owner is under "Open questions". -->

## Platform

web

## Users
Owners of an Elektron Syntakt who keep their projects as backups and want to rearrange them: working on a Mac, in Chrome, with the Syntakt connected over USB. They are musicians at their instrument, not developers; they know the Syntakt's own vocabulary (pattern banks A to H, slots 1 to 16, kits, trigs, parameter locks, project slots 1 to 128) and expect the tool to use it.

SynPat is a public project for Syntakt owners in general, not only for the person who built it. These users did not write the code, do not know its internals (`.stprj` files, SysEx, project versions 0x0A/0x0C/0x0D, the working copy and revision model) and cannot ask the author. That implies:
- README, help text and every in-app message must stand on their own. No assumed context from the author: explain a term the first time it matters, say what will happen to which object, and never rely on "you know what I mean".
- Internal terms appear only with a plain-language meaning beside them, and error messages say what failed, what state things are in, and what to do next.
- Safety limits and what has been verified on hardware are stated up front, because a stranger cannot judge the risk from the code.

## Product Purpose
SynPat is a local tool for moving musical material between Syntakt projects without Elektron Transfer's whole-project model. It exists to do four things:
- Copy patterns, together with the kits they use, from one project into another, including between project versions 0x0A, 0x0C and 0x0D.
- Queue several copies from several source projects into one destination, validate the whole queue, and run it once.
- Back up projects from the device and load projects into empty device slots over USB-MIDI, without Elektron Transfer.
- Start a new blank project for an empty device slot.

Success is that the owner's existing projects and the device's contents are never put at risk, and that a copy they would otherwise rebuild by hand takes a few clicks and a visible, checkable plan.

## Positioning
A pattern-level, queue-based manager that talks to the Syntakt directly from the browser (WebMIDI SysEx) and never overwrites or deletes anything. Elektron Transfer handles whole projects and holds the MIDI port; SynPat works at pattern and kit level, shows the planned result before anything is written, and restricts device writes to empty slots with a verified read-back. It is unofficial: the file format and protocol were reverse-engineered, and it is not affiliated with or endorsed by Elektron.

## Operating Context
- Runs as a small Python server (standard library only) on loopback, with a plain HTML/CSS/JS front end. No build step, no framework, no third-party packages.
- Backups live in a folder set by `SYNPAT_DATA`, containing `PROJECTS`, `OLD BACKUP` and `OUTPUT`. New files go to `OUTPUT`; existing files are never overwritten.
- Target platform for now: macOS with Chrome (WebMIDI with SysEx is needed for the device features). Edge also supports WebMIDI and works, but Chrome on a Mac is the target. Other platforms (Windows, Linux, Safari, other browsers) are not in scope at present. Elektron Transfer and Overbridge must be closed because they hold the MIDI port.
- The server has no authentication and is for loopback only. It keeps one queue and one working copy at a time, in memory, shared by all tabs; the queue survives a page reload, not a server restart.
- Typical session: choose a source and a destination (each a local `.stprj` or a Syntakt slot), click source patterns onto destination slots, review the planned grid and the per-operation validation, run, then save a new file and/or write to an empty slot.
- Audition sends a MIDI Program Change; it selects a pattern in the project currently loaded on the device, not in the file shown.

## Capabilities and Constraints
- **Never overwrite, never delete (permanent).** This is a fixed product constraint, not a current limitation: no feature, now or later, may overwrite or delete anything on the device or on disk. Device writes go only into empty slots, are re-checked right before writing, need a confirm that names the target, and are verified by read-back (decoded project contents, because the device re-compresses what it stores). Nothing on the device can be deleted. Every file output is a new file; an existing name is refused. Future features must be designed to keep this.
- Reading from the device (slot list, Back up) does not modify it.
- Supported project versions: 0x0A, 0x0C, 0x0D. Version 0x08 is listed as unsupported and untouched. 0x0A to 0x0C conversion matches what the device produced; 0x0C to 0x0A is inferred and unchecked on a device; lossy conversions are refused unless forced.
- Only the pattern and the kit it references are copied. A queue has one destination project and at most 128 operations.
- A blank project is derived from an embedded blank-project image (first tested on hardware in slot 125); it carries nothing from the user's own projects except version and firmware identification.
- Tested with one device and one firmware: OS 1.42. Other firmware may behave differently.
- Python 3.10 or newer; Node.js only for the JavaScript protocol tests.
- Terminology to keep: project, slot (device slot 1 to 128, and pattern slot A01 to H16), pattern, kit, queue, operation, working copy, backup, destination, source, force, "on the Syntakt" versus "local file".

## Brand Commitments
- The name is SynPat ("Syntakt pattern manager").
- Voice: precise, terse, safety-first. Say what will happen and to which object; say what failed and what state things are in; never soften a risk.
- Two stable symbols: a blue folder means a local file on this computer; an amber device icon means something on the Syntakt.
- The tool must keep saying that it is unofficial, reverse-engineered and used at the owner's own risk.

## Evidence on Hand
- Recorded replies from a real Syntakt (OS 1.42) in `web/tests/fixtures/`, used by `web/tests/rpc.test.mjs`; Python tests that run against real project backups from `SYNPAT_DATA` when present.
- README.md documents what was tested on hardware (slot reads byte-identical to Transfer backups, multi-chunk writes with verified read-back, the queue end to end, the blank-project write) and what is only inferred.
- Absent, and not to be invented: other users, testimonials, usage numbers, other firmware or devices tested, any statement from Elektron.

## Product Principles
1. **Never overwrite, never delete.** Permanent. Anything new must work within it; if a feature seems to need an overwrite or a delete, the feature is changed, not the rule.
2. **Safety is visible.** Anything that can change the device names its target, can be inspected first, and states its outcome in full, including partial or unverified writes.
3. **Plan, then commit.** Nothing is written until the queue has been validated and run; the planned result is always shown before it is real.
4. **Speak the instrument's language, and stand on your own.** Use the Syntakt's own names and positions (banks, slots, kits, trigs), keep local files and device contents visibly distinct, and write every message for someone who has never seen the code.
5. **Small and boring.** Standard library, plain files, loopback; prefer a visible limitation to a clever workaround.
6. **Honest about what is verified.** Separate what was tested on hardware from what is inferred, in the product and in its docs.

## Accessibility & Inclusion
No product-specific requirement has been stated. The interface keeps visible keyboard focus and named controls, but no formal standard (such as WCAG level) has been chosen.

## Open questions
These still need an answer from the owner; none is assumed above.
1. **Voice beyond "precise, terse, safety-first":** any wording the owner wants always or never used (for example how to refer to Elektron, or whether first-run help text is wanted).
2. **Accessibility target:** is a specific standard or any assistive-technology use required?
3. **Firmware:** which firmware versions beyond OS 1.42 should be treated as in scope, and who verifies them?
4. **Scope growth:** may later versions copy more than patterns and kits (for example sounds, sample assignments, songs, MIDI track setups)? (Any such feature must keep "never overwrite, never delete".)
5. **Licensing and release posture:** MIT is in place; is there any stance on distribution, support or Elektron's trademarks beyond the existing disclaimer?
