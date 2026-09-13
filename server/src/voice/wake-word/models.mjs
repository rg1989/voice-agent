import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// openWakeWord's pre-trained ONNX models are hosted as assets of this release.
export const WAKE_WORD_RELEASE = 'v0.5.1'
const RELEASE_URL = `https://github.com/dscripka/openWakeWord/releases/download/${WAKE_WORD_RELEASE}`
// Female-name classifiers come from a community collection (MIT), pinned to
// one commit; the commit in their file names keeps them apart from release assets.
const COMMUNITY_COMMIT = '8bcd2f20bb7b76c351b2eff871fa1ce873fe9be2'
const COMMUNITY_URL = `https://raw.githubusercontent.com/fwartner/home-assistant-wakewords-collection/${COMMUNITY_COMMIT}/en`

const FEATURE_MODELS = Object.freeze({
  melspectrogram: {
    file: 'melspectrogram.onnx',
    sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
  },
  embedding: {
    file: 'embedding_model.onnx',
    sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
  },
})

export const WAKE_WORD_MODELS = Object.freeze({
  hey_jarvis: {
    file: 'hey_jarvis_v0.1.onnx',
    sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
  },
  hey_lisa: {
    file: 'hey_lisa_8bcd2f20.onnx',
    url: `${COMMUNITY_URL}/hey_lisa/hey_lisa.onnx`,
    sha256: '6f6260aa0ba93941b138e374631d539b6ead160c6737952c30879cd74000e501',
  },
  hey_megan: {
    file: 'hey_megan_8bcd2f20.onnx',
    url: `${COMMUNITY_URL}/hey_megan/hey_megan.onnx`,
    sha256: '3fc86748753c120a75caca05e6568a727d18160311c2c891026752648312bfe7',
  },
  hey_mycroft: {
    file: 'hey_mycroft_v0.1.onnx',
    sha256: 'c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18',
  },
})

export const WAKE_WORDS = Object.freeze(Object.keys(WAKE_WORD_MODELS))

const preparations = new Map()

export function wakeWordModelDirectory(cacheDirectory) {
  return resolve(cacheDirectory, 'wake-word', WAKE_WORD_RELEASE)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(model, target, fetchImpl) {
  const staging = `${target}.${process.pid}-${Date.now()}.partial`
  try {
    const response = await fetchImpl(model.url || `${RELEASE_URL}/${model.file}`)
    if (!response.ok || !response.body) {
      throw new Error(`Wake word model download failed: ${model.file} (HTTP ${response.status})`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(staging, {
      flags: 'wx',
      mode: 0o600,
    }))
    if (await sha256(staging) !== model.sha256) {
      throw new Error(`Wake word model checksum mismatch: ${model.file}`)
    }
    // Only verified files ever appear under their final name.
    renameSync(staging, target)
    return target
  } finally {
    rmSync(staging, { force: true })
  }
}

function ensureFile(directory, model, fetchImpl) {
  const target = resolve(directory, model.file)
  if (existsSync(target)) return Promise.resolve(target)
  if (!preparations.has(target)) {
    preparations.set(target, download(model, target, fetchImpl)
      .finally(() => preparations.delete(target)))
  }
  return preparations.get(target)
}

// Downloads (once) the shared feature models plus the selected classifier and
// returns their absolute paths.
export async function ensureWakeWordModels({
  cacheDirectory,
  wakeWord,
  fetchImpl = fetch,
} = {}) {
  if (!Object.hasOwn(WAKE_WORD_MODELS, wakeWord)) {
    throw new Error(`Unknown wake word: ${wakeWord}`)
  }
  if (!cacheDirectory) throw new Error('Wake word model cache directory is required')
  const directory = wakeWordModelDirectory(cacheDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const [melspectrogram, embedding, classifier] = await Promise.all([
    ensureFile(directory, FEATURE_MODELS.melspectrogram, fetchImpl),
    ensureFile(directory, FEATURE_MODELS.embedding, fetchImpl),
    ensureFile(directory, WAKE_WORD_MODELS[wakeWord], fetchImpl),
  ])
  return { melspectrogram, embedding, classifier }
}
