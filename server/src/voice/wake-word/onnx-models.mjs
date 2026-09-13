import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web'
import {
  EMBEDDING_SIZE,
  EMBEDDING_WINDOW,
  MEL_BINS,
  WakeWordFeatures,
} from './features.mjs'

// Pure WASM backend on a single thread: no native addon, identical on
// Linux x64 and macOS arm64.
ort.env.wasm.numThreads = 1
ort.env.logLevel = 'error'

async function loadModel(path) {
  const session = await ort.InferenceSession.create(readFileSync(path), {
    executionProviders: ['wasm'],
  })
  const [input] = session.inputNames
  const [output] = session.outputNames
  return {
    session,
    async run(data, dims) {
      const outputs = await session.run({ [input]: new ort.Tensor('float32', data, dims) })
      return outputs[output].data
    },
  }
}

export async function loadWakeWordFeatures({ melspectrogram, embedding, classifier }) {
  const mel = await loadModel(melspectrogram)
  const embed = await loadModel(embedding)
  const classify = await loadModel(classifier)
  // Classifier input is [1, featureFrames, 96].
  const featureFrames = classify.session.inputMetadata?.[0]?.shape?.[1]
  const frames = Number.isInteger(featureFrames) ? featureFrames : 16
  const features = new WakeWordFeatures({
    melspectrogram: samples => mel.run(samples, [1, samples.length]),
    embed: (windows, batch) => embed.run(windows, [batch, EMBEDDING_WINDOW, MEL_BINS, 1]),
    classify: async embeddings => (await classify.run(embeddings, [1, frames, EMBEDDING_SIZE]))[0],
    featureFrames: frames,
  })
  await features.init()
  return features
}
