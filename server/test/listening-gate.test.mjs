import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isStopListeningPhrase,
  isWakeWordOnly,
  ListeningGate,
  mentionsWakeWord,
} from '../src/voice/listening-gate.mjs'

// 0.1 s of 16 kHz PCM16, tagged so chunks can be told apart.
const chunk = tag => Buffer.alloc(3200, tag).toString('base64')

function harness(settings = {}, { busy = false, createDetector, onWakeCheckEnd } = {}) {
  const log = []
  const detectors = []
  const errors = []
  let speaking = false
  const gate = new ListeningGate({
    settings: {
      listeningMode: 'wake_word',
      wakeWord: 'hey_jarvis',
      followUpSeconds: 5,
      ...settings,
    },
    cacheDirectory: '/tmp/cache',
    createDetector: createDetector || (options => {
      const detector = {
        options,
        pushed: [],
        resets: 0,
        closed: false,
        ready: Promise.resolve(),
        push: audio => detector.pushed.push(audio),
        reset: () => { detector.resets += 1 },
        close: () => { detector.closed = true },
      }
      detectors.push(detector)
      return detector
    }),
    passAudio: audio => log.push({ audio }),
    onChange: status => log.push({ status }),
    onError: error => errors.push(error),
    isBusy: () => busy,
    isUserSpeaking: () => speaking,
    onWakeCheckEnd,
  })
  return {
    gate,
    log,
    detectors,
    errors,
    passed: () => log.filter(entry => entry.audio).map(entry => entry.audio),
    states: () => log.filter(entry => entry.status).map(entry => entry.status),
    setSpeaking: value => { speaking = value },
    setBusy: value => { busy = value },
  }
}

test('armed audio feeds only the lazily created detector', () => {
  const kit = harness()
  assert.equal(kit.gate.state, 'armed')
  assert.equal(kit.detectors.length, 0)
  for (let index = 0; index < 10; index += 1) kit.gate.append(chunk(index))
  assert.deepEqual(kit.passed(), [])
  assert.equal(kit.detectors.length, 1)
  assert.equal(kit.detectors[0].options.wakeWord, 'hey_jarvis')
  assert.equal(kit.detectors[0].options.cacheDirectory, '/tmp/cache')
  assert.equal(kit.detectors[0].pushed.length, 10)
})

test('always mode passes audio through without a detector', () => {
  const kit = harness({ listeningMode: 'always' })
  kit.gate.append(chunk(1))
  assert.equal(kit.gate.state, 'always')
  assert.deepEqual(kit.passed(), [chunk(1)])
  assert.equal(kit.detectors.length, 0)
})

test('the wake word announces awake, flushes a second and a half of pre-roll, then passes audio', () => {
  const kit = harness()
  for (let index = 0; index < 20; index += 1) kit.gate.append(chunk(index))
  kit.detectors[0].options.onDetected()
  assert.equal(kit.gate.state, 'awake')
  assert.deepEqual(kit.log[0], {
    status: { state: 'awake', reason: 'wake_word', wakeWord: 'hey_jarvis' },
  })
  assert.deepEqual(kit.passed(), Array.from({ length: 15 }, (_, index) => chunk(index + 5)))
  kit.gate.append(chunk(20))
  assert.equal(kit.passed().at(-1), chunk(20))
  assert.equal(kit.detectors[0].pushed.length, 20)
  kit.gate.close()
})

test('with no speech after the wake word the gate re-arms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  t.mock.timers.tick(7_999)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.equal(kit.gate.state, 'armed')
  assert.equal(kit.states().at(-1).reason, 'no_speech')
  assert.equal(kit.detectors[0].resets, 1)
})

test('the follow-up window starts only when the response has settled', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted()
  t.mock.timers.tick(60_000)
  assert.equal(kit.gate.state, 'awake')

  kit.gate.responseStarted()
  t.mock.timers.tick(60_000)
  assert.equal(kit.gate.state, 'awake')

  kit.gate.responseSettled()
  assert.deepEqual(kit.states().at(-1), {
    state: 'awake',
    reason: 'follow_up',
    wakeWord: 'hey_jarvis',
    followUpMs: 5000,
  })
  // The visible countdown, then a short hidden grace.
  t.mock.timers.tick(5_499)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.equal(kit.gate.state, 'armed')
  assert.equal(kit.states().at(-1).reason, 'follow_up_expired')
})

test('new speech or a new response cancels the follow-up window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.responseSettled()
  t.mock.timers.tick(3_000)
  kit.gate.responseStarted()
  // The countdown is hidden again.
  assert.deepEqual(kit.states().at(-1), {
    state: 'awake',
    reason: 'follow_up_cancelled',
    wakeWord: 'hey_jarvis',
  })
  t.mock.timers.tick(10_000)
  assert.equal(kit.gate.state, 'awake')
  kit.gate.responseSettled()
  t.mock.timers.tick(3_000)
  kit.gate.speechStarted()
  t.mock.timers.tick(10_000)
  assert.equal(kit.gate.state, 'awake')

  // Settling while the user is already talking again starts nothing.
  kit.setSpeaking(true)
  kit.gate.responseSettled()
  t.mock.timers.tick(60_000)
  assert.equal(kit.gate.state, 'awake')
})

test('only the status that starts a countdown carries followUpMs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.responseSettled()
  assert.equal(kit.states().at(-1).followUpMs, 5000)
  t.mock.timers.tick(1_000)
  // A re-sent status must not restart the bar while the timer runs on.
  kit.gate.applySettings({ listeningMode: 'wake_word', wakeWord: 'hey_lisa', followUpSeconds: 5 })
  assert.deepEqual(kit.states().at(-1), { state: 'awake', reason: 'follow_up', wakeWord: 'hey_lisa' })
  assert.equal(kit.gate.status().followUpMs, undefined)
})

test('an ignored input resumes the running countdown instead of restarting it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.responseSettled('resp-1')
  t.mock.timers.tick(2_000)
  kit.gate.speechStarted()
  t.mock.timers.tick(1_000)
  kit.gate.inputIgnored('resp-2')
  kit.gate.responseSettled('resp-2')
  assert.equal(kit.states().at(-1).followUpMs, 2000)
  t.mock.timers.tick(2_499)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.equal(kit.gate.state, 'armed')
  assert.equal(kit.states().at(-1).reason, 'follow_up_expired')

  // With no countdown to resume, and after a real answer, the window is full.
  kit.detectors[0].options.onDetected()
  kit.gate.inputIgnored('resp-3')
  kit.gate.responseSettled('resp-3')
  assert.equal(kit.states().at(-1).followUpMs, 5000)
  t.mock.timers.tick(4_000)
  kit.gate.speechStarted()
  kit.gate.responseSettled('resp-4')
  assert.equal(kit.states().at(-1).followUpMs, 5000)
})

test('a zero-second follow-up re-arms as soon as the response settles', () => {
  const kit = harness({ followUpSeconds: 0 })
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.responseSettled()
  assert.equal(kit.gate.state, 'armed')
  assert.equal(kit.states().at(-1).reason, 'follow_up_expired')
})

test('stop re-arms only in wake word mode', () => {
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  assert.equal(kit.gate.stop('ignored'), true)
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'ignored', wakeWord: 'hey_jarvis' })

  const always = harness({ listeningMode: 'always' })
  assert.equal(always.gate.stop('stop'), false)
  assert.equal(always.gate.state, 'always')
  assert.deepEqual(always.states(), [])
})

test('mode switches apply live', () => {
  const kit = harness({ listeningMode: 'always' })
  kit.gate.applySettings({ listeningMode: 'wake_word', wakeWord: 'hey_lisa', followUpSeconds: 5 })
  assert.deepEqual(kit.states().at(-1), { state: 'armed', reason: 'mode_changed', wakeWord: 'hey_lisa' })
  kit.gate.append(chunk(1))
  assert.equal(kit.detectors[0].options.wakeWord, 'hey_lisa')

  kit.gate.applySettings({ listeningMode: 'wake_word', wakeWord: 'hey_mycroft', followUpSeconds: 5 })
  assert.equal(kit.detectors[0].closed, true)
  assert.equal(kit.states().at(-1).wakeWord, 'hey_mycroft')
  kit.gate.append(chunk(2))
  assert.equal(kit.detectors[1].options.wakeWord, 'hey_mycroft')

  kit.gate.applySettings({ listeningMode: 'always', wakeWord: 'hey_mycroft', followUpSeconds: 5 })
  assert.equal(kit.detectors[1].closed, true)
  assert.deepEqual(kit.states().at(-1), { state: 'always', reason: 'mode_changed', wakeWord: 'hey_mycroft' })
  kit.gate.append(chunk(3))
  assert.deepEqual(kit.passed(), [chunk(3)])
})

test('switching to wake word mode mid-response arms once it has settled', () => {
  const kit = harness({ listeningMode: 'always' }, { busy: true })
  kit.gate.applySettings({ listeningMode: 'wake_word', wakeWord: 'hey_jarvis', followUpSeconds: 5 })
  assert.equal(kit.gate.state, 'awake')
  kit.gate.append(chunk(1))
  assert.deepEqual(kit.passed(), [chunk(1)])
  kit.gate.responseSettled()
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'mode_changed', wakeWord: 'hey_jarvis' })
  kit.gate.close()
})

test('a detector that cannot start is reported once, not rebuilt on every chunk', async () => {
  let attempts = 0
  const kit = harness({}, {
    createDetector: () => {
      attempts += 1
      throw new Error('model download failed')
    },
  })
  kit.gate.append(chunk(1))
  kit.gate.append(chunk(2))
  assert.equal(attempts, 1)
  assert.equal(kit.errors.length, 1)
  assert.deepEqual(kit.passed(), [])

  const rejected = harness({}, {
    createDetector: () => ({
      ready: Promise.reject(new Error('bad checksum')),
      push: () => {},
      reset: () => {},
      close: () => {},
    }),
  })
  rejected.gate.append(chunk(1))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rejected.errors.length, 1)
  assert.equal(rejected.gate.detector, null)
})

test('recognises bare stop phrases, with or without a leading wake word', () => {
  for (const phrase of [
    'Stop listening.',
    'stop listening now',
    'Go to sleep!',
    "That's all",
    'That’s all.',
    'Never mind',
    'Hey Jarvis, stop listening',
    'Hey Lisa, stop listening.',
    'Megan, go to sleep',
    'Hey Jarvis, go to sleep',
    '停止监听。',
    '别听了',
    '不用了！',
  ]) {
    assert.equal(isStopListeningPhrase(phrase), true, phrase)
  }
  for (const phrase of [
    // A bare stop only interrupts the answer.
    'Stop',
    'stop the timer',
    "don't stop listening",
    'what is the weather',
    'Hey Jarvis',
    '',
  ]) {
    assert.equal(isStopListeningPhrase(phrase), false, phrase)
  }
  // In always mode "never mind" only cancels the answer.
  for (const phrase of ['Never mind', 'nevermind', '不用了！']) {
    assert.equal(isStopListeningPhrase(phrase, { wakeWordMode: false }), false, phrase)
  }
  for (const phrase of ['Stop listening.', 'Go to sleep!', "That's all", '别听了']) {
    assert.equal(isStopListeningPhrase(phrase, { wakeWordMode: false }), true, phrase)
  }
})

test('only the first transcript of a wake has to name the wake word', () => {
  const kit = harness()
  // Speech that began before the wake is never checked.
  kit.gate.speechStarted('turn-before')
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  assert.equal(kit.gate.verifyTranscript('turn-before', 'what time is it'), true)

  // A bare wake word passes and keeps listening; the request after it needs none.
  kit.gate.speechStarted('turn-1')
  assert.equal(kit.gate.verifyTranscript('turn-1', 'Hey Jarvis.'), true)
  kit.gate.speechStarted('turn-2')
  assert.equal(kit.gate.verifyTranscript('turn-2', 'what time is it'), true)
  assert.equal(kit.gate.state, 'awake')

  // Every new wake is checked again.
  kit.gate.stop('stop')
  kit.gate.append(chunk(2))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-3')
  assert.equal(kit.gate.verifyTranscript('turn-3', 'hey travis what time is it'), false)
  kit.gate.arm('unverified')
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'unverified', wakeWord: 'hey_jarvis' })
  assert.equal(kit.gate.verifyTranscript('turn-3', 'hey travis what time is it'), true)

  const always = harness({ listeningMode: 'always' })
  always.gate.speechStarted('turn-1')
  assert.equal(always.gate.verifyTranscript('turn-1', 'what time is it'), true)
})

test('recognises the wake word only in its common transcript spellings', () => {
  for (const [wakeWord, transcript] of [
    ['hey_jarvis', 'Hey Jarvis, what time is it?'],
    ['hey_jarvis', 'hey jervis'],
    ['hey_jarvis', 'JARVAS!'],
    ['hey_jarvis', 'Jarvus.'],
    ['hey_jarvis', '贾维斯，现在几点？'],
    ['hey_jarvis', '嘿嘉维斯'],
    ['hey_lisa', 'Hey Lisa, play some music'],
    ['hey_lisa', 'hey leesa'],
    ['hey_lisa', '丽莎你好'],
    ['hey_megan', 'Hey Meghan!'],
    ['hey_megan', '梅根，现在几点？'],
    ['hey_mycroft', 'Hey Mycroft.'],
    ['hey_mycroft', 'hey my croft'],
    ['glados', 'Hey, GLaDOS. What time is it?'],
    ['glados', 'Okay, GLaDOS.'],
    ['glados', 'Hey Gladys.'],
    ['glados', 'glad os, play some music'],
    ['glados', '格拉多斯，现在几点？'],
  ]) {
    assert.equal(mentionsWakeWord(wakeWord, transcript), true, transcript)
  }
  for (const [wakeWord, transcript] of [
    ['glados', 'I am glad of it'],
    ['glados', 'gladiolus'],
    ['glados', 'Hey Jarvis'],
    ['hey_jarvis', 'hey travis what time is it'],
    ['hey_jarvis', 'Hey Jarvi'],
    ['hey_jarvis', 'jarvisbot'],
    ['hey_jarvis', 'Hey Lisa'],
    ['hey_lisa', 'hey melissa'],
    ['hey_megan', 'hey morgan'],
    ['hey_mycroft', 'hey microsoft'],
    ['unknown', 'jarvis'],
    ['hey_jarvis', ''],
  ]) {
    assert.equal(mentionsWakeWord(wakeWord, transcript), false, transcript)
  }
})

test('a transcript that is only the wake word asks for nothing', () => {
  for (const [wakeWord, transcript] of [
    ['hey_jarvis', 'Hey Jarvis.'],
    ['hey_jarvis', 'Jarvis?'],
    ['hey_jarvis', 'Okay, Jarvis! Jarvis!'],
    ['hey_jarvis', '嘿，贾维斯'],
    ['hey_megan', 'Megan'],
    ['hey_mycroft', 'Hey my croft'],
    ['glados', 'Okay, GLaDOS.'],
    ['glados', 'Gladys?'],
  ]) {
    assert.equal(isWakeWordOnly(wakeWord, transcript), true, transcript)
  }
  for (const [wakeWord, transcript] of [
    ['hey_jarvis', 'Hey Jarvis, what time is it?'],
    ['hey_jarvis', 'Hey Travis.'],
    ['hey_jarvis', '贾维斯现在几点'],
    ['hey_lisa', 'Hey Lisa play some music'],
    ['hey_jarvis', ''],
  ]) {
    assert.equal(isWakeWordOnly(wakeWord, transcript), false, transcript)
  }
})

// Regression: after a bare "Hey Jarvis." the no-speech window could never
// fire, because the wake phrase itself had cleared it.
test('keepListening restarts the no-speech window after a bare wake word', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-1')
  kit.gate.responseStarted()
  t.mock.timers.tick(60_000)
  assert.equal(kit.gate.state, 'awake')
  kit.gate.keepListening()
  t.mock.timers.tick(7_999)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'no_speech', wakeWord: 'hey_jarvis' })
})

// Regression: a turn whose response never started or failed left the gate
// awake with no timer, streaming the microphone indefinitely.
test('an awake exchange that never settles still re-arms, but not mid-speech', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-1')
  t.mock.timers.tick(119_999)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'no_speech', wakeWord: 'hey_jarvis' })

  kit.gate.append(chunk(2))
  kit.detectors[0].options.onDetected()
  kit.setSpeaking(true)
  kit.gate.responseStarted()
  t.mock.timers.tick(120_000)
  assert.equal(kit.gate.state, 'awake')
  kit.setSpeaking(false)
  t.mock.timers.tick(120_000)
  assert.equal(kit.gate.state, 'armed')
})

test('the end of a wake check reports whether the wake word was confirmed', () => {
  const ends = []
  const kit = harness({}, { onWakeCheckEnd: (verified, turnIds) => ends.push([verified, turnIds]) })
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-1')
  assert.equal(kit.gate.awaitsWakeCheck('turn-1'), true)
  assert.equal(kit.gate.awaitsWakeCheck(''), false)
  kit.gate.verifyTranscript('turn-1', 'Hey Jarvis, what time is it?')
  assert.equal(kit.gate.awaitsWakeCheck('turn-1'), false)
  kit.gate.stop('stop')
  assert.deepEqual(ends, [[true, ['turn-1']]])

  kit.gate.append(chunk(2))
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-2')
  kit.gate.arm('unverified')
  assert.deepEqual(ends.at(-1), [false, ['turn-2']])

  kit.gate.append(chunk(3))
  kit.detectors[0].options.onDetected()
  kit.gate.applySettings({ listeningMode: 'always', wakeWord: 'hey_jarvis', followUpSeconds: 5 })
  assert.deepEqual(ends.at(-1), [false, []])
  assert.equal(ends.length, 3)
})

test('the assistant speaking on its own opens the follow-up window without the wake word', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const kit = harness()
  kit.gate.append(chunk(1))
  assert.equal(kit.passed().length, 0)
  kit.gate.assistantSpeaking('resp-1')
  assert.deepEqual(kit.gate.status(), { state: 'awake', reason: 'assistant_speaking', wakeWord: 'hey_jarvis' })
  kit.gate.append(chunk(2))
  assert.equal(kit.passed().length, 1)
  kit.gate.responseSettled('resp-1')
  assert.equal(kit.states().at(-1).followUpMs, 5000)
  t.mock.timers.tick(5_499)
  assert.equal(kit.gate.state, 'awake')
  t.mock.timers.tick(1)
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'follow_up_expired', wakeWord: 'hey_jarvis' })
})

test('the response that stopped listening does not wake the gate with its own audio', () => {
  const kit = harness()
  kit.gate.append(chunk(1))
  kit.detectors[0].options.onDetected()
  kit.gate.stopListening('resp-stop')
  kit.gate.assistantSpeaking('resp-stop')
  assert.equal(kit.gate.state, 'armed')
  kit.gate.assistantSpeaking('resp-later')
  assert.equal(kit.gate.state, 'awake')
})

// Regression (live): in always mode "Stop listening." changed nothing, so the
// next thing said was still heard.
test('in always mode stopping listening waits for the wake word, then listens always again', () => {
  const kit = harness({ listeningMode: 'always' })
  assert.equal(kit.gate.stopListening(), true)
  assert.deepEqual(kit.gate.status(), { state: 'armed', reason: 'stop', wakeWord: 'hey_jarvis' })
  kit.gate.append(chunk(1))
  assert.deepEqual(kit.passed(), [])

  // A false wake keeps waiting.
  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-1')
  assert.equal(kit.gate.verifyTranscript('turn-1', 'hey travis what time is it'), false)
  kit.gate.arm('unverified')

  kit.detectors[0].options.onDetected()
  kit.gate.speechStarted('turn-2')
  assert.equal(kit.gate.verifyTranscript('turn-2', 'Hey Jarvis, what time is it?'), true)
  assert.deepEqual(kit.gate.status(), { state: 'always', reason: 'wake_word', wakeWord: 'hey_jarvis' })
  assert.equal(kit.detectors[0].closed, true)
  kit.gate.append(chunk(2))
  assert.equal(kit.passed().at(-1), chunk(2))

  // A client with no wake word has nothing to wait for.
  const none = harness({ listeningMode: 'always', wakeWord: '' })
  assert.equal(none.gate.stopListening(), false)
  assert.equal(none.gate.state, 'always')
})
