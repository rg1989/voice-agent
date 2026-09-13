import { parentPort, workerData } from 'node:worker_threads'
import { loadWakeWordFeatures } from './onnx-models.mjs'

function report(error) {
  parentPort.postMessage({ type: 'error', message: error?.message || String(error) })
}

async function handle(features, message) {
  if (message?.type === 'reset') features.reset()
  if (message?.type !== 'audio') return
  const scores = await features.process(new Int16Array(message.samples))
  if (scores.length) {
    parentPort.postMessage({ type: 'scores', generation: message.generation, scores })
  }
}

// Messages are handled strictly in order; the first failure stops the chain.
let queue = loadWakeWordFeatures(workerData.models).then(features => {
  parentPort.postMessage({ type: 'ready' })
  return features
})
queue.catch(report)

parentPort.on('message', message => {
  queue = queue.then(features => handle(features, message).then(
    () => features,
    error => {
      report(error)
      throw error
    },
  ))
  queue.catch(() => {})
})
