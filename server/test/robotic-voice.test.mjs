import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoboticVoice } from '../src/voice/robotic-voice.mjs'

const tone = length => Int16Array.from(
  { length },
  (_, index) => Math.round(8000 * Math.sin(2 * Math.PI * 220 * index / 24000)),
)

test('the robotic voice changes the audio but not its length, however it is chunked', () => {
  const input = tone(24000)
  const whole = createRoboticVoice().process(input)
  assert.equal(whole.length, input.length)
  assert.notDeepEqual(whole, input)

  const voice = createRoboticVoice()
  const chunked = []
  let start = 0
  for (const end of [480, 1000, 7331, 24000]) {
    chunked.push(...voice.process(input.subarray(start, end)))
    start = end
  }
  assert.deepEqual(Int16Array.from(chunked), whole)
})

test('silence stays silent and base64 chunks keep their byte length', () => {
  const voice = createRoboticVoice()
  const silence = Buffer.alloc(4800).toString('base64')
  assert.equal(voice.processBase64(silence), silence)
  const odd = Buffer.from([1, 2, 3]).toString('base64')
  assert.equal(Buffer.from(voice.processBase64(odd), 'base64').length, 3)
})
