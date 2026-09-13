import { Worker } from 'node:worker_threads'
import { FRAME_SAMPLES, SAMPLE_RATE } from './features.mjs'
import { ensureWakeWordModels } from './models.mjs'

export const WAKE_WORD_THRESHOLD = 0.5
export const WAKE_WORD_PATIENCE_FRAMES = 2
export const WAKE_WORD_REFRACTORY_FRAMES = Math.round(2 * SAMPLE_RATE / FRAME_SAMPLES)

// Fires when the score reaches the threshold on consecutive frames, then
// ignores the following frames for the refractory period (counted in audio
// frames, so bursty delivery does not change it).
export class WakeWordTrigger {
  constructor({
    threshold = WAKE_WORD_THRESHOLD,
    patience = WAKE_WORD_PATIENCE_FRAMES,
    refractoryFrames = WAKE_WORD_REFRACTORY_FRAMES,
  } = {}) {
    this.threshold = threshold
    this.patience = patience
    this.refractoryFrames = refractoryFrames
    this.reset()
  }

  accept(score) {
    if (this.refractory > 0) {
      this.refractory -= 1
      return false
    }
    this.streak = score >= this.threshold ? this.streak + 1 : 0
    if (this.streak < this.patience) return false
    this.streak = 0
    this.refractory = this.refractoryFrames
    return true
  }

  reset() {
    this.streak = 0
    this.refractory = 0
  }
}

// 16 kHz mono PCM16LE as base64 or bytes; an incomplete trailing byte is dropped.
export function pcm16Samples(audio) {
  const bytes = typeof audio === 'string'
    ? Buffer.from(audio, 'base64')
    : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  const samples = new Int16Array(bytes.length >> 1)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2)
  }
  return samples
}

export function createWakeWordDetector({
  wakeWord,
  cacheDirectory,
  onDetected,
  onError,
  logger,
} = {}) {
  const trigger = new WakeWordTrigger()
  let worker = null
  let closed = false
  let generation = 0
  let settle = null

  function stop() {
    closed = true
    const current = worker
    worker = null
    current?.terminate()
  }

  function fail(error) {
    if (closed) return
    stop()
    logger?.warn?.('wake_word.failed', { wakeWord, error: error?.message || String(error) })
    settle?.(error)
    onError?.(error)
  }

  function receive(current, message) {
    if (message?.type === 'ready') settle?.()
    if (message?.type === 'error') fail(new Error(message.message))
    if (message?.type !== 'scores') return
    for (const score of message.scores) {
      // onDetected may reset or close the detector mid-batch.
      if (current !== worker || message.generation !== generation) return
      if (!trigger.accept(score)) continue
      logger?.info?.('wake_word.detected', { wakeWord, score })
      onDetected?.({ wakeWord, score })
    }
  }

  const ready = ensureWakeWordModels({ cacheDirectory, wakeWord })
    .then(models => new Promise((resolve, reject) => {
      if (closed) {
        resolve()
        return
      }
      settle = error => {
        settle = null
        if (error) reject(error)
        else resolve()
      }
      const current = new Worker(new URL('./worker.mjs', import.meta.url), {
        workerData: { models },
      })
      worker = current
      current.on('message', message => {
        if (current === worker) receive(current, message)
      })
      current.on('error', error => {
        if (current === worker) fail(error)
      })
      current.on('exit', code => {
        if (current === worker) fail(new Error(`Wake word worker exited with code ${code}`))
      })
    }))
  // Failures are reported through onError; keep an unobserved ready quiet.
  ready.catch(fail)

  return {
    ready,
    push(audio) {
      if (!worker || !audio) return
      const samples = pcm16Samples(audio)
      if (!samples.length) return
      worker.postMessage(
        { type: 'audio', generation, samples: samples.buffer },
        [samples.buffer],
      )
    },
    reset() {
      generation += 1
      trigger.reset()
      worker?.postMessage({ type: 'reset' })
    },
    close() {
      if (closed) return
      stop()
      settle?.()
    },
  }
}
