// Per-connection listening gate for the wake-word mode. While armed, mic
// audio only feeds the local wake-word detector, so nothing reaches (or bills)
// the Realtime provider until the wake word is heard.

export const ListeningState = Object.freeze({
  ALWAYS: 'always',
  ARMED: 'armed',
  AWAKE: 'awake',
})

// Long enough for the flushed pre-roll to hold the whole wake phrase.
const PRE_ROLL_SECONDS = 1.5
const MIN_NO_SPEECH_MS = 6_000
const NO_SPEECH_GRACE_MS = 3_000
const DETECTOR_RETRY_MS = 30_000
// Upper bound for an awake exchange that never settles (no response, a failed
// or dropped one), so the microphone never stays open without a timer.
const AWAKE_SAFETY_MS = 120_000

const STOP_PHRASES = new Set([
  'stop listening',
  'stop listening now',
  'go to sleep',
  'stop',
  'thats all',
  'never mind',
  'nevermind',
  '停止监听',
  '别听了',
  '不用了',
])

const WAKE_WORD_PREFIXES = ['hey jarvis', 'jarvis', 'alexa', 'hey mycroft', 'mycroft']
// Words that may sit around a bare wake word ("Hey Jarvis", "嘿，贾维斯").
const WAKE_WORD_FILLERS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'oh', 'yo', '嘿', '你好', '哈喽'])

// How a transcript may spell each wake word. Deliberately short: looser
// matches ("travis", "jarvi", "microsoft") are exactly the detector's false
// triggers this check has to catch.
const WAKE_WORD_SPELLINGS = Object.freeze({
  hey_jarvis: ['jarvis', 'jervis', 'jarvas', 'jarvus', '嘉维斯', '贾维斯'],
  alexa: ['alexa', 'alexia', 'alexis', '亚莉克莎'],
  hey_mycroft: ['mycroft', 'my croft'],
})

// Case- and punctuation-insensitive. Latin spellings must be whole words;
// Han spellings may sit anywhere, as Chinese text has no spaces.
export function mentionsWakeWord(wakeWord, transcript) {
  const text = ` ${String(transcript || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `
  return (WAKE_WORD_SPELLINGS[wakeWord] || []).some(spelling => (
    /\p{Script=Han}/u.test(spelling)
      ? text.includes(spelling)
      : text.includes(` ${spelling} `)
  ))
}

// True when the transcript is only the wake word, with nothing asked.
export function isWakeWordOnly(wakeWord, transcript) {
  if (!mentionsWakeWord(wakeWord, transcript)) return false
  let text = ` ${String(transcript || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `
  for (const spelling of WAKE_WORD_SPELLINGS[wakeWord]) {
    const pattern = /\p{Script=Han}/u.test(spelling) ? spelling : ` ${spelling} `
    while (text.includes(pattern)) text = text.replace(pattern, ' ')
  }
  return text.split(/\s+/u).filter(Boolean).every(word => WAKE_WORD_FILLERS.has(word))
}

export function isStopListeningPhrase(transcript) {
  let text = String(transcript || '')
    .toLowerCase()
    .replace(/['’`]/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  const prefix = WAKE_WORD_PREFIXES.find(word => text.startsWith(`${word} `))
  if (prefix) text = text.slice(prefix.length + 1)
  return STOP_PHRASES.has(text)
}

// The engine (onnxruntime-web + models) loads only once a connection is armed.
export function createWakeWordDetectorLazily(options) {
  let detector = null
  let closed = false
  const ready = import('./wake-word/index.mjs').then(({ createWakeWordDetector }) => {
    if (closed) return undefined
    detector = createWakeWordDetector(options)
    return detector.ready
  })
  return {
    ready,
    push: audio => detector?.push(audio),
    reset: () => detector?.reset(),
    close: () => {
      closed = true
      detector?.close()
    },
  }
}

export class ListeningGate {
  constructor({
    settings = {},
    createDetector = createWakeWordDetectorLazily,
    cacheDirectory = '',
    passAudio,
    onChange = () => {},
    onError = () => {},
    isBusy = () => false,
    isUserSpeaking = () => false,
    // Called once a wake's pending transcript check ends, with its turn ids:
    // true when the wake word was confirmed, false when it never was.
    onWakeCheckEnd = () => {},
    getSampleRate = () => 16_000,
    logger = null,
  }) {
    this.createDetector = createDetector
    this.cacheDirectory = cacheDirectory
    this.passAudio = passAudio
    this.onChange = onChange
    this.onError = onError
    this.isBusy = isBusy
    this.isUserSpeaking = isUserSpeaking
    this.onWakeCheckEnd = onWakeCheckEnd
    this.getSampleRate = getSampleRate
    this.logger = logger
    this.settings = { ...settings }
    this.state = this.wakeWordMode ? ListeningState.ARMED : ListeningState.ALWAYS
    this.reason = 'connected'
    this.detector = null
    this.detectorRetryAt = 0
    this.preRoll = []
    this.preRollBytes = 0
    this.timer = null
    this.armWhenIdle = false
    // Turns of the current wake still waiting for the wake word check.
    this.wakeCheck = null
    this.closed = false
  }

  get wakeWordMode() {
    return this.settings.listeningMode === 'wake_word'
  }

  // The turn belongs to a wake whose wake word is not confirmed yet.
  awaitsWakeCheck(turnId) {
    return Boolean(turnId && this.wakeCheck?.turnIds.has(turnId))
  }

  status() {
    return {
      state: this.state,
      reason: this.reason,
      wakeWord: this.settings.wakeWord || '',
    }
  }

  applySettings(next = {}) {
    const previous = this.settings
    this.settings = { ...next }
    if (!this.wakeWordMode) {
      this.#clearTimer()
      this.armWhenIdle = false
      this.#endWakeCheck(false)
      this.#closeDetector()
      this.#clearPreRoll()
      if (this.state !== ListeningState.ALWAYS) {
        this.#transition(ListeningState.ALWAYS, 'mode_changed')
      }
      return
    }
    if (this.state === ListeningState.ALWAYS) {
      if (!this.isBusy()) {
        this.arm('mode_changed')
        return
      }
      // Let the current exchange finish, then arm.
      this.armWhenIdle = true
      this.#transition(ListeningState.AWAKE, 'mode_changed')
      this.#startTimer(this.#noSpeechMs(), 'mode_changed')
      return
    }
    if (previous.wakeWord !== this.settings.wakeWord) {
      this.#closeDetector()
      this.onChange(this.status())
    }
  }

  append(audio) {
    if (this.state !== ListeningState.ARMED) {
      this.passAudio(audio)
      return
    }
    this.#remember(audio)
    this.#ensureDetector()?.push(audio)
  }

  speechStarted(turnId = '') {
    this.#startSafetyTimer()
    // Only speech that starts after the detection is checked.
    if (turnId) this.wakeCheck?.turnIds.add(turnId)
  }

  responseStarted() {
    this.#startSafetyTimer()
  }

  // Nothing to answer yet (a bare wake word): wait for the request again.
  keepListening() {
    if (this.state === ListeningState.AWAKE) this.#startTimer(this.#noSpeechMs(), 'no_speech')
  }

  // The assistant's response has truly ended and no tool follow-up is pending.
  responseSettled() {
    if (this.state !== ListeningState.AWAKE || this.isUserSpeaking()) return
    if (this.armWhenIdle) {
      this.arm('mode_changed')
      return
    }
    this.#startTimer(this.settings.followUpSeconds * 1000, 'follow_up_expired')
  }

  // Re-arm on request (stop phrase, stop_listening, ignore_input). Only
  // meaningful in wake_word mode.
  stop(reason) {
    if (!this.wakeWordMode) return false
    this.arm(reason)
    return true
  }

  // Second check on top of the detector: the first completed transcript of a
  // wake must name the wake word. Later turns of the same wake need no wake
  // word. False means a false wake, which the caller cancels and re-arms as
  // 'unverified'.
  verifyTranscript(turnId, transcript) {
    if (!this.wakeCheck?.turnIds.has(turnId)) return true
    if (!mentionsWakeWord(this.wakeCheck.wakeWord, transcript)) return false
    this.#endWakeCheck(true)
    return true
  }

  arm(reason) {
    this.#clearTimer()
    this.armWhenIdle = false
    this.#clearPreRoll()
    // New generation: a detection already on its way is dropped.
    this.detector?.reset()
    this.#endWakeCheck(false)
    if (this.state === ListeningState.ARMED) return
    this.#transition(ListeningState.ARMED, reason)
  }

  close() {
    this.closed = true
    this.wakeCheck = null
    this.#clearTimer()
    this.#closeDetector()
    this.#clearPreRoll()
  }

  #noSpeechMs() {
    return Math.max(
      MIN_NO_SPEECH_MS,
      (Number(this.settings.followUpSeconds) || 0) * 1000 + NO_SPEECH_GRACE_MS,
    )
  }

  #endWakeCheck(verified) {
    const check = this.wakeCheck
    if (!check) return
    this.wakeCheck = null
    this.onWakeCheckEnd(verified, [...check.turnIds])
  }

  #startSafetyTimer() {
    if (this.state !== ListeningState.AWAKE) {
      this.#clearTimer()
      return
    }
    this.#clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state !== ListeningState.AWAKE) return
      if (this.isUserSpeaking()) this.#startSafetyTimer()
      else this.arm('no_speech')
    }, AWAKE_SAFETY_MS)
    this.timer.unref?.()
  }

  #wake() {
    if (this.state !== ListeningState.ARMED) return
    const buffered = this.preRoll.map(chunk => chunk.audio)
    this.#clearPreRoll()
    this.wakeCheck = WAKE_WORD_SPELLINGS[this.settings.wakeWord]
      ? { wakeWord: this.settings.wakeWord, turnIds: new Set() }
      : null
    this.#transition(ListeningState.AWAKE, 'wake_word')
    for (const audio of buffered) this.passAudio(audio)
    this.#startTimer(this.#noSpeechMs(), 'no_speech')
  }

  #remember(audio) {
    const bytes = Buffer.isBuffer(audio)
      ? audio.length
      : Buffer.byteLength(String(audio || ''), 'base64')
    this.preRoll.push({ audio, bytes })
    this.preRollBytes += bytes
    // PCM16 mono: two bytes per sample.
    const limit = Math.round(this.getSampleRate() * 2 * PRE_ROLL_SECONDS)
    while (this.preRoll.length > 1 && this.preRollBytes - this.preRoll[0].bytes >= limit) {
      this.preRollBytes -= this.preRoll.shift().bytes
    }
  }

  #clearPreRoll() {
    this.preRoll = []
    this.preRollBytes = 0
  }

  #ensureDetector() {
    if (this.detector || this.closed) return this.detector
    if (Date.now() < this.detectorRetryAt) return null
    let detector = null
    try {
      detector = this.createDetector({
        wakeWord: this.settings.wakeWord,
        cacheDirectory: this.cacheDirectory,
        onDetected: () => {
          if (this.detector === detector) this.#wake()
        },
        onError: error => {
          if (this.detector === detector) this.#detectorFailed(error)
        },
        logger: this.logger,
      })
    } catch (error) {
      this.#detectorFailed(error)
      return null
    }
    this.detector = detector
    Promise.resolve(detector.ready).catch(error => {
      if (this.detector === detector) this.#detectorFailed(error)
    })
    return detector
  }

  #detectorFailed(error) {
    this.logger?.warn?.('wake_word.detector_failed', {
      error: String(error?.message || error),
    })
    this.#closeDetector()
    // Do not rebuild (and re-download) on every audio chunk.
    this.detectorRetryAt = Date.now() + DETECTOR_RETRY_MS
    this.onError(error)
  }

  #closeDetector() {
    const detector = this.detector
    this.detector = null
    try {
      detector?.close()
    } catch {
      // A failing close must not break the connection.
    }
  }

  #startTimer(ms, reason) {
    this.#clearTimer()
    if (ms <= 0) {
      this.arm(reason)
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.state === ListeningState.AWAKE) this.arm(reason)
    }, ms)
    this.timer.unref?.()
  }

  #clearTimer() {
    clearTimeout(this.timer)
    this.timer = null
  }

  #transition(state, reason) {
    this.state = state
    this.reason = reason
    this.onChange(this.status())
  }
}
