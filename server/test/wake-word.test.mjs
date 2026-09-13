import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  WAKE_WORD_REFRACTORY_FRAMES,
  WakeWordTrigger,
  pcm16Samples,
} from '../src/voice/wake-word/detector.mjs'
import { WakeWordFeatures, noiseSamples } from '../src/voice/wake-word/features.mjs'
import {
  WAKE_WORD_MODELS,
  ensureWakeWordModels,
  wakeWordModelDirectory,
} from '../src/voice/wake-word/models.mjs'

// Fake runners: mel call k fills every row with 10k (transformed to k + 2),
// embeddings from init are numbered by row, later ones are 100 + frame.
function fakeFeatures({ score = 0.9 } = {}) {
  const calls = { mel: [], embed: [], classify: [] }
  const features = new WakeWordFeatures({
    melspectrogram: async samples => {
      calls.mel.push(Array.from(samples))
      const frames = Math.ceil(samples.length / 160 - 3)
      return new Float32Array(frames * 32).fill(10 * (calls.mel.length - 1))
    },
    embed: async (windows, batch) => {
      calls.embed.push({ windows: Array.from(windows), batch })
      const output = new Float32Array(batch * 96)
      for (let row = 0; row < batch; row += 1) {
        output.fill(calls.embed.length === 1 ? row : 100 + calls.embed.length - 1, row * 96, (row + 1) * 96)
      }
      return output
    },
    classify: async embeddings => {
      calls.classify.push(Array.from(embeddings))
      return score
    },
  })
  return { calls, features }
}

const rows = (values, size) => Array.from(
  { length: values.length / size },
  (_, index) => values[index * size],
)
const ramp = (start, length) => Int16Array.from({ length }, (_, index) => start + index)

test('seeds the embedding history from 4 s of noise windowed every 8 mel frames', async () => {
  const { calls, features } = fakeFeatures()
  await features.init()
  assert.equal(calls.mel[0].length, 64_000)
  assert.ok(calls.mel[0].every(value => Number.isInteger(value) && value >= -1000 && value < 1000))
  // 397 mel frames -> windows starting at 0, 8, ... 320.
  assert.equal(calls.embed[0].batch, 41)
  assert.equal(calls.embed[0].windows.length, 41 * 76 * 32)
  assert.deepEqual(noiseSamples(), noiseSamples())
})

test('frames audio into 1280-sample chunks with 480 samples of mel context', async () => {
  const { calls, features } = fakeFeatures()
  await features.init()
  assert.deepEqual(await features.process(ramp(0, 1000)), [])
  assert.equal((await features.process(ramp(1000, 500))).length, 1)
  assert.equal((await features.process(ramp(1500, 2000))).length, 1)
  // The first chunk has no history; later chunks prepend the previous 3 hops.
  assert.deepEqual(calls.mel.slice(1).map(input => [input.length, input[0]]), [
    [1280, 0],
    [1760, 800],
  ])
  // Mel buffer starts as 76 rows of ones; new rows are transformed x / 10 + 2.
  assert.deepEqual(rows(calls.embed[1].windows, 32), [
    ...Array(71).fill(1),
    ...Array(5).fill(3),
  ])
  assert.deepEqual(rows(calls.embed[2].windows, 32), [
    ...Array(63).fill(1),
    ...Array(5).fill(3),
    ...Array(8).fill(4),
  ])
  // Classifier sees the newest 16 embeddings, oldest first.
  assert.deepEqual(rows(calls.classify[1], 96), [
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 101, 102,
  ])
})

test('reports zero for the first five predictions after init and reset', async () => {
  const { calls, features } = fakeFeatures({ score: 0.8 })
  await features.init()
  const scores = await features.process(new Int16Array(1280 * 7))
  assert.deepEqual(scores, [0, 0, 0, 0, 0, 0.8, 0.8])

  await features.process(new Int16Array(600))
  features.reset()
  assert.deepEqual(await features.process(new Int16Array(1280 * 6)), [0, 0, 0, 0, 0, 0.8])
  // Reset drops the partial chunk and the mel context.
  assert.equal(calls.mel[8].length, 1280)
  assert.deepEqual(rows(calls.embed[8].windows, 32), [...Array(71).fill(1), ...Array(5).fill(10)])
  assert.deepEqual(rows(calls.classify[7], 96).slice(-2), [40, 108])
})

test('fires only on consecutive frames above threshold, then waits out the refractory period', () => {
  const trigger = new WakeWordTrigger()
  assert.equal(WAKE_WORD_REFRACTORY_FRAMES, 25)
  assert.deepEqual([0.9, 0.1, 0.7, 0.4, 0.5].map(score => trigger.accept(score)), [
    false, false, false, false, false,
  ])
  assert.equal(trigger.accept(0.5), true)
  for (let frame = 0; frame < 25; frame += 1) assert.equal(trigger.accept(1), false)
  assert.equal(trigger.accept(1), false)
  assert.equal(trigger.accept(1), true)

  trigger.accept(1)
  trigger.reset()
  assert.equal(trigger.accept(1), false)
  assert.equal(trigger.accept(1), true)
})

test('decodes little-endian PCM16 from base64 or bytes and drops a trailing odd byte', () => {
  const bytes = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x07])
  assert.deepEqual(Array.from(pcm16Samples(bytes.toString('base64'))), [1, 32767, -32768])
  assert.deepEqual(Array.from(pcm16Samples(new Uint8Array(bytes).subarray(2))), [32767, -32768])
})

test('uses cached wake word models without downloading', async () => {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-wake-word-'))
  try {
    const directory = wakeWordModelDirectory(cacheDirectory)
    mkdirSync(directory, { recursive: true })
    for (const file of ['melspectrogram.onnx', 'embedding_model.onnx', WAKE_WORD_MODELS.hey_lisa.file]) {
      writeFileSync(join(directory, file), 'model')
    }
    const models = await ensureWakeWordModels({
      cacheDirectory,
      wakeWord: 'hey_lisa',
      fetchImpl: () => assert.fail('must not download'),
    })
    assert.deepEqual(models, {
      melspectrogram: join(directory, 'melspectrogram.onnx'),
      embedding: join(directory, 'embedding_model.onnx'),
      classifier: join(directory, 'hey_lisa_8bcd2f20.onnx'),
    })
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true })
  }
})

test('rejects unknown wake words and downloads that fail verification', async () => {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-wake-word-'))
  try {
    await assert.rejects(
      ensureWakeWordModels({ cacheDirectory, wakeWord: 'hey_siri' }),
      /Unknown wake word/,
    )
    const requested = []
    await assert.rejects(ensureWakeWordModels({
      cacheDirectory,
      wakeWord: 'hey_jarvis',
      fetchImpl: async url => {
        requested.push(url)
        return url.endsWith('embedding_model.onnx')
          ? new Response('missing', { status: 404 })
          : new Response('tampered')
      },
    }), /checksum mismatch|HTTP 404/)
    assert.equal(requested.length, 3)
    assert.ok(requested.every(url => url.startsWith(
      'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/',
    )))
    const directory = wakeWordModelDirectory(cacheDirectory)
    assert.ok(existsSync(directory))
    assert.deepEqual(readdirSync(directory), [])

    // Community classifiers come from their pinned commit.
    await assert.rejects(ensureWakeWordModels({
      cacheDirectory,
      wakeWord: 'hey_megan',
      fetchImpl: async url => {
        requested.push(url)
        return new Response('missing', { status: 404 })
      },
    }), /HTTP 404/)
    assert.ok(requested.includes('https://raw.githubusercontent.com/fwartner/home-assistant-wakewords-collection/8bcd2f20bb7b76c351b2eff871fa1ce873fe9be2/en/hey_megan/hey_megan.onnx'))
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true })
  }
})
