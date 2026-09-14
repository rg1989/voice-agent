import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MEDIA_BROWSER_IDS } from '../core/live-settings.mjs'
import { logger as defaultLogger } from '../core/logger.mjs'
import { detectPlayerBrowsers, playerLaunchArgs, resolvePlayerBrowser } from './browsers.mjs'
import { DEVTOOLS_PIPE_STDIO, DevToolsPipe } from './devtools-pipe.mjs'
import { playerCommandAllowed, startPlayerFullscreen } from './fullscreen.mjs'
import { MediaError } from './media-error.mjs'
import {
  AppServices,
  APP_SERVICE_IDS,
  spotifyUri,
  stremioDetailUrl,
} from './app-services.mjs'
import { createTransport } from './transport.mjs'

export { MediaError }

export const PLAYER_BROWSER_IDS = MEDIA_BROWSER_IDS
export const PLAYER_SETUP_URL = 'https://www.youtube.com'

const PLAYER_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.netflix.com',
])
const execFileAsync = promisify(execFile)
const STOP_TIMEOUT_MS = 10_000
// Browser.close gets this long to end the browser before SIGTERM; its reply is
// waited for at most CLOSE_REPLY_TIMEOUT_MS of that.
const CLOSE_GRACE_MS = 3000
const CLOSE_REPLY_TIMEOUT_MS = 1000
const LEFTOVER_POLL_MS = 250
const PS_TIMEOUT_MS = 5000
const TRANSPORT_METHODS = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  next: 'next',
  previous: 'previous',
  seek_relative: 'seekRelative',
})

export function playerUrlAllowed(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    return false
  }
  return parsed.protocol === 'https:'
    && PLAYER_HOSTS.has(parsed.hostname)
    && !parsed.port
    && !parsed.username
    && !parsed.password
}

function exitsWithin(current, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms)
    current.exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// Only the gateway holds these socket ends: they are close-on-exec in this
// process, so nothing it starts later inherits them, and the pipe has no port
// or path another local process could connect to.
function openPipe(child) {
  const [, , stderr, toBrowser, fromBrowser] = child.stdio || []
  if (!toBrowser || !fromBrowser) return null
  return new DevToolsPipe({ toBrowser, fromBrowser, stderr, allow: playerCommandAllowed })
}

// One browser process for the whole Gateway. Playback runs it in kiosk mode
// with a private DevTools pipe the gateway uses to make the video full screen
// and to close the browser without beforeunload prompts; setup() runs the
// same profile in a normal window, without the pipe (so it stops by signal), for the
// one-time sign-in. Both share the slot, because Chromium allows one process
// per profile folder.
export class MediaPlayer extends EventEmitter {
  #getSettings
  #configDir
  #platform
  #spawn
  #execFileImpl
  #logger
  #detectBrowsers
  #stopTimeoutMs
  #closeGraceMs
  #readLink
  #kill
  #fullscreen
  #current = null
  // The playback that #stopCurrent is closing over DevTools. It is no longer
  // #current, but killNow must still reach it while the grace period runs.
  #closing = null
  #queue = Promise.resolve()
  // Spotify and Stremio run in their own apps (see app-services.mjs).
  #apps
  #appPlayback = null
  #userControlSerial = 0

  constructor({
    getSettings,
    configDir,
    platform = process.platform,
    spawnImpl = spawn,
    execFileImpl = execFileAsync,
    logger = defaultLogger,
    appServices = null,
    detectBrowsers = detectPlayerBrowsers,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    closeGraceMs = CLOSE_GRACE_MS,
    readLinkImpl = readlinkSync,
    killImpl = (pid, signal) => process.kill(pid, signal),
    fullscreenImpl = startPlayerFullscreen,
  } = {}) {
    super()
    this.#getSettings = getSettings
    this.#configDir = configDir
    this.#platform = platform
    this.#spawn = spawnImpl
    this.#execFileImpl = execFileImpl
    this.#logger = logger
    this.#detectBrowsers = detectBrowsers
    this.#stopTimeoutMs = stopTimeoutMs
    this.#closeGraceMs = closeGraceMs
    this.#apps = appServices || new AppServices({ platform })
    this.#readLink = readLinkImpl
    this.#kill = killImpl
    this.#fullscreen = fullscreenImpl
  }

  play({ url, title = null, service } = {}) {
    // App services share the queue, so play, setup and stop still run one at
    // a time in call order.
    if (APP_SERVICE_IDS.includes(service)) {
      return this.#serialize(() => this.#playInApp({ url, title, service }))
    }
    return this.#serialize(async () => {
      if (!playerUrlAllowed(url)) {
        throw new MediaError('url_not_allowed', `the player does not open ${String(url)}`)
      }
      const browser = this.#browser()
      // Spotify is paused only once the link and the browser passed their checks.
      if (this.#appPlayback) await this.#stopApp('replaced')
      await this.#stopCurrent('replaced')
      await this.#launch({ browser, url, kind: 'playback', title, service })
      this.emit('started', this.state())
      this.#startFullscreen(this.#current)
      return { status: 'playing', title, url, service, browser: browser.id }
    })
  }

  setup() {
    return this.#serialize(async () => {
      const browser = this.#browser()
      await this.#stopCurrent('replaced')
      await this.#launch({ browser, url: PLAYER_SETUP_URL, kind: 'setup' })
      return { status: 'opened', browser: browser.id }
    })
  }

  stop({ reason = 'user' } = {}) {
    return this.#serialize(async () => {
      if (this.#appPlayback) return this.#stopApp(reason)
      return await this.#stopCurrent(reason) ? { status: 'stopped' } : { status: 'idle' }
    })
  }

  // source 'talk_pause' marks MediaTalkPause's own pause and resume. Any other
  // pause (voice tool, backend tool) bumps controlSerial: pausing a player that
  // is already paused raises no event, so the serial is how pause while talking
  // learns it must not resume.
  async control(action, { seconds, source } = {}) {
    if (!Object.hasOwn(TRANSPORT_METHODS, action)) {
      throw new TypeError(`unknown media action: ${action}`)
    }
    const current = this.#current
    if (!this.#appPlayback && current?.kind !== 'playback') {
      throw new MediaError('not_playing', 'nothing is playing')
    }
    if (action === 'pause' && source !== 'talk_pause') this.#userControlSerial += 1
    if (this.#appPlayback) return this.#controlApp(action, { seconds, source })
    const transport = createTransport({
      platform: this.#platform,
      pid: current.pid,
      bundleId: current.browser.bundleId,
      execFileImpl: this.#execFileImpl,
    })
    // The record says playing even after the user paused the video in the page
    // or it ended. A talk pause asks the browser first, so the resume at turn
    // end cannot start it again. The record stays as it is: marking it paused
    // would skip the next talk pause once the user resumes in the page.
    if (action === 'pause' && source === 'talk_pause' && !await transport.playing()) {
      throw new MediaError('not_playing', 'the player is not playing')
    }
    await transport[TRANSPORT_METHODS[action]](Number(seconds) || 0)
    if (this.#current === current) {
      if (action === 'pause' && !current.paused) {
        current.paused = true
        this.emit('paused', this.state())
      }
      if (action === 'resume' && current.paused) {
        current.paused = false
        this.emit('resumed', this.state())
      }
    }
    return { status: 'ok', action }
  }

  state() {
    if (this.#appPlayback) return this.#appState()
    const current = this.#current?.kind === 'playback' ? this.#current : null
    return {
      active: Boolean(current),
      paused: Boolean(current?.paused),
      title: current?.title ?? null,
      url: current?.url ?? null,
      service: current?.service ?? null,
      browser: current?.browser.id ?? null,
      pid: current?.pid ?? null,
      startedAt: current?.startedAt ?? null,
      controlSerial: this.#userControlSerial,
    }
  }

  // For a gateway process that is exiting: close() may not have stopped the
  // browser yet, and it must not outlive every way to control it. That
  // includes a browser that got Browser.close but has not exited yet.
  killNow() {
    const current = this.#current ?? this.#closing
    if (current && !current.done) current.child.kill('SIGTERM')
  }

  // Runs inside #serialize, so it never calls the public, serialized stop():
  // that would wait on its own queue forever.
  async #playInApp({ url, title = null, service }) {
    const target = service === 'spotify' ? spotifyUri(url) : stremioDetailUrl(url)
    if (!target) {
      throw new MediaError('url_not_allowed', service === 'spotify'
        ? 'Spotify needs a spotify: URI or an open.spotify.com link'
        : 'Stremio needs a stremio:///detail/<movie|series>/<imdbId>/<imdbId> link')
    }
    if (service === 'spotify') await this.#apps.playSpotify(target)
    else await this.#apps.openStremio(target)
    // End what played before only once the app has taken over, so a failed
    // launch leaves the user's current playback alone.
    const previous = this.#appPlayback
    if (previous) {
      this.#appPlayback = null
      // A new Spotify track already replaced the old one inside the app.
      if (service !== 'spotify') await this.#pauseSpotify()
      this.emit('stopped', { reason: 'replaced', title: previous.title, service: previous.service })
    } else {
      // Ends browser playback or the setup window; does nothing when idle.
      await this.#stopCurrent('replaced')
    }
    if (service === 'stremio') return { status: 'opened', title, url: target, service }
    this.#appPlayback = { title, url: target, service, paused: false, startedAt: Date.now() }
    this.emit('started', this.#appState())
    return { status: 'playing', title, url: target, service, browser: null }
  }

  async #stopApp(reason) {
    const previous = this.#appPlayback
    this.#appPlayback = null
    await this.#pauseSpotify()
    this.emit('stopped', { reason, title: previous.title, service: previous.service })
    return { status: 'stopped' }
  }

  // The user may already have quit Spotify, or the OS may refuse the control;
  // ending playback still succeeds, but the log must say why Spotify may still play.
  async #pauseSpotify() {
    await this.#apps.spotifyControl('pause').catch(error => this.#logger.warn('media.app.pause_failed', {
      code: String(error?.code || ''),
      error: String(error?.message || error),
    }))
  }

  // control() has already bumped #userControlSerial before it calls this, so a
  // pause that finds Spotify paused still stops MediaTalkPause from resuming.
  async #controlApp(action, { seconds, source } = {}) {
    // A new Spotify play() may replace the playback during either await below,
    // so only the playback this call started with is updated, like the
    // browser path.
    const playback = this.#appPlayback
    // #appPlayback is only the Gateway's own record: Spotify paused in the app,
    // or an album that ended, still reads as playing. A talk pause asks Spotify
    // first, so the resume at turn end cannot start what the user had stopped.
    if (action === 'pause' && source === 'talk_pause' && !await this.#apps.spotifyPlaying()) {
      if (this.#appPlayback === playback && !playback.paused) {
        playback.paused = true
        this.emit('paused', this.#appState())
      }
      throw new MediaError('not_playing', 'Spotify is not playing')
    }
    await this.#apps.spotifyControl(action, { seconds })
    if (this.#appPlayback !== playback) return { status: 'ok', action }
    // Report pause changes once, like the browser path.
    if (action === 'pause' && !playback.paused) {
      playback.paused = true
      this.emit('paused', this.#appState())
    }
    if (action === 'resume' && playback.paused) {
      playback.paused = false
      this.emit('resumed', this.#appState())
    }
    return { status: 'ok', action }
  }

  #appState() {
    const { title, url, service, paused, startedAt } = this.#appPlayback
    return {
      active: true,
      paused,
      title,
      url,
      service,
      browser: null,
      pid: null,
      startedAt,
      // The same counter as P1's state(), so MediaTalkPause sees Spotify controls.
      controlSerial: this.#userControlSerial,
    }
  }

  #serialize(work) {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }

  #browser() {
    const setting = this.#getSettings?.()?.mediaBrowser || 'auto'
    const browser = resolvePlayerBrowser(setting, this.#detectBrowsers({ platform: this.#platform }))
    if (browser) return browser
    throw new MediaError(
      'no_browser',
      setting === 'auto' ? 'no supported player browser is installed' : `${setting} is not installed`,
    )
  }

  async #launch({ browser, url, kind, title = null, service = null }) {
    const failed = error => new MediaError('launch_failed', `${browser.label} did not start: ${error.message}`)
    const profileDir = join(this.#configDir, 'player', browser.id)
    const playback = kind === 'playback'
    await this.#stopLeftover(profileDir)
    let child
    try {
      mkdirSync(profileDir, { recursive: true })
      child = this.#spawn(
        browser.binary,
        playerLaunchArgs({ platform: this.#platform, profileDir, url, kiosk: playback, devtoolsPipe: playback }),
        // Playback: fds 3 and 4 carry the DevTools pipe, and stderr is read for
        // the reason Chromium may refuse it. Setup keeps every stdio closed.
        { stdio: playback ? [...DEVTOOLS_PIPE_STDIO] : 'ignore' },
      )
    } catch (error) {
      throw failed(error)
    }
    const current = {
      kind, child, browser, url, title, service, pid: null, paused: false, startedAt: null, done: false,
      pipe: playback ? openPipe(child) : null, fullscreen: null,
    }
    current.exited = new Promise(resolve => {
      child.once('exit', (exitCode, signal) => {
        current.done = true
        this.#releaseControl(current, 'exited')
        resolve({ exitCode, signal })
      })
    })
    await new Promise((resolve, reject) => {
      const onError = error => {
        current.done = true
        this.#releaseControl(current, 'launch_failed')
        reject(failed(error))
      }
      child.once('error', onError)
      child.once('spawn', () => {
        child.off('error', onError)
        resolve()
      })
    })
    child.on('error', error => this.#logger.warn('media.player.error', { error: String(error?.message || error) }))
    current.pid = child.pid
    current.startedAt = Date.now()
    this.#current = current
    current.exited.then(() => this.#exited(current))
    this.#logger.info('media.player.started', { kind, browser: browser.id, pid: child.pid })
  }

  // Best effort and never throws into play(): the video plays either way.
  #startFullscreen(current) {
    if (!current?.pipe || current.done || current.fullscreen) return
    try {
      current.fullscreen = this.#fullscreen({ pipe: current.pipe, logger: this.#logger, urlAllowed: playerUrlAllowed })
    } catch (error) {
      this.#logger.warn('media.fullscreen.error', { error: String(error?.message || error) })
    }
  }

  // Ends the full-screen routine and closes the pipe client, before any signal
  // on stop or replace. The pipe streams are destroyed only once the browser
  // exited: Chromium quits when its fd 3 closes, so they stay open while it runs.
  #releaseControl(current, reason) {
    this.#endFullscreen(current)
    if (!current.pipe) return
    current.pipe.close(reason)
    if (current.done) {
      for (const stream of current.child.stdio?.slice(2) || []) stream?.destroy()
    }
  }

  #exited(current) {
    if (this.#current !== current) return
    this.#current = null
    this.#logger.info('media.player.exited', { kind: current.kind, pid: current.pid })
    if (current.kind === 'playback') {
      this.emit('stopped', { reason: 'exited', title: current.title, service: current.service })
    }
  }

  #alive(pid) {
    try {
      this.#kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Chromium hands a second launch on the same profile folder to the browser
  // already running there and exits at once. A player left by an earlier
  // gateway (crash, SIGKILL, restart) would keep playing out of reach, so it
  // is stopped first. SingletonLock is a symlink to "<hostname>-<pid>"; only a
  // live process on this host whose command line names this profile folder is
  // stopped, never a process that reused the PID of a stale lock.
  async #stopLeftover(profileDir) {
    let lock = ''
    try {
      lock = String(this.#readLink(join(profileDir, 'SingletonLock')))
    } catch {
      return
    }
    const dash = lock.lastIndexOf('-')
    const pid = Number(lock.slice(dash + 1))
    if (dash < 1 || lock.slice(0, dash) !== hostname() || !Number.isInteger(pid) || pid < 1) return
    if (!this.#alive(pid)) return
    let command = ''
    try {
      ;({ stdout: command } = await this.#execFileImpl(
        'ps',
        ['-ww', '-o', 'args=', '-p', String(pid)],
        { timeout: PS_TIMEOUT_MS },
      ))
    } catch {
      return
    }
    if (!` ${String(command || '').trim()} `.includes(` --user-data-dir=${profileDir} `)) return
    this.#logger.warn('media.player.leftover', { pid })
    try {
      this.#kill(pid, 'SIGTERM')
    } catch {
      return
    }
    for (let waited = 0; waited < this.#stopTimeoutMs; waited += LEFTOVER_POLL_MS) {
      await new Promise(resolve => setTimeout(resolve, Math.min(LEFTOVER_POLL_MS, this.#stopTimeoutMs)))
      if (!this.#alive(pid)) return
    }
    try {
      this.#kill(pid, 'SIGKILL')
    } catch {
      // It exited between the last check and the kill.
    }
  }

  #endFullscreen(current) {
    const routine = current.fullscreen
    current.fullscreen = null
    try {
      routine?.dispose()
    } catch (error) {
      this.#logger.warn('media.fullscreen.error', { error: String(error?.message || error) })
    }
  }

  // Asks the playback browser to quit with Browser.close on its pipe. Chromium
  // then exits without running beforeunload, where SIGTERM on macOS before
  // Chrome 154 can wait on a site's "Leave site?" dialog. Resolves true when
  // the browser exited within the grace period. A closed or refused pipe, an
  // error reply or a pipe error resolves false at once, for SIGTERM. The reply
  // is not needed: Chromium may shut its pipe down before writing it, so only
  // 'exit' tells that the browser ended.
  async #closeOverDevTools(current) {
    const { pipe } = current
    if (!pipe || pipe.closed || pipe.refusal) return false
    this.#endFullscreen(current)
    const exited = exitsWithin(current, this.#closeGraceMs)
    const failed = pipe.send('Browser.close', {}, { timeoutMs: CLOSE_REPLY_TIMEOUT_MS }).then(
      () => false,
      // A pipe the browser shut while exiting, or no reply in time, is not a failure.
      error => !current.done && error?.code !== 'timeout' && pipe.closeReason !== 'browser_closed',
    )
    return Promise.race([exited, failed.then(refused => (refused ? false : exited))])
  }

  async #stopCurrent(reason) {
    const current = this.#current
    if (!current) return false
    this.#current = null
    let method = null
    this.#closing = current
    try {
      if (!current.done && await this.#closeOverDevTools(current)) method = 'devtools'
    } finally {
      this.#closing = null
    }
    this.#releaseControl(current, reason)
    if (!current.done) {
      method = 'sigterm'
      current.child.kill('SIGTERM')
      if (!await exitsWithin(current, this.#stopTimeoutMs)) {
        this.#logger.warn('media.player.kill', { pid: current.pid })
        method = 'sigkill'
        current.child.kill('SIGKILL')
        await current.exited
      }
    }
    if (method) this.#logger.info('media.player.closed', { kind: current.kind, pid: current.pid, method })
    if (current.kind === 'playback') {
      this.emit('stopped', { reason, title: current.title, service: current.service })
    }
    return true
  }
}
