import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { compileSong, windowEvents } from '../core/compile'
import { CONTINUE, START, STOP, isRealTime, noteOff, noteOn, songPositionPointer } from '../core/midi'
import { Scheduler } from '../core/scheduler'
import { clamp, type LoopRange } from '../core/song'
import { locate, quarterNotesAt, stepStartTime, type Position } from '../core/timing'
import { useMidiStore } from './midi'
import { useSongStore } from './song'

function sameRange(a: LoopRange | null, b: LoopRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end)
}

/**
 * Transport states:
 *  - stopped: nothing runs and the cursor sits at the start.
 *  - playing: the scheduler runs and the play gate is high.
 *  - paused: nothing runs, the gate is low, but the cursor keeps its position so playback
 *    can resume from there.
 *
 * "The start" is the start of the song, or of the loop range when the song has loop points:
 * playback then stays between them (the scheduler is fed just that window of the song) and
 * the Loop setting decides whether it repeats or stops at the end of the range.
 *
 * Gear on the sync output (see the midi store) follows along: MIDI clock ticks are compiled
 * into the scheduler's event list while a sync output is selected, Start or Song Position
 * Pointer + Continue go out whenever a pass begins (play, resume, reset, seek, loop points that
 * moved), and Stop whenever playback halts. Positions are those of the whole song, so a DAW
 * lands on the same bar as the cursor even when only the loop range plays.
 */
export const useTransportStore = defineStore('transport', () => {
  const songStore = useSongStore()
  const midi = useMidiStore()

  /** Seconds from song start of the start of what plays: the loop range, or the whole song. */
  const loopStart = computed(() => songStore.loopSeconds?.start ?? 0)

  const playing = ref(false)
  const paused = ref(false)
  /** Cursor, in seconds from the start of the song (not of the loop range). */
  const positionSeconds = ref(loopStart.value)
  const position = computed<Position | null>(() => locate(songStore.timeline, positionSeconds.value))
  /** Global step under the cursor while playing or paused, or -1 when stopped. */
  const currentStep = computed(() =>
    playing.value || paused.value ? (position.value?.globalStep ?? -1) : -1,
  )

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  /**
   * The play gate: the song's `playGateNote` is held on for the whole time the song is playing.
   * The pending note-off is remembered so the gate is released on the channel and note it was
   * raised on, even if the settings change mid-song.
   */
  let gateOff: number[] | null = null

  function raiseGate() {
    if (gateOff) return
    const { midiChannel, velocity, playGateNote } = songStore.song.settings
    gateOff = noteOff(midiChannel, playGateNote)
    midi.send(noteOn(midiChannel, playGateNote, velocity), now())
  }

  function releaseGate() {
    if (!gateOff) return
    midi.send(gateOff, now())
    gateOff = null
  }

  const scheduler = new Scheduler({
    // Gates and the x16 clock go to the module; MIDI clock ticks go to the sync output.
    send: (data, at) => (isRealTime(data) ? midi.sendSync(data, at) : midi.send(data, at)),
    now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    // The scheduler stops by itself when a non-looping song (or loop range) reaches its end.
    onStop: () => halt(loopStart.value),
  })

  let frame: unknown = null
  const raf: (cb: () => void) => unknown =
    typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16)
  const caf: (h: unknown) => void =
    typeof cancelAnimationFrame === 'function'
      ? (h) => cancelAnimationFrame(h as number)
      : (h) => clearTimeout(h as ReturnType<typeof setTimeout>)

  /** What the scheduler holds: the window of the song it plays, in seconds from song start. */
  let loadedStart = 0
  let loadedDuration = 0
  let loadedRange: LoopRange | null = null

  function pump() {
    if (!scheduler.isRunning) return
    positionSeconds.value = loadedStart + scheduler.position()
    frame = raf(pump)
  }

  function stopFrames() {
    if (frame !== null) caf(frame)
    frame = null
  }

  /**
   * Tell the sync output where playback is about to go: Start when it is the top of the song,
   * otherwise Song Position Pointer then Continue, so a DAW picks up at the same bar.
   */
  function syncStart(songSeconds: number, at: number) {
    if (songSeconds <= 0) {
      midi.sendSync([START], at)
    } else {
      midi.sendSync(songPositionPointer(quarterNotesAt(songStore.timeline, songSeconds)), at)
      midi.sendSync([CONTINUE], at)
    }
  }

  /**
   * Begin a pass `offset` seconds into what plays, telling the sync output first. Everything is
   * stamped after the events already queued at the outputs, so a receiver counting clock ticks
   * from the Start or Continue counts exactly the ticks of the new pass; a pass that restarts a
   * running one is a Stop followed by a fresh start, as far as the receiver can tell.
   */
  function start(offset: number) {
    const at = scheduler.queuedUntil()
    if (scheduler.isRunning) midi.sendSync([STOP], at)
    syncStart(loadedStart + offset, at)
    scheduler.start(offset)
  }

  /**
   * Hand the song, or the window of it between the loop points, to the scheduler. While
   * playing, an edit is picked up seamlessly; loop points that moved restart playback inside
   * the new range instead, carrying on from the same place when the cursor is still inside it.
   */
  function reload() {
    const compiled = compileSong(songStore.song, { syncClock: midi.isSyncConnected })
    const range = songStore.loopSeconds
    const nextRange = songStore.song.settings.loopRange
    const moved = playing.value && !sameRange(loadedRange, nextRange)
    const was = moved ? loadedStart + scheduler.position() : 0
    loadedStart = range?.start ?? 0
    loadedDuration = range ? range.end - range.start : compiled.duration
    loadedRange = nextRange ? { ...nextRange } : null
    const events = range ? windowEvents(compiled.events, range.start, range.end) : compiled.events
    scheduler.load(events, loadedDuration, songStore.song.settings.loop)
    if (moved && scheduler.isRunning) {
      const from = was - loadedStart
      start(from > 0 && from < loadedDuration ? from : 0)
      positionSeconds.value = loadedStart + scheduler.position()
    }
  }

  /** Stop the scheduler, the gate and the sync, leaving the cursor at `at` (stopped at the start, paused past it). */
  function halt(at: number) {
    const wasPlaying = playing.value
    scheduler.stop(false)
    releaseGate()
    if (wasPlaying) midi.sendSync([STOP], now())
    stopFrames()
    playing.value = false
    positionSeconds.value = at
    paused.value = at > loopStart.value
  }

  /** Start playing from `fromSeconds`: the paused position by default, the start when stopped. */
  function play(fromSeconds = positionSeconds.value) {
    if (songStore.duration <= 0) return
    reload()
    // A cursor outside what plays (the song shrank or the loop points moved while paused) starts over.
    const offset = fromSeconds - loadedStart
    const from = offset > 0 && offset < loadedDuration ? offset : 0
    // The gate goes high before the first step so the module sees "playing" first.
    raiseGate()
    start(from)
    playing.value = scheduler.isRunning
    if (playing.value) {
      paused.value = false
      positionSeconds.value = loadedStart + from
      stopFrames()
      pump()
    } else {
      releaseGate()
      midi.sendSync([STOP], now())
    }
  }

  /** Stop where the cursor is, so `resume()` carries on from the same step. */
  function pause() {
    if (!playing.value) return
    halt(loadedStart + scheduler.position())
  }

  /** Continue from the paused position (or start from the top when stopped). */
  function resume() {
    if (playing.value) return
    play()
  }

  /** Return the cursor to the start. Playback, if running, restarts from there and keeps going. */
  function reset() {
    if (playing.value) {
      start(0)
      positionSeconds.value = loadedStart
      return
    }
    positionSeconds.value = loopStart.value
    paused.value = false
  }

  /**
   * Put the cursor at `seconds` from song start. Stopped or paused, it just moves there (and
   * sits "paused", so it shows, unless that is the start). Playing, playback jumps there and
   * carries on; a target outside the loop points, which playback cannot reach, pauses there.
   */
  function seek(seconds: number) {
    const at = clamp(seconds, 0, songStore.duration)
    if (playing.value) {
      const offset = at - loadedStart
      if (offset >= 0 && offset < loadedDuration) {
        start(offset)
        positionSeconds.value = at
      } else {
        halt(at)
      }
      return
    }
    positionSeconds.value = at
    paused.value = at > loopStart.value
  }

  /** Put the cursor at the start of a step on the whole-song step axis. */
  function seekToStep(globalStep: number) {
    seek(stepStartTime(songStore.timeline, globalStep))
  }

  /** Stop and return the cursor to the start. */
  function stop() {
    halt(loopStart.value)
  }

  /** Play/pause, the Space key behaviour. */
  function toggle() {
    if (playing.value) pause()
    else play()
  }

  /** Stop everything: the song, every output on the module and whatever follows the sync output. */
  function panic() {
    const wasPlaying = playing.value
    stop()
    // Stopping already told the sync output while playing; stopped, Esc still halts gear that runs on.
    if (!wasPlaying) midi.sendSync([STOP], now())
    const { midiChannel, baseNote, playGateNote } = songStore.song.settings
    midi.panic(midiChannel, baseNote, playGateNote)
  }

  // Live-edit: recompile while playing so grid edits are heard on the next pass.
  watch(
    () => songStore.revision,
    () => {
      if (playing.value) reload()
    },
  )

  watch(
    () => songStore.song.settings.loop,
    (loop) => scheduler.setLoop(loop),
  )

  // A sync output chosen while playing gets the clock from here on, and is told where the song
  // is: the pass restarts in place so its ticks and its Continue line up. One deselected or
  // unplugged just stops being fed.
  watch(
    () => (midi.isSyncConnected ? midi.syncOutputId : null),
    (id) => {
      if (!playing.value) return
      reload()
      if (id) start(scheduler.position())
    },
  )

  // A stopped cursor sits at the start of what plays, so it follows the loop points.
  watch(loopStart, (at) => {
    if (!playing.value && !paused.value) positionSeconds.value = at
  })

  return {
    playing,
    paused,
    positionSeconds,
    position,
    currentStep,
    play,
    pause,
    resume,
    reset,
    seek,
    seekToStep,
    stop,
    toggle,
    panic,
  }
})
