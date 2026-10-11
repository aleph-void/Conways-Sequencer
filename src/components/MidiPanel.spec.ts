import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMidiStore, type MidiAccessLike } from '../stores/midi'
import MidiPanel from './MidiPanel.vue'

function access(ids: string[]): MidiAccessLike {
  return {
    outputs: new Map(ids.map((id) => [id, { id, name: `Port ${id}`, manufacturer: 'Fake', state: 'connected', send() {} }])),
    onstatechange: null,
  }
}

describe('MidiPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('explains when Web MIDI is unsupported and disables the button', () => {
    const wrapper = mount(MidiPanel)
    expect(wrapper.get('[data-testid="midi-status"]').text()).toMatch(/not available/)
    expect(wrapper.get('[data-testid="enable-midi"]').attributes('disabled')).toBeDefined()
  })

  it('lists outputs after access is granted and selects one', async () => {
    const wrapper = mount(MidiPanel)
    const midi = useMidiStore()
    await midi.requestAccess(async () => access(['a', 'b']))
    await wrapper.vm.$nextTick()
    const select = wrapper.get('[data-testid="midi-output"]')
    expect(select.findAll('option')).toHaveLength(3)
    expect(wrapper.get('[data-testid="midi-status"]').text()).toBe('Select an output.')
    await select.setValue('b')
    expect(midi.selectedOutputId).toBe('b')
    expect(wrapper.get('[data-testid="midi-status"]').text()).toContain('Port b')
    expect(wrapper.get('[data-testid="midi-status"]').classes()).toContain('status-ok')
  })

  it('shows denied and error states', async () => {
    const wrapper = mount(MidiPanel)
    const midi = useMidiStore()
    await midi.requestAccess(async () => Promise.reject(new Error('Permission denied')))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="midi-status"]').text()).toMatch(/denied/)
    await midi.requestAccess(async () => Promise.reject(new Error('kaboom')))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="midi-status"]').text()).toContain('kaboom')
  })

  it('reports no outputs', async () => {
    const wrapper = mount(MidiPanel)
    await useMidiStore().requestAccess(async () => access([]))
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="midi-status"]').text()).toMatch(/No MIDI outputs/)
  })

  it('asks for access from the button and rescans the outputs', async () => {
    const wrapper = mount(MidiPanel)
    const midi = useMidiStore()
    midi.status = 'idle'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="midi-status"]').text()).toMatch(/Enable MIDI/)
    const request = vi.spyOn(midi, 'requestAccess')
    await wrapper.get('[data-testid="enable-midi"]').trigger('click')
    expect(request).toHaveBeenCalledTimes(1)

    await midi.requestAccess(async () => access(['a']))
    await wrapper.vm.$nextTick()
    const refresh = vi.spyOn(midi, 'refreshOutputs')
    await wrapper.get('button[title="Rescan outputs"]').trigger('click')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('offers a sync output beside the status line once there are outputs to pick', async () => {
    const wrapper = mount(MidiPanel)
    const midi = useMidiStore()
    expect(wrapper.find('[data-testid="sync-output"]').exists()).toBe(false)
    await midi.requestAccess(async () => access([]))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="sync-output"]').exists()).toBe(false)
    await midi.requestAccess(async () => access(['a', 'b']))
    await wrapper.vm.$nextTick()
    const select = wrapper.get('[data-testid="sync-output"]')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['— none —', 'Port a (Fake)', 'Port b (Fake)'])
    expect((select.element as HTMLSelectElement).value).toBe('')
    await select.setValue('b')
    expect(midi.syncOutputId).toBe('b')
    expect(midi.isSyncConnected).toBe(true)
    // The status line is about the module's output; the picker itself shows the sync one.
    const status = wrapper.get('[data-testid="midi-status"]')
    expect(status.text()).toBe('Select an output.')
    await wrapper.get('[data-testid="midi-output"]').setValue('a')
    expect(status.text()).toBe('Sending to Port a')
    expect(status.attributes('title')).toBe('Sending to Port a')
    await select.setValue('')
    expect(midi.syncOutputId).toBeNull()
  })
})
