<script setup lang="ts">
import { computed } from 'vue'
import { useMidiStore } from '../stores/midi'

const midi = useMidiStore()

const selected = computed({
  get: () => midi.selectedOutputId ?? '',
  set: (value: string) => midi.selectOutput(value || null),
})

const sync = computed({
  get: () => midi.syncOutputId ?? '',
  set: (value: string) => midi.selectSyncOutput(value || null),
})

const syncTitle =
  'Also send MIDI clock, Start, Stop and Continue to this output, so a DAW or other MIDI gear follows the transport'

/** The sync picker needs outputs to pick from; without any, the status line has the room to say so. */
const showSync = computed(() => midi.status === 'ready' && midi.outputs.length > 0)

const statusText = computed(() => {
  switch (midi.status) {
    case 'unsupported':
      return 'Web MIDI is not available in this browser. Use Chrome, Edge or Opera.'
    case 'idle':
      return 'Click "Enable MIDI" to list your interfaces.'
    case 'requesting':
      return 'Waiting for permission…'
    case 'denied':
      return 'MIDI access was denied. Allow it in the site permissions and try again.'
    case 'error':
      return `Could not access MIDI: ${midi.error ?? 'unknown error'}`
    case 'ready':
      return midi.outputs.length === 0
        ? 'No MIDI outputs found. Connect your interface and it will appear here.'
        : midi.isConnected
          ? `Sending to ${midi.selectedOutput?.name}`
          : 'Select an output.'
  }
  return ''
})

const statusClass = computed(() => {
  if (midi.isConnected) return 'status-ok'
  if (midi.status === 'denied' || midi.status === 'error' || midi.status === 'unsupported') return 'status-bad'
  return 'status-warn'
})
</script>

<template>
  <section class="group" aria-labelledby="midi-heading">
    <h2 id="midi-heading" class="sr-only">MIDI output</h2>
    <div class="row">
      <button
        v-if="midi.status !== 'ready'"
        class="primary"
        :disabled="midi.status === 'requesting' || midi.status === 'unsupported'"
        data-testid="enable-midi"
        @click="midi.requestAccess()"
      >
        Enable MIDI
      </button>
      <label v-else>
        <span>Interface</span>
        <select v-model="selected" data-testid="midi-output" aria-label="MIDI output">
          <option value="">— choose an output —</option>
          <option v-for="o in midi.outputs" :key="o.id" :value="o.id">
            {{ o.name }}<template v-if="o.manufacturer"> ({{ o.manufacturer }})</template>
          </option>
        </select>
      </label>
      <button v-if="midi.status === 'ready'" class="icon" title="Rescan outputs" @click="midi.refreshOutputs()">
        ⟳
      </button>
    </div>
    <div class="detail" :class="{ contained: showSync }">
      <label v-if="showSync" class="sync" :title="syncTitle">
        <span>Sync</span>
        <select v-model="sync" class="compact" data-testid="sync-output" aria-label="MIDI sync output">
          <option value="">— none —</option>
          <option v-for="o in midi.outputs" :key="o.id" :value="o.id">
            {{ o.name }}<template v-if="o.manufacturer"> ({{ o.manufacturer }})</template>
          </option>
        </select>
      </label>
      <p class="status" :class="statusClass" :title="statusText" data-testid="midi-status">{{ statusText }}</p>
    </div>
  </section>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.row {
  align-items: center;
}

/*
 * The sync picker shares the status line. With it there, the line must not size the panel
 * (the toolbar would wrap at common laptop widths): it takes the width of the interface row
 * above and the status text gives way, with the full text in its tooltip.
 */
.detail {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.detail.contained {
  contain: inline-size;
}

.detail.contained .status {
  flex: 1 1 auto;
}

.sync {
  flex: 0 0 auto;
  gap: 6px;
}

/* Narrow on purpose: the open list shows the full names, and the status line needs the room. */
.compact {
  width: 120px;
  min-width: 0;
  max-width: 120px;
  padding: 2px 6px;
  font-size: 11.5px;
}

.status {
  margin: 0;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

label {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

select {
  min-width: 200px;
  max-width: 280px;
}

@media (max-width: 767px) {
  label {
    flex: 1 1 auto;
    min-width: 0;
  }

  select {
    flex: 1 1 auto;
    min-width: 0;
    max-width: none;
  }

  .compact {
    width: auto;
    max-width: 240px;
  }

  .detail {
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  .sync {
    flex: 1 1 100%;
  }

  .status {
    white-space: normal;
    max-width: none;
  }
}
</style>
