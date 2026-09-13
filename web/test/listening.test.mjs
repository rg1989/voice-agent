import assert from 'node:assert/strict'
import test from 'node:test'
import { setRuntimeLanguage } from '../src/i18n.js'
import {
  RECOMMENDED_WAKE_WORD,
  followUpCountdownMs,
  shouldPlayWakeChime,
  wakeWordArmed,
  wakeWordHint,
  wakeWordLabel,
} from '../src/listening.js'

test('wake word ids read like the gateway labels', () => {
  assert.equal(wakeWordLabel('hey_jarvis'), 'Hey Jarvis')
  assert.equal(wakeWordLabel('hey_lisa'), 'Hey Lisa')
  assert.equal(wakeWordLabel('hey_mycroft'), 'Hey Mycroft')
  assert.equal(wakeWordLabel(''), '')
  assert.equal(RECOMMENDED_WAKE_WORD, 'hey_jarvis')
})

test('armed presentation needs the microphone on and an otherwise idle orb', () => {
  const armed = { listeningState: 'armed', voiceEnabled: true, visualState: 'idle' }
  assert.equal(wakeWordArmed(armed), true)
  assert.equal(wakeWordArmed({ ...armed, voiceEnabled: false }), false)
  assert.equal(wakeWordArmed({ ...armed, visualState: 'speaking' }), false)
  assert.equal(wakeWordArmed({ ...armed, visualState: 'error' }), false)
  assert.equal(wakeWordArmed({ ...armed, listeningState: 'awake' }), false)
  assert.equal(wakeWordArmed({ ...armed, listeningState: 'always' }), false)
  assert.equal(wakeWordArmed(), false)
})

test('follow-up countdown shows only while the microphone is on', () => {
  assert.equal(followUpCountdownMs({ listeningFollowUpMs: 5000, voiceEnabled: true }), 5000)
  assert.equal(followUpCountdownMs({ listeningFollowUpMs: 5000, voiceEnabled: false }), 0)
  assert.equal(followUpCountdownMs({ listeningFollowUpMs: 0, voiceEnabled: true }), 0)
  assert.equal(followUpCountdownMs(), 0)
})

test('armed hint names the wake word in both languages', () => {
  try {
    setRuntimeLanguage('zh-CN')
    assert.equal(wakeWordHint('hey_jarvis'), '说“Hey Jarvis”唤醒我')
    assert.equal(wakeWordHint(''), '说出唤醒词唤醒我')
    setRuntimeLanguage('en')
    assert.equal(wakeWordHint('hey_jarvis'), 'Say “Hey Jarvis”')
    assert.equal(wakeWordHint(''), 'Say the wake word')
  } finally {
    setRuntimeLanguage('')
  }
})

test('chimes only on a real wake by the wake word', () => {
  const woke = { type: 'voice.listening', state: 'awake', reason: 'wake_word', wakeWord: 'hey_jarvis' }
  assert.equal(shouldPlayWakeChime(woke, 'armed'), true)
  assert.equal(shouldPlayWakeChime(woke), true)
  // A status resend (for example on voice.ready) repeats the reason.
  assert.equal(shouldPlayWakeChime(woke, 'awake'), false)
  assert.equal(shouldPlayWakeChime({ ...woke, reason: 'mode_changed' }, 'always'), false)
  assert.equal(shouldPlayWakeChime({ ...woke, state: 'armed', reason: 'no_speech' }, 'awake'), false)
  assert.equal(shouldPlayWakeChime({ ...woke, type: 'voice.state' }, 'armed'), false)
  assert.equal(shouldPlayWakeChime(null), false)
})
