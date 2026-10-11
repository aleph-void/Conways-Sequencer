import {
  CLOCK_NOTE,
  CLOCK_PULSES_PER_BEAT,
  MIDI_CLOCKS_PER_QUARTER,
  TIMING_CLOCK,
  noteOff,
  noteOffFor,
  noteOn,
  outputToNote,
} from './midi'
import { cellDivision, gatesOf, isChannelSilenced, type Gate, type Section, type Song } from './song'
import { buildTimeline, stepOffsetSeconds, totalDuration, type SectionTiming } from './timing'

export interface MidiEvent {
  /** Seconds from song start. */
  time: number
  /** A gate's note-on or note-off for the module, or a MIDI clock tick for the sync output. */
  kind: 'on' | 'off' | 'clock'
  /** The note the gate is on, or NO_NOTE for a clock tick, which belongs to no gate. */
  note: number
  data: number[]
}

/** The `note` of an event that is not about a note at all (a sync clock tick). */
export const NO_NOTE = -1

export interface CompileOptions {
  /**
   * Also emit the MIDI clock for the sync output: a Timing Clock tick MIDI_CLOCKS_PER_QUARTER
   * times per quarter note, following each section's tempo. Off by default, since without a
   * sync output the ticks would have nowhere to go.
   */
  syncClock?: boolean
}

export interface CompiledSong {
  events: MidiEvent[]
  duration: number
  timeline: SectionTiming[]
}

/** Minimum gap between a gate's note-off and the next note-on of the same note, in seconds. */
export const MIN_GAP_SECONDS = 0.002

/**
 * Turn a song into a flat, time-sorted list of MIDI events, for the module and, when asked, the
 * sync output.
 *
 * A gate goes high at the start of an on-step and stays high for the whole step. If the
 * following step is also on, the gate is held through it, so a run of consecutive on-steps
 * is one gate that only drops at the next off-step (or the end of the section). A divided
 * step (see `Section.divisions`) fires its share of gates back to back inside the step
 * instead, each taking an equal part of it, and never joins a run: the gates around it drop
 * before it and start fresh after it. Step starts follow the section's swing (see
 * `swingDelay` in core/timing.ts): a swung step starts late and the step before it holds on
 * until it does, so the gates stay back to back.
 *
 * On top of the drawn gates, the x16 clock on CLOCK_NOTE pulses CLOCK_PULSES_PER_BEAT times
 * per beat of every section, following each section's tempo and time signature. Mute and
 * solo never touch it, and neither does swing: like a DAW's MIDI clock it stays straight, so
 * gear following it keeps time while the gates shuffle around it.
 *
 * With `syncClock`, MIDI clock ticks for the sync output are compiled in as well (see
 * `pushSyncClock`), so they share the scheduler's timeline with the gates and stay locked to
 * them through tempo changes and loops.
 *
 * Pure: the same song and options always yield the same events.
 */
export function compileSong(song: Song, options: CompileOptions = {}): CompiledSong {
  const timeline = buildTimeline(song)
  const events: MidiEvent[] = []
  const { midiChannel, baseNote, velocity } = song.settings

  for (const timing of timeline) {
    const section = song.sections[timing.index]
    if (!section) continue
    pushClock(events, timing, section, midiChannel, velocity)
    if (options.syncClock) pushSyncClock(events, timing)
    for (const channel of song.channels) {
      if (isChannelSilenced(channel, song.channels)) continue
      const steps = section.steps[channel.id]
      if (!steps || steps.length === 0) continue
      const note = outputToNote(channel.output, baseNote)
      const on = noteOn(midiChannel, note, velocity)
      const off = noteOff(midiChannel, note)
      const valid = steps.filter((s) => s >= 0 && s < timing.stepCount)
      for (const gate of gatesOf(valid, (step) => cellDivision(section, channel.id, step))) {
        const { start, length } = gateSeconds(timing, gate)
        events.push({ time: start, kind: 'on', note, data: on })
        events.push({ time: start + length, kind: 'off', note, data: off })
      }
    }
  }

  sortEvents(events)
  return { events, duration: totalDuration(timeline), timeline }
}

/**
 * When a gate goes high, in seconds from song start, and for how long: from the start of its
 * first step to the start of the step after its last, swing included, and for a divided step
 * the slot's equal share of that. It drops MIN_GAP_SECONDS before the next step (or slot) so
 * a gate starting there is seen as a fresh note-on.
 */
function gateSeconds(timing: SectionTiming, gate: Gate): { start: number; length: number } {
  const stepStart = timing.startTime + stepOffsetSeconds(timing, gate.start)
  const stepEnd = timing.startTime + stepOffsetSeconds(timing, gate.end + 1)
  const share = (stepEnd - stepStart) / gate.division
  const start = stepStart + gate.slot * share
  return { start, length: Math.max(MIN_GAP_SECONDS, share - MIN_GAP_SECONDS) }
}

/**
 * Sort by time; at equal times send note-offs before note-ons so a new gate on the same note
 * works, with clock ticks in between (they go to another output, so only determinism matters).
 */
function sortEvents(events: MidiEvent[]): MidiEvent[] {
  return events.sort((a, b) => a.time - b.time || rank(a) - rank(b) || a.note - b.note)
}

/**
 * Cut a compiled, time-sorted event list down to the window [start, end) seconds and re-base
 * it so the window starts at 0, which is what playing between loop points comes down to.
 *
 * Gates are kept whole at the edges, exactly as if the window were the entire song: a gate
 * that is already high when the window starts gets a note-on at 0, and one still high when
 * it ends gets a note-off just before the end (MIN_GAP_SECONDS early, like every gate
 * before a following step), so that looping the window re-triggers it cleanly and nothing
 * is left hanging. The x16 clock and the MIDI clock are cut the same way.
 */
export function windowEvents(events: readonly MidiEvent[], start: number, end: number): MidiEvent[] {
  const duration = end - start
  if (!(duration > 0)) return []
  const EPS = 1e-9
  const out: MidiEvent[] = []
  /** Note -> the note-on that left it high, for notes high at `start` and then inside the window. */
  const high = new Map<number, MidiEvent>()
  let inside = false
  for (const event of events) {
    if (event.time >= end - EPS) break
    if (!inside && event.time >= start - EPS) {
      // Entering the window: whatever is still high from before it goes high again at 0.
      inside = true
      for (const on of high.values()) out.push({ ...on, time: 0 })
    }
    if (inside) out.push({ ...event, time: Math.max(0, event.time - start) })
    if (event.kind === 'on') high.set(event.note, event)
    else if (event.kind === 'off') high.delete(event.note)
  }
  if (!inside) for (const on of high.values()) out.push({ ...on, time: 0 })
  // Whatever is still high at the end is released just before the window ends.
  const release = Math.max(MIN_GAP_SECONDS, duration - MIN_GAP_SECONDS)
  for (const on of high.values()) {
    const at = Math.max(release, Math.max(0, on.time - start))
    out.push({ time: at, kind: 'off', note: on.note, data: noteOffFor(on.data) })
  }
  return sortEvents(out)
}

/**
 * Emit the clock pulses for one section: CLOCK_PULSES_PER_BEAT evenly spaced note-on/off pairs
 * per beat. A pulse is high for half its period (a 50 % duty cycle), but never shorter than
 * MIN_GAP_SECONDS and always off before the next pulse starts.
 */
function pushClock(events: MidiEvent[], timing: SectionTiming, section: Section, midiChannel: number, velocity: number) {
  const beats = section.timeSignature.beats * section.bars
  const period = clockPeriod(timing, section)
  const width = clockPulseWidth(period)
  const on = noteOn(midiChannel, CLOCK_NOTE, velocity)
  const off = noteOff(midiChannel, CLOCK_NOTE)
  for (let pulse = 0; pulse < beats * CLOCK_PULSES_PER_BEAT; pulse++) {
    const start = timing.startTime + pulse * period
    events.push({ time: start, kind: 'on', note: CLOCK_NOTE, data: on })
    events.push({ time: start + width, kind: 'off', note: CLOCK_NOTE, data: off })
  }
}

/**
 * Emit the MIDI clock for one section: a Timing Clock tick MIDI_CLOCKS_PER_QUARTER times per
 * quarter note at the section's tempo. As the MIDI spec has it, the rate follows the quarter
 * note whatever the time signature (a beat of x/8 gets half as many ticks), unlike the module's
 * x16 clock, which follows the beat. Like that clock it is never swung.
 */
function pushSyncClock(events: MidiEvent[], timing: SectionTiming) {
  const period = midiClockPeriod(timing.tempo)
  const ticks = Math.round(timing.duration / period)
  const data = [TIMING_CLOCK]
  for (let tick = 0; tick < ticks; tick++) {
    events.push({ time: timing.startTime + tick * period, kind: 'clock', note: NO_NOTE, data })
  }
}

/** Seconds from one MIDI clock tick to the next at a tempo in quarter notes per minute. */
export function midiClockPeriod(tempo: number): number {
  return 60 / tempo / MIDI_CLOCKS_PER_QUARTER
}

/** Seconds from one clock pulse to the next in a section: a beat split CLOCK_PULSES_PER_BEAT ways. */
export function clockPeriod(timing: Pick<SectionTiming, 'stepDuration'>, section: Pick<Section, 'subdivision'>): number {
  return (timing.stepDuration * section.subdivision) / CLOCK_PULSES_PER_BEAT
}

/** How long a clock pulse of the given period stays high (see `pushClock`). */
export function clockPulseWidth(period: number): number {
  return Math.max(MIN_GAP_SECONDS, Math.min(period / 2, period - MIN_GAP_SECONDS))
}

function rank(e: MidiEvent): number {
  return e.kind === 'off' ? 0 : e.kind === 'clock' ? 1 : 2
}
