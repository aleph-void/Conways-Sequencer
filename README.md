# Conway's Sequencer

[![Sponsor Aleph Void](https://img.shields.io/badge/Sponsor-Aleph%20Void-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/aleph-void)

A client-side binary gate sequencer for the
[Nervous Squirrel Conway's Game](https://www.nervoussquirrel.com/conways_game.html)
eurorack module, by [Aleph Void, LLC](https://alephvoid.com).

Draw on/off steps on a piano-roll style grid, one row per module output, and the
app sends MIDI notes over [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API)
so each row becomes a gate on the module. Nothing leaves your browser: there is no
backend, and songs autosave to local storage.

## Features

- **MIDI output picker.** Lists the outputs the browser can see, remembers your
  choice, and follows hot-plugging.
- **MIDI sync output.** A second, optional output picker ("Sync", under the
  interface picker) sends standard MIDI sync to a DAW, drum machine or any other
  gear that follows MIDI clock: Timing Clock at 24 pulses per quarter note while
  the song plays, Start when playback begins at the top of the song, Song
  Position Pointer followed by Continue when it resumes or jumps anywhere else,
  and Stop when it pauses or stops. Nothing else is sent to it, and it can be
  the same port as the module's. The choice is remembered. See
  [Syncing a DAW or other MIDI gear](#syncing-a-daw-or-other-midi-gear).
- **Up to 62 channels** on the module's 64 outputs. Each channel maps to an
  output number (1–62), which becomes MIDI note `baseNote + output - 1`
  (output 1 = C2 / note 36 by default, as the module expects).
- **x16 clock.** MIDI note 98 is pulsed 16 times per beat (note-on then note-off,
  50 % duty cycle) for as long as the song is playing, following each section's
  tempo and time signature, so one module output can clock other gear.
- **Play gate.** A MIDI note is held on for as long as the song is playing and
  released when it pauses or stops, so one module output can act as a run/stop
  gate. It defaults to note 99, the module's 64th output (its 64 outputs follow
  notes 36–99), and can be changed in the module settings. See
  [Syncing Pam's Pro Workout](#syncing-pams-pro-workout) for a patch that uses
  these two outputs to clock and run another module.
- **Sections** with their own tempo, time signature, bar count, step
  resolution and swing. Leave a section's tempo or swing blank and it inherits
  the previous section's. Reorder sections by dragging the ⋮⋮ grip (or focus it and
  press ↑/↓), and duplicate one, notes included, with ⧉.
- **Swing.** Each section has a swing percentage, the MPC-style figure most
  DAWs and grooveboxes use: 50 % is straight, 67 % a triplet feel (the
  off-steps land on the last third of a triplet) and 75 % the hardest shuffle,
  with the off-steps a dotted step late. It works on the section's step grid:
  the steps of every beat are paired up and the second step of each pair is
  pushed late to that fraction of the pair, so with 4 steps per beat it is
  sixteenth swing and with 2 it is eighth swing. The first step of a pair never
  moves, so beats and bars stay put, and a gate drawn on a straight step holds
  on until the swung step after it starts, so gates stay back to back. The x16
  clock is not swung, like a DAW's MIDI clock, so gear following it keeps
  straight time while the gates shuffle around it. Swing is saved with the
  song.
- **Draw gates** by clicking or click-dragging across the grid; Enter/Space
  toggles the focused cell for keyboard users.
- **Divide a cell.** Right-click a cell (or press the Menu key or Shift+F10 on
  a focused one) and pick 1 to 8 from the menu: the step then fires that many
  evenly spaced gates back to back inside it, like a ratchet, instead of one
  gate held for the whole step, and 1 makes it a plain gate again. An empty
  cell is turned on. Right-click a cell inside the selected block and the
  choice applies to every gate in the block (its empty cells stay empty), so a
  whole run can be divided at once; the menu marks the divisions the block
  already holds. A divided cell is drawn as that many short bars and never
  joins the gates next to it into one long gate. Divisions travel with blocks
  and bars when they are copied, cut and pasted, and are saved with the song.
- **Select, copy and paste blocks.** Shift+drag across the grid selects a block
  of cells spanning as many tracks and steps as the drag covers (Shift+Enter or
  Shift+Space stretches the selection to the focused cell for keyboard users).
  Ctrl/Cmd+C copies the block, Ctrl/Cmd+X cuts it, Delete clears it, and
  Ctrl/Cmd+V pastes it where the cursor is: its first step lands on the
  cursor's step and its first track on the selected track (or the one it came
  from), replacing what those cells held. The same commands sit above the grid
  as buttons, and the clipboard survives switching songs, so a block can be
  carried from one song to another. Selection needs a mouse or pen; on a touch
  screen a drag scrolls the grid.
- **Cut, copy, paste and delete whole bars.** The bars between the loop points
  (see below) are the selected bars, and the buttons above the grid work on
  them as time rather than as cells: Delete bars takes them out of the song,
  gates and all, so the bars after them move up and the song gets shorter; Cut
  bars does the same but keeps them on a clipboard of their own; Copy bars just
  copies them; and Insert bars at cursor puts the clipboard back in front of
  the bar the cursor is in (click a bar number to put it there), pushing the
  rest of the song along. The keys are the block's with Shift: Ctrl/Cmd+Shift+C,
  Ctrl/Cmd+Shift+X, Ctrl/Cmd+Shift+V and Shift+Delete. Bars that keep time the
  way the section they land in does join it; bars with another time signature
  or step resolution become a section of their own, splitting the one they land
  inside, and keep the tempo and name of the section they came from. The pasted
  bars become the loop points so they show, and the clipboard survives switching
  songs.
- **Place the cursor** by clicking a section header or a bar number: the cursor
  goes to the step under the pointer (Enter/Space on a focused header puts it at
  the header's start). While playing, playback jumps there and carries on; while
  stopped, the transport shows the position as paused, so Play resumes from it
  and a paste lands on it.
- **A colour per track.** Every channel row draws its gates, and the swatch beside
  its name, in its own hue, so neighbouring tracks are easy to tell apart at a
  glance. Colours follow row position: twelve well-separated hues, then the
  palette repeats.
- **Gates follow the grid.** A gate goes high for the whole of every step it is
  drawn on, and consecutive on-steps hold it high as one long gate until the
  next empty step. The grid draws such a run as one continuous bar. A divided
  step breaks the run on either side of it: its gates each take an equal share
  of the step (of the swung step, when it swings) and drop 2 ms before the
  next one, so the module sees every one of them as a fresh trigger.
- **Sample-accurate-ish timing**: a look-ahead scheduler hands messages to the
  MIDI port with explicit timestamps, so JavaScript timer jitter never reaches
  the module. Edits while playing are picked up live.
- **Autosave.** Every edit made in the GUI is written to the browser's local
  storage a moment later and restored on the next visit; the Song panel shows
  when the last save happened and warns if storage is full or disabled.
- **Song browser.** The "Songs" tab on the left edge slides out a drawer listing
  every song saved in this browser, most recently edited first. Pick one to
  load it and work on it (the choice is remembered across reloads), start a new
  song, duplicate one with ⧉ (the copy, named "… copy", opens), or delete one
  with × after confirming in a dialog. "New" and "Import JSON" add a song to
  the browser rather than replacing the one you have open.
- **Module view.** A "Module" button in the toolbar shows a picture of the
  Conway's Game panel beside the grid: its 64 outputs in the module's 8x8
  layout, each ringed in the colour of the track assigned to it, with the x16
  clock and the play gate marked. While the song plays, every output that is
  high right now lights up, following the cursor frame by frame, so you can
  check what the module is being sent while you work on the song. It works
  without a MIDI output selected (and says so), flags a base note that pushes
  the clock or play gate off the panel, and is remembered across reloads.
- **Transport.** Play, pause where the cursor is, resume from there, reset the
  cursor to the start (playback keeps going if it was running), stop, loop and
  panic. Space = play/pause, Esc = panic. The cursor can also be placed by
  clicking a section header or a bar number in the grid (see above).
- **Loop points.** The Loop strip under the bar numbers sets a range of bars to
  listen to on their own: click a bar to loop just that bar, drag across bars for
  a range, Shift+click (or Shift+Enter) to extend it, ✕ to clear it. Playback
  stays between the points, across sections and tempo changes, and the Loop
  box decides whether the range repeats or plays once and stops. Gates that
  cross a loop point are cut cleanly at it, and the points are saved with the
  song. The same range is the bar selection the Cut, Copy and Delete bars
  buttons act on (see above).
- **JSON export/import.**
- **Works offline and installs as an app.** The site is a progressive web app:
  a service worker precaches the whole build on the first visit, so it loads
  without a network afterwards (web fonts are cached once seen too), and the
  browser offers to install it as a standalone app with the Aleph Void icon.
  An "Offline" badge shows while the connection is down, and when a new
  version has been deployed a toast offers to reload into it; nothing swaps
  underneath you mid-performance.
- **Editor-first layout.** The grid fills the viewport below a one-line
  toolbar (MIDI output + transport); sections, module settings and song files
  live in a collapsible settings drawer whose state is remembered. A Full
  screen button puts the whole GUI in the browser's full-screen mode.
- **Track orientation.** An Editor setting in the drawer turns the grid: tracks
  run left to right (the default), right to left, top to bottom or bottom to
  top. Sideways, every channel becomes a column headed by its name and
  controls, and the section, bar and loop strips run down the left edge. A
  song is far taller than it is wide that way, so vertical tracks run down the
  page rather than scrolling inside the grid: the page grows with the song and
  scrolls as a whole, with the module view keeping its place beside it. The
  choice is a preference of the browser, kept across songs and reloads; it is
  not part of the song file.
- **Works on tablets and phones.** Below desktop width the page scrolls
  instead of squeezing the grid; on phones the toolbar and drawer stack, the
  channel column narrows and the drawer starts closed so the grid is on
  screen. On touch screens the steps and controls are bigger, a tap draws a
  gate and a swipe scrolls the grid.

## Syncing Pam's Pro Workout

The x16 clock and the play gate exist so the module can drive other gear in
time with the song. Here is how to run
[ALM Pamela's PRO Workout](https://busycircuits.com/alm038/) from them, so
Pam's outputs follow the song's tempo and start and stop with the transport.

### Patch

With the default base note (output 1 = note 36), the two sync outputs are the
last two on the panel:

| Conway's Game output | MIDI note | Carries        | Patch to on Pam's      |
| -------------------- | --------- | -------------- | ---------------------- |
| 63 (penultimate)     | 98        | x16 clock      | **CLK** CV input       |
| 64 (last)            | 99        | Play gate      | **RUN** CV input       |

Output 63 pulses 16 times per beat while the song plays and acts as Pam's
external clock. Output 64 is held high for as long as the song plays and
released when it pauses or stops, so Pam's runs and stops with the transport.

The play gate note can be changed in the module settings; if you move it, patch
whichever output now carries it to RUN instead. The Module view marks both the
clock and the play gate on the panel picture, so it is the quickest way to
check which jack is which.

### Pam's settings

In Pam's main settings (press and hold the encoder):

| Setting                 | Value    | Why                                              |
| ----------------------- | -------- | ------------------------------------------------ |
| **Clock mode**          | **CV**   | Pam's follows the clock on its CLK input         |
| **CV clock divisions**  | **16**   | The clock is 16 pulses per beat (sixteenths)     |
| **RUN MODE**            | **RUN**  | The RUN input starts and stops Pam's as a gate   |

With the clock divisions set to 16, Pam's reads sixteen pulses as one beat, so
its BPM, divisions and multiplications line up with the tempo set in each
section of the song, including tempo changes between sections. With RUN MODE
set to RUN, Pam's starts when the play gate goes high and stops when it goes
low, so pressing Play, Pause or Stop in the sequencer does the same on Pam's;
any other RUN MODE (such as RESET) will not follow the transport.

Set Pam's internal BPM aside: in CV clock mode the displayed tempo follows the
incoming clock, and the sequencer decides it from the section's tempo and time
signature.

## Syncing a DAW or other MIDI gear

The x16 clock and play gate above sync gear through the module's outputs. Gear
with a MIDI input (a DAW, a drum machine, a hardware sequencer, or a eurorack
MIDI-to-clock module) can follow the transport directly instead: pick it in the
**Sync** picker under the interface picker and set it to follow external MIDI
clock (in a DAW, enable sync or "slave to MIDI clock" on that input).

While the song plays, the sync output gets a MIDI Timing Clock tick 24 times per
quarter note, following each section's tempo, including tempo changes between
sections. As the MIDI specification has it, the rate follows the quarter note
whatever the time signature (a beat of x/8 gets 12 ticks), unlike the module's
x16 clock, which follows the beat. Swing never touches it. The transport
messages follow the sequencer's:

| Sequencer                                   | Sync output sends                        |
| ------------------------------------------- | ---------------------------------------- |
| Play from the top of the song               | Start                                    |
| Resume, or play from anywhere else          | Song Position Pointer, then Continue     |
| Reset or click a bar while playing          | Stop, then Start or Position + Continue  |
| Pause, Stop, the end of a non-looping song  | Stop                                     |
| Panic (Esc)                                 | Stop, even when already stopped          |

Positions are counted from the start of the whole song, so when only the bars
between the loop points play the receiver still lands on the same bar as the
cursor. When the loop wraps the clock just keeps ticking: the receiver carries
on forward rather than jumping back, as it would with a DAW's own loop. The
clock is only sent while the song plays; gear that needs a clock while stopped
to show a tempo will show its own until Play.

## Browser support

Web MIDI is available in Chromium-based browsers (Chrome, Edge, Opera, Brave).
Firefox needs a site permission add-on; Safari does not support it.

## Development

```sh
npm install
npm run dev          # local dev server
npm run check        # typecheck + lint + unit tests
npm run test:e2e     # Playwright end-to-end tests (needs `npx playwright install chromium` once)
npm run build        # production build to dist/
```

Unit and component tests live next to the code as `*.spec.ts` and run with
Vitest in jsdom. End-to-end tests live in `tests/e2e` and run against the built
app in headless Chromium with a fake Web MIDI implementation that records every
message sent; `tests/e2e/pwa.spec.ts` also takes the browser offline and checks
the app still loads from the service worker's cache.

The PWA pieces live in `vite.config.ts` (`VitePWA`: manifest and Workbox
precache/runtime-cache rules) and `src/components/PwaStatus.vue` (offline badge
and update/offline-ready toasts). The service worker is only generated by
`npm run build`; `npm run dev` runs without one. The PNG icons under `public/`
are rendered from `public/favicon.svg` by `node scripts/make-icons.mjs`
(needs the Playwright Chromium); re-run it after changing the logo.

The same script renders `public/og-image.png`, the 1200×630 preview card that
the Open Graph and Twitter Card `<meta>` tags in `index.html` point at, so a
link to the site unfurls with the logo, title and description on Facebook,
LinkedIn, Slack, Discord, iMessage, Mastodon, Bluesky and X. Those tags carry
absolute URLs on the production domain (see `CNAME`), because link scrapers
do not resolve relative paths; edit them if the domain changes. The card is
excluded from the service worker's precache since only scrapers fetch it.

## Deployment

`.github/workflows/ci.yml` runs lint, typecheck, unit tests with coverage
thresholds, the production build and the e2e suite on every push and pull
request. On a push to `main` it then builds with `BASE_PATH=/<repo>/` and
deploys `dist/` to GitHub Pages. Enable Pages for the repository with
**Source: GitHub Actions** once, and every merge to `main` ships.

## Automation

The other files under `.github/` are free GitHub features that keep the
repository healthy without any paid plan (the repository is public):

- **Dependabot** (`dependabot.yml`) opens weekly, grouped pull requests for npm
  packages and for the actions used in the workflows. Security updates arrive as
  soon as an advisory is published.
- **Dependabot auto-merge** (`workflows/dependabot-auto-merge.yml`) enables
  GitHub auto-merge on Dependabot's minor and patch bumps, so they land once CI
  is green; majors wait for a human. It needs **Allow auto-merge** enabled in
  the repository settings and a ruleset on `main` that requires the CI job
  (without a required check, auto-merge would merge immediately).
- **CodeQL** (`workflows/codeql.yml`) scans the TypeScript on every pull
  request, every push to `main` and weekly, and reports to the Security tab. If
  CodeQL *default setup* is enabled in the repository's code-security settings,
  disable it or delete this workflow; the two cannot run side by side.
- **Dependency review** (`workflows/dependency-review.yml`) fails a pull request
  that adds a dependency with a known high-severity vulnerability or a strong
  copyleft licence. It requires **Dependency graph** to be enabled under the
  repository's Advanced Security settings.
- **OpenSSF Scorecard** (`workflows/scorecard.yml`) scores supply-chain
  practices on every push to `main` and weekly, and publishes the result so a
  badge can be shown.
- **Workflow lint** (`workflows/workflow-lint.yml`) runs
  [actionlint](https://github.com/rhysd/actionlint) and
  [zizmor](https://github.com/zizmorcore/zizmor) whenever anything under
  `.github/` changes, catching workflow syntax errors and security
  anti-patterns. Every action is pinned to a commit SHA with the version in a
  trailing comment; Dependabot updates both together.

## Song file format

Songs are plain JSON (`*.conway-seq.json`). Unknown fields are ignored on
import and out-of-range values are clamped; see `src/core/serialization.ts`.

```jsonc
{
  "version": 1,
  "name": "Untitled",
  "settings": {
    "midiChannel": 1, "baseNote": 36, "velocity": 100, "playGateNote": 99, "loop": true,
    "loopRange": { "start": 4, "end": 8 }  // bars 5–8 of the whole song (0-based, end exclusive); null = whole song
  },
  "channels": [{ "id": "ch_1", "name": "Kick", "output": 0, "muted": false, "solo": false }],
  "sections": [
    {
      "id": "sec_1",
      "name": "A",
      "tempo": 120,                    // null = inherit from the previous section
      "timeSignature": { "beats": 4, "unit": 4 },
      "bars": 4,
      "subdivision": 4,                // steps per beat
      "swing": 66,                     // 50..75, 50 = straight; null = inherit from the previous section
      "steps": { "ch_1": [0, 4, 8, 12] }, // "on" step indices per channel
      "divisions": { "ch_1": { "12": 3 } } // step -> gates it is divided into (2..8) per channel; absent = one gate
    }
  ]
}
```

## License

MIT
