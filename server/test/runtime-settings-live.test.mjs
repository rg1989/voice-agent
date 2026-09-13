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
  ])
  assert.equal(settings.followUpSeconds, 5)
  assert.deepEqual(settings.followUpDefaults, { seconds: 5, min: 0, max: 10 })
  assert.equal(settings.cameraEnabled, false)
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
  assert.equal(settingsNeedRestart(['listeningMode', 'brain']), true)
  assert.equal(settingsNeedRestart(['turnThreshold']), true)
})

test('a restart reads the live settings from config.env, not the inherited env', () => {
  const env = restartEnvironment({
    PATH: '/usr/bin',
    QWEN_AUDIO_LISTENING_MODE: 'always',
    QWEN_AUDIO_WAKE_WORD: 'hey_lisa',
    QWEN_AUDIO_FOLLOW_UP_SECONDS: '5',
    QWEN_AUDIO_CAMERA_ENABLED: 'false',
  })
  assert.deepEqual(env, { PATH: '/usr/bin' })
})
