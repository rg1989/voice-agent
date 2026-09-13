import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, chmodSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backendWorkspaceEnvironmentKeys, config } from '../core/config.mjs'
import { computerUseMode } from '../core/computer-use-mode.mjs'
import {
  FOLLOW_UP_SECONDS_RANGE,
  LIVE_SETTING_KEYS,
  LIVE_SETTINGS_DEFAULTS,
  LIVE_SETTINGS_ENV_KEYS,
  liveSettingsFromEnvironment,
} from '../core/live-settings.mjs'

// Runtime settings the WebUI is allowed to change: which agent does the work,
// which folder it works in, and which voice speaks.
//
// These three all live in config.env and are read once at Gateway start, so
// applying a change means writing the file and restarting. Voice could in
// principle change live over session.output_voice.update, but keeping one
// mechanism for all three keeps the surface small and the behaviour
// predictable.

const CONFIG_KEYS = Object.freeze({
  brain: 'AGENT_PROTOCOL',
  folder: 'QWAUDIO_WORKSPACE',
  voice: 'QWEN_OMNI_REALTIME_VOICE',
  audioVoice: 'QWEN_AUDIO_REALTIME_VOICE',
  summaryOnly: 'QWEN_AUDIO_VOICE_SUMMARY_ONLY',
  turnThreshold: 'QWEN_AUDIO_TURN_THRESHOLD',
  turnSilenceMs: 'QWEN_AUDIO_TURN_SILENCE_MS',
  computerUse: 'QWEN_AUDIO_AGENT_COMPUTER_USE',
  webTools: 'QWEN_AUDIO_WEB_TOOLS_ENABLED',
  ...LIVE_SETTINGS_ENV_KEYS,
})

// Keys an open voice connection applies itself, so saving them needs no restart.
const LIVE_KEYS = new Set(['voice', ...LIVE_SETTING_KEYS])

export function settingsNeedRestart(changed = []) {
  return changed.some(key => !LIVE_KEYS.has(key))
}

export const LISTENING_MODE_OPTIONS = Object.freeze([
  {
    id: 'always',
    label: 'Always listening',
    detail: 'Everything the microphone hears goes to the voice model.',
  },
  {
    id: 'wake_word',
    label: 'Wake word',
    detail: 'Nothing is sent to the voice model until the wake word is heard.',
  },
])

export const WAKE_WORD_OPTIONS = Object.freeze([
  { id: 'hey_jarvis', label: 'Hey Jarvis' },
  { id: 'alexa', label: 'Alexa' },
  { id: 'hey_mycroft', label: 'Hey Mycroft' },
])

export const FOLLOW_UP_DEFAULTS = Object.freeze({
  seconds: LIVE_SETTINGS_DEFAULTS.followUpSeconds,
  ...FOLLOW_UP_SECONDS_RANGE,
})

export const COMPUTER_USE_OPTIONS = Object.freeze([
  {
    id: 'per_task',
    label: 'Ask once per task',
    detail: 'Asks the first time a task needs your computer, then lets it work until the task ends.',
  },
  {
    id: 'every_action',
    label: 'Ask every time',
    detail: 'Asks before every screenshot, click and keystroke.',
  },
  {
    id: 'always',
    label: 'Never ask',
    detail: 'Uses your screen, mouse and keyboard without asking. Only if you trust every task.',
  },
  {
    id: 'off',
    label: 'Off',
    detail: 'The assistant cannot see your screen or use your mouse and keyboard.',
  },
])

// Voices confirmed against Alibaba's Qwen-Omni-Realtime voice list.
export const OMNI_VOICES = Object.freeze([
  { id: 'Jennifer', label: 'Jennifer', detail: 'Female · American English' },
  { id: 'Aiden', label: 'Aiden', detail: 'Male · American English' },
  { id: 'Ryan', label: 'Ryan', detail: 'Male · American English, dramatic' },
  { id: 'Mione', label: 'Mione', detail: 'Female · British English' },
  { id: 'Tina', label: 'Tina', detail: 'Female · multilingual, model default' },
  { id: 'Andre', label: 'Andre', detail: 'Male · neutral multilingual' },
  { id: 'Cindy', label: 'Cindy', detail: 'Female · Taiwanese-accented English' },
  { id: 'Lenn', label: 'Lenn', detail: 'Male · German-accented English' },
])

export const BRAINS = Object.freeze([
  { id: 'claude', label: 'Claude Code', detail: 'Uses your existing ~/.claude login' },
  { id: 'codex', label: 'Codex', detail: 'Uses your existing Codex login' },
  { id: 'omp', label: 'Oh My Pi', detail: 'Uses the provider and model set in ~/.omp' },
  { id: 'none', label: 'No agent', detail: 'Voice conversation only' },
])

export const TURN_DETECTION_DEFAULTS = Object.freeze({ threshold: 0.5, silenceMs: 800 })

function clampNumber(value, { min, max }) {
  // Number('') 是 0，会把「没配置」读成「调到最小」。
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(max, Math.max(min, parsed))
}

function configPath() {
  // via core config, not shared/runtime-paths directly: app/ sits above core/
  // and the dependency tests enforce that direction.
  return resolve(config.configDirectory, 'config.env')
}

function readConfigLines() {
  const path = configPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n')
}

function valueOf(lines, key) {
  const match = lines
    .filter(line => line.startsWith(`${key}=`))
    .pop()
  return match ? match.slice(key.length + 1).trim() : ''
}

function applyValues(lines, values) {
  const keys = Object.keys(values)
  const kept = lines.filter(line => !keys.some(key => line.startsWith(`${key}=`)))
  const added = keys
    .filter(key => values[key] !== null)
    .map(key => `${key}=${values[key]}`)
  return [...kept, ...added]
}

function writeConfig(lines) {
  const path = configPath()
  const body = lines.filter((line, index, all) => line.trim() || index < all.length - 1)
  writeFileSync(path, `${body.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
  chmodSync(path, 0o600)
}

// The generic ACP entry is how a backend the catalog does not know about — such
// as Oh My Pi — gets wired in. It brings its own model and credentials.
function ompCommand() {
  const candidates = [
    process.env.OMP_BIN,
    resolve(process.env.HOME || '', '.bun/bin/omp'),
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) || ''
}

export function readRuntimeSettings() {
  const lines = readConfigLines()
  const protocol = valueOf(lines, CONFIG_KEYS.brain)
  const label = valueOf(lines, 'ACP_LABEL')
  const brain = protocol === 'acp' && /oh my pi/i.test(label) ? 'omp' : (protocol || 'none')
  const live = liveSettingsFromEnvironment(Object.fromEntries(
    Object.values(LIVE_SETTINGS_ENV_KEYS).map(key => [key, valueOf(lines, key)]),
  ))
  return {
    brain,
    brains: BRAINS.filter(entry => entry.id !== 'omp' || ompCommand()),
    folder: valueOf(lines, CONFIG_KEYS.folder),
    voice: valueOf(lines, CONFIG_KEYS.voice) || valueOf(lines, CONFIG_KEYS.audioVoice),
    voices: OMNI_VOICES,
    summaryOnly: valueOf(lines, CONFIG_KEYS.summaryOnly).toLowerCase() === 'true',
    turnThreshold: clampNumber(valueOf(lines, CONFIG_KEYS.turnThreshold), { min: 0, max: 1 })
      ?? TURN_DETECTION_DEFAULTS.threshold,
    turnSilenceMs: clampNumber(valueOf(lines, CONFIG_KEYS.turnSilenceMs), { min: 200, max: 5000 })
      ?? TURN_DETECTION_DEFAULTS.silenceMs,
    turnDefaults: TURN_DETECTION_DEFAULTS,
    computerUse: computerUseMode({
      QWEN_AUDIO_AGENT_COMPUTER_USE: valueOf(lines, CONFIG_KEYS.computerUse),
    }),
    computerUseOptions: COMPUTER_USE_OPTIONS,
    webTools: ['1', 'true', 'yes', 'on'].includes(valueOf(lines, CONFIG_KEYS.webTools).toLowerCase()),
    listeningMode: live.listeningMode,
    listeningModes: LISTENING_MODE_OPTIONS,
    wakeWord: live.wakeWord,
    wakeWords: WAKE_WORD_OPTIONS,
    followUpSeconds: live.followUpSeconds,
    followUpDefaults: FOLLOW_UP_DEFAULTS,
    cameraEnabled: live.cameraEnabled,
  }
}

export function updateRuntimeSettings(patch = {}) {
  let lines = readConfigLines()
  const changed = []

  if (typeof patch.brain === 'string' && patch.brain) {
    const brain = patch.brain
    if (!BRAINS.some(entry => entry.id === brain)) {
      throw Object.assign(new Error(`unknown brain: ${brain}`), { status: 400 })
    }
    if (brain === 'omp') {
      const command = ompCommand()
      if (!command) {
        throw Object.assign(new Error('omp is not installed'), { status: 400 })
      }
      lines = applyValues(lines, {
        [CONFIG_KEYS.brain]: 'acp',
        ACP_COMMAND: command,
        ACP_ARGS: '["acp"]',
        ACP_LABEL: 'Oh My Pi',
      })
    } else {
      lines = applyValues(lines, {
        [CONFIG_KEYS.brain]: brain,
        ACP_COMMAND: null,
        ACP_ARGS: null,
        ACP_LABEL: null,
      })
    }
    changed.push('brain')
  }

  if (typeof patch.folder === 'string') {
    const folder = patch.folder.trim()
    if (folder) {
      const absolute = resolve(folder.replace(/^~(?=\/|$)/, process.env.HOME || '~'))
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
        throw Object.assign(new Error(`no such folder: ${folder}`), { status: 400 })
      }
      lines = applyValues(lines, { [CONFIG_KEYS.folder]: absolute })
    } else {
      lines = applyValues(lines, { [CONFIG_KEYS.folder]: null })
    }
    changed.push('folder')
  }

  if (typeof patch.voice === 'string' && patch.voice) {
    if (!OMNI_VOICES.some(entry => entry.id === patch.voice)) {
      throw Object.assign(new Error(`unknown voice: ${patch.voice}`), { status: 400 })
    }
    lines = applyValues(lines, { [CONFIG_KEYS.voice]: patch.voice })
    changed.push('voice')
  }

  if (patch.turnThreshold !== undefined) {
    const threshold = clampNumber(patch.turnThreshold, { min: 0, max: 1 })
    if (threshold === null) {
      throw Object.assign(new Error('turnThreshold must be a number'), { status: 400 })
    }
    lines = applyValues(lines, { [CONFIG_KEYS.turnThreshold]: String(threshold) })
    changed.push('turnThreshold')
  }

  if (patch.turnSilenceMs !== undefined) {
    const silence = clampNumber(patch.turnSilenceMs, { min: 200, max: 5000 })
    if (silence === null) {
      throw Object.assign(new Error('turnSilenceMs must be a number'), { status: 400 })
    }
    lines = applyValues(lines, { [CONFIG_KEYS.turnSilenceMs]: String(Math.round(silence)) })
    changed.push('turnSilenceMs')
  }

  if (typeof patch.computerUse === 'string') {
    if (!COMPUTER_USE_OPTIONS.some(option => option.id === patch.computerUse)) {
      throw Object.assign(
        new Error(`unknown computer use mode: ${patch.computerUse}`),
        { status: 400 },
      )
    }
    lines = applyValues(lines, { [CONFIG_KEYS.computerUse]: patch.computerUse })
    changed.push('computerUse')
  }

  if (typeof patch.webTools === 'boolean') {
    lines = applyValues(lines, { [CONFIG_KEYS.webTools]: patch.webTools ? 'true' : 'false' })
    changed.push('webTools')
  }

  if (typeof patch.summaryOnly === 'boolean') {
    lines = applyValues(lines, {
      [CONFIG_KEYS.summaryOnly]: patch.summaryOnly ? 'true' : null,
    })
    changed.push('summaryOnly')
  }

  if (typeof patch.listeningMode === 'string') {
    if (!LISTENING_MODE_OPTIONS.some(option => option.id === patch.listeningMode)) {
      throw Object.assign(
        new Error(`unknown listening mode: ${patch.listeningMode}`),
        { status: 400 },
      )
    }
    lines = applyValues(lines, { [CONFIG_KEYS.listeningMode]: patch.listeningMode })
    changed.push('listeningMode')
  }

  if (typeof patch.wakeWord === 'string') {
    if (!WAKE_WORD_OPTIONS.some(option => option.id === patch.wakeWord)) {
      throw Object.assign(new Error(`unknown wake word: ${patch.wakeWord}`), { status: 400 })
    }
    lines = applyValues(lines, { [CONFIG_KEYS.wakeWord]: patch.wakeWord })
    changed.push('wakeWord')
  }

  if (patch.followUpSeconds !== undefined) {
    const seconds = clampNumber(patch.followUpSeconds, FOLLOW_UP_SECONDS_RANGE)
    if (seconds === null) {
      throw Object.assign(new Error('followUpSeconds must be a number'), { status: 400 })
    }
    lines = applyValues(lines, { [CONFIG_KEYS.followUpSeconds]: String(seconds) })
    changed.push('followUpSeconds')
  }

  if (typeof patch.cameraEnabled === 'boolean') {
    lines = applyValues(lines, {
      [CONFIG_KEYS.cameraEnabled]: patch.cameraEnabled ? 'true' : 'false',
    })
    changed.push('cameraEnabled')
  }

  if (!changed.length) return { changed }
  writeConfig(lines)
  return { changed }
}

// Everything the settings API writes to config.env. The replacement Gateway
// must read these from the file, so they are stripped from the env it
// inherits: loadRuntimeEnvironment only fills a key when it is undefined
// (shared/runtime-environment.mjs), so an inherited value silently wins over
// the file and the setting appears to change but never takes effect.
const MANAGED_ENV_KEYS = Object.freeze([
  CONFIG_KEYS.brain,
  CONFIG_KEYS.folder,
  CONFIG_KEYS.voice,
  CONFIG_KEYS.audioVoice,
  CONFIG_KEYS.summaryOnly,
  CONFIG_KEYS.turnThreshold,
  CONFIG_KEYS.turnSilenceMs,
  CONFIG_KEYS.computerUse,
  CONFIG_KEYS.webTools,
  CONFIG_KEYS.listeningMode,
  CONFIG_KEYS.wakeWord,
  CONFIG_KEYS.followUpSeconds,
  CONFIG_KEYS.cameraEnabled,
  'ACP_COMMAND',
  'ACP_ARGS',
  'ACP_LABEL',
])

export function restartEnvironment(source = process.env) {
  const env = { ...source }
  for (const key of MANAGED_ENV_KEYS) delete env[key]
  // At start the Gateway writes each backend's workspace variable (ACP_WORKSPACE,
  // CLAUDE_CODE_WORKSPACE, ...) into its own environment from QWAUDIO_WORKSPACE.
  // Inherited by the replacement, it would outrank the folder just saved.
  for (const key of backendWorkspaceEnvironmentKeys()) delete env[key]
  return env
}

// The Gateway holds a single-instance lease, so it cannot restart itself in
// place. A detached helper outlives this process, waits for the lease to clear,
// and starts the replacement.
export function scheduleRestart({ delayMs = 250 } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '../../..')
  const script = resolve(repoRoot, 'bin/restart')
  if (!existsSync(script)) {
    throw Object.assign(new Error('restart helper is not available'), { status: 501 })
  }
  const child = spawn('/bin/bash', [script], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: restartEnvironment(),
  })
  child.unref()
  return { restarting: true, delayMs }
}

// Folder picker. A browser cannot hand back a real path from <input type=file>
// — that is a security boundary, not an oversight — so the Gateway lists
// directories and the UI walks them. Same-origin and local identity already
// gate this route, and the backend agent can read the disk anyway.
const FOLDER_PAGE = 500

function homeDirectory() {
  return process.env.HOME || '/'
}

export function listFolders(requested = '') {
  const raw = String(requested || '').trim()
  const start = raw
    ? resolve(raw.replace(/^~(?=\/|$)/, homeDirectory()))
    : (readRuntimeSettings().folder || homeDirectory())
  const path = existsSync(start) && statSync(start).isDirectory()
    ? start
    : homeDirectory()

  let entries = []
  let error = ''
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .filter(entry => {
        if (entry.isDirectory()) return true
        // follow symlinked project dirs, which are common under ~/code
        if (!entry.isSymbolicLink()) return false
        try {
          return statSync(resolve(path, entry.name)).isDirectory()
        } catch {
          return false
        }
      })
      .map(entry => ({ name: entry.name, path: resolve(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, FOLDER_PAGE)
  } catch (caught) {
    error = caught.code === 'EACCES' ? 'permission denied' : caught.message
  }

  const parent = resolve(path, '..')
  return {
    path,
    parent: parent === path ? '' : parent,
    home: homeDirectory(),
    entries,
    ...(error ? { error } : {}),
  }
}
