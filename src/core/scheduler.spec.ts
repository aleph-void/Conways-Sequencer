import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MidiEvent } from './compile'
import { Scheduler } from './scheduler'

function ev(time: number, kind: 'on' | 'off', note = 36): MidiEvent {
  return { time, kind, note, data: kind === 'on' ? [0x90, note, 100] : [0x80, note, 0] }
}

describe('Scheduler', () => {
  let sent: Array<{ data: number[]; at: number }>
  let scheduler: Scheduler
  let onStop: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    sent = []
    onStop = vi.fn<() => void>()
    scheduler = new Scheduler({
      send: (data, at) => sent.push({ data, at }),
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      lookaheadMs: 100,
      intervalMs: 25,
      onStop,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends events inside the look-ahead window with absolute timestamps', () => {
    scheduler.load([ev(0, 'on'), ev(0.05, 'off'), ev(0.5, 'on'), ev(0.55, 'off')], 1, false)
    vi.setSystemTime(1000)
    scheduler.start()
    expect(sent.map((s) => s.at)).toEqual([1000, 1050])
    vi.advanceTimersByTime(375) // now 1375, horizon 1475: the 1500 event is still out of reach
    expect(sent.map((s) => s.at)).toEqual([1000, 1050])
    vi.advanceTimersByTime(25) // now 1400, horizon 1500: note-on at 1500 is handed over
    expect(sent.map((s) => s.at)).toEqual([1000, 1050, 1500])
    vi.advanceTimersByTime(50) // now 1450, horizon 1550: note-off follows
    expect(sent.map((s) => s.at)).toEqual([1000, 1050, 1500, 1550])
  })

  it('stops itself at the end when not looping', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 1, false)
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    vi.advanceTimersByTime(999)
    expect(scheduler.isRunning).toBe(true)
    vi.advanceTimersByTime(30)
    expect(scheduler.isRunning).toBe(false)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('wraps around when looping', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 0.5, true)
    scheduler.start()
    vi.advanceTimersByTime(1000)
    const ons = sent.filter((s) => s.data[0] === 0x90).map((s) => s.at)
    expect(ons).toEqual([0, 500, 1000])
    expect(scheduler.isRunning).toBe(true)
    expect(scheduler.position()).toBeCloseTo(0)
    vi.advanceTimersByTime(125)
    expect(scheduler.position()).toBeCloseTo(0.125)
  })

  it('sends note-off for sounding notes when stopped mid-gate', () => {
    scheduler.load([ev(0, 'on', 40), ev(5, 'off', 40)], 10, false)
    scheduler.start()
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(100)
    scheduler.stop()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.data).toEqual([0x80, 40, 0])
    expect(onStop).toHaveBeenCalledTimes(1)
    scheduler.stop()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('does not start with an empty song', () => {
    scheduler.load([], 0, true)
    scheduler.start()
    expect(scheduler.isRunning).toBe(false)
    expect(scheduler.position()).toBe(0)
  })

  it('can start from an offset', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off'), ev(1, 'on'), ev(1.1, 'off')], 2, false)
    scheduler.start(1)
    expect(sent.map((s) => s.data[0])).toEqual([0x90, 0x80])
    expect(sent[0]!.at).toBe(0)
    expect(scheduler.position()).toBeCloseTo(1)
  })

  it('re-raises a gate that spans the start offset', () => {
    scheduler.load([ev(0, 'on', 40), ev(2, 'off', 40), ev(0.5, 'on', 41), ev(0.6, 'off', 41)].sort((a, b) => a.time - b.time), 3, false)
    vi.setSystemTime(1000)
    scheduler.start(1)
    // Note 40 is still high at 1 s, so its note-on is re-sent now; note 41 already ended.
    expect(sent).toEqual([{ data: [0x90, 40, 100], at: 1000 }])
    vi.advanceTimersByTime(1000)
    expect(sent.at(-1)).toEqual({ data: [0x80, 40, 0], at: 2000 })
  })

  it('does not re-raise anything when starting from the top', () => {
    scheduler.load([ev(0.5, 'on'), ev(0.6, 'off')], 1, false)
    scheduler.start(0)
    expect(sent).toEqual([])
  })

  it('sends stop note-offs after events already handed to the output', () => {
    scheduler.load([ev(0.05, 'on', 40), ev(0.08, 'off', 40), ev(0.09, 'on', 41), ev(5, 'off', 41)], 10, false)
    scheduler.start()
    // Everything up to 100 ms is already queued at the output.
    expect(sent.map((s) => s.at)).toEqual([50, 80, 90])
    scheduler.stop()
    // The note-off for 41 must not be timestamped before its queued note-on.
    expect(sent.at(-1)).toEqual({ data: [0x80, 41, 0], at: 90 })
  })

  it('restarts after the events already queued when started while running', () => {
    scheduler.load([ev(0.09, 'on', 41), ev(5, 'off', 41)], 10, false)
    scheduler.start()
    expect(sent.map((s) => s.at)).toEqual([90])
    scheduler.start(0)
    // Off for the queued note at the instant it was queued for; the new pass is anchored there too.
    expect(sent.slice(1)).toEqual([{ data: [0x80, 41, 0], at: 90 }])
    expect(scheduler.position()).toBe(0)
    vi.advanceTimersByTime(100)
    expect(sent.slice(2)).toEqual([{ data: [0x90, 41, 100], at: 180 }])
    expect(scheduler.position()).toBeCloseTo(0.01, 3)
  })

  it('reloads material while running without losing position or re-sending events', () => {
    scheduler.load([ev(0, 'on'), ev(0.05, 'off'), ev(0.55, 'on'), ev(0.6, 'off')], 2, true)
    scheduler.start()
    vi.advanceTimersByTime(500) // horizon now 600 ms: the 550/600 events were already sent
    expect(sent).toHaveLength(4)
    scheduler.load([ev(0, 'on'), ev(0.05, 'off'), ev(0.55, 'on'), ev(0.6, 'off'), ev(1, 'on', 50), ev(1.1, 'off', 50)], 2, true)
    expect(scheduler.isRunning).toBe(true)
    expect(scheduler.position()).toBeCloseTo(0.5)
    vi.advanceTimersByTime(500)
    expect(sent).toHaveLength(6)
    expect(sent.filter((s) => s.data[1] === 50).map((s) => s.at)).toEqual([1000, 1100])
    // After the loop wraps, the first events play again exactly once.
    vi.advanceTimersByTime(1100)
    expect(sent.filter((s) => s.at === 2000)).toHaveLength(1)
  })

  it('ends a sounding note when the reloaded material no longer ends it', () => {
    scheduler.load([ev(0, 'on', 40), ev(1.5, 'off', 40)], 2, true)
    scheduler.start()
    vi.advanceTimersByTime(200)
    scheduler.load([ev(1, 'on', 41), ev(1.1, 'off', 41)], 2, true)
    expect(sent.map((s) => s.data)).toEqual([
      [0x90, 40, 100],
      [0x80, 40, 0],
    ])
  })

  it('keeps a sounding note when the reloaded material still ends it', () => {
    scheduler.load([ev(0, 'on', 40), ev(1.5, 'off', 40)], 2, true)
    scheduler.start()
    vi.advanceTimersByTime(200)
    scheduler.load([ev(0, 'on', 40), ev(1, 'on', 41), ev(1.1, 'off', 41), ev(1.5, 'off', 40)], 2, true)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(sent.map((s) => s.at)).toEqual([0, 1000, 1100, 1500])
  })

  it('handles a reload whose horizon crosses the loop boundary', () => {
    scheduler.load([ev(0, 'on'), ev(0.05, 'off')], 0.5, true)
    scheduler.start()
    vi.advanceTimersByTime(450) // horizon 550 ms: the wrap-around on/off at 500/550 were already sent
    const before = sent.length
    scheduler.load([ev(0, 'on'), ev(0.05, 'off'), ev(0.1, 'on', 42), ev(0.15, 'off', 42)], 0.5, true)
    vi.advanceTimersByTime(100)
    expect(sent.slice(before).map((s) => [s.data[1], s.at])).toEqual([
      [42, 600],
      [42, 650],
    ])
  })

  it('stops when reloaded with an empty song while running', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 2, true)
    scheduler.start()
    scheduler.load([], 0, true)
    expect(scheduler.isRunning).toBe(false)
    expect(onStop).toHaveBeenCalled()
  })

  it('re-anchors the position when the song length changes mid-play', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 2, true)
    scheduler.start()
    vi.advanceTimersByTime(1500)
    scheduler.load([ev(0, 'on'), ev(0.1, 'off'), ev(2.5, 'on', 44), ev(2.6, 'off', 44)], 4, true)
    expect(scheduler.position()).toBeCloseTo(1.5)
    vi.advanceTimersByTime(1000)
    expect(sent.filter((s) => s.data[1] === 44).map((s) => Math.round(s.at))).toEqual([2500, 2600])
  })

  it('reports non-looping position clamped to the duration', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 1, false)
    scheduler.start()
    vi.advanceTimersByTime(600)
    expect(scheduler.position()).toBeCloseTo(0.6)
    scheduler.setLoop(true)
    vi.advanceTimersByTime(600)
    expect(scheduler.position()).toBeCloseTo(0.2)
  })

  it('starts past the last event, sends nothing and still stops at the end', () => {
    scheduler.load([ev(0, 'on'), ev(0.1, 'off')], 1, false)
    scheduler.start(0.5)
    expect(scheduler.isRunning).toBe(true)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(600)
    expect(scheduler.isRunning).toBe(false)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
    // Stopping again is a no-op.
    scheduler.stop()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  describe('clock ticks', () => {
    const tick = (time: number): MidiEvent => ({ time, kind: 'clock', note: -1, data: [0xf8] })

    it('sends them without tracking them as sounding notes', () => {
      scheduler.load([tick(0), ev(0, 'on', 40), tick(0.02), tick(0.04), ev(5, 'off', 40)], 10, false)
      scheduler.start()
      expect(sent.map((s) => s.data)).toEqual([[0xf8], [0x90, 40, 100], [0xf8], [0xf8]])
      vi.advanceTimersByTime(50)
      scheduler.stop()
      // Only the gate is released: a tick has nothing to turn off.
      expect(sent.slice(4)).toEqual([{ data: [0x80, 40, 0], at: 50 }])
    })

    it('never re-raises them as spanning gates when starting mid-song', () => {
      scheduler.load([tick(0), tick(0.5), ev(1, 'on'), ev(1.1, 'off')], 2, false)
      scheduler.start(0.75)
      expect(sent).toEqual([])
      vi.advanceTimersByTime(300)
      expect(sent.map((s) => s.data[0])).toEqual([0x90, 0x80])
    })

    it('keeps them when reloading, without re-sending those already out', () => {
      scheduler.load([tick(0), tick(0.05), tick(0.5)], 1, true)
      scheduler.start()
      expect(sent.map((s) => s.at)).toEqual([0, 50])
      scheduler.load([tick(0), tick(0.05), tick(0.1), tick(0.5)], 1, true)
      vi.advanceTimersByTime(100)
      expect(sent.map((s) => s.at)).toEqual([0, 50, 100])
    })
  })

  it('reports when the next message can go out', () => {
    expect(scheduler.queuedUntil()).toBe(0)
    scheduler.load([ev(0.09, 'on', 41), ev(5, 'off', 41)], 10, false)
    scheduler.start()
    // Running, nothing can go out before the note-on already queued for 90 ms...
    expect(scheduler.queuedUntil()).toBe(90)
    vi.advanceTimersByTime(200)
    // ...until the clock has moved past it.
    expect(scheduler.queuedUntil()).toBe(200)
    // A restart queues the note-on for 290 ms; stopped, it is simply now, whatever was queued.
    scheduler.start()
    expect(scheduler.queuedUntil()).toBe(290)
    scheduler.stop()
    expect(scheduler.queuedUntil()).toBe(200)
  })
})
