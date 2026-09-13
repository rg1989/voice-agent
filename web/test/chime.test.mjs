import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as chime from '../src/realtime/chime.js'
import {
  playWakeChime,
  WAKE_CHIME_PEAK_GAIN,
  wakeChimeDuration,
  wakeChimeSchedule,
} from '../src/realtime/chime.js'
import { microphoneSamplesDuringManualInput } from '../src/realtime/useRealtimeVoice.js'

const close = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `${actual} != ${expected}`,
)

test('wake chime is a short, gentle, rising two-tone cue', () => {
  const tones = wakeChimeSchedule(10)
  assert.equal(tones.length, 2)
  assert.ok(tones[1].frequency > tones[0].frequency)
  assert.ok(tones[1].start > tones[0].start)
  close(wakeChimeDuration(), 0.25)
  close(Math.max(...tones.map(tone => tone.end)) - 10, 0.25)
  for (const tone of tones) {
    assert.ok(tone.peakAt > tone.start, 'gentle attack')
    assert.ok(tone.end - tone.peakAt > tone.peakAt - tone.start, 'decay is longer than the attack')
    assert.ok(tone.peak > 0 && tone.peak <= 0.2, 'modest volume')
  }
  assert.equal(WAKE_CHIME_PEAK_GAIN, tones[0].peak)
})

// Regression: zeroing the uplink while the chime played replaced the words
// spoken right after the wake word ("Hey Jarvis, what's the…") with silence.
test('the wake chime never silences speech that follows the wake word', async () => {
  assert.equal('chimeUplinkMuted' in chime, false)
  assert.equal('chimeUplinkMutedUntil' in chime, false)
  const { context } = fakeContext()
  assert.ok(await playWakeChime(context) > 0)
  const speech = Float32Array.from([0.4, -0.3])
  assert.equal(microphoneSamplesDuringManualInput(speech, false), speech)
  const hook = readFileSync(new URL('../src/realtime/useRealtimeVoice.js', import.meta.url), 'utf8')
  assert.doesNotMatch(hook, /chimeMuted/)
})

function fakeContext(state = 'running') {
  const calls = []
  const param = name => new Proxy({}, {
    get: (_, method) => (...args) => calls.push([name, method, ...args]),
  })
  const node = kind => ({
    kind,
    connected: [],
    connect(target) { this.connected.push(target) },
    disconnect() { calls.push([kind, 'disconnect']) },
  })
  const context = {
    state,
    currentTime: 2,
    destination: { kind: 'destination' },
    oscillators: [],
    gains: [],
    async resume() {
      calls.push(['context', 'resume'])
      this.state = 'running'
    },
    createOscillator() {
      const oscillator = {
        ...node('oscillator'),
        frequency: param('frequency'),
        start: at => calls.push(['oscillator', 'start', at]),
        stop: at => calls.push(['oscillator', 'stop', at]),
      }
      this.oscillators.push(oscillator)
      return oscillator
    },
    createGain() {
      const gain = { ...node('gain'), gain: param('gain') }
      this.gains.push(gain)
      return gain
    },
  }
  return { context, calls }
}

test('plays straight to the destination and resumes a suspended context first', async () => {
  const { context, calls } = fakeContext('suspended')
  const remaining = await playWakeChime(context)
  assert.deepEqual(calls[0], ['context', 'resume'])
  assert.ok(remaining >= wakeChimeDuration())
  assert.equal(context.oscillators.length, 2)
  context.oscillators.forEach((oscillator, index) => {
    assert.equal(oscillator.type, 'sine')
    assert.deepEqual(oscillator.connected, [context.gains[index]])
    assert.deepEqual(context.gains[index].connected, [context.destination])
  })
  const starts = calls.filter(([kind, method]) => kind === 'oscillator' && method === 'start')
  assert.ok(starts.every(([, , at]) => at >= context.currentTime))
  const ramps = calls.filter(([kind, method]) => kind === 'gain' && method.endsWith('RampToValueAtTime'))
  assert.equal(ramps.length, 4)
})

test('does nothing without a usable context', async () => {
  assert.equal(await playWakeChime(null), 0)
  const { context, calls } = fakeContext('closed')
  assert.equal(await playWakeChime(context), 0)
  assert.equal(calls.length, 0)
})
