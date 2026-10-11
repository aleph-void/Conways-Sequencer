import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useMidiStore, type MidiAccessLike, type MidiOutputLike } from './midi'
import { useSongStore } from './song'
import { useTransportStore } from './transport'

function fakeOutput(): MidiOutputLike & { sent: Array<[number[], number | undefined]> } {
  const sent: Array<[number[], number | undefined]> = []
  return { id: 'o', name: 'o', manufacturer: '', state: 'connected', sent, send: (d, t) => sent.push([[...d], t]) }
}

describe('useTransportStore', () => {
  let out: ReturnType<typeof fakeOutput>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    localStorage.clear()
    setActivePinia(createPinia())
    out = fakeOutput()
    const access: MidiAccessLike = { outputs: new Map([['o', out]]), onstatechange: null }
    await useMidiStore().requestAccess(async () => access)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('plays the compiled song through the MIDI store and tracks position', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    const sec = song.song.sections[0]!
    const ch = song.song.channels[0]!.id
    song.toggleStep(sec.id, ch, 0)
    song.toggleStep(sec.id, ch, 4)

    transport.play()
    expect(transport.playing).toBe(true)
    // The play gate goes high first, then the first step's note-on.
    expect(out.sent[0]).toEqual([[0x90, 99, 100], 0])
    expect(out.sent[1]).toEqual([[0x90, 36, 100], 0])
    await vi.advanceTimersByTimeAsync(600)
    // Each gate holds for its whole 125 ms step, minus the 2 ms gap before the next step.
    expect(out.sent.filter((s) => s[0][1] === 36).map((s) => s[1])).toEqual([0, 123, 500, 623])
    expect(transport.positionSeconds).toBeCloseTo(0.6, 1)
    expect(transport.currentStep).toBe(4)
    expect(transport.position?.sectionIndex).toBe(0)

    transport.stop()
    expect(transport.playing).toBe(false)
    expect(transport.positionSeconds).toBe(0)
    expect(transport.currentStep).toBe(-1)
    expect(out.sent.at(-1)).toEqual([[0x80, 99, 0], 600])
  })

  it('pulses the x16 clock on note 98 sixteen times per beat while playing', async () => {
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(1000)
    const ons = out.sent.filter((s) => s[0][0] === 0x90 && s[0][1] === 98).map((s) => s[1]!)
    const offs = out.sent.filter((s) => s[0][0] === 0x80 && s[0][1] === 98).map((s) => s[1]!)
    // 120 BPM: a beat is 500 ms, so a pulse every 31.25 ms, high for half of that.
    expect(ons.filter((t) => t < 500)).toHaveLength(16)
    expect(ons.slice(0, 3)).toEqual([0, 31.25, 62.5])
    expect(ons[16]).toBe(500)
    expect(offs.slice(0, 2)).toEqual([15.625, 46.875])
    expect(out.sent[0]).toEqual([[0x90, 99, 100], 0]) // the play gate still goes first
    transport.stop()
    // Nothing on the clock note is sent after stop, apart from releasing a pulse that was high.
    const after = out.sent.slice(out.sent.findIndex((s) => s[0][1] === 99 && s[0][0] === 0x80))
    expect(after.filter((s) => s[0][1] === 98 && s[0][0] === 0x90)).toHaveLength(0)
  })

  it('holds the play gate on note 99 while playing and releases it on stop', () => {
    const transport = useTransportStore()
    const gate = () => out.sent.filter((s) => s[0][1] === 99).map((s) => s[0])
    transport.play()
    expect(gate()).toEqual([[0x90, 99, 100]])
    transport.stop()
    expect(gate()).toEqual([[0x90, 99, 100], [0x80, 99, 0]])
    transport.stop() // a second stop does not release the gate twice
    expect(gate()).toHaveLength(2)
  })

  it('sends the play gate on the configured channel with the configured velocity', () => {
    const song = useSongStore()
    song.updateSettings({ midiChannel: 5, velocity: 64 })
    const transport = useTransportStore()
    transport.play()
    expect(out.sent[0]![0]).toEqual([0x94, 99, 64])
    // The gate is released on the channel it was raised on, even if the setting changed meanwhile.
    song.updateSettings({ midiChannel: 2 })
    transport.stop()
    expect(out.sent.at(-1)![0]).toEqual([0x84, 99, 0])
  })

  it('sends the play gate on the configured note and releases that same note', () => {
    const song = useSongStore()
    song.updateSettings({ playGateNote: 100 })
    const transport = useTransportStore()
    transport.play()
    expect(out.sent[0]![0]).toEqual([0x90, 100, 100])
    song.updateSettings({ playGateNote: 99 })
    transport.stop()
    expect(out.sent.at(-1)![0]).toEqual([0x80, 100, 0])
  })

  it('releases the play gate when a non-looping song reaches its end', async () => {
    const song = useSongStore()
    song.updateSettings({ loop: false })
    const transport = useTransportStore()
    transport.play()
    expect(out.sent.filter((s) => s[0][1] === 99)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(8100)
    expect(transport.playing).toBe(false)
    expect(out.sent.filter((s) => s[0][1] === 99).map((s) => s[0])).toEqual([[0x90, 99, 100], [0x80, 99, 0]])
  })

  it('does not raise the play gate for a song that cannot play', () => {
    const song = useSongStore()
    song.removeSection(song.song.sections[0]!.id)
    const transport = useTransportStore()
    transport.play()
    expect(out.sent).toHaveLength(0)
  })

  it('toggle plays and pauses', async () => {
    const transport = useTransportStore()
    transport.toggle()
    expect(transport.playing).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    transport.toggle()
    expect(transport.playing).toBe(false)
    expect(transport.paused).toBe(true)
    expect(transport.positionSeconds).toBeCloseTo(0.3, 1)
  })

  it('pauses where the cursor is, keeps the readout there and resumes from it', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    const sec = song.song.sections[0]!
    const ch = song.song.channels[0]!.id
    song.toggleStep(sec.id, ch, 0)
    song.toggleStep(sec.id, ch, 8) // 1.0 s in
    transport.play()
    await vi.advanceTimersByTimeAsync(600)

    transport.pause()
    expect(transport.playing).toBe(false)
    expect(transport.paused).toBe(true)
    expect(transport.positionSeconds).toBeCloseTo(0.6, 2)
    expect(transport.currentStep).toBe(4)
    expect(transport.position?.sectionIndex).toBe(0)
    // Pausing drops the gate (after the note-off of any clock pulse that was high)...
    expect(out.sent.at(-1)).toEqual([[0x80, 99, 0], 600])
    const sentBefore = out.sent.length
    // ...and nothing more goes out while paused.
    await vi.advanceTimersByTimeAsync(1000)
    expect(out.sent).toHaveLength(sentBefore)
    expect(transport.positionSeconds).toBeCloseTo(0.6, 2)

    transport.resume()
    expect(transport.playing).toBe(true)
    expect(transport.paused).toBe(false)
    // The gate goes high again; the step at 0 s is not replayed, the one at 1.0 s follows 400 ms later.
    expect(out.sent[sentBefore]).toEqual([[0x90, 99, 100], 1600])
    await vi.advanceTimersByTimeAsync(500)
    const ons = out.sent.slice(sentBefore + 1).filter((s) => s[0][0] === 0x90 && s[0][1] === 36)
    expect(ons).toEqual([[[0x90, 36, 100], 2000]])
    expect(transport.positionSeconds).toBeCloseTo(1.1, 1)
  })

  it('resumes a gate that was held across the pause point', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    const sec = song.song.sections[0]!
    const ch = song.song.channels[0]!.id
    for (const step of [0, 1, 2, 3, 4, 5, 6, 7]) song.toggleStep(sec.id, ch, step) // one gate for the whole bar
    transport.play()
    await vi.advanceTimersByTimeAsync(500)
    transport.pause()
    const gates = () => out.sent.filter((s) => s[0][1] === 36 || s[0][1] === 99)
    // The held gate is dropped on pause, then the play gate is released.
    expect(gates().slice(-2).map((s) => s[0])).toEqual([[0x80, 36, 0], [0x80, 99, 0]])
    transport.resume()
    // ...and raised again on resume, right after the play gate.
    expect(gates().slice(-2)).toEqual([[[0x90, 99, 100], 500], [[0x90, 36, 100], 500]])
  })

  it('reset returns the cursor to the start and keeps playing', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    const sec = song.song.sections[0]!
    const ch = song.song.channels[0]!.id
    song.toggleStep(sec.id, ch, 0)
    transport.play()
    await vi.advanceTimersByTimeAsync(700)
    expect(transport.currentStep).toBe(5)
    const gates = () => out.sent.filter((s) => s[0][1] === 99).length
    const before = gates()

    transport.reset()
    expect(transport.playing).toBe(true)
    expect(transport.positionSeconds).toBe(0)
    expect(transport.currentStep).toBe(0)
    // The first step plays again, without the gate being released and re-raised. The new pass is
    // anchored after the clock pulses already handed to the output (up to 120 ms ahead).
    const restart = out.sent.filter((s) => s[0][1] === 36).at(-1)!
    expect(restart[0]).toEqual([0x90, 36, 100])
    expect(restart[1]).toBeGreaterThanOrEqual(700)
    expect(restart[1]).toBeLessThanOrEqual(820)
    expect(gates()).toBe(before)
    await vi.advanceTimersByTimeAsync(300)
    // The readout is refreshed once per (16 ms) frame, so it may lag the clock by up to one frame.
    const expected = (1000 - restart[1]!) / 1000
    expect(transport.positionSeconds).toBeGreaterThan(expected - 0.02)
    expect(transport.positionSeconds).toBeLessThanOrEqual(expected)
  })

  it('reset while paused returns to the stopped state', async () => {
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(400)
    transport.pause()
    expect(transport.paused).toBe(true)
    transport.reset()
    expect(transport.paused).toBe(false)
    expect(transport.playing).toBe(false)
    expect(transport.positionSeconds).toBe(0)
    expect(transport.currentStep).toBe(-1)
    // Play now starts from the top again.
    transport.play()
    expect(transport.positionSeconds).toBe(0)
  })

  it('seek puts the cursor on a step and shows it as paused', () => {
    const transport = useTransportStore()
    transport.seekToStep(20)
    expect(transport.playing).toBe(false)
    expect(transport.paused).toBe(true)
    expect(transport.positionSeconds).toBe(2.5)
    expect(transport.currentStep).toBe(20)
    // Playing picks up from there.
    transport.play()
    expect(transport.positionSeconds).toBe(2.5)
    transport.stop()
    // Seeking to the start is the stopped state; past the end lands on the end.
    transport.seekToStep(3)
    transport.seekToStep(0)
    expect(transport.paused).toBe(false)
    expect(transport.currentStep).toBe(-1)
    transport.seek(99)
    expect(transport.positionSeconds).toBe(8)
    transport.seek(-1)
    expect(transport.positionSeconds).toBe(0)
  })

  it('seek while playing jumps there and carries on', async () => {
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(400)
    transport.seekToStep(40)
    expect(transport.playing).toBe(true)
    expect(transport.positionSeconds).toBe(5)
    // The new pass is anchored after the events already handed to the output (up to 120 ms ahead).
    await vi.advanceTimersByTimeAsync(300)
    expect(transport.positionSeconds).toBeGreaterThan(5.1)
    expect(transport.positionSeconds).toBeLessThanOrEqual(5.3)
    expect([41, 42]).toContain(transport.currentStep)
  })

  it('stop while paused clears the paused position', async () => {
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(400)
    transport.pause()
    transport.stop()
    expect(transport.paused).toBe(false)
    expect(transport.positionSeconds).toBe(0)
  })

  it('starts over when the song became shorter than the paused position', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(5000)
    transport.pause()
    expect(transport.positionSeconds).toBeCloseTo(5, 1)
    song.updateSection(song.song.sections[0]!.id, { bars: 1 }) // 2 s long now
    transport.resume()
    expect(transport.playing).toBe(true)
    expect(transport.positionSeconds).toBe(0)
  })

  it('does nothing for a song with no sections', () => {
    const song = useSongStore()
    song.removeSection(song.song.sections[0]!.id)
    const transport = useTransportStore()
    transport.play()
    expect(transport.playing).toBe(false)
  })

  it('recompiles live when the grid changes while playing', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    const sec = song.song.sections[0]!
    const ch = song.song.channels[1]!.id
    transport.play()
    await vi.advanceTimersByTimeAsync(100)
    song.toggleStep(sec.id, ch, 8) // 1.0 s into the song
    await vi.advanceTimersByTimeAsync(1000)
    expect(out.sent.some((s) => s[0][1] === 37 && s[1] === 1000)).toBe(true)
    expect(transport.playing).toBe(true)
  })

  it('stops at the end when loop is off and resets', async () => {
    const song = useSongStore()
    song.updateSettings({ loop: false })
    const transport = useTransportStore()
    transport.play()
    await vi.advanceTimersByTimeAsync(8100)
    expect(transport.playing).toBe(false)
    expect(transport.positionSeconds).toBe(0)
  })

  it('panic stops and floods note-offs', () => {
    const transport = useTransportStore()
    transport.play()
    transport.panic()
    expect(transport.playing).toBe(false)
    // Stop releases the play gate, then the flood covers 62 outputs, the clock and the play gate again.
    const flood = out.sent.slice(-65).map((s) => s[0])
    expect(out.sent.at(-66)![0]).toEqual([0x80, 99, 0])
    expect(flood[0]).toEqual([0x80, 36, 0])
    expect(flood[61]).toEqual([0x80, 97, 0])
    expect(flood[62]).toEqual([0x80, 98, 0])
    expect(flood[63]).toEqual([0x80, 99, 0])
    expect(flood[64]).toEqual([0xb0, 123, 0])
  })

  it('reacts to loop setting changes while playing', async () => {
    const song = useSongStore()
    const transport = useTransportStore()
    transport.play()
    song.updateSettings({ loop: false })
    await vi.advanceTimersByTimeAsync(8100)
    expect(transport.playing).toBe(false)
  })

  describe('loop points', () => {
    /** Note-ons of the first channel (note 36) as scheduler timestamps. */
    const gateOns = () => out.sent.filter((s) => s[0][0] === 0x90 && s[0][1] === 36).map((s) => s[1])

    it('plays only the bars between the loop points and wraps inside them', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      const sec = song.song.sections[0]!
      const ch = song.song.channels[0]!.id
      // The default song: four 2 s bars. Gates at 0 s, 2 s (bar 2), 5 s (bar 3) and 6 s (bar 4).
      for (const step of [0, 16, 40, 48]) song.toggleStep(sec.id, ch, step)
      song.setLoopRange(1, 3) // bars 2–3: 2 s to 6 s
      await nextTick()
      expect(transport.positionSeconds).toBe(2)

      transport.play()
      expect(transport.playing).toBe(true)
      expect(transport.positionSeconds).toBe(2)
      expect(transport.currentStep).toBe(16)
      expect(out.sent[0]).toEqual([[0x90, 99, 100], 0]) // the play gate first...
      expect(out.sent[1]).toEqual([[0x90, 36, 100], 0]) // ...then the gate at the loop start
      await vi.advanceTimersByTimeAsync(4100)
      // Bar 2's gate, bar 3's gate, then bar 2's again after the wrap: nothing from bars 1 or 4.
      expect(gateOns()).toEqual([0, 3000, 4000])
      expect(transport.positionSeconds).toBeCloseTo(2.1, 1)
      expect(transport.currentStep).toBe(16)
      // The clock keeps running through the wrap.
      expect(out.sent.filter((s) => s[0][0] === 0x90 && s[0][1] === 98 && s[1]! >= 4000).length).toBeGreaterThan(0)
      transport.stop()
      expect(transport.positionSeconds).toBe(2)
      expect(transport.paused).toBe(false)
    })

    it('plays the range once and stops at its end when loop is off', async () => {
      const song = useSongStore()
      song.updateSettings({ loop: false })
      song.setLoopRange(1, 3)
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(3900)
      expect(transport.playing).toBe(true)
      await vi.advanceTimersByTimeAsync(200)
      expect(transport.playing).toBe(false)
      expect(transport.paused).toBe(false)
      expect(transport.positionSeconds).toBe(2)
      expect(out.sent.filter((s) => s[0][1] === 99).map((s) => s[0])).toEqual([[0x90, 99, 100], [0x80, 99, 0]])
    })

    it('pauses and resumes inside the range; reset and stop go to the range start', async () => {
      const song = useSongStore()
      song.setLoopRange(1, 3)
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(1000)
      transport.pause()
      expect(transport.paused).toBe(true)
      expect(transport.positionSeconds).toBeCloseTo(3, 2)
      transport.resume()
      expect(transport.playing).toBe(true)
      expect(transport.positionSeconds).toBeCloseTo(3, 2)
      await vi.advanceTimersByTimeAsync(500)
      expect(transport.positionSeconds).toBeCloseTo(3.5, 1)

      transport.reset()
      expect(transport.playing).toBe(true)
      expect(transport.positionSeconds).toBe(2)
      expect(transport.currentStep).toBe(16)
      await vi.advanceTimersByTimeAsync(500)
      transport.stop()
      expect(transport.playing).toBe(false)
      expect(transport.paused).toBe(false)
      expect(transport.positionSeconds).toBe(2)
    })

    it('starts from the range start when the paused cursor is outside the loop points', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(1000)
      transport.pause()
      expect(transport.positionSeconds).toBeCloseTo(1, 2)
      song.setLoopRange(1, 3)
      transport.resume()
      expect(transport.positionSeconds).toBe(2)
      expect(transport.currentStep).toBe(16)
    })

    it('seek inside the loop points keeps playing; outside them it pauses there', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      song.setLoopRange(1, 3) // 2 s to 6 s
      transport.play()
      expect(transport.positionSeconds).toBe(2)
      transport.seekToStep(32)
      expect(transport.playing).toBe(true)
      expect(transport.positionSeconds).toBe(4)
      transport.seekToStep(56)
      expect(transport.playing).toBe(false)
      expect(transport.paused).toBe(true)
      expect(transport.positionSeconds).toBe(7)
      // Stopped, a seek to the range start is the stopped state again.
      transport.seek(2)
      expect(transport.paused).toBe(false)
    })

    it('moves the stopped cursor along with the loop points', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      expect(transport.positionSeconds).toBe(0)
      song.setLoopRange(2, 3)
      await nextTick()
      expect(transport.positionSeconds).toBe(4)
      expect(transport.currentStep).toBe(-1)
      song.clearLoopRange()
      await nextTick()
      expect(transport.positionSeconds).toBe(0)
    })

    it('carries on inside new loop points set while playing, or restarts when left outside', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      // A restart is anchored after the clock pulses already handed to the output, so the cursor
      // may read up to the 120 ms look-ahead behind where it was.
      const expectNear = (expected: number) => {
        expect(transport.positionSeconds).toBeGreaterThan(expected - 0.13)
        expect(transport.positionSeconds).toBeLessThanOrEqual(expected + 0.001)
      }
      song.setLoopRange(0, 2) // 0–4 s
      transport.play()
      await vi.advanceTimersByTimeAsync(3000)
      expectNear(3)
      song.setLoopRange(1, 3) // 2–6 s: the cursor at 3 s is still inside
      await nextTick()
      expect(transport.playing).toBe(true)
      expectNear(3)
      const before = transport.positionSeconds
      await vi.advanceTimersByTimeAsync(2500)
      // Past the old range's end, inside the new one.
      expectNear(before + 2.5)
      song.setLoopRange(3, 4) // 6–8 s: the cursor is left outside, so the range starts over
      await nextTick()
      expect(transport.playing).toBe(true)
      expectNear(6)
      await vi.advanceTimersByTimeAsync(1000)
      expectNear(7)
      const inside = transport.positionSeconds
      song.clearLoopRange() // the whole song: the cursor at 7 s is inside it
      await nextTick()
      expectNear(inside)
      expect(transport.currentStep).toBeGreaterThanOrEqual(54)
    })

    it('picks up grid edits while looping a range', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      const sec = song.song.sections[0]!
      const ch = song.song.channels[0]!.id
      song.setLoopRange(1, 3)
      transport.play()
      await vi.advanceTimersByTimeAsync(100)
      song.toggleStep(sec.id, ch, 24) // 3 s into the song, 1 s into the range
      await vi.advanceTimersByTimeAsync(1000)
      expect(gateOns()).toEqual([1000])
      expect(transport.playing).toBe(true)
    })

    it('plays the whole song once the loop points are cleared', async () => {
      const song = useSongStore()
      const transport = useTransportStore()
      const sec = song.song.sections[0]!
      const ch = song.song.channels[0]!.id
      song.toggleStep(sec.id, ch, 0)
      song.setLoopRange(1, 3)
      song.clearLoopRange()
      transport.play()
      expect(transport.positionSeconds).toBe(0)
      expect(out.sent[1]).toEqual([[0x90, 36, 100], 0])
    })
  })

  describe('sync output', () => {
    let sync: ReturnType<typeof fakeOutput>
    const data = () => sync.sent.map((s) => s[0])
    const ticks = () => sync.sent.filter((s) => s[0][0] === 0xf8).map((s) => s[1]!)

    beforeEach(async () => {
      sync = fakeOutput()
      sync.id = 'sync'
      const midi = useMidiStore()
      midi.reset()
      const outputs = new Map<string, MidiOutputLike>([
        ['o', out],
        ['sync', sync],
      ])
      await midi.requestAccess(async () => ({ outputs, onstatechange: null }))
      midi.selectOutput('o')
      midi.selectSyncOutput('sync')
    })

    it('sends Start, then a clock tick every 24th of a quarter note while playing, then Stop', async () => {
      const transport = useTransportStore()
      transport.play()
      expect(sync.sent[0]).toEqual([[0xfa], 0])
      await vi.advanceTimersByTimeAsync(1000)
      const t = ticks()
      // 120 BPM: 24 ticks per 500 ms quarter note, one every 20.83 ms, the first on the Start.
      expect(t[0]).toBe(0)
      expect(t[1]).toBeCloseTo(1000 / 48, 6)
      expect(t[24]).toBeCloseTo(500, 6)
      expect(t.filter((at) => at < 1000)).toHaveLength(48)
      // Only real-time messages reach the sync output, and no tick reaches the module.
      expect(data().every((d) => d[0] === 0xfa || d[0] === 0xf8)).toBe(true)
      expect(out.sent.some((s) => s[0][0] === 0xf8)).toBe(false)
      transport.stop()
      expect(sync.sent.at(-1)).toEqual([[0xfc], 1000])
      const count = sync.sent.length
      transport.stop()
      await vi.advanceTimersByTimeAsync(500)
      // A second stop says nothing more, and the clock stays silent while stopped.
      expect(sync.sent).toHaveLength(count)
    })

    it('pauses with Stop and resumes with Song Position Pointer then Continue', async () => {
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(600)
      transport.pause()
      expect(sync.sent.at(-1)).toEqual([[0xfc], 600])
      const before = sync.sent.length
      transport.resume()
      // 0.6 s at 120 BPM is 1.2 quarter notes: 4.8 MIDI beats, rounded to 5.
      expect(sync.sent.slice(before, before + 2)).toEqual([
        [[0xf2, 5, 0], 600],
        [[0xfb], 600],
      ])
      // The ticks pick up with the first one at or after the cursor (the 29th, at 604.17 ms).
      expect(sync.sent[before + 2]![0]).toEqual([0xf8])
      expect(sync.sent[before + 2]![1]).toBeCloseTo((29 * 1000) / 48, 6)
    })

    it('restarts the sync after the queued ticks on reset and on seek while playing', async () => {
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(700)
      const before = sync.sent.length
      transport.reset()
      // Stop, Start and the first tick of the new pass share one timestamp, after everything
      // already handed to the outputs (up to the 120 ms look-ahead), so a receiver counting
      // ticks from the Start counts exactly the new pass.
      const restart = sync.sent.slice(before, before + 3)
      expect(restart.map((s) => s[0])).toEqual([[0xfc], [0xfa], [0xf8]])
      const at = restart[0]![1]!
      expect(at).toBeGreaterThanOrEqual(700)
      expect(at).toBeLessThanOrEqual(820)
      expect(restart.map((s) => s[1])).toEqual([at, at, at])

      await vi.advanceTimersByTimeAsync(400)
      const mark = sync.sent.length
      transport.seekToStep(40) // 5 s: 10 quarter notes, 40 MIDI beats
      expect(sync.sent.slice(mark, mark + 3).map((s) => s[0])).toEqual([[0xfc], [0xf2, 40, 0], [0xfb]])
      expect(transport.playing).toBe(true)
    })

    it('gives a loop range its position in the whole song, and Start only from the top', async () => {
      const song = useSongStore()
      song.setLoopRange(1, 3) // bars 2–3: 2 s in, 4 quarter notes, 16 MIDI beats
      const transport = useTransportStore()
      transport.play()
      expect(data().slice(0, 2)).toEqual([[0xf2, 16, 0], [0xfb]])
      await vi.advanceTimersByTimeAsync(4100)
      // Through the wrap the clock just keeps ticking: the receiver is not moved back.
      expect(data().filter((d) => d[0] !== 0xf8)).toEqual([[0xf2, 16, 0], [0xfb]])
      transport.stop()
      song.setLoopRange(0, 2)
      await nextTick()
      const mark = sync.sent.length
      transport.play()
      expect(sync.sent[mark]![0]).toEqual([0xfa])
    })

    it('feeds a sync output chosen while playing from where the song is, and drops one deselected', async () => {
      const midi = useMidiStore()
      midi.selectSyncOutput(null)
      const transport = useTransportStore()
      transport.play()
      await vi.advanceTimersByTimeAsync(500)
      expect(sync.sent).toEqual([])
      midi.selectSyncOutput('sync')
      await nextTick()
      // The running pass is stopped and restarted in place: 0.5 s is 1 quarter note, 4 MIDI beats.
      expect(data().slice(0, 4)).toEqual([[0xfc], [0xf2, 4, 0], [0xfb], [0xf8]])
      await vi.advanceTimersByTimeAsync(500)
      expect(ticks().length).toBeGreaterThan(20)
      expect(transport.playing).toBe(true)
      midi.selectSyncOutput(null)
      await nextTick()
      const count = sync.sent.length
      await vi.advanceTimersByTimeAsync(500)
      expect(sync.sent).toHaveLength(count)
      expect(transport.playing).toBe(true)
    })

    it('sends one Stop from panic, playing or not', () => {
      const transport = useTransportStore()
      transport.panic()
      expect(data()).toEqual([[0xfc]])
      transport.play()
      const before = sync.sent.length
      transport.panic()
      expect(sync.sent.slice(before).map((s) => s[0])).toEqual([[0xfc]])
    })

    it('sends nothing for a song that cannot play', () => {
      const song = useSongStore()
      song.removeSection(song.song.sections[0]!.id)
      useTransportStore().play()
      expect(sync.sent).toEqual([])
    })
  })
})
