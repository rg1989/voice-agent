import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Writes config.env, so use a private config directory: other test files run
// in parallel against the runner's shared one.
const configDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-live-settings-'))
process.env.QWAUDIO_CONFIG_DIR = configDirectory
test.after(() => rmSync(configDirectory, { recursive: true, force: true }))

const {
  readRuntimeSettings,
  restartEnvironment,
  settingsNeedRestart,
  updateRuntimeSettings,
} = await import('../src/app/runtime-settings.mjs')

test('settings expose the listening, wake word, follow-up and camera options', () => {
  const settings = readRuntimeSettings()
  assert.equal(settings.listeningMode, 'always')
  assert.deepEqual(settings.listeningModes.map(option => option.id), ['always', 'wake_word'])
  assert.equal(settings.wakeWord, 'hey_jarvis')
  assert.deepEqual(settings.wakeWords, [
    { id: 'hey_jarvis', label: 'Hey Jarvis' },
    { id: 'hey_lisa', label: 'Hey Lisa' },
    { id: 'hey_megan', label: 'Hey Megan' },
    { id: 'hey_mycroft', label: 'Hey Mycroft' },
    { id: 'glados', label: 'GLaDOS' },
  ])
  assert.equal(settings.followUpSeconds, 5)
  assert.deepEqual(settings.followUpDefaults, { seconds: 5, min: 0, max: 10 })
  assert.equal(settings.cameraEnabled, false)
  assert.equal(settings.roboticVoice, false)
})

test('settings expose the media player options with their defaults', () => {
  const settings = readRuntimeSettings({
    detectBrowsers: () => [{
      id: 'edge',
      label: 'Microsoft Edge',
      binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      bundleId: 'com.microsoft.edgemac',
    }],
  })
  assert.equal(settings.mediaBrowser, 'auto')
  assert.equal(settings.mediaReturnToAssistant, false)
  assert.equal(settings.mediaPauseWhileTalking, true)
  assert.deepEqual(settings.mediaBrowserOptions, [
    { id: 'auto', label: 'Automatic', installed: true },
    { id: 'chrome', label: 'Google Chrome', installed: false },
    { id: 'edge', label: 'Microsoft Edge', installed: true },
    { id: 'chromium', label: 'Chromium', installed: false },
    { id: 'brave', label: 'Brave', installed: false },
  ])
  assert.equal(readRuntimeSettings({ detectBrowsers: () => [] }).mediaBrowserOptions[0].installed, false)
})

test('saving the live settings persists them to config.env', () => {
  const result = updateRuntimeSettings({
    listeningMode: 'wake_word',
    wakeWord: 'hey_mycroft',
    followUpSeconds: 45,
    cameraEnabled: true,
  })
  assert.deepEqual(result.changed, ['listeningMode', 'wakeWord', 'followUpSeconds', 'cameraEnabled'])
  const file = readFileSync(join(configDirectory, 'config.env'), 'utf8')
  assert.match(file, /^QWEN_AUDIO_LISTENING_MODE=wake_word$/m)
  assert.match(file, /^QWEN_AUDIO_WAKE_WORD=hey_mycroft$/m)
  assert.match(file, /^QWEN_AUDIO_FOLLOW_UP_SECONDS=10$/m)
  assert.match(file, /^QWEN_AUDIO_CAMERA_ENABLED=true$/m)
  const settings = readRuntimeSettings()
  assert.equal(settings.listeningMode, 'wake_word')
  assert.equal(settings.wakeWord, 'hey_mycroft')
  assert.equal(settings.followUpSeconds, 10)
  assert.equal(settings.cameraEnabled, true)
  // Whole seconds only.
  updateRuntimeSettings({ followUpSeconds: 6.6 })
  assert.match(readFileSync(join(configDirectory, 'config.env'), 'utf8'), /^QWEN_AUDIO_FOLLOW_UP_SECONDS=7$/m)
})

test('invalid live settings are rejected', () => {
  for (const patch of [
    { listeningMode: 'push_to_talk' },
    { wakeWord: 'ok_google' },
    { followUpSeconds: 'soon' },
  ]) {
    assert.throws(() => updateRuntimeSettings(patch), error => error.status === 400)
  }
})

test('only patches made entirely of live keys skip the restart', () => {
  assert.equal(settingsNeedRestart(['voice']), false)
  assert.equal(settingsNeedRestart(['listeningMode', 'wakeWord', 'followUpSeconds', 'cameraEnabled']), false)
  assert.equal(settingsNeedRestart(['roboticVoice']), false)
  assert.equal(settingsNeedRestart(['listeningMode', 'brain']), true)
  assert.equal(settingsNeedRestart(['turnThreshold']), true)
})

test('each voice keeps its own persona, saved without a restart', async () => {
  const { config } = await import('../src/core/config.mjs')
  const { personaPath, readPersona } = await import('../src/core/persona.mjs')
  // Never write the developer's real personas.
  assert.ok(config.configDirectory.startsWith(configDirectory), config.configDirectory)

  updateRuntimeSettings({ voice: 'Siiri' })
  assert.equal(personaPath(), join(configDirectory, 'personas', 'Siiri.md'))
  const result = updateRuntimeSettings({ persona: '  ## Identity\n\nYou are GLaDOS.  ' })
  assert.deepEqual(result.changed, ['persona'])
  assert.equal(readFileSync(personaPath(), 'utf8'), '## Identity\n\nYou are GLaDOS.\n')
  assert.equal(readRuntimeSettings().persona, '## Identity\n\nYou are GLaDOS.')
  assert.equal(readRuntimeSettings().personaVoice, 'Siiri')

  updateRuntimeSettings({ voice: 'Mione' })
  assert.doesNotMatch(readRuntimeSettings().persona, /GLaDOS/)
  // A voice without its own file speaks as ASSISTANT.md.
  assert.equal(readPersona('Ethan'), readFileSync(config.assistantProfilePath, 'utf8').trim())
  updateRuntimeSettings({ voice: 'Siiri' })
  assert.match(readRuntimeSettings().persona, /GLaDOS/)

  assert.equal(settingsNeedRestart(['persona', 'voice']), false)
  for (const persona of ['   ', 'x'.repeat(4001)]) {
    assert.throws(() => updateRuntimeSettings({ persona }), error => error.status === 400)
  }
})

test('saving the media settings persists them and needs no restart', () => {
  const result = updateRuntimeSettings({
    mediaBrowser: 'brave',
    mediaReturnToAssistant: true,
    mediaPauseWhileTalking: false,
  })
  assert.deepEqual(result.changed, ['mediaBrowser', 'mediaReturnToAssistant', 'mediaPauseWhileTalking'])
  assert.equal(settingsNeedRestart(result.changed), false)
  const file = readFileSync(join(configDirectory, 'config.env'), 'utf8')
  assert.match(file, /^QWEN_AUDIO_MEDIA_BROWSER=brave$/m)
  assert.match(file, /^QWEN_AUDIO_MEDIA_RETURN_TO_ASSISTANT=true$/m)
  assert.match(file, /^QWEN_AUDIO_MEDIA_PAUSE_WHILE_TALKING=false$/m)
  const settings = readRuntimeSettings({ detectBrowsers: () => [] })
  assert.equal(settings.mediaBrowser, 'brave')
  assert.equal(settings.mediaReturnToAssistant, true)
  assert.equal(settings.mediaPauseWhileTalking, false)
  for (const patch of [{ mediaBrowser: 'safari' }, { mediaBrowser: 'firefox' }]) {
    assert.throws(() => updateRuntimeSettings(patch), error => error.status === 400)
  }
})

test('a restart reads the live settings from config.env, not the inherited env', () => {
  const env = restartEnvironment({
    PATH: '/usr/bin',
    QWEN_AUDIO_LISTENING_MODE: 'always',
    QWEN_AUDIO_WAKE_WORD: 'hey_lisa',
    QWEN_AUDIO_FOLLOW_UP_SECONDS: '5',
    QWEN_AUDIO_CAMERA_ENABLED: 'false',
    QWEN_AUDIO_ROBOTIC_VOICE: 'true',
    QWEN_AUDIO_MEDIA_BROWSER: 'chrome',
    QWEN_AUDIO_MEDIA_RETURN_TO_ASSISTANT: 'false',
    QWEN_AUDIO_MEDIA_PAUSE_WHILE_TALKING: 'true',
  })
  assert.deepEqual(env, { PATH: '/usr/bin' })
})

test('the pause before a reply stays within what the voice service honours', () => {
  updateRuntimeSettings({ turnSilenceMs: 1400 })
  assert.equal(readRuntimeSettings().turnSilenceMs, 1400)
  // DashScope ignores anything above 6 s and falls back to a short pause.
  updateRuntimeSettings({ turnSilenceMs: 9000 })
  assert.equal(readRuntimeSettings().turnSilenceMs, 6000)
  updateRuntimeSettings({ turnSilenceMs: 0 })
  assert.equal(readRuntimeSettings().turnSilenceMs, 200)
})
