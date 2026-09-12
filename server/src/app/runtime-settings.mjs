import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, chmodSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../core/config.mjs'

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
})

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
  return {
    brain,
    brains: BRAINS.filter(entry => entry.id !== 'omp' || ompCommand()),
    folder: valueOf(lines, CONFIG_KEYS.folder),
    voice: valueOf(lines, CONFIG_KEYS.voice) || valueOf(lines, CONFIG_KEYS.audioVoice),
    voices: OMNI_VOICES,
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

  if (!changed.length) return { changed }
  writeConfig(lines)
  return { changed }
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
    env: { ...process.env },
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
