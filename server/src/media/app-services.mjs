// Services that play in their own desktop app instead of the player browser.
//
// Spotify plays in the Spotify desktop app. The Gateway never calls the Spotify
// Web API and never touches the user's account. Stremio cannot start playback
// from outside, so only its title page is opened.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
// From its own module, not ./player.mjs: player.mjs imports this file.
import { MediaError } from './media-error.mjs'

export const APP_SERVICE_IDS = Object.freeze(['spotify', 'stremio'])

const SPOTIFY_TYPES = '(track|album|playlist|artist|episode|show)'
const SPOTIFY_ID = '([A-Za-z0-9]{22})'
const SPOTIFY_URI = new RegExp(`^spotify:${SPOTIFY_TYPES}:${SPOTIFY_ID}$`)
const SPOTIFY_LINK = new RegExp(
  `^https://open\\.spotify\\.com/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?${SPOTIFY_TYPES}/${SPOTIFY_ID}(?:[?#].*)?$`,
)
const STREMIO_DETAIL = /^stremio:\/\/\/detail\/(movie|series)\/(tt\d{7,10})\/(tt\d{7,10})$/
const COMMAND_TIMEOUT_MS = 10_000
const MIN_COMMAND_TIMEOUT_MS = 1_000
const LAUNCH_POLL_MS = 500
// One wall-clock deadline for finding and starting Spotify on Linux, then at
// most OPEN_TIMEOUT_MS for playerctl open: about 21 s in the worst case, under
// omp's 30 s MCP call timeout.
const LAUNCH_TIMEOUT_MS = 15_000
const OPEN_TIMEOUT_MS = 5_000

const MAC_COMMANDS = Object.freeze({
  pause: 'pause',
  resume: 'play',
  next: 'next track',
  previous: 'previous track',
})
const LINUX_COMMANDS = Object.freeze({
  pause: 'pause',
  resume: 'play',
  next: 'next',
  previous: 'previous',
})

const execFileAsync = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export function spotifyUri(value) {
  const text = String(value ?? '').trim()
  const match = text.match(SPOTIFY_URI) || text.match(SPOTIFY_LINK)
  return match ? `spotify:${match[1]}:${match[2]}` : null
}

export function stremioDetailUrl(value) {
  const match = String(value ?? '').trim().match(STREMIO_DETAIL)
  return match && match[2] === match[3] ? match[0] : null
}

function unknownAction(action) {
  return new MediaError('transport_unavailable', `Unknown media action: ${action}`)
}

function seekOffset(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new MediaError('transport_unavailable', 'seek_relative needs a number of seconds')
  }
  return seconds
}

// Spotify answers in seconds; AppleScript may print a decimal comma.
function absolutePosition(stdout, offset) {
  const current = Number.parseFloat(String(stdout).trim().replace(',', '.'))
  if (!Number.isFinite(current)) {
    throw new MediaError('not_playing', 'Spotify reported no playback position')
  }
  return Math.max(0, Math.round((current + offset) * 1000) / 1000)
}

export class AppServices {
  constructor({
    platform = process.platform,
    execFileImpl = execFileAsync,
    spawnImpl = spawn,
    sleep = delay,
    now = Date.now,
    launchTimeoutMs = LAUNCH_TIMEOUT_MS,
  } = {}) {
    Object.assign(this, { platform, execFileImpl, spawnImpl, sleep, now, launchTimeoutMs })
  }

  run(file, args, timeout = COMMAND_TIMEOUT_MS) {
    return this.execFileImpl(file, args, { timeout })
  }

  // A slow or hanging command may use only the time left before the deadline.
  commandTimeout(deadline) {
    return Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(COMMAND_TIMEOUT_MS, deadline - this.now()))
  }

  async playSpotify(uri) {
    // Checked here too: the URI is placed inside an AppleScript string.
    if (!SPOTIFY_URI.test(String(uri))) {
      throw new MediaError('url_not_allowed', `Not a Spotify URI: ${uri}`)
    }
    try {
      if (this.platform === 'darwin') {
        // open -g starts Spotify in the background when it is not running.
        await this.run('open', ['-g', uri])
        await this.run('osascript', ['-e', `tell application "Spotify" to play track "${uri}"`])
        return
      }
      if (this.platform === 'linux') {
        const deadline = this.now() + this.launchTimeoutMs
        if (!await this.spotifyRunning(deadline)) await this.launchSpotify(deadline)
        await this.run('playerctl', ['-p', 'spotify', 'open', uri], OPEN_TIMEOUT_MS)
        return
      }
    } catch (error) {
      if (error instanceof MediaError) throw error
      throw new MediaError('launch_failed', `Spotify did not start playing: ${error?.message || error}`)
    }
    throw new MediaError('launch_failed', `Spotify playback is not supported on ${this.platform}`)
  }

  async spotifyRunning(deadline) {
    try {
      const { stdout } = await this.run('playerctl', ['-l'], this.commandTimeout(deadline))
      return String(stdout).split('\n').some(name => name.trim() === 'spotify')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new MediaError('transport_unavailable', 'playerctl is not installed')
      }
      // playerctl exits non-zero when no player is running at all, and a
      // command killed by its timeout counts as no player too.
      return false
    }
  }

  async launchSpotify(deadline) {
    const child = this.spawnImpl('spotify', [], { detached: true, stdio: 'ignore' })
    let failure = null
    child.once('error', error => { failure = error })
    child.unref()
    // Wall-clock, not a count of sleeps: each poll can itself take seconds.
    while (this.now() < deadline) {
      await this.sleep(Math.min(LAUNCH_POLL_MS, deadline - this.now()))
      if (failure) {
        throw new MediaError('launch_failed', `Spotify could not be started: ${failure.message}`)
      }
      if (await this.spotifyRunning(deadline)) return
    }
    throw new MediaError('launch_failed', 'Spotify did not start in time')
  }

  async spotifyControl(action, { seconds } = {}) {
    try {
      if (this.platform === 'darwin') return await this.macSpotifyControl(action, seconds)
      if (this.platform === 'linux') return await this.linuxSpotifyControl(action, seconds)
    } catch (error) {
      if (error instanceof MediaError) throw error
      throw new MediaError('transport_unavailable', `Spotify did not respond: ${error?.message || error}`)
    }
    throw new MediaError('transport_unavailable', `Spotify control is not supported on ${this.platform}`)
  }

  // Spotify's own player state. The user may have paused Spotify in the app,
  // or the album may have ended, and the Gateway hears of neither.
  async spotifyPlaying() {
    if (this.platform === 'darwin') {
      try {
        // A quit Spotify prints nothing, which reads as not playing.
        const { stdout } = await this.macTell('player state')
        return String(stdout).trim() === 'playing'
      } catch (error) {
        throw new MediaError('transport_unavailable', `Spotify did not respond: ${error?.message || error}`)
      }
    }
    if (this.platform === 'linux') {
      try {
        const { stdout } = await this.run('playerctl', ['-p', 'spotify', 'status'])
        return String(stdout).trim() === 'Playing'
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new MediaError('transport_unavailable', 'playerctl is not installed')
        }
        // playerctl exits non-zero when no Spotify player is running.
        return false
      }
    }
    throw new MediaError('transport_unavailable', `Spotify control is not supported on ${this.platform}`)
  }

  // "tell application" alone would launch a Spotify the user has quit, so
  // every command is guarded.
  macTell(command) {
    return this.run('osascript', [
      '-e',
      `if application "Spotify" is running then tell application "Spotify" to ${command}`,
    ])
  }

  async macSpotifyControl(action, seconds) {
    // A quit Spotify prints no position, which absolutePosition reports as
    // not_playing.
    const tell = command => this.macTell(command)
    if (action === 'seek_relative') {
      const offset = seekOffset(seconds)
      const { stdout } = await tell('player position')
      const position = absolutePosition(stdout, offset)
      await tell(`set player position to ${position}`)
      return
    }
    const command = MAC_COMMANDS[action]
    if (!command) throw unknownAction(action)
    await tell(command)
  }

  async linuxSpotifyControl(action, seconds) {
    if (action === 'seek_relative') {
      const offset = seekOffset(seconds)
      const { stdout } = await this.run('playerctl', ['-p', 'spotify', 'position'])
      const position = absolutePosition(stdout, offset)
      await this.run('playerctl', ['-p', 'spotify', 'position', String(position)])
      return
    }
    const command = LINUX_COMMANDS[action]
    if (!command) throw unknownAction(action)
    await this.run('playerctl', ['-p', 'spotify', command])
  }

  async openStremio(url) {
    if (!stremioDetailUrl(url)) {
      throw new MediaError('url_not_allowed', `Not a Stremio detail link: ${url}`)
    }
    const opener = this.platform === 'darwin'
      ? 'open'
      : this.platform === 'linux' ? 'xdg-open' : null
    if (!opener) {
      throw new MediaError('launch_failed', `Stremio is not supported on ${this.platform}`)
    }
    try {
      await this.run(opener, [url])
    } catch (error) {
      throw new MediaError('launch_failed', `Stremio could not be opened: ${error?.message || error}`)
    }
  }
}
