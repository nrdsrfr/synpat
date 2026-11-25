---
name: SynPat
description: Dark, dense operator panel for moving patterns between Elektron Syntakt projects. Blue folder = local file, amber device = on the Syntakt.
colors:
  bench-black: "#16181c"
  panel-slate: "#1f2228"
  raised-slate: "#2a2e36"
  sunk-black: "#101216"
  hairline: "#333843"
  chalk: "#dde1e8"
  dim-chalk: "#98a0ae"
  syntakt-amber: "#e8a33d"
  amber-hover: "#f0b556"
  on-amber: "#1b1405"
  local-blue: "#7fb0e3"
  focus-blue: "#4aa3ff"
  ok-green: "#5ec27a"
  fault-red: "#e5534b"
  fault-text: "#f08a83"
  beat-grey: "#6c7587"
  cell-slate: "#262a31"
  segment-active: "#383e4a"
  planned-tint: "#3a3220"
  conflict-tint: "#3b2326"
  applied-tint: "#27402f"
typography:
  title:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.4
  heading:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  meta:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  cell:
    fontFamily: "-apple-system, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.25
  log:
    fontFamily: "ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  cell: "3px"
  control: "4px"
  panel: "6px"
  pill: "9px"
spacing:
  hairline: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
    height: "26px"
  button-primary:
    backgroundColor: "{colors.syntakt-amber}"
    textColor: "{colors.on-amber}"
    rounded: "{rounded.control}"
    padding: "3px 16px"
    height: "26px"
  button-primary-hover:
    backgroundColor: "{colors.amber-hover}"
  button-primary-disabled:
    backgroundColor: "{colors.raised-slate}"
    textColor: "{colors.dim-chalk}"
  segmented-active:
    backgroundColor: "{colors.segment-active}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.control}"
    padding: "3px 12px"
  panel:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.panel}"
    padding: "12px"
  grid-cell:
    backgroundColor: "{colors.cell-slate}"
    textColor: "{colors.dim-chalk}"
    rounded: "{rounded.cell}"
    padding: "2px 3px"
    height: "42px"
  grid-cell-planned:
    backgroundColor: "{colors.planned-tint}"
    textColor: "{colors.syntakt-amber}"
  grid-cell-conflict:
    backgroundColor: "{colors.conflict-tint}"
    textColor: "{colors.fault-text}"
  grid-cell-applied:
    backgroundColor: "{colors.applied-tint}"
    textColor: "{colors.chalk}"
  runbar:
    backgroundColor: "{colors.bench-black}"
    textColor: "{colors.chalk}"
    padding: "8px 16px"
    height: "52px"
  log:
    backgroundColor: "{colors.sunk-black}"
    textColor: "{colors.chalk}"
    typography: "{typography.log}"
    rounded: "{rounded.control}"
---

# Design System: SynPat

## Overview

**Creative North Star: "The Patch Bench"**

SynPat is an operator panel, used mid-task by someone with a synthesizer on the desk. It is a dark, flat, dense instrument-side tool: two project panes, a queue and one pinned Run bar. The surface is quiet so that the few colours that carry meaning (a blue folder for local files, an amber device for the Syntakt, amber for what is planned or selected, red for what is blocked, green for what is applied) read at a glance. Mode: **Operate**. Scanability, consistency and the real usage scene outrank expression; the brand lives in precise details and in the safety language.

Density is deliberate. A bank of 128 patterns, a 128-slot device list and a multi-operation queue must be readable together on a laptop screen, so type is small (13px base, 10 to 12px in data), spacing sits on a 4px scale, and nothing is decorative. Structure comes from tonal layering of slate surfaces and 1px hairlines, not from shadows, gradients or ornament.

The one borrowed gesture from the hardware is the beat marker: every fourth step (1, 5, 9, 13) wears a thin light frame, as the Syntakt's trig keys do. It is applied to the pattern grids and the step preview, on its own layer so it never fights a state colour.

**Key Characteristics:**
- Flat dark slate, tonal layers and hairlines; shadows only for things that float over the page.
- Amber is the single accent (selection, plan, primary action, device); it is never decoration.
- Meaning is repeated by icon and text, never colour alone: status icons are drawn SVG, always paired with a word.
- One system sans family; a monospace face only for the log and the project-name field.
- The Run action is always in reach: a pinned bar at the bottom of the window.

## Colors

A near-black blue-grey base with one warm accent. Cool neutrals, one amber, one blue for "local", and the red/green pair for state.

### Primary
- **Syntakt Amber** (#e8a33d): the accent and the colour of "on the Syntakt". Used for the primary button fill, selected-cell outline, planned cells (dashed border), pattern labels (A01…), warnings, the unsaved pill, the "force needed" cue, and device icons. Hover fill is **Amber Hover** (#f0b556). Text on an amber fill is **On Amber** (#1b1405).

### Secondary
- **Local Blue** (#7fb0e3): the colour of "local file on this computer". Used only on the folder icon and local-file links (Source/Destination buttons in the slot table).
- **Focus Blue** (#4aa3ff): keyboard focus ring and the device Program-Change marker on a grid cell (the pattern currently selected on the device).

### Neutral
- **Bench Black** (#16181c): page background, table body, load list, summary box.
- **Panel Slate** (#1f2228): header, panes, queue panel, slot panel, dialogs, menus.
- **Raised Slate** (#2a2e36): buttons, selects, inputs, segmented control track.
- **Sunk Black** (#101216): the recessed step preview and log.
- **Cell Slate** (#262a31): a pattern cell at rest. **Segment Active** (#383e4a): the chosen side of the Local file / Syntakt toggle.
- **Hairline** (#333843): every 1px border and divider.
- **Chalk** (#dde1e8): text. **Dim Chalk** (#98a0ae): secondary text, labels, meta, empty-state copy (at least 4.5:1 on the slate surfaces).
- **Beat Grey** (#6c7587): the beat-marker frame on grid cells and, in the preview, #5f687a on off steps.

### State
- **OK Green** (#5ec27a): applied/OK status, applied cells (border), success lines. **Applied Tint** (#27402f) fills an applied cell.
- **Fault Red** (#e5534b): conflict border, errors, "can't apply". **Fault Text** (#f08a83) is the readable red for text on dark; **Conflict Tint** (#3b2326) fills a conflicting cell.
- **Planned Tint** (#3a3220): fills a planned cell.

### Named Rules
**The Two Origins Rule.** Blue folder means a file on this computer; amber device means something on the Syntakt. The pair is used everywhere an object has an origin (pickers, where-lines, queue rows, log lines, buttons such as Back up and Load…) and nowhere else.

**The Rare Amber Rule.** Amber marks what the user is acting on or what will change: selection, plan, primary action, device. If a screen is mostly amber, something is wrong.

**The Words Beside Colour Rule.** Red, green and amber never stand alone: each state has an icon and a word ("can't apply", "applied", "1 warning").

## Typography

**Body Font:** the platform system sans (`-apple-system, system-ui, sans-serif`).
**Mono Font:** `ui-monospace, monospace`, for the log and the new-project name field only.

**Character:** native and unadorned, so the tool feels like part of the Mac. Hierarchy comes from weight and size in a tight scale (about 1.1 per step), not from a second family.

### Hierarchy
- **Title** (700, 15px, 1.4): the app name and dialog titles.
- **Heading** (650, 14px): pane and panel headings (Source, Destination, Queue, Device slots), in Chalk, not amber.
- **Body** (400, 13px, 1.4): controls and primary copy; queue route labels.
- **Label** (400, 12px): secondary copy, where-lines, notes (max 90ch), table cells, queue rows.
- **Meta** (400, 11px): tags beside headings, version strings, timestamps, "show/hide".
- **Cell** (600/400, 10px, 1.25): pattern cells; the label (A01) is amber 600, the pattern name and trig count are 400 in Chalk and Dim Chalk.
- **Log** (mono, 11px, 1.45).

Numerals in data (slots, trig counts, versions) use tabular figures.

### Named Rules
**The One Family Rule.** No display face and no second text family. Product UI labels are never set in anything but the system sans.

## Layout

A two-column workbench over a full-width queue.

- **Page:** a flex column at least one viewport tall. Header (slim, one row, wraps on narrow widths), then `main` with Source and Destination side by side (`1fr 1fr`, 12px gap, 16px side padding), then the Queue panel, then the collapsed Log, then the Run bar pinned to the bottom (`position: sticky`, 52px).
- **Queue panel:** a queue list on the left and the step preview in a 300px column on the right, so the preview sits right under the grids. At 1100px and below the preview column is 240px and each queue row stacks onto three lines (route and status/buttons; source and kit/force; messages). At 900px and below the panes and the queue/preview stack into one column.
- **Pattern grids:** 8 rows (banks A to H) by 16 columns (slots 1 to 16), `repeat(16, minmax(0, 1fr))`, fixed 42px rows, 2px gaps. Cell size never changes with state or content; text ellipsizes.
- **Spacing scale:** 2 / 4 / 8 / 12 / 16 / 24px (grid gap, `--s1` to `--s5`). Tight groups use 4 to 8px; panels use 12px padding; page gutters 16px; dialogs 16px by 24px.
- **Density:** high on purpose. Controls are 26px tall (22 to 24px inside tables and rows).
- **Overlays escape their container:** the Slots panel and MIDI menu are absolutely positioned from the header (up to 900px wide; max height viewport minus 96px, scrolling inside), so the 128-row device list never pushes the workflow down. The panel closes on Escape, on an outside click, and after a Source/Destination button is used.
- **No page-load choreography.** Everything is present on first paint.

## Elevation & Depth

Flat by default. Depth is conveyed by tonal layering (Bench Black page, Panel Slate surfaces, Raised Slate controls, Sunk Black recesses) and 1px Hairline borders. Shadows exist only for objects that float above the page.

### Shadow Vocabulary
- **Menu** (`box-shadow: 0 8px 24px #0009`): the MIDI menu.
- **Panel** (`box-shadow: 0 12px 32px #000a`): the Slots panel.
- **Dialog** (`box-shadow: 0 16px 48px #000b`, backdrop `#000a`): the run and load dialogs.

### Named Rules
**The Flat-Until-Floating Rule.** A surface that sits in the page flow has a hairline and no shadow. Only menus, panels and dialogs that overlay content get a soft, offset shadow. No coloured glows, no hard offset shadows.

## Shapes

Small, quiet rounding on a rectilinear grid. Cells 3px; controls, table wrappers, banners and the segmented toggle 4px; panes, panels, dialogs and menus 6px; the "unsaved" pill 9px. The segmented Local file / Syntakt toggle is a single bordered control with a 1px divider, the active side filled Segment Active. Borders are 1px Hairline; planned and conflicting cells use a 1px dashed border in amber or red (applied cells are solid green). Icons are drawn, not typographic: 16-unit SVG symbols, monochrome in `currentColor` (folder, device, check, x, warn, up, down, play, chevron), sized 12 to 15px, 1.4 to 1.8 stroke.

## Components

### Buttons
- **Shape:** 4px radius, 26px tall, 3px by 8px padding, Raised Slate fill, Hairline border, Chalk text.
- **Hover:** border turns Syntakt Amber. **Active:** fill #343944. **Disabled:** 45% opacity, default cursor.
- **Primary:** Syntakt Amber fill, On Amber text, weight 650, 16px side padding. Exactly one primary action is shown at a time: Run queue…, or Outputs… after a run. Disabled primary falls back to Raised Slate with Dim Chalk text.
- **Ghost-accent:** an amber border and text (Connect to Syntakt before a device is connected).
- **Icon buttons** (queue row up/down/remove): 24px square, icon only, with aria-labels.
- **Focus:** a 2px Focus Blue outline, 1px offset, on every control.

### Header
One slim row on Panel Slate with a bottom hairline: app name and subtitle at the left; at the right the device status text, the progress bar while busy, Connect/Reconnect, Refresh (only once a connection exists), the Slots toggle (only once slots are listed), the MIDI menu, and Audition selected. Errors in the status text turn red and wrap; they are never truncated. Long non-error status truncates with its full text in a tooltip.

### MIDI menu
A native details dropdown, 360px wide, from the header: status, Out, In and Channel selects, and the connection and audition notes. It opens by itself when no Syntakt port is auto-detected.

### Slots panel
Over the page from the header: a heading with device info and an all/occupied/empty filter, a sticky-header fixed-layout table (slot, name, action, local backup), and one safety sentence. Occupied rows offer Back up and Source/Destination buttons for matching local backups; empty rows (italic, Dim Chalk) offer Load…. Rows are 12px type with 2px vertical padding.

### Segmented toggle (Local file / Syntakt)
A two-option radio group drawn as one bordered control, each option an icon plus word. The radios are visually hidden but focusable; the checked side is filled and Chalk, the other Dim Chalk.

### Pattern grids (signature component)
The 8×16 bank grid for Source and Destination. A cell shows its label (A01…, amber), pattern name and trig count (`218t`).

- **Rest:** Cell Slate, Hairline border, 3px radius. Hover: border #5a6272.
- **Empty:** 50% opacity, Dim Chalk label.
- **Selected:** 2px solid amber outline (inset by 1px); empty selected cells return to full opacity.
- **Planned:** 1px dashed amber border, Planned Tint, text `← #n` (the operation number) in amber.
- **Conflict:** 1px dashed red border, Conflict Tint, text `✗ #n` in Fault Text.
- **Applied (after a run):** solid green border, Applied Tint.
- **Device marker:** a 12px device-icon badge top right plus an inset Focus Blue ring, for the pattern the device itself has selected.
- **Beat markers:** columns 1, 5, 9 and 13 get a 1px inner frame in Beat Grey inset 1px inside the border, on every bank row. It is a pseudo-element layer under the text and badge, so it coexists with every state border above. On empty (dimmed) cells the frame is brightened to #808a9b so it survives the 50% opacity.
- **Empty grid:** until a project is chosen the grid is faded to 45% under a centred one-line instruction.

### Step preview
A 640×182 canvas (64 steps by 13 tracks) in Sunk Black, shown at the width of its column. Lit steps are amber; steps 1, 5, 9, 13… (every fourth) use a slightly lighter off fill and carry the beat-marker frame (1.5px, #5f687a off, #fff2d2 on).

### Queue rows
One grid row per operation: number, route (`A01 NAME → A13`, labels bold), source file with its origin icon (dim), kit field and Force checkbox, a status (check "ok", warn "1 warning", x "can't apply", "applied"), and up/down/remove icon buttons; messages sit on a second line under the route (amber for warnings, Fault Text for errors, with an icon). A blocked row has a faint red wash; if force can override it, "force" turns amber and bold. A banner above the list reports validation or run-refused errors in Fault Text on a red wash.

### Run bar
Pinned to the bottom of the window on a translucent Bench Black with a top hairline: a hint at the left (red when the queue is blocked: "Fix or force the operations marked “can’t apply” to enable Run."), Undo run / New queue / Outputs… / Clear queue and the primary Run queue… at the right.

### Run summary
After a run, a recessed box lists outcomes first (operations applied; file saved; device write result), then a foldable warnings group (open when 2 or fewer, remembers the user's choice), then a note that Undo run reverts only the local working copy. Device-write lines use the device icon and one of: verified (green), cancelled, failed with nothing written, PARTIAL write, written but not verified, VERIFY FAILED (red).

### Dialogs
Run and Load dialogs: Panel Slate, 6px radius, 560px max width, 16px by 24px padding, a 15px title, a lede, a "Send the result to" group (Save to folder with an optional file name; Write to Syntakt with an empty-slot select and a reason line), a note, and right-aligned Cancel + primary action. "Write to Syntakt" is never pre-ticked.

### Log
A collapsed disclosure at the bottom whose summary carries the latest message and error/warning counts; an error opens it. Open: a 182px monospace box in Sunk Black, newest first, timestamps in Dim Chalk, origin icons on lines.

## Interaction and Safety Language

These are design requirements, not copy preferences.

- **Device writes target empty slots only.** The UI never offers an occupied slot as a write target. The slot is checked again immediately before writing.
- **Every write confirm names its target:** project name, revision (and short hash), project version and the slot number, and says the slot is empty and the device keeps its other projects. A confirm for a blank-template project adds that it is built from SynPat's blank template (derived by SynPat, first tested on hardware in slot 125), not copied from an existing project.
- **Opt-in, not default:** a device write is never pre-ticked, even when a blank project's slot is locked. The slot select is disabled when locked and says why.
- **Busy states disable.** While the device is busy or an output is running, controls that touch the device are disabled and progress is shown in the header.
- **Errors say what failed, what state things are in, and what to do.** Examples to keep in shape: "device write failed (nothing written): …"; "PARTIAL write — check slot NNN on the device (it may hold an incomplete project): …"; "written to slot NNN, NOT verified (read-back failed): …"; "written to slot NNN but VERIFY FAILED (n difference(s) in the project contents)"; "Run refused, nothing was applied: …". Information already in a message is never dropped when rewording it.
- **Undo is honest:** Undo run reverts the local working copy only; saved files and device writes are not undone, and this is stated beside the result.
- **Both origins are always labelled** with the icon pair and, where it matters, the words "On Syntakt" / "Local file".

## Responsive Behaviour

Designed for a laptop browser (checked at 1440×900, 1280×800 and 1024).
- **≥1101px:** two panes side by side; queue rows are single-line with fixed trailing columns (kit/force 150px, status 92px, buttons 78px).
- **≤1100px:** header gap tightens, status text caps at 30ch, preview column narrows to 240px, queue rows wrap to three lines, and grid names truncate harder (full details stay in the tooltip).
- **≤900px:** Source and Destination stack; the queue and preview stack.
- Touch is not a target; hit areas are mouse-sized (22 to 26px).
- `prefers-reduced-motion` removes the two 150ms chevron rotations; there is no other motion.

## Do's and Don'ts

### Do:
- **Do** keep amber for selection, plan, primary action and the device; use blue only for local files.
- **Do** pair every state colour with an icon and a word.
- **Do** use the 2 / 4 / 8 / 12 / 16 / 24px spacing scale and 3 / 4 / 6px radii.
- **Do** keep grid cells the same size in every state and put new state treatments on a separate layer (border, outline, inset ring, pseudo-element) so they combine.
- **Do** show one primary button at a time, and keep Run reachable in the pinned bar.
- **Do** truncate long file names with an ellipsis and a tooltip, but never truncate an error.
- **Do** keep copy terse and exact, and name the object and the slot.

### Don't:
- **Don't** add a second type family, display fonts, gradients, glass or decorative shadows.
- **Don't** introduce a new accent colour for a feature; extend the existing amber/blue/red/green meanings instead.
- **Don't** let the 128-row device list push the workflow down: it stays an overlay panel.
- **Don't** use colour alone, unicode glyphs or emoji as icons; draw SVG symbols from the shared sprite.
- **Don't** pre-select a device write, or offer an occupied slot, or soften or shorten the partial-write and unverified-write wording.
- **Don't** change cell size, add layout shift on state change, or move the Run action out of reach.
