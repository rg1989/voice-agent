import { EventEmitter } from 'node:events'

// Settings that open voice connections pick up without a Gateway restart.
// config.env stays the persisted source; this store is what running
// connections read and subscribe to.

export const LISTENING_MODES = Object.freeze(['always', 'wake_word'])
export const WAKE_WORDS = Object.freeze(['hey_jarvis', 'hey_lisa', 'hey_megan', 'hey_mycroft', 'glados'])
export const FOLLOW_UP_SECONDS_RANGE = Object.freeze({ min: 0, max: 10 })
// Browsers the media player may launch; auto picks the first one installed.
export const MEDIA_BROWSER_IDS = Object.freeze(['auto', 'chrome', 'edge', 'chromium', 'brave'])

export const LIVE_SETTINGS_DEFAULTS = Object.freeze({
  listeningMode: 'always',
  wakeWord: 'hey_jarvis',
  followUpSeconds: 5,
  cameraEnabled: false,
  roboticVoice: false,
  mediaBrowser: 'auto',
  mediaReturnToAssistant: false,
  mediaPauseWhileTalking: true,
})

export const LIVE_SETTING_KEYS = Object.freeze(Object.keys(LIVE_SETTINGS_DEFAULTS))

export const LIVE_SETTINGS_ENV_KEYS = Object.freeze({
  listeningMode: 'QWEN_AUDIO_LISTENING_MODE',
  wakeWord: 'QWEN_AUDIO_WAKE_WORD',
  followUpSeconds: 'QWEN_AUDIO_FOLLOW_UP_SECONDS',
  cameraEnabled: 'QWEN_AUDIO_CAMERA_ENABLED',
  roboticVoice: 'QWEN_AUDIO_ROBOTIC_VOICE',
  mediaBrowser: 'QWEN_AUDIO_MEDIA_BROWSER',
  mediaReturnToAssistant: 'QWEN_AUDIO_MEDIA_RETURN_TO_ASSISTANT',
  mediaPauseWhileTalking: 'QWEN_AUDIO_MEDIA_PAUSE_WHILE_TALKING',
})

function followUpSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  // Whole seconds; an older, longer value clamps to the maximum.
  return Math.min(FOLLOW_UP_SECONDS_RANGE.max, Math.max(FOLLOW_UP_SECONDS_RANGE.min, Math.round(parsed)))
}

// An unset or unreadable switch is undefined, so the default applies.
function switchValue(text) {
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return undefined
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

// Invalid values fall back field by field, so one bad key never resets the rest.
export function normalizeLiveSettings(values = {}, fallback = LIVE_SETTINGS_DEFAULTS) {
  return {
    listeningMode: LISTENING_MODES.includes(values.listeningMode)
      ? values.listeningMode
      : fallback.listeningMode,
    wakeWord: WAKE_WORDS.includes(values.wakeWord) ? values.wakeWord : fallback.wakeWord,
    followUpSeconds: followUpSeconds(values.followUpSeconds) ?? fallback.followUpSeconds,
    cameraEnabled: booleanOr(values.cameraEnabled, fallback.cameraEnabled),
    roboticVoice: booleanOr(values.roboticVoice, fallback.roboticVoice),
    mediaBrowser: MEDIA_BROWSER_IDS.includes(values.mediaBrowser)
      ? values.mediaBrowser
      : fallback.mediaBrowser,
    mediaReturnToAssistant: booleanOr(values.mediaReturnToAssistant, fallback.mediaReturnToAssistant),
    mediaPauseWhileTalking: booleanOr(values.mediaPauseWhileTalking, fallback.mediaPauseWhileTalking),
  }
}

export function liveSettingsFromEnvironment(env = process.env) {
  const text = key => String(env[LIVE_SETTINGS_ENV_KEYS[key]] || '').trim().toLowerCase()
  return normalizeLiveSettings({
    listeningMode: text('listeningMode'),
    wakeWord: text('wakeWord'),
    followUpSeconds: env[LIVE_SETTINGS_ENV_KEYS.followUpSeconds],
    cameraEnabled: ['1', 'true', 'yes', 'on'].includes(text('cameraEnabled')),
    roboticVoice: ['1', 'true', 'yes', 'on'].includes(text('roboticVoice')),
    mediaBrowser: text('mediaBrowser'),
    mediaReturnToAssistant: switchValue(text('mediaReturnToAssistant')),
    mediaPauseWhileTalking: switchValue(text('mediaPauseWhileTalking')),
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
