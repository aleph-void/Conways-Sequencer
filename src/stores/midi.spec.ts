import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OUTPUT_STORAGE_KEY,
  SYNC_OUTPUT_STORAGE_KEY,
  useMidiStore,
  type MidiAccessLike,
  type MidiOutputLike,
} from './midi'

function fakeOutput(id: string, name = id): MidiOutputLike & { sent: Array<[number[], number | undefined]> } {
  const sent: Array<[number[], number | undefined]> = []
  return {
    id,
    name,
    manufacturer: 'Fake',
    state: 'connected',
    sent,
    send: (data, ts) => sent.push([[...data], ts]),
  }
}

function fakeAccess(outputs: MidiOutputLike[]): MidiAccessLike {
  return { outputs: new Map(outputs.map((o) => [o.id, o])), onstatechange: null }
}

describe('useMidiStore', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('reports unsupported when navigator has no requestMIDIAccess (jsdom)', () => {
    const store = useMidiStore()
    expect(store.supported).toBe(false)
    expect(store.status).toBe('unsupported')
  })

  it('refuses to request without a provider when unsupported', async () => {
    const store = useMidiStore()
    expect(await store.requestAccess()).toBe(false)
    expect(store.status).toBe('unsupported')
  })

  it('lists outputs and auto-selects a single one', async () => {
    const store = useMidiStore()
    const out = fakeOutput('o1', 'Conway Interface')
    expect(await store.requestAccess(async () => fakeAccess([out]))).toBe(true)
    expect(store.status).toBe('ready')
    expect(store.outputs).toEqual([{ id: 'o1', name: 'Conway Interface', manufacturer: 'Fake', state: 'connected' }])
    expect(store.selectedOutputId).toBe('o1')
    expect(store.isConnected).toBe(true)
  })

  it('does not auto-select when several outputs exist', async () => {
    const store = useMidiStore()
    await store.requestAccess(async () => fakeAccess([fakeOutput('a'), fakeOutput('b')]))
    expect(store.selectedOutputId).toBeNull()
    expect(store.isConnected).toBe(false)
    store.selectOutput('b')
    expect(store.selectedOutput?.id).toBe('b')
    expect(localStorage.getItem(OUTPUT_STORAGE_KEY)).toBe('b')
    store.selectOutput(null)
    expect(localStorage.getItem(OUTPUT_STORAGE_KEY)).toBeNull()
  })

  it('restores the previously selected output from storage', async () => {
    localStorage.setItem(OUTPUT_STORAGE_KEY, 'b')
    setActivePinia(createPinia())
    const store = useMidiStore()
    await store.requestAccess(async () => fakeAccess([fakeOutput('a'), fakeOutput('b')]))
    expect(store.selectedOutput?.id).toBe('b')
  })

  it('keeps the preference when the device disappears and re-lists on statechange', async () => {
    const store = useMidiStore()
    const access = fakeAccess([fakeOutput('a'), fakeOutput('b')])
    await store.requestAccess(async () => access)
    store.selectOutput('b')
    access.outputs.delete('b')
    access.onstatechange?.({})
    expect(store.outputs.map((o) => o.id)).toEqual(['a'])
    expect(store.selectedOutputId).toBe('b')
    expect(store.isConnected).toBe(false)
    access.outputs.set('b', fakeOutput('b'))
    access.onstatechange?.({})
    expect(store.isConnected).toBe(true)
  })

  it('sends to the selected output with timestamps and counts messages', async () => {
    const store = useMidiStore()
    const out = fakeOutput('o1')
    await store.requestAccess(async () => fakeAccess([out]))
    expect(store.send([0x90, 36, 100], 123)).toBe(true)
    expect(out.sent).toEqual([[[0x90, 36, 100], 123]])
    expect(store.sentCount).toBe(1)
  })

  it('returns false when sending without an output or when the port throws', async () => {
    const store = useMidiStore()
    expect(store.send([0x90, 36, 100])).toBe(false)
    const bad = fakeOutput('o1')
    bad.send = () => {
      throw new Error('closed')
    }
    await store.requestAccess(async () => fakeAccess([bad]))
    expect(store.send([0x90, 36, 100])).toBe(false)
  })

  it('maps permission errors to denied and other failures to error', async () => {
    const store = useMidiStore()
    expect(await store.requestAccess(async () => Promise.reject(new DOMException('x', 'NotAllowedError')))).toBe(false)
    expect(store.status).toBe('denied')
    await store.requestAccess(async () => Promise.reject(new Error('device busy')))
    expect(store.status).toBe('error')
    await store.requestAccess(async () => Promise.reject(new Error('Permission denied')))
    expect(store.status).toBe('denied')
    expect(store.error).toBe('Permission denied')
    await store.requestAccess(async () => Promise.reject('boom'))
    expect(store.status).toBe('error')
    expect(store.error).toBe('boom')
  })

  it('panic sends note-off for all outputs, the clock and the play gate', async () => {
    const store = useMidiStore()
    const out = fakeOutput('o1')
    await store.requestAccess(async () => fakeAccess([out]))
    store.panic(1, 36)
    expect(out.sent).toHaveLength(65)
    expect(out.sent[61]![0]).toEqual([0x80, 97, 0])
    expect(out.sent[62]![0]).toEqual([0x80, 98, 0])
    expect(out.sent[63]![0]).toEqual([0x80, 99, 0])
    expect(out.sent[64]![0]).toEqual([0xb0, 123, 0])
  })

  it('reset forgets everything', async () => {
    const store = useMidiStore()
    await store.requestAccess(async () => fakeAccess([fakeOutput('o1')]))
    store.reset()
    expect(store.status).toBe('unsupported')
    expect(store.outputs).toEqual([])
    expect(store.send([0x90, 1, 1])).toBe(false)
  })

  it('uses navigator.requestMIDIAccess when available', async () => {
    const out = fakeOutput('native')
    const request = vi.fn(async () => fakeAccess([out]))
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: request, configurable: true })
    try {
      setActivePinia(createPinia())
      const store = useMidiStore()
      expect(store.supported).toBe(true)
      expect(store.status).toBe('idle')
      await store.requestAccess()
      expect(request).toHaveBeenCalledWith({ sysex: false })
      expect(store.outputs[0]!.id).toBe('native')
    } finally {
      delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess
    }
  })

  it('clears the outputs when refreshed before access is granted, and survives a storage that throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const store = useMidiStore()
    getItem.mockRestore()
    expect(store.selectedOutputId).toBeNull()
    store.outputs = [{ id: 'x', name: 'x', manufacturer: '', state: 'connected' }]
    store.refreshOutputs()
    expect(store.outputs).toEqual([])
  })
})

describe('useMidiStore sync output', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('starts with no sync output, even when the only output is picked for the module', async () => {
    const store = useMidiStore()
    await store.requestAccess(async () => fakeAccess([fakeOutput('a')]))
    expect(store.selectedOutputId).toBe('a')
    expect(store.syncOutputId).toBeNull()
    expect(store.syncOutput).toBeNull()
    expect(store.isSyncConnected).toBe(false)
    expect(store.sendSync([0xf8])).toBe(false)
  })

  it("selects a sync output, remembers it and keeps its messages apart from the module's", async () => {
    const store = useMidiStore()
    const a = fakeOutput('a')
    const b = fakeOutput('b')
    await store.requestAccess(async () => fakeAccess([a, b]))
    store.selectOutput('a')
    store.selectSyncOutput('b')
    expect(store.syncOutput?.id).toBe('b')
    expect(store.isSyncConnected).toBe(true)
    expect(localStorage.getItem(SYNC_OUTPUT_STORAGE_KEY)).toBe('b')
    expect(store.sendSync([0xfa], 5)).toBe(true)
    expect(store.send([0x90, 36, 100], 5)).toBe(true)
    expect(b.sent).toEqual([[[0xfa], 5]])
    expect(a.sent).toEqual([[[0x90, 36, 100], 5]])
    expect(store.syncSentCount).toBe(1)
    expect(store.sentCount).toBe(1)
    store.selectSyncOutput(null)
    expect(localStorage.getItem(SYNC_OUTPUT_STORAGE_KEY)).toBeNull()
    expect(store.isSyncConnected).toBe(false)
  })

  it("restores the sync output from storage, and it may be the module's port", async () => {
    localStorage.setItem(SYNC_OUTPUT_STORAGE_KEY, 'a')
    setActivePinia(createPinia())
    const store = useMidiStore()
    const a = fakeOutput('a')
    await store.requestAccess(async () => fakeAccess([a]))
    expect(store.selectedOutput?.id).toBe('a')
    expect(store.syncOutput?.id).toBe('a')
    store.sendSync([0xfc])
    expect(a.sent).toEqual([[[0xfc], undefined]])
  })

  it('keeps the preference while the device is unplugged and reports a port that fails', async () => {
    const store = useMidiStore()
    const access = fakeAccess([fakeOutput('a'), fakeOutput('b')])
    await store.requestAccess(async () => access)
    store.selectSyncOutput('b')
    access.outputs.delete('b')
    access.onstatechange?.({})
    expect(store.syncOutputId).toBe('b')
    expect(store.isSyncConnected).toBe(false)
    expect(store.sendSync([0xf8])).toBe(false)
    const bad = fakeOutput('b')
    bad.send = () => {
      throw new Error('closed')
    }
    access.outputs.set('b', bad)
    access.onstatechange?.({})
    expect(store.isSyncConnected).toBe(true)
    expect(store.sendSync([0xf8])).toBe(false)
    store.reset()
    expect(store.syncSentCount).toBe(0)
  })
})
