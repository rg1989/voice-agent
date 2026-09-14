import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MediaError } from './media-error.mjs'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 5000

async function run(execFileImpl, tool, args) {
  try {
    const { stdout } = await execFileImpl(tool, args, { timeout: COMMAND_TIMEOUT_MS })
    return String(stdout || '')
  } catch (error) {
    throw new MediaError(
      'transport_unavailable',
      error?.code === 'ENOENT' ? `${tool} is not installed` : `${tool} failed: ${error?.message || error}`,
    )
  }
}

// Linux: MPRIS through playerctl. Chromium registers one player per browser
// process named <prefix>.instance<browser PID> (Brave renames the prefix), so
// the suffix picks out the player and never the user's own browser.
function linuxTransport({ pid, execFileImpl }) {
  const suffix = `.instance${pid}`
  const playerName = async () => {
    const names = (await run(execFileImpl, 'playerctl', ['-l'])).split('\n').map(line => line.trim())
    const name = names.find(entry => entry.endsWith(suffix))
    if (!name) throw new MediaError('transport_unavailable', `no MPRIS player ends in ${suffix}`)
    return name
  }
  const command = action => async () => {
    await run(execFileImpl, 'playerctl', ['-p', await playerName(), action])
  }
  return {
    pause: command('pause'),
    resume: command('play'),
    next: command('next'),
    previous: command('previous'),
    async playing() {
      return (await run(execFileImpl, 'playerctl', ['-p', await playerName(), 'status'])).trim() === 'Playing'
    },
    async seekRelative(seconds) {
      const name = await playerName()
      const elapsed = Number.parseFloat(await run(execFileImpl, 'playerctl', ['-p', name, 'position']))
      if (!Number.isFinite(elapsed)) {
        throw new MediaError('transport_unavailable', 'the player reported no position')
      }
      await run(execFileImpl, 'playerctl', ['-p', name, 'position', String(Math.max(0, elapsed + seconds))])
    },
  }
}

// macOS: media-control acts on whichever app owns Now Playing and cannot
// address a PID, so every command first checks that the owner is the player
// browser's bundle id. Bundle id alone is not enough when the player and the
// user's everyday browser share one bundle id (both are com.google.Chrome):
// when media-control's output carries processIdentifier, it must also match
// the player's own PID, or the command could pause the user's own browser.
function macTransport({ pid, bundleId, execFileImpl }) {
  const nowPlaying = async (args = ['get']) => {
    const stdout = await run(execFileImpl, 'media-control', args)
    let info = null
    try {
      info = JSON.parse(stdout)
    } catch {
      throw new MediaError('transport_unavailable', 'media-control returned unreadable output')
    }
    const owners = [info?.bundleIdentifier, info?.parentApplicationBundleIdentifier]
    if (!bundleId || !owners.includes(bundleId)) {
      throw new MediaError(
        'transport_unavailable',
        `Now Playing is not the player browser (${info?.bundleIdentifier || 'nothing'})`,
      )
    }
    if (info?.processIdentifier !== undefined && info.processIdentifier !== pid) {
      throw new MediaError(
        'transport_unavailable',
        `Now Playing is process ${info.processIdentifier}, not the player browser's ${pid}`,
      )
    }
    return info
  }
  const command = action => async () => {
    await nowPlaying()
    await run(execFileImpl, 'media-control', [action])
  }
  return {
    pause: command('pause'),
    resume: command('play'),
    next: command('next-track'),
    previous: command('previous-track'),
    async playing() {
      return (await nowPlaying()).playing === true
    },
    async seekRelative(seconds) {
      // elapsedTime is from the last Now Playing update and lags while the
      // video plays; --now adds elapsedTimeNow, estimated for this moment.
      const info = await nowPlaying(['get', '--now'])
      const elapsed = Number(info.elapsedTimeNow ?? info.elapsedTime)
      if (!Number.isFinite(elapsed)) {
        throw new MediaError('transport_unavailable', 'Now Playing reported no elapsed time')
      }
      await run(execFileImpl, 'media-control', ['seek', String(Math.max(0, elapsed + seconds))])
    },
  }
}

export function createTransport({
  platform = process.platform,
  pid,
  bundleId = null,
  execFileImpl = execFileAsync,
}) {
  if (platform === 'linux') return linuxTransport({ pid, execFileImpl })
  if (platform === 'darwin') return macTransport({ pid, bundleId, execFileImpl })
  const unsupported = async () => {
    throw new MediaError('transport_unavailable', `no media transport on ${platform}`)
  }
  return {
    pause: unsupported,
    resume: unsupported,
    next: unsupported,
    previous: unsupported,
    playing: unsupported,
    seekRelative: unsupported,
  }
}
