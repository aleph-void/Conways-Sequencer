import { defineStore } from 'pinia'
import { computed, ref, type Ref } from 'vue'
import { allOutputsOff, isWebMidiSupported } from '../core/midi'

export type MidiStatus = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied' | 'error'

export interface OutputInfo {
  id: string
  name: string
  manufacturer: string
  state: string
}

export const OUTPUT_STORAGE_KEY = 'conways-sequencer:output'
export const SYNC_OUTPUT_STORAGE_KEY = 'conways-sequencer:sync-output'

/** Minimal subset of MIDIAccess we need, so tests can pass a fake. */
export interface MidiAccessLike {
  outputs: Map<string, MidiOutputLike>
  onstatechange: ((event: unknown) => void) | null
}

export interface MidiOutputLike {
  id: string
  name?: string | null
  manufacturer?: string | null
  state?: string
  send: (data: number[] | Uint8Array, timestamp?: number) => void
  open?: () => Promise<unknown>
}

export type RequestMidiAccess = () => Promise<MidiAccessLike>

/**
 * Web MIDI access and the two outputs the app sends to, both remembered across reloads:
 *  - the output (the "interface"): the module, which gets the gates, the x16 clock and the
 *    play gate;
 *  - the sync output: optional, for a DAW or other gear that should follow the transport. It
 *    gets MIDI clock, Start, Continue, Stop and Song Position Pointer, and nothing else.
 * They may be the same port.
 */
export const useMidiStore = defineStore('midi', () => {
  const supported = isWebMidiSupported()
  const status = ref<MidiStatus>(supported ? 'idle' : 'unsupported')
  const error = ref<string | null>(null)
  const outputs = ref<OutputInfo[]>([])
  const selectedOutputId = ref<string | null>(readStored(OUTPUT_STORAGE_KEY))
  const syncOutputId = ref<string | null>(readStored(SYNC_OUTPUT_STORAGE_KEY))
  /** Count of messages handed to each output; handy for tests and a tiny activity indicator. */
  const sentCount = ref(0)
  const syncSentCount = ref(0)

  // The native MIDIAccess object is kept out of Vue reactivity on purpose.
  let access: MidiAccessLike | null = null

  const selectedOutput = computed(() => outputs.value.find((o) => o.id === selectedOutputId.value) ?? null)
  const isConnected = computed(() => status.value === 'ready' && selectedOutput.value !== null)
  const syncOutput = computed(() => outputs.value.find((o) => o.id === syncOutputId.value) ?? null)
  const isSyncConnected = computed(() => status.value === 'ready' && syncOutput.value !== null)

  function readStored(key: string): string | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    } catch {
      return null
    }
  }

  function store(key: string, id: string | null) {
    try {
      if (typeof localStorage !== 'undefined') {
        if (id) localStorage.setItem(key, id)
        else localStorage.removeItem(key)
      }
    } catch {
      // ignore
    }
  }

  function refreshOutputs() {
    if (!access) {
      outputs.value = []
      return
    }
    outputs.value = [...access.outputs.values()].map((o) => ({
      id: o.id,
      name: o.name ?? o.id,
      manufacturer: o.manufacturer ?? '',
      state: o.state ?? 'connected',
    }))
    // A missing device keeps its preference (for either output) so it is re-selected when it
    // comes back. The sync output is never picked automatically: most setups have none.
    if (selectedOutputId.value && !outputs.value.some((o) => o.id === selectedOutputId.value)) return
    if (!selectedOutputId.value && outputs.value.length === 1) selectedOutputId.value = outputs.value[0]!.id
  }

  /**
   * Request Web MIDI access. `request` can be injected for tests; by default it
   * uses navigator.requestMIDIAccess without sysex (we never need it).
   */
  async function requestAccess(request?: RequestMidiAccess): Promise<boolean> {
    const fn: RequestMidiAccess | null =
      request ?? (supported ? () => navigator.requestMIDIAccess({ sysex: false }) as unknown as Promise<MidiAccessLike> : null)
    if (!fn) {
      status.value = 'unsupported'
      return false
    }
    status.value = 'requesting'
    error.value = null
    try {
      access = await fn()
      access.onstatechange = () => refreshOutputs()
      refreshOutputs()
      status.value = 'ready'
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const name = e instanceof Error ? e.name : ''
      status.value = /denied|permission|NotAllowed|SecurityError/i.test(`${name} ${message}`) ? 'denied' : 'error'
      error.value = message
      access = null
      outputs.value = []
      return false
    }
  }

  function selectOutput(id: string | null) {
    selectedOutputId.value = id
    store(OUTPUT_STORAGE_KEY, id)
  }

  /** Choose the sync output, or none (`null`) to send no sync messages at all. */
  function selectSyncOutput(id: string | null) {
    syncOutputId.value = id
    store(SYNC_OUTPUT_STORAGE_KEY, id)
  }

  function sendTo(id: string | null, data: number[], timestamp: number | undefined, count: Ref<number>) {
    const out = access && id ? access.outputs.get(id) : null
    if (!out) return false
    try {
      out.send(data, timestamp)
      count.value += 1
      return true
    } catch {
      return false
    }
  }

  /** Send a message to the output at an absolute DOMHighResTimeStamp (ms). Silently no-ops without one. */
  function send(data: number[], timestamp?: number) {
    return sendTo(selectedOutputId.value, data, timestamp, sentCount)
  }

  /** Send a message to the sync output at an absolute DOMHighResTimeStamp (ms). Silently no-ops without one. */
  function sendSync(data: number[], timestamp?: number) {
    return sendTo(syncOutputId.value, data, timestamp, syncSentCount)
  }

  /** Note-off for every possible output on the module, then All Notes Off. */
  function panic(midiChannel: number, baseNote: number, playGateNote?: number) {
    for (const msg of allOutputsOff(midiChannel, baseNote, playGateNote)) send(msg)
  }

  /** Test hook / teardown: forget the access object. */
  function reset() {
    access = null
    outputs.value = []
    status.value = supported ? 'idle' : 'unsupported'
    error.value = null
    sentCount.value = 0
    syncSentCount.value = 0
  }

  return {
    supported,
    status,
    error,
    outputs,
    selectedOutputId,
    selectedOutput,
    isConnected,
    sentCount,
    syncOutputId,
    syncOutput,
    isSyncConnected,
    syncSentCount,
    requestAccess,
    refreshOutputs,
    selectOutput,
    selectSyncOutput,
    send,
    sendSync,
    panic,
    reset,
  }
})
