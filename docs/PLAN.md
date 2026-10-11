# Implementation plan — Conway's Sequencer

Client-side Vue 3 app that turns a binary piano roll into MIDI gates for the
Nervous Squirrel Conway's Game module. This document is the plan the first
iteration was built against, with what shipped and what is left.

## 1. Goals and constraints

| Requirement | Decision |
| --- | --- |
| Client-side only | Vite + Vue 3 + Pinia, static build, no backend. Songs autosave to a `localStorage` library browsed from a slide-out drawer, export/import as JSON. |
| Select the MIDI output in the GUI | `navigator.requestMIDIAccess({ sysex: false })`; outputs listed in a `<select>`, choice persisted, `statechange` tracked for hot-plug. |
| MIDI sync output | A second, optional output in `stores/midi.ts` (`syncOutputId`, `sendSync`, persisted under its own key, never auto-selected) picked in `MidiPanel.vue`. With one selected the transport compiles MIDI clock ticks (`compileSong(song, { syncClock: true })`: `kind: 'clock'`, 24 per quarter note per `MIDI_CLOCKS_PER_QUARTER`, following each section's tempo, never swung) into the same event list as the gates, so they share the scheduler's timeline and loop with it; the transport routes real-time messages (`isRealTime`) to the sync output and everything else to the module. `transport.start()` sends Start from the top of the song or Song Position Pointer (`quarterNotesAt` of the whole-song position) + Continue, stamped at `Scheduler.queuedUntil()` so a receiver counts exactly the new pass's ticks; `halt()` and `panic()` send Stop. |
| Up to 62 channels | Hard cap `MAX_CHANNELS = 62`. A channel = one module output (shown 1-based). MIDI note = `baseNote + output`. The last two outputs are reserved for the x16 clock and the play gate. |
| x16 clock | `CLOCK_NOTE = 98` is pulsed `CLOCK_PULSES_PER_BEAT = 16` times per beat while playing, compiled into the event list alongside the gates so it follows every section's tempo and time signature. Half-period pulses, never below the 2 ms retrigger gap. Independent of the base note; mute and solo do not affect it. |
| Play gate | `settings.playGateNote` (default `DEFAULT_PLAY_GATE_NOTE = 99`, the module's 64th output) goes note-on when playback starts or resumes and note-off when it pauses or stops (manual stop, end of a non-looping song, or panic). Independent of the base note. |
| Transport | `stores/transport.ts` has three states: stopped (cursor at 0), playing, paused (cursor kept, gate low). Pause stops the scheduler where it is; resume restarts it from the cursor and re-raises any gate that spans the resume point; reset returns the cursor to 0 and keeps playing if it was playing. |
| Loop points | `settings.loopRange` is a range of bars on the whole-song bar axis (`{ start, end }`, end exclusive, null for the whole song), saved with the song and clamped whenever the song loses bars. The transport feeds the scheduler just that window of the compiled song (`windowEvents` in `core/compile.ts` cuts the event list and re-raises/releases gates at the edges), so the scheduler itself knows nothing about loop points; "the start" becomes the range start and the Loop setting decides whether the range repeats. The grid's loop strip (one cell per bar: click, drag, Shift to extend, keyboard, tap) edits it. |
| Channel = binary on/off of a MIDI note → gate | Note-on at the start of an on-step, note-off at the next off-step: a gate is held for the whole step, and consecutive on-steps form one long gate. |
| Divided cells (ratchets) | `Section.divisions` maps channel id → step → 2..8. `gatesOf` in `core/song.ts` turns a channel's on-steps into gates: runs of plain steps, and a divided step's own gates (it never joins a run); `gateSeconds` in `core/compile.ts` gives each gate an equal share of its (swung) step, dropping 2 ms before the next. The grid's cell context menu (`SequencerGrid.vue`, right-click, Menu key or Shift+F10) sets it for one cell or, on a cell inside the selected block, for every gate in the block (`divideRange` in `core/clipboard.ts`). Blocks and bar clips carry divisions alongside their rows. |
| Sections with tempo, time signature, bars | `Section { tempo: number \| null, timeSignature {beats, unit}, bars, subdivision }`. `tempo: null` inherits from the previous section (first section falls back to 120). |
| Draw "on" bars like a piano roll | Grid: rows = channels, columns = every step of every section. Click toggles, drag paints, keyboard toggles. |
| Comprehensive tests, GitHub Actions → GitHub Pages | Vitest unit/component tests with coverage thresholds, Playwright e2e against the built app with a fake Web MIDI, one workflow that tests then deploys. |
| Editor-first layout | The shell is viewport-sized. A one-line toolbar holds the MIDI output picker and transport; sections, module settings and song I/O sit in a collapsible drawer (`stores/ui.ts`, persisted). The gate grid flexes to fill the remaining height. |
| Track orientation | `stores/ui.ts` keeps `trackOrientation` (`ltr`, the default, `rtl`, `ttb`, `btt`) with the other layout preferences, set from `components/EditorPanel.vue` in the drawer. `SequencerGrid.vue` renders the same DOM for every orientation and lets CSS lay it out: rows (headed left or right; `direction: rtl` mirrors them) or columns (headed top or bottom; a reversed flex column puts the scroll origin at the bottom), with `App.vue` letting the shell grow past the viewport so a vertical song runs down the page rather than scrolling inside the grid (bottom to top scrolls the page to the foot of the grid, where the song starts), and with the step-boundary borders and gate outlines mapped onto the physical sides per orientation. `ChannelHeader.vue` stacks its controls on three lines when it tops a column. |
| Module view | `core/module.ts` models the panel: 64 outputs in an 8x8 field following consecutive notes from the base note (`moduleLayout` maps channels, the clock and the play gate onto them; `highNotes` says which notes are high at a playback position, pulse width and 2 ms gate gap included, derived from the song rather than from the bytes sent so it works without a MIDI output). `components/ModuleView.vue` renders it beside the grid (above it below 1000px); shown from the toolbar, persisted in `stores/ui.ts`. |
| Tablets and phones | Below 1200px wide (or 520px tall) the shell scrolls as a page instead of being viewport-sized (`App.vue`). Below 768px (`style.css`, `App.vue`) phones get the toolbar and drawer stacked, a 164px channel column whose controls wrap onto two lines, and the drawer closed by default. `(pointer: coarse)` widens steps, heightens rows and gives 36px controls. In the grid a touch tap toggles on click and a swipe pans (`touch-action: pan-x pan-y`); mouse and pen still paint from pointerdown. |
| alephvoid.com branding | Aleph Void logo mark (from the alephvoid.com repo) in the header and footer, page title, favicon; the site's near-black palette with the violet accent (`#6d28d9` / `#8b5cf6`), Inter for UI text and JetBrains Mono for labels. Tokens live in `src/style.css`. |

### Module facts the design relies on

- 64 trigger/gate outputs, driven by MIDI notes starting at C2 (36). Public
  listings quote "C2 / note 36 to E7 / note 100"; 64 outputs from 36 end at 99,
  so the base note is a setting (default 36) in case a unit is offset by one.
  In practice a unit does not react to note 100, so the play gate defaults to
  note 99 (the 64th output) and is itself a setting.
- Outputs can be set to trigger (fixed 20 ms pulse) or gate (follows the note).
  Gate length only matters in gate mode; in trigger mode any gate length works.
- MIDI channel is not documented on the public pages, so it is a setting (default 1).

## 2. Architecture

```
src/
  core/            pure TypeScript, no Vue, 100 % unit-testable
    song.ts        types, factories, step arithmetic, invariants
    timing.ts      tempo inheritance, step durations, section timeline, locate(time), locateStep(step)
    clipboard.ts   blocks of gates: read a rectangle of cells out of a song, write one back
    midi.ts        message builders (notes, sync: clock/Start/Stop/Continue/Song Position), output→note mapping, note names
    compile.ts     Song → sorted MidiEvent[] (the "render" step), MIDI clock ticks on request
    scheduler.ts   look-ahead scheduler: hands events to the port with timestamps
    module.ts      the module's panel: output layout and which notes are high at a position
    serialization.ts  JSON export/import with validation + clamping
    library.ts     the song library in localStorage: index + one key per song
  stores/          Pinia
    song.ts        the document + all edits + autosave + library (open/new/duplicate/delete)
    midi.ts        Web MIDI access, outputs, the module and sync output selections, send()/sendSync(), panic()
    transport.ts   play/stop/position/seek, wires compile + scheduler + midi, drives the sync output
    editor.ts      the selected block and the clipboard (copy/cut/paste at the cursor/delete)
  components/      Vue SFCs, thin over the stores
    AppHeader, MidiPanel, TransportBar, SettingsPanel,
    SectionsPanel, EditorPanel (browser preferences: track orientation),
    SequencerGrid (+ ChannelHeader), SongIO,
    SongBrowser (slide-out drawer listing the saved songs),
    ConfirmDialog (modal confirmation box, used before deleting a song),
    ModuleView (live picture of the module's 64 outputs)
tests/e2e/         Playwright specs + fake Web MIDI fixture
```

Design choices worth knowing:

- **Compile, then schedule.** The whole song is compiled to a flat, time-sorted
  event list (pure function, deterministic, trivially testable). The scheduler
  only walks that list. Live edits recompile and swap the list without
  re-sending events that already went out and without hanging notes.
- **Timestamps, not timers.** `MIDIOutput.send(data, timestamp)` with a 120 ms
  look-ahead and a 25 ms wake-up, the standard Web Audio "tale of two clocks"
  approach. Timer jitter affects only how early a message is queued.
- **One key per song.** The library index (`conways-sequencer:library`) holds
  the open song's id and a small entry per song (name, counts, timestamps) for
  the browser to list; each song's JSON lives under `conways-sequencer:song:<id>`,
  so autosaving one song never rewrites the others. The pre-library single-slot
  autosave is migrated into the first entry on load. A save compares against
  what is stored, so merely opening a song does not bump its "edited" time.
- **Step storage** is `Record<channelId, number[]>` of sorted on-step indices
  per section: compact in JSON, cheap to toggle, no fixed-size arrays to resize
  when a section's length changes (out-of-range steps are trimmed).
- **Time signature semantics.** Tempo is quarter notes per minute. A beat in
  x/8 is an eighth note, so 7/8 at 120 BPM with subdivision 2 gives 125 ms
  steps. Steps per bar = beats × subdivision.
- **Native objects stay out of reactivity.** `MIDIAccess` lives in a module
  variable; the store exposes plain `OutputInfo` records.

## 3. Milestones

1. **Scaffold** — Vite/Vue/TS/Pinia, ESLint, Vitest, Playwright, CI. ✅
2. **Core model + timing + MIDI + compiler + scheduler** with unit tests. ✅
3. **Stores** (song, midi, transport) with tests, including fake timers and a
   fake MIDI access object. ✅
4. **UI** — MIDI picker, transport, settings, sections table, grid with
   paint-drag, channel header, import/export. Component tests. ✅
5. **E2E** — fake Web MIDI injected via `addInitScript`; tests for output
   selection, section editing, drawing/persistence, 62-channel cap, x16 clock, play gate, playback
   message content and timing, panic, export/import. ✅
6. **Deploy** — single workflow: test job on every push/PR, build with
   `BASE_PATH=/<repo>/` and deploy to Pages on `main`. ✅

## 4. Test strategy

| Layer | Tool | What it proves |
| --- | --- | --- |
| `core/*` | Vitest (node-ish, jsdom env) | Tempo inheritance, step/time math, note mapping, compile output (times, ordering, held/merged gates, mute, settings), scheduler behaviour with fake timers (look-ahead, loop wrap, stop → note-offs, live reload), JSON validation/clamping. |
| `stores/*` | Vitest + Pinia | Every edit action and its invariants (62-channel cap, step trimming, id uniqueness), autosave/debounce/flush, the song library (open, new, duplicate, delete, migration, storage failures), MIDI access states and hot-plug, transport ↔ scheduler ↔ MIDI integration. |
| `components/*` | Vitest + @vue/test-utils | Rendering, user interactions (click/drag/keyboard painting, inputs, buttons), empty and error states, keyboard shortcuts. |
| App | Playwright, headless Chromium | Real DOM, real pointer drags, real `localStorage`, real downloads; MIDI messages asserted byte-for-byte via the fake port log, including timestamps 500 ms apart for steps 4 apart at 120 BPM. |

Coverage thresholds (lines/statements/functions 85 %, branches 80 %) are
enforced in `vite.config.ts` so CI fails if coverage regresses. Current
coverage is ~97 % lines.

## 5. Not in this iteration (candidates for next)

- **Undo/redo** — the song store already funnels every edit through a few
  actions; a command stack or snapshot history fits there.
- **Section-spanning ties** — a tied run that crosses a section boundary
  currently yields two gates.
- **Swing / per-step velocity** — velocity is global because the module only
  reads gates; swing would be a per-section offset applied in `compile.ts`.
- **Game-of-Life helpers** — seed a section from a Life pattern, or step a
  pattern per bar, as a nod to the module's other mode.
- **Hardware verification** — the fake MIDI port proves the bytes; a real
  Conway's Game module should confirm the default base note (36 vs 37) and
  channel.
