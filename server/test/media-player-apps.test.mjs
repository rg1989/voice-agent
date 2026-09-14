import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MediaPlayer } from '../src/media/player.mjs'

const TRACK = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'
const OTHER = 'spotify:track:7GhIk7Il098yCjg4BQjzvb'
const STREMIO = 'stremio:///detail/movie/tt1375666/tt1375666'

function fakeApps() {
  const calls = []
  const apps = {
    calls,
    // What Spotify itself reports. The user can pause it in the app, or the
    // album can end, without the Gateway hearing about it.
    playing: true,
    async playSpotify(uri) { calls.push(['playSpotify', uri]) },
    async openStremio(url) { calls.push(['openStremio', url]) },
    async spotifyControl(action, options = {}) { calls.push(['spotifyControl', action, options]) },
    async spotifyPlaying() {
      calls.push(['spotifyPlaying'])
      return apps.playing
    },
  }
  return apps
}

// No test may find, start or script a real browser, even while the app-service
// code does not exist yet and P1's browser path handles every link.
function harness(t, overrides = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'qwaudio-media-apps-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  const apps = fakeApps()
  const events = []
  const player = new MediaPlayer({
    getSettings: () => ({
      mediaBrowser: 'auto',
      mediaReturnToAssistant: false,
      mediaPauseWhileTalking: true,
    }),
    configDir,
    platform: 'linux',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    detectBrowsers: () => [],
    spawnImpl: () => { throw new Error('tests never spawn') },
    execFileImpl: async () => { throw new Error('tests never exec') },
    appServices: apps,
    ...overrides,
  })
  for (const name of ['started', 'stopped', 'paused', 'resumed']) {
    player.on(name, payload => events.push([name, payload]))
  }
  return { player, apps, events }
}

test('plays a Spotify link in the Spotify app and reports it as the current playback', async t => {
  const { player, apps, events } = harness(t)
  const result = await player.play({
    url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    title: 'Never Gonna Give You Up',
    service: 'spotify',
  })
  assert.deepEqual(result, {
    status: 'playing',
    title: 'Never Gonna Give You Up',
    url: TRACK,
    service: 'spotify',
    browser: null,
  })
  assert.deepEqual(apps.calls, [['playSpotify', TRACK]])
  const state = player.state()
  assert.equal(state.active, true)
  assert.equal(state.paused, false)
  assert.equal(state.service, 'spotify')
  assert.equal(state.url, TRACK)
  assert.equal(state.browser, null)
  assert.equal(state.pid, null)
  assert.equal(typeof state.startedAt, 'number')
  assert.deepEqual(events.map(([name]) => name), ['started'])
})

test('routes transport and stop to Spotify while it plays', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, service: 'spotify' })
  assert.deepEqual(await player.control('pause'), { status: 'ok', action: 'pause' })
  assert.equal(player.state().paused, true)
  await player.control('resume')
  await player.control('seek_relative', { seconds: -15 })
  assert.deepEqual(await player.stop(), { status: 'stopped' })
  assert.equal(player.state().active, false)
  assert.deepEqual(apps.calls.slice(1), [
    ['spotifyControl', 'pause', { seconds: undefined }],
    ['spotifyControl', 'resume', { seconds: undefined }],
    ['spotifyControl', 'seek_relative', { seconds: -15 }],
    ['spotifyControl', 'pause', {}],
  ])
  assert.deepEqual(events.map(([name]) => name), ['started', 'paused', 'resumed', 'stopped'])
  assert.deepEqual(events.at(-1)[1], { reason: 'user', title: null, service: 'spotify' })
})

test('every Spotify control counts as a user control, even a pause while already paused', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, service: 'spotify' })
  const before = player.state().controlSerial
  assert.equal(typeof before, 'number')
  await player.control('pause')
  // A backend pause during a talk pause finds Spotify already paused: no
  // 'paused' event and the same startedAt, so only the serial shows it, and
  // MediaTalkPause must not resume afterwards.
  await player.control('pause')
  assert.equal(player.state().controlSerial, before + 2)
  assert.equal(player.state().paused, true)
  assert.deepEqual(events.map(([name]) => name), ['started', 'paused'])
  assert.deepEqual(apps.calls.slice(1).map(call => call[1]), ['pause', 'pause'])
})

test('a talk pause finds Spotify already paused in the app: no pause is sent and the playback reads as paused', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, service: 'spotify' })
  apps.playing = false
  const serial = player.state().controlSerial
  await assert.rejects(player.control('pause', { source: 'talk_pause' }), { code: 'not_playing' })
  assert.deepEqual(apps.calls.slice(1), [['spotifyPlaying']])
  assert.equal(player.state().active, true)
  assert.equal(player.state().paused, true)
  assert.equal(player.state().controlSerial, serial)
  assert.deepEqual(events.map(([name]) => name), ['started', 'paused'])

  // The user's own resume afterwards reaches Spotify and reads as playing.
  await player.control('resume')
  assert.deepEqual(apps.calls.slice(2), [['spotifyControl', 'resume', { seconds: undefined }]])
  assert.equal(player.state().paused, false)
  assert.deepEqual(events.map(([name]) => name), ['started', 'paused', 'resumed'])
})

test('a talk pause pauses and resumes Spotify as before while Spotify plays', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, service: 'spotify' })
  await player.control('pause', { source: 'talk_pause' })
  assert.equal(player.state().paused, true)
  await player.control('resume', { source: 'talk_pause' })
  assert.deepEqual(apps.calls.slice(1), [
    ['spotifyPlaying'],
    ['spotifyControl', 'pause', { seconds: undefined }],
    ['spotifyControl', 'resume', { seconds: undefined }],
  ])
  assert.deepEqual(events.map(([name]) => name), ['started', 'paused', 'resumed'])
})

test('a Spotify control that settles after a new track started leaves the new track alone', async t => {
  const { player, apps, events } = harness(t)
  // Holds the next Spotify call back until release() is called.
  const holdNext = method => {
    const working = apps[method]
    let release
    apps[method] = (...parameters) => {
      apps[method] = working
      return new Promise(resolve => { release = () => resolve(working(...parameters)) })
    }
    return () => release()
  }
  const names = () => events.map(([name, payload]) => [name, payload.title])

  await player.play({ url: TRACK, title: 'One', service: 'spotify' })
  const releasePause = holdNext('spotifyControl')
  const pausing = player.control('pause')
  await player.play({ url: OTHER, title: 'Two', service: 'spotify' })
  releasePause()
  assert.deepEqual(await pausing, { status: 'ok', action: 'pause' })
  assert.equal(player.state().title, 'Two')
  assert.equal(player.state().paused, false)
  assert.deepEqual(names(), [['started', 'One'], ['stopped', 'One'], ['started', 'Two']])

  // The same for a talk pause that finds Spotify not playing.
  apps.playing = false
  const releaseRead = holdNext('spotifyPlaying')
  const talkPausing = player.control('pause', { source: 'talk_pause' })
  await player.play({ url: TRACK, title: 'Three', service: 'spotify' })
  releaseRead()
  await assert.rejects(talkPausing, { code: 'not_playing' })
  assert.equal(player.state().title, 'Three')
  assert.equal(player.state().paused, false)
  assert.deepEqual(names().slice(3), [['stopped', 'Two'], ['started', 'Three']])
})

test('a new Spotify track replaces the current one without pausing the app', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, title: 'One', service: 'spotify' })
  await player.play({ url: OTHER, title: 'Two', service: 'spotify' })
  assert.deepEqual(apps.calls, [['playSpotify', TRACK], ['playSpotify', OTHER]])
  assert.deepEqual(
    events.map(([name, payload]) => [name, payload.title]),
    [['started', 'One'], ['stopped', 'One'], ['started', 'Two']],
  )
  assert.equal(events[1][1].reason, 'replaced')
  assert.equal(player.state().title, 'Two')
})

test('opening a Stremio page ends Spotify playback and leaves nothing playing', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, service: 'spotify' })
  const result = await player.play({ url: STREMIO, title: 'Inception', service: 'stremio' })
  assert.deepEqual(result, { status: 'opened', title: 'Inception', url: STREMIO, service: 'stremio' })
  assert.deepEqual(apps.calls, [
    ['playSpotify', TRACK],
    ['openStremio', STREMIO],
    ['spotifyControl', 'pause', {}],
  ])
  assert.equal(player.state().active, false)
  assert.deepEqual(events.map(([name]) => name), ['started', 'stopped'])
  assert.equal(events[1][1].reason, 'replaced')
})

test('an app service stops browser playback only after the app has taken over', async t => {
  const spawned = []
  const { player, apps } = harness(t, {
    detectBrowsers: () => [{ id: 'chrome', label: 'Chrome', binary: '/bin/chrome', bundleId: null }],
    spawnImpl: binary => {
      const child = new EventEmitter()
      child.pid = 4242
      child.kill = signal => {
        apps.calls.push(['kill', signal])
        setImmediate(() => child.emit('exit', null, signal))
        return true
      }
      spawned.push(binary)
      setImmediate(() => child.emit('spawn'))
      return child
    },
  })
  player.on('stopped', payload => apps.calls.push(['stopped', payload.reason, payload.service]))
  await player.play({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Video',
    service: 'youtube',
  })
  assert.equal(player.state().service, 'youtube')
  const result = await player.play({ url: STREMIO, title: 'Inception', service: 'stremio' })
  assert.deepEqual(result, { status: 'opened', title: 'Inception', url: STREMIO, service: 'stremio' })
  assert.deepEqual(spawned, ['/bin/chrome'])
  assert.deepEqual(apps.calls, [
    ['openStremio', STREMIO],
    ['kill', 'SIGTERM'],
    ['stopped', 'replaced', 'youtube'],
  ])
  assert.equal(player.state().active, false)
})

test('rejects links that are not Spotify URIs or Stremio detail pages without touching playback', async t => {
  const { player, apps } = harness(t)
  await assert.rejects(
    player.play({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', service: 'spotify' }),
    { code: 'url_not_allowed' },
  )
  await assert.rejects(
    player.play({ url: 'stremio:///detail/movie/tt1/tt1', service: 'stremio' }),
    { code: 'url_not_allowed' },
  )
  assert.deepEqual(apps.calls, [])
})

test('a failed Spotify pause still ends playback and logs why', async t => {
  const warnings = []
  const { player, apps, events } = harness(t, {
    logger: { info() {}, warn: (event, fields) => warnings.push([event, fields]), error() {}, debug() {} },
  })
  const denied = () => async () => {
    throw Object.assign(new Error('Not authorised to send Apple events'), { code: 'control_failed' })
  }

  const working = apps.spotifyControl
  await player.play({ url: TRACK, service: 'spotify' })
  apps.spotifyControl = denied()
  assert.deepEqual(await player.stop(), { status: 'stopped' })
  assert.equal(player.state().active, false)

  apps.spotifyControl = working
  await player.play({ url: TRACK, service: 'spotify' })
  apps.spotifyControl = denied()
  const result = await player.play({ url: STREMIO, service: 'stremio' })
  assert.equal(result.status, 'opened')
  assert.equal(player.state().active, false)

  assert.deepEqual(
    events.map(([name, payload]) => [name, payload.reason ?? null]),
    [['started', null], ['stopped', 'user'], ['started', null], ['stopped', 'replaced']],
  )
  const failure = { code: 'control_failed', error: 'Not authorised to send Apple events' }
  assert.deepEqual(warnings, [['media.app.pause_failed', failure], ['media.app.pause_failed', failure]])
})

test('a failed app launch leaves the current Spotify playback alone', async t => {
  const { player, apps, events } = harness(t)
  await player.play({ url: TRACK, title: 'One', service: 'spotify' })
  apps.playSpotify = async () => {
    throw Object.assign(new Error('Spotify did not start playing'), { code: 'launch_failed' })
  }
  await assert.rejects(player.play({ url: OTHER, service: 'spotify' }), { code: 'launch_failed' })
  assert.equal(player.state().title, 'One')
  assert.deepEqual(events.map(([name]) => name), ['started'])
  assert.equal(apps.calls.some(call => call[0] === 'spotifyControl'), false)
})
