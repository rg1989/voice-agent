import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from './config.mjs'

// Each voice speaks as its own character: personas/<Voice>.md in the config
// directory. The voice, the brain and Settings all resolve it here. A voice
// without a character file, or a deployment that sets its own assistant
// profile, uses assistantProfilePath (ASSISTANT.md) as before.

const VOICE_KEYS = ['QWEN_OMNI_REALTIME_VOICE', 'QWEN_AUDIO_REALTIME_VOICE']

// Settings rewrites config.env when a voice is picked, without a restart, so
// read it fresh instead of trusting the value loaded at startup.
export function selectedVoice() {
  try {
    const lines = readFileSync(resolve(config.configDirectory, 'config.env'), 'utf8').split('\n')
    for (const key of VOICE_KEYS) {
      const line = lines.filter(entry => entry.startsWith(`${key}=`)).pop()
      const value = line?.slice(key.length + 1).trim()
      if (value) return value
    }
  } catch {
    // no config.env yet
  }
  return config.audioVoice || ''
}

export function personaPath(voice = selectedVoice()) {
  // A frontend profile or QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH picks its own file.
  const defaultProfile = config.assistantProfilePath === resolve(config.configDirectory, 'ASSISTANT.md')
  // The name becomes a file name, so only plain voice ids qualify.
  if (defaultProfile && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(voice)) {
    return resolve(config.configDirectory, 'personas', `${voice}.md`)
  }
  return config.assistantProfilePath
}

export function readPersona(voice = selectedVoice()) {
  for (const path of [personaPath(voice), config.assistantProfilePath]) {
    try {
      const text = readFileSync(path, 'utf8').trim()
      if (text) return text
    } catch {
      // try the next one
    }
  }
  return ''
}
