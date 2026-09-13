// Streaming port of openWakeWord's AudioFeatures (openwakeword/utils.py) and
// Model.predict fed with 80 ms chunks. The ONNX runners are injected so the
// framing can be tested without models:
//   melspectrogram(Float32Array samples) -> Float32Array frames * 32
//   embed(Float32Array batch * 76 * 32, batch) -> Float32Array batch * 96
//   classify(Float32Array featureFrames * 96) -> score

export const SAMPLE_RATE = 16_000
export const FRAME_SAMPLES = 1280
// The melspectrogram of each chunk also sees the previous 3 hops of audio.
export const MEL_CONTEXT_SAMPLES = 160 * 3
export const MEL_BINS = 32
export const EMBEDDING_WINDOW = 76
export const EMBEDDING_STEP = 8
export const EMBEDDING_SIZE = 96
const NOISE_SAMPLES = SAMPLE_RATE * 4
// openWakeWord reports 0 until five predictions have been made.
const WARMUP_PREDICTIONS = 5

// openWakeWord seeds the embedding history with 4 s of random noise in
// [-1000, 1000); a fixed-seed PRNG (mulberry32) keeps that reproducible.
export function noiseSamples(length = NOISE_SAMPLES, seed = 0x5eed) {
  let state = seed >>> 0
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    samples[index] = Math.floor((((value ^ (value >>> 14)) >>> 0) / 4294967296) * 2000) - 1000
  }
  return samples
}

function transformMel(frames) {
  for (let index = 0; index < frames.length; index += 1) {
    frames[index] = frames[index] / 10 + 2
  }
  return frames
}

function pushRows(buffer, rows, rowSize) {
  const added = Math.min(rows.length, buffer.length)
  buffer.copyWithin(0, added)
  buffer.set(rows.subarray(rows.length - added), buffer.length - added)
  return Math.floor(added / rowSize)
}

export class WakeWordFeatures {
  #melspectrogram
  #embed
  #classify
  #featureFrames
  #initialEmbeddings = null
  #pending = new Int16Array(0)
  #context = new Float32Array(0)
  #mel = null
  #embeddings = null
  #predictions = 0

  constructor({ melspectrogram, embed, classify, featureFrames = 16 }) {
    this.#melspectrogram = melspectrogram
    this.#embed = embed
    this.#classify = classify
    this.#featureFrames = featureFrames
  }

  async init() {
    const frames = transformMel(await this.#melspectrogram(noiseSamples()))
    const windowSize = EMBEDDING_WINDOW * MEL_BINS
    const count = Math.floor(frames.length / MEL_BINS)
    const starts = []
    for (let start = 0; start + EMBEDDING_WINDOW <= count; start += EMBEDDING_STEP) {
      starts.push(start)
    }
    const batch = new Float32Array(starts.length * windowSize)
    starts.forEach((start, index) => {
      batch.set(frames.subarray(start * MEL_BINS, start * MEL_BINS + windowSize), index * windowSize)
    })
    const embeddings = await this.#embed(batch, starts.length)
    this.#initialEmbeddings = new Float32Array(this.#featureFrames * EMBEDDING_SIZE)
    pushRows(this.#initialEmbeddings, embeddings, EMBEDDING_SIZE)
    this.reset()
  }

  // Same as AudioFeatures.reset + Model.reset: forget audio, mel frames,
  // embeddings and the warm-up count.
  reset() {
    this.#pending = new Int16Array(0)
    this.#context = new Float32Array(0)
    this.#mel = new Float32Array(EMBEDDING_WINDOW * MEL_BINS).fill(1)
    this.#embeddings = this.#initialEmbeddings.slice()
    this.#predictions = 0
  }

  // Returns one score per completed 1280-sample frame.
  async process(samples) {
    const pending = new Int16Array(this.#pending.length + samples.length)
    pending.set(this.#pending)
    pending.set(samples, this.#pending.length)
    const scores = []
    let offset = 0
    for (; pending.length - offset >= FRAME_SAMPLES; offset += FRAME_SAMPLES) {
      scores.push(await this.#frame(pending.subarray(offset, offset + FRAME_SAMPLES)))
    }
    this.#pending = pending.slice(offset)
    return scores
  }

  async #frame(frame) {
    const input = new Float32Array(this.#context.length + frame.length)
    input.set(this.#context)
    input.set(frame, this.#context.length)
    this.#context = input.slice(-MEL_CONTEXT_SAMPLES)
    pushRows(this.#mel, transformMel(await this.#melspectrogram(input)), MEL_BINS)
    const embedding = await this.#embed(this.#mel.slice(), 1)
    pushRows(this.#embeddings, embedding.subarray(0, EMBEDDING_SIZE), EMBEDDING_SIZE)
    const score = await this.#classify(this.#embeddings.slice())
    this.#predictions += 1
    return this.#predictions <= WARMUP_PREDICTIONS ? 0 : score
  }
}
