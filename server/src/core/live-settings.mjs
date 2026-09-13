import { EventEmitter } from 'node:events'

// Settings that open voice connections pick up without a Gateway restart.
// config.env stays the persisted source; this store is what running
// connections read and subscribe to.

export const LISTENING_MODES = Object.freeze(['always', 'wake_word'])
export const WAKE_WORDS = Object.freeze(['hey_jarvis', 'hey_lisa', 'hey_megan', 'hey_mycroft'])
export const FOLLOW_UP_SECONDS_RANGE = Object.freeze({ min: 0, max: 10 })

export const LIVE_SETTINGS_DEFAULTS = Object.freeze({
  listeningMode: 'always',
  wakeWord: 'hey_jarvis',
  followUpSeconds: 5,
  cameraEnabled: false,
})

export const LIVE_SETTING_KEYS = Object.freeze(Object.keys(LIVE_SETTINGS_DEFAULTS))

export const LIVE_SETTINGS_ENV_KEYS = Object.freeze({
  listeningMode: 'QWEN_AUDIO_LISTENING_MODE',
  wakeWord: 'QWEN_AUDIO_WAKE_WORD',
  followUpSeconds: 'QWEN_AUDIO_FOLLOW_UP_SECONDS',
  cameraEnabled: 'QWEN_AUDIO_CAMERA_ENABLED',
})

function followUpSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  // Whole seconds; an older, longer value clamps to the maximum.
  return Math.min(FOLLOW_UP_SECONDS_RANGE.max, Math.max(FOLLOW_UP_SECONDS_RANGE.min, Math.round(parsed)))
}

// Invalid values fall back field by field, so one bad key never resets the rest.
export function normalizeLiveSettings(values = {}, fallback = LIVE_SETTINGS_DEFAULTS) {
  return {
    listeningMode: LISTENING_MODES.includes(values.listeningMode)
      ? values.listeningMode
      : fallback.listeningMode,
    wakeWord: WAKE_WORDS.includes(values.wakeWord) ? values.wakeWord : fallback.wakeWord,
    followUpSeconds: followUpSeconds(values.followUpSeconds) ?? fallback.followUpSeconds,
    cameraEnabled: typeof values.cameraEnabled === 'boolean'
      ? values.cameraEnabled
      : fallback.cameraEnabled,
  }
}

export function liveSettingsFromEnvironment(env = process.env) {
  const text = key => String(env[LIVE_SETTINGS_ENV_KEYS[key]] || '').trim().toLowerCase()
  return normalizeLiveSettings({
    listeningMode: text('listeningMode'),
    wakeWord: text('wakeWord'),
    followUpSeconds: env[LIVE_SETTINGS_ENV_KEYS.followUpSeconds],
    cameraEnabled: ['1', 'true', 'yes', 'on'].includes(text('cameraEnabled')),
  })
}

export class LiveSettings extends EventEmitter {
  #values

  constructor(initial = {}) {
    super()
    // one listener per open voice connection
    this.setMaxListeners(0)
    this.#values = Object.freeze(normalizeLiveSettings(initial))
  }

  get() {
    return this.#values
  }

  update(patch = {}) {
    const previous = this.#values
    const next = Object.freeze(normalizeLiveSettings({ ...previous, ...patch }, previous))
    const changed = LIVE_SETTING_KEYS.filter(key => next[key] !== previous[key])
    if (!changed.length) return changed
    this.#values = next
    this.emit('change', next, previous, changed)
    return changed
  }
}
