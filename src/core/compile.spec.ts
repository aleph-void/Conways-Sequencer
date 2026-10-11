import { describe, expect, it } from 'vitest'
import { MIN_GAP_SECONDS, NO_NOTE, compileSong, midiClockPeriod, windowEvents, type MidiEvent } from './compile'
import { CLOCK_NOTE, TIMING_CLOCK } from './midi'
import { createChannel, createSection, createSong, type Song } from './song'

/** The drawn gates only: the clock is checked by its own tests below. */
function gates(events: readonly MidiEvent[]): MidiEvent[] {
  return events.filter((e) => e.note !== CLOCK_NOTE)
}

function clock(events: readonly MidiEvent[]): MidiEvent[] {
  return events.filter((e) => e.note === CLOCK_NOTE)
}

function song(overrides: Partial<Song> = {}): Song {
  const base = createSong()
  base.channels = [createChannel(0, { id: 'c0' }), createChannel(5, { id: 'c5' })]
  base.sections = [createSection({ id: 's1', tempo: 120, bars: 1 })] // 16 steps × 0.125 s
  return { ...base, ...overrides }
}

describe('compileSong', () => {
  it('fires a divided step\'s gates back to back inside the step and breaks the run around it', () => {
    const s = song()
    // Steps 0–1 are a run, 2 is divided in four, 3 follows it: the run drops before 2, and
    // 3 starts afresh after 2's four 31.25 ms gates.
    s.sections[0]!.steps = { c0: [0, 1, 2, 3] }
    s.sections[0]!.divisions = { c0: { 2: 4 } }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.kind)).toEqual(['on', 'off', 'on', 'off', 'on', 'off', 'on', 'off', 'on', 'off', 'on', 'off'])
    const times = events.map((e) => e.time)
    expect(times[0]).toBe(0)
    expect(times[1]).toBeCloseTo(0.25 - MIN_GAP_SECONDS)
    for (let slot = 0; slot < 4; slot++) {
      expect(times[2 + slot * 2]).toBeCloseTo(0.25 + slot * 0.03125)
      expect(times[3 + slot * 2]).toBeCloseTo(0.25 + (slot + 1) * 0.03125 - MIN_GAP_SECONDS)
    }
    expect(times[10]).toBeCloseTo(0.375)
    expect(times[11]).toBeCloseTo(0.5 - MIN_GAP_SECONDS)
  })

  it('divides a swung step over its real, longer or shorter, length', () => {
    const s = song()
    s.sections[0]!.swing = 75
    // Step 1 swings half a step late (62.5 ms), so it lasts 62.5 ms; halved, its two gates are 31.25 ms.
    s.sections[0]!.steps = { c0: [1] }
    s.sections[0]!.divisions = { c0: { 1: 2 } }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.time)).toEqual([
      expect.closeTo(0.1875, 6),
      expect.closeTo(0.1875 + 0.03125 - MIN_GAP_SECONDS, 6),
      expect.closeTo(0.1875 + 0.03125, 6),
      expect.closeTo(0.25 - MIN_GAP_SECONDS, 6),
    ])
  })

  it('never lets a divided gate drop before it starts, however short the step', () => {
    const s = song()
    s.sections[0]!.tempo = 400
    s.sections[0]!.subdivision = 8
    s.sections[0]!.steps = { c0: [0] }
    s.sections[0]!.divisions = { c0: { 0: 8 } }
    const events = gates(compileSong(s).events)
    expect(events).toHaveLength(16)
    for (let i = 0; i < 16; i += 2) expect(events[i + 1]!.time - events[i]!.time).toBeCloseTo(MIN_GAP_SECONDS, 9)
  })

  it('produces only the clock for an empty grid', () => {
    const c = compileSong(song())
    expect(gates(c.events)).toEqual([])
    expect(c.events).toHaveLength(2 * 16 * 4)
    expect(c.duration).toBe(2)
  })

  it('holds a gate high for the whole step it is drawn on', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0, 4] }
    const events = gates(compileSong(s).events)
    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({ time: 0, kind: 'on', note: 36, data: [0x90, 36, 100] })
    expect(events[1]).toMatchObject({ kind: 'off', note: 36, data: [0x80, 36, 0] })
    expect(events[1]!.time).toBeCloseTo(0.125 - MIN_GAP_SECONDS) // full step, minus the retrigger gap
    expect(events[2]!.time).toBeCloseTo(0.5)
    expect(events[3]!.time).toBeCloseTo(0.625 - MIN_GAP_SECONDS)
  })

  it('uses the base note, MIDI channel and velocity from settings', () => {
    const s = song()
    s.settings = { ...s.settings, baseNote: 48, midiChannel: 3, velocity: 64 }
    s.sections[0]!.steps = { c5: [1] }
    const { events } = compileSong(s)
    expect(gates(events)[0]!.data).toEqual([0x92, 53, 64])
    expect(gates(events)[1]!.data).toEqual([0x82, 53, 0])
    expect(clock(events)[0]!.data).toEqual([0x92, CLOCK_NOTE, 64])
    expect(clock(events)[1]!.data).toEqual([0x82, CLOCK_NOTE, 0])
  })

  it('keeps a gate high through consecutive on-steps until the next off-step', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0, 1, 2, 8] }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.kind)).toEqual(['on', 'off', 'on', 'off'])
    expect(events[0]!.time).toBe(0)
    expect(events[1]!.time).toBeCloseTo(0.375 - MIN_GAP_SECONDS)
    expect(events[2]!.time).toBeCloseTo(1)
    expect(events[3]!.time).toBeCloseTo(1.125 - MIN_GAP_SECONDS)
  })

  it('drops a gate just before the next on-step after a gap so the module sees a new note-on', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0, 2] }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.kind)).toEqual(['on', 'off', 'on', 'off'])
    expect(events[1]!.time).toBeCloseTo(0.125 - MIN_GAP_SECONDS)
    expect(events[1]!.time).toBeLessThan(events[2]!.time)
    expect(events[2]!.time).toBeCloseTo(0.25)
  })

  it('holds a gate to the end of the section when the last steps are on', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [14, 15] }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.kind)).toEqual(['on', 'off'])
    expect(events[0]!.time).toBeCloseTo(1.75)
    expect(events[1]!.time).toBeCloseTo(2 - MIN_GAP_SECONDS)
  })

  it('swings the off-steps late and holds the step before each one until it starts', () => {
    const s = song()
    s.sections[0]!.swing = 66 // steps 1, 3, 5... start 0.66 × 250 ms = 165 ms into their pair
    s.sections[0]!.steps = { c0: [0, 1, 2, 3, 5] }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.kind)).toEqual(['on', 'off', 'on', 'off'])
    // Steps 0-3 are one gate: from 0 to the start of step 4, which does not swing.
    expect(events[0]!.time).toBe(0)
    expect(events[1]!.time).toBeCloseTo(0.5 - MIN_GAP_SECONDS)
    // Step 5 starts late and still ends at step 6, so it is a shorter gate.
    expect(events[2]!.time).toBeCloseTo(0.5 + 0.165)
    expect(events[3]!.time).toBeCloseTo(0.75 - MIN_GAP_SECONDS)
  })

  it('holds a straight step on until the swung step after it starts', () => {
    const s = song()
    s.sections[0]!.swing = 75
    s.sections[0]!.steps = { c0: [0], c5: [1] }
    const [on0, off0, on1, off1] = gates(compileSong(s).events)
    // Step 0's gate runs until step 1 starts at 187.5 ms; step 1's gate is the rest of the pair.
    expect(on0!.time).toBe(0)
    expect(off0!.time).toBeCloseTo(0.1875 - MIN_GAP_SECONDS)
    expect(on1!.time).toBeCloseTo(0.1875)
    expect(off1!.time).toBeCloseTo(0.25 - MIN_GAP_SECONDS)
    expect(gates(compileSong(s).events)).toHaveLength(4)
  })

  it('keeps the clock straight whatever the swing', () => {
    const s = song()
    const straight = clock(compileSong(s).events).map((e) => e.time)
    s.sections[0]!.swing = 75
    expect(clock(compileSong(s).events).map((e) => e.time)).toEqual(straight)
  })

  it('skips muted channels', () => {
    const s = song()
    s.channels[0]!.muted = true
    s.sections[0]!.steps = { c0: [0], c5: [0] }
    const events = gates(compileSong(s).events)
    expect(events.map((e) => e.note)).toEqual([41, 41])
  })

  it('only plays soloed channels while any channel is soloed', () => {
    const s = song()
    s.channels[1]!.solo = true
    s.sections[0]!.steps = { c0: [0], c5: [0] }
    expect(gates(compileSong(s).events).map((e) => e.note)).toEqual([41, 41])

    // Soloing a second channel un-silences it; the pair plays together.
    s.channels[0]!.solo = true
    expect(gates(compileSong(s).events).map((e) => e.note)).toEqual([36, 41, 36, 41])

    // A muted channel stays silent even when soloed.
    s.channels[0]!.muted = true
    expect(gates(compileSong(s).events).map((e) => e.note)).toEqual([41, 41])
  })

  it('ignores steps outside the section length', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [15, 16, 99, -1] }
    expect(gates(compileSong(s).events)).toHaveLength(2)
  })

  it('offsets events in later sections by the earlier sections duration', () => {
    const s = song()
    s.sections.push(createSection({ id: 's2', tempo: null, bars: 1 }))
    s.sections[1]!.steps = { c0: [0] }
    const { events, timeline } = compileSong(s)
    expect(timeline[1]!.startTime).toBe(2)
    expect(gates(events)[0]!.time).toBe(2)
  })

  it('sorts events by time with note-offs before note-ons at equal times', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0], c5: [0] }
    const { events } = compileSong(s)
    // At time 0 the three note-ons are ordered by note; the clock's own pulses interleave after that.
    expect(events.slice(0, 3).map((e) => [e.kind, e.note])).toEqual([
      ['on', 36],
      ['on', 41],
      ['on', CLOCK_NOTE],
    ])
    expect(gates(events).map((e) => [e.kind, e.note])).toEqual([
      ['on', 36],
      ['on', 41],
      ['off', 36],
      ['off', 41],
    ])
  })

  describe('x16 clock', () => {
    it('pulses note 98 sixteen times per beat with a half-period width', () => {
      const { events } = compileSong(song()) // 1 bar of 4/4 at 120 BPM: 4 beats of 0.5 s
      const pulses = clock(events)
      expect(pulses).toHaveLength(2 * 16 * 4)
      expect(pulses[0]).toMatchObject({ time: 0, kind: 'on', note: CLOCK_NOTE, data: [0x90, CLOCK_NOTE, 100] })
      expect(pulses[1]).toMatchObject({ kind: 'off', note: CLOCK_NOTE, data: [0x80, CLOCK_NOTE, 0] })
      expect(pulses[1]!.time).toBeCloseTo(0.5 / 16 / 2)
      expect(pulses[2]!.time).toBeCloseTo(0.5 / 16)
      // The 17th pulse starts exactly one beat in.
      expect(pulses[32]!.time).toBeCloseTo(0.5)
      expect(pulses.at(-2)!.time).toBeCloseTo(2 - 0.5 / 16)
      expect(pulses.every((p) => p.note === CLOCK_NOTE)).toBe(true)
    })

    it('follows each section\'s tempo and time signature', () => {
      const s = song()
      s.sections = [
        createSection({ id: 's1', tempo: 60, timeSignature: { beats: 3, unit: 4 }, bars: 1 }), // 3 beats of 1 s
        createSection({ id: 's2', tempo: 120, timeSignature: { beats: 6, unit: 8 }, bars: 1, subdivision: 2 }), // 6 beats of 0.25 s
      ]
      const pulses = clock(compileSong(s).events).filter((e) => e.kind === 'on')
      expect(pulses).toHaveLength(16 * 3 + 16 * 6)
      expect(pulses[1]!.time).toBeCloseTo(1 / 16)
      expect(pulses[48]!.time).toBeCloseTo(3)
      expect(pulses[49]!.time).toBeCloseTo(3 + 0.25 / 16)
    })

    it('keeps every pulse off before the next one starts at the fastest tempo', () => {
      const s = song()
      s.sections = [createSection({ id: 's1', tempo: 400, timeSignature: { beats: 1, unit: 16 }, bars: 1 })]
      const pulses = clock(compileSong(s).events)
      expect(pulses[1]!.time).toBeGreaterThanOrEqual(MIN_GAP_SECONDS)
      expect(pulses[1]!.time).toBeLessThan(pulses[2]!.time)
    })

    it('is not silenced by mute or solo', () => {
      const s = song()
      s.channels[0]!.muted = true
      s.channels[1]!.solo = true
      expect(clock(compileSong(s).events)).toHaveLength(2 * 16 * 4)
    })
  })

  it('is deterministic', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0, 3, 7], c5: [1, 2] }
    expect(compileSong(s)).toEqual(compileSong(s))
  })
})

describe('windowEvents', () => {
  function ev(time: number, kind: 'on' | 'off', note = 36): MidiEvent {
    return { time, kind, note, data: kind === 'on' ? [0x90, note, 100] : [0x80, note, 0] }
  }

  it('keeps only the events inside the window, re-based to start at 0', () => {
    const events = [ev(0, 'on'), ev(0.1, 'off'), ev(1, 'on'), ev(1.1, 'off'), ev(2, 'on'), ev(2.1, 'off')]
    const out = windowEvents(events, 1, 2)
    expect(out.map((e) => [e.kind, Number(e.time.toFixed(6))])).toEqual([
      ['on', 0],
      ['off', 0.1],
    ])
    expect(out[0]!.data).toEqual([0x90, 36, 100])
  })

  it('is empty for an empty or inverted window', () => {
    expect(windowEvents([ev(0, 'on'), ev(0.1, 'off')], 1, 1)).toEqual([])
    expect(windowEvents([ev(0, 'on'), ev(0.1, 'off')], 2, 1)).toEqual([])
  })

  it('raises a gate that is already high when the window starts', () => {
    const events = [ev(0.5, 'on'), ev(0.7, 'on', 40), ev(0.9, 'off', 40), ev(1.5, 'off')]
    const out = windowEvents(events, 1, 2)
    // Note 36 spans the window start: its note-on comes back at 0. Note 40 ended before it.
    expect(out).toEqual([ev(0, 'on'), ev(0.5, 'off')])
  })

  it('releases a gate that is still high when the window ends', () => {
    const events = [ev(1.5, 'on'), ev(3, 'off')]
    const out = windowEvents(events, 1, 2)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(ev(0.5, 'on'))
    expect(out[1]).toMatchObject({ kind: 'off', note: 36, data: [0x80, 36, 0] })
    expect(out[1]!.time).toBeCloseTo(1 - MIN_GAP_SECONDS)
  })

  it('releases on the channel the gate was raised on', () => {
    const on: MidiEvent = { time: 1.5, kind: 'on', note: 36, data: [0x95, 36, 100] }
    const out = windowEvents([on, ev(3, 'off')], 1, 2)
    expect(out[1]!.data).toEqual([0x85, 36, 0])
  })

  it('bridges a gate that spans the whole window', () => {
    const events = [ev(0, 'on'), ev(5, 'off')]
    const out = windowEvents(events, 1, 2)
    expect(out.map((e) => e.kind)).toEqual(['on', 'off'])
    expect(out[0]!.time).toBe(0)
    expect(out[1]!.time).toBeCloseTo(1 - MIN_GAP_SECONDS)
  })

  it('never releases a gate before its own note-on in a tiny window', () => {
    const events = [ev(1.0005, 'on'), ev(5, 'off')]
    const out = windowEvents(events, 1, 1.001)
    expect(out.map((e) => e.kind)).toEqual(['on', 'off'])
    expect(out[1]!.time).toBeGreaterThanOrEqual(out[0]!.time)
  })

  it('treats an event exactly at the window end as outside it', () => {
    const events = [ev(0, 'on'), ev(0.1, 'off'), ev(2, 'on'), ev(2.1, 'off')]
    expect(windowEvents(events, 1, 2)).toEqual([])
  })

  it('cuts a compiled song, clock included, to a bar in the middle', () => {
    const s = song()
    s.sections[0]!.bars = 3 // three 2 s bars
    s.sections[0]!.steps = { c0: [0, 15, 16, 17, 30, 31, 32] } // a gate across each bar line
    const compiled = compileSong(s)
    const out = windowEvents(compiled.events, 2, 4)
    expect(clock(out)).toHaveLength(2 * 16 * 4)
    expect(clock(out)[0]!.time).toBe(0)
    const g = gates(out)
    expect(g.map((e) => [e.kind, Number(e.time.toFixed(3))])).toEqual([
      ['on', 0], // steps 15–17 are one gate; it is high at the bar line, so it goes high at 0
      ['off', 0.248],
      ['on', 1.75], // steps 30–32 run past the bar line: released just before the window ends
      ['off', 1.998],
    ])
  })
})

describe('MIDI clock', () => {
  const ticks = (events: readonly MidiEvent[]) => events.filter((e) => e.kind === 'clock')

  it('is left out unless asked for', () => {
    expect(ticks(compileSong(song()).events)).toEqual([])
    expect(ticks(compileSong(song(), {}).events)).toEqual([])
  })

  it('ticks 24 times per quarter note at the section tempo, leaving the rest untouched', () => {
    const { events } = compileSong(song(), { syncClock: true }) // 1 bar of 4/4 at 120 BPM: 2 s, 4 quarter notes
    const t = ticks(events)
    expect(t).toHaveLength(96)
    expect(t[0]).toEqual({ time: 0, kind: 'clock', note: NO_NOTE, data: [TIMING_CLOCK] })
    expect(t[1]!.time).toBeCloseTo(midiClockPeriod(120), 9)
    expect(t[24]!.time).toBeCloseTo(0.5, 9)
    expect(t[95]!.time).toBeCloseTo(2 - midiClockPeriod(120), 9)
    expect(events.filter((e) => e.kind !== 'clock')).toEqual(compileSong(song()).events)
  })

  it("follows the quarter note, not the beat, in x/8 time, and each section's tempo", () => {
    const s = song()
    s.sections = [
      createSection({ id: 'a', tempo: 120, bars: 1, timeSignature: { beats: 6, unit: 8 } }), // 6 eighths: 3 quarter notes, 1.5 s
      createSection({ id: 'b', tempo: 60, bars: 1 }), // 4 quarter notes, 4 s
    ]
    const t = ticks(compileSong(s, { syncClock: true }).events)
    expect(t).toHaveLength(3 * 24 + 4 * 24)
    expect(t[72]!.time).toBeCloseTo(1.5, 9)
    expect(t[71]!.time).toBeCloseTo(1.5 - midiClockPeriod(120), 9)
    expect(t[73]!.time - t[72]!.time).toBeCloseTo(midiClockPeriod(60), 9)
  })

  it('is not swung and ignores mute and solo', () => {
    const s = song()
    s.sections[0]!.swing = 75
    s.channels[0]!.muted = true
    s.channels[1]!.solo = true
    const straight = ticks(compileSong(song(), { syncClock: true }).events).map((e) => e.time)
    expect(ticks(compileSong(s, { syncClock: true }).events).map((e) => e.time)).toEqual(straight)
  })

  it('goes out before the note-ons that share its instant', () => {
    const s = song()
    s.sections[0]!.steps = { c0: [0] }
    const { events } = compileSong(s, { syncClock: true })
    expect(events.slice(0, 3).map((e) => [e.kind, e.time])).toEqual([
      ['clock', 0],
      ['on', 0],
      ['on', 0],
    ])
  })

  it('is cut to a window like everything else', () => {
    const { events } = compileSong(song(), { syncClock: true })
    const t = ticks(windowEvents(events, 0.5, 1))
    expect(t).toHaveLength(24)
    expect(t[0]!.time).toBe(0)
    expect(t[23]!.time).toBeCloseTo(0.5 - midiClockPeriod(120), 9)
  })

  it('is deterministic', () => {
    expect(compileSong(song(), { syncClock: true })).toEqual(compileSong(song(), { syncClock: true }))
  })
})
