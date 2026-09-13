import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LiveSettings,
  liveSettingsFromEnvironment,
} from '../src/core/live-settings.mjs'

test('live settings default to always listening with the camera off', () => {
  assert.deepEqual(liveSettingsFromEnvironment({}), {
    listeningMode: 'always',
    wakeWord: 'hey_jarvis',
    followUpSeconds: 5,
    cameraEnabled: false,
    roboticVoice: false,
  })
})

test('live settings parse config.env values and fall back per invalid field', () => {
  assert.deepEqual(liveSettingsFromEnvironment({
    QWEN_AUDIO_LISTENING_MODE: 'WAKE_WORD',
    QWEN_AUDIO_WAKE_WORD: 'ok_google',
    QWEN_AUDIO_FOLLOW_UP_SECONDS: '90',
    QWEN_AUDIO_CAMERA_ENABLED: 'true',
    QWEN_AUDIO_ROBOTIC_VOICE: 'on',
  }), {
    listeningMode: 'wake_word',
    wakeWord: 'hey_jarvis',
    followUpSeconds: 10,
    cameraEnabled: true,
    roboticVoice: true,
  })
})

test('a saved wake word that is no longer offered falls back to Hey Jarvis', () => {
  assert.equal(liveSettingsFromEnvironment({ QWEN_AUDIO_WAKE_WORD: 'alexa' }).wakeWord, 'hey_jarvis')
})

test('the store seeds from config and emits change only when a value changes', () => {
  const store = new LiveSettings({ listeningMode: 'wake_word', followUpSeconds: 8, port: 3101 })
  assert.deepEqual(store.get(), {
    listeningMode: 'wake_word',
    wakeWord: 'hey_jarvis',
    followUpSeconds: 8,
    cameraEnabled: false,
    roboticVoice: false,
  })
  const events = []
  store.on('change', (next, previous, changed) => events.push({ next, previous, changed }))

  assert.deepEqual(store.update({ listeningMode: 'wake_word', voice: 'Aiden' }), [])
  assert.deepEqual(store.update({ wakeWord: 'hey_megan', followUpSeconds: 'soon' }), ['wakeWord'])
  assert.equal(events.length, 1)
  assert.equal(events[0].previous.wakeWord, 'hey_jarvis')
  assert.equal(events[0].next.wakeWord, 'hey_megan')
  // An invalid value keeps the current one rather than resetting to the default.
  assert.equal(store.get().followUpSeconds, 8)
  // Whole seconds only.
  assert.deepEqual(store.update({ followUpSeconds: 6.6 }), ['followUpSeconds'])
  assert.equal(store.get().followUpSeconds, 7)
})
