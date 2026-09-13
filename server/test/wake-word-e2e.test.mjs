import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  WakeWordTrigger,
  createWakeWordDetector,
  pcm16Samples,
} from '../src/voice/wake-word/detector.mjs'
import {
  WAKE_WORD_MODELS,
  ensureWakeWordModels,
  wakeWordModelDirectory,
} from '../src/voice/wake-word/models.mjs'

// Runs the real openWakeWord models when they are already cached below, or
// with QWAUDIO_WAKE_WORD_E2E=1 (downloads them), so default runs stay offline.
// Fixtures are raw 16 kHz mono PCM16LE made with
//   say -v <Voice> -o x.aiff "<phrase>" && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav
// with the WAV header stripped.
const cacheDirectory = join(tmpdir(), 'qwaudio-wake-word-models')
const cached = [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  ...Object.values(WAKE_WORD_MODELS).map(model => model.file),
].every(file => existsSync(join(wakeWordModelDirectory(cacheDirectory), file)))
const skip = !cached && process.env.QWAUDIO_WAKE_WORD_E2E !== '1'
  && 'openWakeWord models are not cached; set QWAUDIO_WAKE_WORD_E2E=1 to download them'

const SECOND = 16_000
const fixture = name => pcm16Samples(
  readFileSync(new URL(`./fixtures/wake-word/${name}.pcm`, import.meta.url)),
)

function concat(...parts) {
  const output = new Int16Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function whiteNoise(length, amplitude, seed = 7) {
  let state = seed
  return Int16Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return Math.round((state / 1073741824 - 1) * amplitude)
  })
}

const expectations = {
  hey_jarvis: {
    fires: ['hey-jarvis-samantha', 'hey-jarvis-daniel', 'hey-jarvis-karen'],
    quiet: [
      'hey-service-samantha',
      'hey-travis-daniel',
      'a-jar-of-peas-samantha',
      'turn-off-the-lights-daniel',
      'alexa-samantha',
      'hey-mycroft-samantha',
    ],
  },
  alexa: { fires: ['alexa-samantha'], quiet: ['hey-jarvis-samantha'] },
  hey_mycroft: { fires: ['hey-mycroft-samantha'], quiet: ['hey-jarvis-samantha'] },
}

test('real models fire on their wake word and stay quiet on near misses', { skip }, async () => {
  const { loadWakeWordFeatures } = await import('../src/voice/wake-word/onnx-models.mjs')
  for (const [wakeWord, { fires, quiet }] of Object.entries(expectations)) {
    const features = await loadWakeWordFeatures(
      await ensureWakeWordModels({ cacheDirectory, wakeWord }),
    )
    const clips = [
      ...fires.map(name => [name, fixture(name), 1]),
      ...quiet.map(name => [name, fixture(name), 0]),
      ['silence', new Int16Array(3 * SECOND), 0],
      ['white noise', whiteNoise(3 * SECOND, 3000), 0],
    ]
    for (const [name, clip, expected] of clips) {
      features.reset()
      const trigger = new WakeWordTrigger()
      const silence = new Int16Array(SECOND)
      const scores = await features.process(concat(silence, clip, silence))
      const detections = scores.filter(score => trigger.accept(score)).length
      assert.equal(detections, expected,
        `${wakeWord} on ${name}: max score ${Math.max(...scores).toFixed(3)}`)
    }
  }
})

test('detector worker reports each wake word in a base64 PCM stream', { skip }, async () => {
  const detections = []
  const errors = []
  const detector = createWakeWordDetector({
    wakeWord: 'hey_jarvis',
    cacheDirectory,
    onDetected: event => detections.push(event),
    onError: error => errors.push(error),
  })
  try {
    await detector.ready
    const gap = new Int16Array(1.5 * SECOND)
    const stream = concat(
      gap, fixture('a-jar-of-peas-samantha'),
      gap, fixture('hey-jarvis-samantha'),
      gap, fixture('hey-jarvis-karen'),
      gap,
    )
    const bytes = Buffer.from(stream.buffer)
    // 100 ms chunks, the size clients send.
    for (let offset = 0; offset < bytes.length; offset += 3200) {
      detector.push(bytes.subarray(offset, offset + 3200).toString('base64'))
    }
    const deadline = Date.now() + 20_000
    while (detections.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.deepEqual(errors, [])
    assert.equal(detections.length, 2)
    assert.ok(detections.every(event => event.wakeWord === 'hey_jarvis' && event.score >= 0.5))
  } finally {
    detector.close()
  }
})
