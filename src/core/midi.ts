import { DEFAULT_PLAY_GATE_NOTE, MAX_CHANNELS, clamp } from './song'

export const NOTE_OFF = 0x80
export const NOTE_ON = 0x90
export const CONTROL_CHANGE = 0xb0
export const CC_ALL_NOTES_OFF = 123
/**
 * The play gate is a note held high (note-on) for as long as the song is playing and released
 * (note-off) the moment it stops or pauses. Which note is a song setting (`playGateNote`); this is
 * the default, the module's 64th output.
 */
export { DEFAULT_PLAY_GATE_NOTE }
/**
 * Fixed note for the x16 clock: pulsed CLOCK_PULSES_PER_BEAT times per beat for as long as
 * the song is playing, so the module gets a steady clock next to the sequenced gates.
 * Independent of the base note setting.
 */
export const CLOCK_NOTE = 98
export const CLOCK_PULSES_PER_BEAT = 16

/**
 * System messages for the sync output, which lets a DAW or other MIDI gear follow the transport:
 * Timing Clock ticks MIDI_CLOCKS_PER_QUARTER times per quarter note while the song plays, Start,
 * Continue and Stop follow the transport, and Song Position Pointer says where a Continue picks
 * up, in MIDI beats (sixteenth notes, MIDI_BEATS_PER_QUARTER to a quarter note).
 */
export const TIMING_CLOCK = 0xf8
export const START = 0xfa
export const CONTINUE = 0xfb
export const STOP = 0xfc
export const SONG_POSITION = 0xf2
export const MIDI_CLOCKS_PER_QUARTER = 24
export const MIDI_BEATS_PER_QUARTER = 4
/** Song Position Pointer is a 14-bit count: 16383 MIDI beats, a little over 1000 bars of 4/4. */
export const MAX_SONG_POSITION = 0x3fff

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** Status byte for a channel message. `channel` is 1-based (1..16). */
export function statusByte(kind: number, channel: number): number {
  const ch = clamp(Math.round(channel), 1, 16) - 1
  return (kind & 0xf0) | ch
}

export function noteOn(channel: number, note: number, velocity: number): number[] {
  return [statusByte(NOTE_ON, channel), clamp(Math.round(note), 0, 127), clamp(Math.round(velocity), 1, 127)]
}

export function noteOff(channel: number, note: number): number[] {
  return [statusByte(NOTE_OFF, channel), clamp(Math.round(note), 0, 127), 0]
}

/** The note-off that releases the note a note-on message raised, on the same channel. */
export function noteOffFor(noteOnData: readonly number[]): number[] {
  return [NOTE_OFF | ((noteOnData[0] ?? NOTE_ON) & 0x0f), noteOnData[1] ?? 0, 0]
}

export function allNotesOff(channel: number): number[] {
  return [statusByte(CONTROL_CHANGE, channel), CC_ALL_NOTES_OFF, 0]
}

/**
 * Song Position Pointer for a point `quarterNotes` from the start of the song, as the 14-bit
 * count of MIDI beats (sixteenth notes) the message carries, least significant 7 bits first.
 * The count is rounded to the nearest beat and clamped to what 14 bits can hold.
 */
export function songPositionPointer(quarterNotes: number): number[] {
  const beats = clamp(Math.round(quarterNotes * MIDI_BEATS_PER_QUARTER), 0, MAX_SONG_POSITION)
  return [SONG_POSITION, beats & 0x7f, beats >> 7]
}

/** Whether a message is a system real-time message (clock and transport), which belongs on the sync output. */
export function isRealTime(data: readonly number[]): boolean {
  return (data[0] ?? 0) >= TIMING_CLOCK
}

/** Module output (0..61) -> MIDI note number. Throws if the result leaves 0..127. */
export function outputToNote(output: number, baseNote: number): number {
  if (!Number.isInteger(output) || output < 0 || output >= MAX_CHANNELS) {
    throw new RangeError(`output must be an integer in 0..${MAX_CHANNELS - 1}, got ${output}`)
  }
  const note = baseNote + output
  if (note < 0 || note > 127) throw new RangeError(`note ${note} is outside 0..127`)
  return note
}

/** Human-readable note name using the C4 = 60 convention (so 36 = C2, as the module's docs state). */
export function noteName(note: number): string {
  const n = clamp(Math.round(note), 0, 127)
  const octave = Math.floor(n / 12) - 1
  return `${NOTE_NAMES[n % 12]}${octave}`
}

/** Every note-off the module could possibly need (outputs, the clock and the play gate), used for "panic" / stop. */
export function allOutputsOff(channel: number, baseNote: number, playGateNote = DEFAULT_PLAY_GATE_NOTE): number[][] {
  const messages: number[][] = []
  for (let output = 0; output < MAX_CHANNELS; output++) {
    const note = baseNote + output
    if (note >= 0 && note <= 127) messages.push(noteOff(channel, note))
  }
  messages.push(noteOff(channel, CLOCK_NOTE))
  messages.push(noteOff(channel, playGateNote))
  messages.push(allNotesOff(channel))
  return messages
}

export function isWebMidiSupported(nav: Pick<Navigator, 'requestMIDIAccess'> | undefined = globalThis.navigator): boolean {
  return !!nav && typeof nav.requestMIDIAccess === 'function'
}
