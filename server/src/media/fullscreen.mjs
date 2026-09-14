import { DevToolsPipeError } from './devtools-pipe.mjs'

// Makes the player's own video full screen once it plays.
//
// The kiosk window already fills the screen, but YouTube and Netflix still
// draw their normal page around the video, and a page may enter full screen
// only from a user gesture. The gateway supplies one over its private
// DevTools pipe (devtools-pipe.mjs): Runtime.evaluate with userGesture gives
// the page transient activation, and the page script uses it at once.
//
// Each attempt runs these steps, each only while nothing is full screen yet:
// 1. click the site's own full-screen button, so the site's layout and state
//    follow full screen;
// 2. press the site's documented `f` key (skipped while focus is in a text
//    field, where it would type an f, and never while full screen, because f
//    toggles);
// 3. requestFullscreen() on the site's player element (the whole page on
//    Netflix).
// The selectors are site internals that change without notice. A missing one
// only moves on to the next step.
//
// Best effort: nothing here throws into the player. Failures are logged and
// the video keeps playing in the kiosk window. After the user leaves full
// screen (Esc) it stays that way for the rest of that video; the next video
// on the page (a new watch URL) gets full screen again if it dropped.

export const FULLSCREEN_TIMING = Object.freeze({
  pollMs: 500,
  playDeadlineMs: 45_000,
  attempts: 3,
  retryMs: 2000,
  keySettleMs: 1000,
})

const F_KEY = Object.freeze({ key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com'])

// Runs inside the player page and is sent as source text, so it must not use
// anything from this module. 'state' only reads. 'button' and 'element'
// request full screen once, synchronously, before the first await, while the
// DevTools user gesture is still valid. On any host other than the player's
// it returns at once without touching the page.
async function pageAction(mode) {
  const services = {
    'www.youtube.com': 'youtube',
    'youtube.com': 'youtube',
    'm.youtube.com': 'youtube',
    'music.youtube.com': 'youtube_music',
    'www.netflix.com': 'netflix',
  }
  const controls = {
    youtube: { button: '#movie_player .ytp-fullscreen-button', element: '#movie_player' },
    youtube_music: { button: null, element: 'ytmusic-player' },
    netflix: { button: '[data-uia="control-fullscreen-enter"]', element: ':root' },
  }
  const service = location.protocol === 'https:' ? services[location.hostname] || null : null
  if (!service) {
    return { service: null, hasVideo: false, playing: false, fullscreen: false, typing: false, method: null }
  }
  const playingVideo = () => Array.from(document.querySelectorAll('video'))
    .find(video => !video.paused && video.readyState >= 2 && video.currentTime > 0) || null
  const read = method => {
    const active = document.activeElement
    return {
      service,
      hasVideo: document.querySelectorAll('video').length > 0,
      playing: Boolean(playingVideo()),
      fullscreen: Boolean(document.fullscreenElement),
      typing: Boolean(active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''))),
      method,
    }
  }
  const settle = ms => new Promise(resolve => {
    if (document.fullscreenElement) {
      resolve()
      return
    }
    let timer = null
    const done = () => {
      clearTimeout(timer)
      document.removeEventListener('fullscreenchange', done)
      resolve()
    }
    document.addEventListener('fullscreenchange', done)
    timer = setTimeout(done, ms)
  })
  const before = read(null)
  if (mode === 'state' || !before.playing || before.fullscreen) return before
  if (mode === 'button') {
    const button = controls[service].button ? document.querySelector(controls[service].button) : null
    if (!button) return read('button_missing')
    button.click()
    await settle(1500)
    return read('button')
  }
  if (mode === 'element') {
    const video = playingVideo()
    const element = document.querySelector(controls[service].element) || video.parentElement || video
    try {
      await Promise.race([element.requestFullscreen(), settle(1500)])
    } catch (error) {
      return { ...read('element'), error: String((error && error.name) || error) }
    }
    return read('element')
  }
  return before
}

export const PAGE_SCRIPTS = Object.freeze(Object.fromEntries(
  ['state', 'button', 'element'].map(mode => [mode, `(${pageAction})(${JSON.stringify(mode)})`]),
))

const SCRIPT_MODES = new Map(Object.entries(PAGE_SCRIPTS).map(([mode, expression]) => [expression, mode]))

function hasExactly(params, keys) {
  const own = Object.keys(params)
  return own.length === keys.length && keys.every(key => Object.hasOwn(params, key))
}

// Every command the gateway may send on the player's pipe, checked by
// DevToolsPipe.send() before anything is written. Nothing here reads cookies,
// storage or network traffic, opens pages or targets, and the page only ever
// runs PAGE_SCRIPTS. Target commands and Browser.close go to the browser; the
// rest need the player page's session. Browser.close is how the player stops
// the browser (player.mjs): Chromium then exits without running beforeunload,
// so a site's "Leave site?" dialog cannot hold the stop, as SIGTERM can on
// macOS before Chrome 154.
export function playerCommandAllowed(method, params, { sessionId = null } = {}) {
  if (!params || typeof params !== 'object') return false
  const onBrowser = !sessionId
  switch (method) {
    case 'Target.setDiscoverTargets':
      return onBrowser && hasExactly(params, ['discover']) && params.discover === true
    case 'Target.getTargets':
      return onBrowser && hasExactly(params, [])
    case 'Target.attachToTarget':
      return onBrowser && hasExactly(params, ['targetId', 'flatten'])
        && typeof params.targetId === 'string' && params.flatten === true
    case 'Runtime.evaluate': {
      const mode = SCRIPT_MODES.get(params.expression)
      return !onBrowser && Boolean(mode)
        && hasExactly(params, ['expression', 'awaitPromise', 'returnByValue', 'userGesture'])
        && params.awaitPromise === true && params.returnByValue === true
        && params.userGesture === (mode !== 'state')
    }
    case 'Input.dispatchKeyEvent': {
      const isF = params.key === F_KEY.key && params.code === F_KEY.code
        && params.windowsVirtualKeyCode === F_KEY.windowsVirtualKeyCode
      const down = params.type === 'keyDown' && params.text === 'f'
        && hasExactly(params, ['type', 'key', 'code', 'windowsVirtualKeyCode', 'text'])
      const up = params.type === 'keyUp' && hasExactly(params, ['type', 'key', 'code', 'windowsVirtualKeyCode'])
      return !onBrowser && isF && (down || up)
    }
    case 'Browser.close':
      return onBrowser && hasExactly(params, [])
    default:
      return false
  }
}

// Names the video a watch URL plays ('youtube:<id>', 'youtube_music:<id>',
// 'netflix:<id>'), or null for any other page. Extra query parameters and the
// hash do not change it, so a URL update within one video is not a new video.
export function videoKey(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname === 'www.netflix.com') {
    const match = /^\/watch\/([^/]+)/.exec(parsed.pathname)
    return match ? `netflix:${match[1]}` : null
  }
  const id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : null
  if (!id) return null
  if (parsed.hostname === 'music.youtube.com') return `youtube_music:${id}`
  return YOUTUBE_HOSTS.has(parsed.hostname) ? `youtube:${id}` : null
}

// Starts the routine on the player's pipe and returns { dispose() }.
// urlAllowed(url) -> boolean picks the player page among the browser's targets.
export function startPlayerFullscreen({ pipe, logger, urlAllowed, timing = {} }) {
  const routine = new PlayerFullscreen({ pipe, logger, urlAllowed, timing: { ...FULLSCREEN_TIMING, ...timing } })
  routine.start()
  return routine
}

class PlayerFullscreen {
  #pipe
  #logger
  #urlAllowed
  #timing
  #disposed = false
  #targetId = null
  #session = null
  #sessionId = null
  #videoKey = null
  #run = 0
  #timers = new Set()
  #unsubscribe = []

  constructor({ pipe, logger, urlAllowed, timing }) {
    this.#pipe = pipe
    this.#logger = logger
    this.#urlAllowed = urlAllowed
    this.#timing = timing
  }

  start() {
    this.#unsubscribe.push(
      this.#pipe.onEvent(event => this.#onEvent(event)),
      this.#pipe.onClose(reason => {
        if (this.#disposed) return
        this.#logger.info('media.fullscreen.pipe_closed', { reason })
        this.dispose()
      }),
    )
    this.#discover()
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#run += 1
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe()
  }

  // Discovery is needed for Target.targetInfoChanged, which reports the next
  // video; getTargets covers the page that already exists.
  async #discover() {
    try {
      await this.#pipe.send('Target.setDiscoverTargets', { discover: true })
      const { targetInfos = [] } = await this.#pipe.send('Target.getTargets', {})
      for (const info of targetInfos) this.#track(info)
    } catch (error) {
      this.#unavailable(error)
    }
  }

  #onEvent({ method, params }) {
    if (this.#disposed) return
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.#track(params.targetInfo)
    } else if (method === 'Target.targetDestroyed' && params.targetId === this.#targetId) {
      this.#targetId = null
      this.#forgetSession()
    } else if (method === 'Target.detachedFromTarget' && params.sessionId && params.sessionId === this.#sessionId) {
      this.#forgetSession()
    }
  }

  #forgetSession() {
    this.#session = null
    this.#sessionId = null
    this.#videoKey = null
    this.#run += 1
  }

  // The player page is the first page target on a player host. Service
  // workers, iframes and other pages are never attached.
  #track(info) {
    if (!info || info.type !== 'page' || typeof info.targetId !== 'string') return
    if (this.#targetId === null && this.#urlAllowed(info.url)) this.#targetId = info.targetId
    if (info.targetId !== this.#targetId) return
    const key = this.#urlAllowed(info.url) ? videoKey(info.url) : null
    if (key === this.#videoKey) return
    this.#videoKey = key
    this.#run += 1
    if (key) this.#apply(this.#run)
  }

  async #apply(run) {
    const live = () => !this.#disposed && run === this.#run
    try {
      const sessionId = await this.#attach()
      const deadline = Date.now() + this.#timing.playDeadlineMs
      let attempts = 0
      for (;;) {
        if (!live()) return
        const state = await this.#evaluate(sessionId, 'state')
        if (!live()) return
        if (!state?.playing) {
          if (Date.now() >= deadline) {
            this.#logger.warn('media.fullscreen.gave_up', { reason: 'not_playing', service: state?.service ?? null })
            return
          }
          await this.#sleep(this.#timing.pollMs)
          continue
        }
        if (state.fullscreen) {
          this.#entered(state.service, 'already', attempts)
          return
        }
        attempts += 1
        const method = await this.#enter(sessionId, live)
        if (!live()) return
        if (method) {
          this.#entered(state.service, method, attempts)
          return
        }
        if (attempts >= this.#timing.attempts) {
          this.#logger.warn('media.fullscreen.gave_up', { reason: 'refused', service: state.service, attempts })
          return
        }
        await this.#sleep(this.#timing.retryMs)
      }
    } catch (error) {
      if (live()) this.#unavailable(error)
    }
  }

  // One attempt: the site's button, then the f key, then the player element.
  // Returns how full screen was reached, or null.
  async #enter(sessionId, live) {
    const clicked = await this.#evaluate(sessionId, 'button')
    if (!live() || !clicked?.playing) return null
    if (clicked.fullscreen) return clicked.method === 'button' ? 'button' : 'already'
    const before = await this.#evaluate(sessionId, 'state')
    if (!live() || !before?.playing) return null
    if (before.fullscreen) return 'button'
    if (!before.typing) {
      await this.#press(sessionId)
      await this.#sleep(this.#timing.keySettleMs)
      if (!live()) return null
      const after = await this.#evaluate(sessionId, 'state')
      if (!live() || !after?.playing) return null
      if (after.fullscreen) return 'key'
    }
    const requested = await this.#evaluate(sessionId, 'element')
    if (!live() || !requested?.fullscreen) return null
    return requested.method === 'element' ? 'element' : 'already'
  }

  #attach() {
    if (!this.#session) {
      const attaching = this.#pipe.send('Target.attachToTarget', { targetId: this.#targetId, flatten: true })
        .then(({ sessionId }) => {
          if (typeof sessionId !== 'string') {
            throw new DevToolsPipeError('protocol', 'Target.attachToTarget returned no sessionId')
          }
          this.#sessionId = sessionId
          return sessionId
        })
      attaching.catch(() => {
        if (this.#session === attaching) this.#session = null
      })
      this.#session = attaching
    }
    return this.#session
  }

  async #evaluate(sessionId, mode) {
    const reply = await this.#call('Runtime.evaluate', {
      expression: PAGE_SCRIPTS[mode],
      awaitPromise: true,
      returnByValue: true,
      userGesture: mode !== 'state',
    }, sessionId)
    if (!reply || reply.exceptionDetails) return null
    return reply.result?.value ?? null
  }

  async #press(sessionId) {
    await this.#call('Input.dispatchKeyEvent', { type: 'keyDown', ...F_KEY, text: 'f' }, sessionId)
    await this.#call('Input.dispatchKeyEvent', { type: 'keyUp', ...F_KEY }, sessionId)
  }

  // A timeout or a protocol error (a navigation destroying the page's context
  // mid-call) fails only this step. A closed pipe or a refused command ends
  // the run.
  async #call(method, params, sessionId) {
    try {
      return await this.#pipe.send(method, params, { sessionId })
    } catch (error) {
      if (error?.code === 'closed' || error?.code === 'not_allowed') throw error
      return null
    }
  }

  #sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        resolve()
      }, ms)
      timer.unref?.()
      this.#timers.add(timer)
    })
  }

  #entered(service, method, attempt) {
    this.#logger.info('media.fullscreen.entered', { service, method, attempt })
  }

  #unavailable(error) {
    if (this.#disposed || error?.code === 'closed') return
    this.#logger.warn('media.fullscreen.unavailable', {
      reason: this.#pipe.refusal || error?.code || 'error',
      error: String(error?.message || error),
    })
  }
}
