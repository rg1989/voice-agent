import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  AppServices,
  spotifyUri,
  stremioDetailUrl,
} from '../src/media/app-services.mjs'

const TRACK = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'
const INCEPTION = 'stremio:///detail/movie/tt1375666/tt1375666'
const tick = () => new Promise(resolve => setImmediate(resolve))
const noPlayers = () => Object.assign(new Error('No players found'), { code: 1 })

// answer(file, args, options) returns { stdout } or an Error to throw. Every
// call and the timeout it was given are recorded.
function fakeExec(answer = () => ({})) {
  const calls = []
  const timeouts = []
  const execFileImpl = async (file, args, options) => {
    calls.push([file, ...args])
    timeouts.push(options?.timeout)
    const result = answer(file, args, options)
    if (result instanceof Error) throw result
    return { stdout: '', stderr: '', ...result }
  }
  return { calls, timeouts, execFileImpl }
}

function fakeSpawn({ error } = {}) {
  const spawned = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.unref = () => {}
    spawned.push({ command, args, options })
    if (error) setImmediate(() => child.emit('error', error))
    return child
  }
  return { spawned, spawnImpl }
}

// A fake clock: sleep moves it forward, so deadlines pass without real waiting.
function services(platform, {
  exec = fakeExec(),
  spawn = fakeSpawn(),
  launchTimeoutMs,
  clock = { now: 0 },
} = {}) {
  return new AppServices({
    platform,
    execFileImpl: exec.execFileImpl,
    spawnImpl: spawn.spawnImpl,
    sleep: async ms => {
      clock.now += ms
      await tick()
    },
    now: () => clock.now,
    ...(launchTimeoutMs === undefined ? {} : { launchTimeoutMs }),
  })
}

test('normalizes Spotify URIs and open.spotify.com links and rejects anything else', () => {
  assert.equal(spotifyUri(TRACK), TRACK)
  assert.equal(spotifyUri('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc'), TRACK)
  assert.equal(
    spotifyUri('https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3'),
    'spotify:album:1DFixLWuPkv3KT3TnV35m3',
  )
  for (const bad of [
    'spotify:track:short',
    'https://evil.example/track/4uLU6hMCjMI75M1A2tKUQC',
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC" to quit',
    '',
    null,
  ]) {
    assert.equal(spotifyUri(bad), null)
  }
})

test('accepts only Stremio detail links whose two IMDb ids match', () => {
  assert.equal(stremioDetailUrl(INCEPTION), INCEPTION)
  assert.equal(
    stremioDetailUrl('stremio:///detail/series/tt0903747/tt0903747'),
    'stremio:///detail/series/tt0903747/tt0903747',
  )
  for (const bad of [
    'stremio:///detail/movie/tt1375666/tt0903747',
    'stremio:///detail/channel/tt1375666/tt1375666',
    'https://web.stremio.com/#/detail/movie/tt1375666',
    'stremio:///detail/movie/tt1375666/tt1375666;open -a Calculator',
  ]) {
    assert.equal(stremioDetailUrl(bad), null)
  }
})

test('on macOS it opens the URI in the background, then tells Spotify to play it', async () => {
  const exec = fakeExec()
  await services('darwin', { exec }).playSpotify(TRACK)
  assert.deepEqual(exec.calls, [
    ['open', '-g', TRACK],
    ['osascript', '-e', `tell application "Spotify" to play track "${TRACK}"`],
  ])
})

test('on Linux it opens the URI in a Spotify player that is already running', async () => {
  const exec = fakeExec((file, args) => (
    args[0] === '-l' ? { stdout: 'chromium.instance42\nspotify\n' } : {}
  ))
  const spawn = fakeSpawn()
  await services('linux', { exec, spawn }).playSpotify(TRACK)
  assert.deepEqual(spawn.spawned, [])
  assert.deepEqual(exec.calls, [
    ['playerctl', '-l'],
    ['playerctl', '-p', 'spotify', 'open', TRACK],
  ])
})

test('on Linux it launches Spotify when no Spotify player is running, waits for it, then opens the URI', async () => {
  let listed = 0
  const exec = fakeExec((file, args) => {
    if (args[0] !== '-l') return {}
    listed += 1
    return listed < 3 ? noPlayers() : { stdout: 'spotify\n' }
  })
  const spawn = fakeSpawn()
  await services('linux', { exec, spawn }).playSpotify(TRACK)
  assert.deepEqual(spawn.spawned, [
    { command: 'spotify', args: [], options: { detached: true, stdio: 'ignore' } },
  ])
  assert.deepEqual(exec.calls, [
    ['playerctl', '-l'],
    ['playerctl', '-l'],
    ['playerctl', '-l'],
    ['playerctl', '-p', 'spotify', 'open', TRACK],
  ])
})

test('on Linux a missing Spotify app fails as launch_failed', async () => {
  const exec = fakeExec((file, args) => (args[0] === '-l' ? noPlayers() : {}))
  const spawn = fakeSpawn({
    error: Object.assign(new Error('spawn spotify ENOENT'), { code: 'ENOENT' }),
  })
  await assert.rejects(
    services('linux', { exec, spawn }).playSpotify(TRACK),
    { code: 'launch_failed', message: /could not be started/ },
  )
  assert.equal(exec.calls.some(call => call.includes('open')), false)
})

test('on Linux a Spotify that never shows up fails once the launch timeout passes', async () => {
  const exec = fakeExec((file, args) => (args[0] === '-l' ? noPlayers() : {}))
  await assert.rejects(
    services('linux', { exec, launchTimeoutMs: 1_000 }).playSpotify(TRACK),
    { code: 'launch_failed', message: /did not start in time/ },
  )
  assert.equal(exec.calls.filter(call => call[1] === '-l').length, 3)
})

test('on Linux one launch deadline bounds every playerctl call, even a hanging one', async () => {
  // Each playerctl -l hangs until its timeout kills it.
  const clock = { now: 0 }
  const hanging = fakeExec((file, args, options) => {
    if (args[0] !== '-l') return {}
    clock.now += options.timeout
    return Object.assign(new Error('Command failed: playerctl -l'), { killed: true, signal: 'SIGTERM' })
  })
  await assert.rejects(
    services('linux', { exec: hanging, clock }).playSpotify(TRACK),
    { code: 'launch_failed', message: /did not start in time/ },
  )
  assert.deepEqual(hanging.timeouts, [10_000, 4_500])
  assert.ok(clock.now <= 15_000, `finding Spotify took ${clock.now} ms`)
  assert.equal(hanging.calls.some(call => call.includes('open')), false)

  // A slow but working start keeps the 5 s limit on playerctl open.
  const slowClock = { now: 0 }
  let listed = 0
  const slow = fakeExec((file, args) => {
    if (args[0] !== '-l') return {}
    listed += 1
    slowClock.now += 2_000
    return listed < 2 ? noPlayers() : { stdout: 'spotify\n' }
  })
  await services('linux', { exec: slow, clock: slowClock }).playSpotify(TRACK)
  assert.deepEqual(slow.timeouts, [10_000, 10_000, 5_000])
})

test('on Linux a missing playerctl is reported as transport_unavailable', async () => {
  const exec = fakeExec(() => Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(
    services('linux', { exec }).playSpotify(TRACK),
    { code: 'transport_unavailable', message: /playerctl is not installed/ },
  )
})

test('controls Spotify with playerctl on Linux, reading the position before a relative seek', async () => {
  const exec = fakeExec((file, args) => (
    args.at(-1) === 'position' ? { stdout: '42.500000\n' } : {}
  ))
  const apps = services('linux', { exec })
  for (const action of ['pause', 'resume', 'next', 'previous']) {
    await apps.spotifyControl(action)
  }
  await apps.spotifyControl('seek_relative', { seconds: -10 })
  await apps.spotifyControl('seek_relative', { seconds: -100 })
  assert.deepEqual(exec.calls, [
    ['playerctl', '-p', 'spotify', 'pause'],
    ['playerctl', '-p', 'spotify', 'play'],
    ['playerctl', '-p', 'spotify', 'next'],
    ['playerctl', '-p', 'spotify', 'previous'],
    ['playerctl', '-p', 'spotify', 'position'],
    ['playerctl', '-p', 'spotify', 'position', '32.5'],
    ['playerctl', '-p', 'spotify', 'position'],
    ['playerctl', '-p', 'spotify', 'position', '0'],
  ])
})

test('controls Spotify with AppleScript on macOS without launching a Spotify that is not running', async () => {
  const exec = fakeExec((file, args) => (
    args[1].endsWith('to player position') ? { stdout: '12,5\n' } : {}
  ))
  const apps = services('darwin', { exec })
  await apps.spotifyControl('pause')
  await apps.spotifyControl('next')
  await apps.spotifyControl('seek_relative', { seconds: 30 })
  assert.deepEqual(exec.calls, [
    ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to pause'],
    ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to next track'],
    ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to player position'],
    ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to set player position to 42.5'],
  ])

  // A quit Spotify prints nothing for the position, and no seek is sent.
  const quit = fakeExec()
  await assert.rejects(
    services('darwin', { exec: quit }).spotifyControl('seek_relative', { seconds: 10 }),
    { code: 'not_playing' },
  )
  assert.deepEqual(quit.calls, [
    ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to player position'],
  ])
})

test('on macOS it reads Spotify\'s own player state without launching a Spotify that is not running', async () => {
  // A quit Spotify prints nothing: the running guard skips the tell.
  for (const [stdout, playing] of [['playing\n', true], ['paused\n', false], ['stopped\n', false], ['', false]]) {
    const exec = fakeExec(() => ({ stdout }))
    assert.equal(await services('darwin', { exec }).spotifyPlaying(), playing, `player state ${JSON.stringify(stdout)}`)
    assert.deepEqual(exec.calls, [
      ['osascript', '-e', 'if application "Spotify" is running then tell application "Spotify" to player state'],
    ])
  }
  const refused = fakeExec(() => new Error('Not authorised to send Apple events to Spotify'))
  await assert.rejects(services('darwin', { exec: refused }).spotifyPlaying(), { code: 'transport_unavailable' })
})

test('on Linux it reads Spotify\'s own player status with playerctl', async () => {
  for (const [answer, playing] of [
    [{ stdout: 'Playing\n' }, true],
    [{ stdout: 'Paused\n' }, false],
    [{ stdout: 'Stopped\n' }, false],
    // playerctl exits non-zero when no Spotify player is running.
    [noPlayers(), false],
  ]) {
    const exec = fakeExec(() => answer)
    assert.equal(await services('linux', { exec }).spotifyPlaying(), playing, String(answer.stdout ?? answer.message))
    assert.deepEqual(exec.calls, [['playerctl', '-p', 'spotify', 'status']])
  }
  const missing = fakeExec(() => Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(services('linux', { exec: missing }).spotifyPlaying(), { code: 'transport_unavailable' })
  await assert.rejects(services('win32', { exec: missing }).spotifyPlaying(), { code: 'transport_unavailable' })
  assert.deepEqual(missing.calls, [['playerctl', '-p', 'spotify', 'status']])
})

test('rejects unknown actions, a seek without seconds, and unsupported platforms without running anything', async () => {
  const exec = fakeExec()
  await assert.rejects(services('linux', { exec }).spotifyControl('shuffle'), { code: 'transport_unavailable' })
  await assert.rejects(services('linux', { exec }).spotifyControl('seek_relative', {}), { code: 'transport_unavailable' })
  await assert.rejects(services('win32', { exec }).spotifyControl('pause'), { code: 'transport_unavailable' })
  await assert.rejects(services('win32', { exec }).playSpotify(TRACK), { code: 'launch_failed' })
  await assert.rejects(services('win32', { exec }).openStremio(INCEPTION), { code: 'launch_failed' })
  assert.deepEqual(exec.calls, [])
})

test('opens a Stremio detail page with open on macOS and xdg-open on Linux, and nothing else', async () => {
  const mac = fakeExec()
  await services('darwin', { exec: mac }).openStremio(INCEPTION)
  const linux = fakeExec()
  await services('linux', { exec: linux }).openStremio(INCEPTION)
  assert.deepEqual(mac.calls, [['open', INCEPTION]])
  assert.deepEqual(linux.calls, [['xdg-open', INCEPTION]])

  const refused = fakeExec()
  await assert.rejects(services('linux', { exec: refused }).openStremio('https://evil.example/'), { code: 'url_not_allowed' })
  await assert.rejects(services('darwin', { exec: refused }).playSpotify('spotify:track:x" to quit'), { code: 'url_not_allowed' })
  assert.deepEqual(refused.calls, [])

  const broken = fakeExec(() => new Error('no handler for stremio'))
  await assert.rejects(services('linux', { exec: broken }).openStremio(INCEPTION), { code: 'launch_failed' })
})
