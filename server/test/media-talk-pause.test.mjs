import assert from 'node:assert/strict'
import test from 'node:test'
import { MediaPlayer } from '../src/media/player.mjs'
import { MediaTalkPause } from '../src/voice/media-talk-pause.mjs'

function fakePlayer(initial = {}) {
  const player = {
    calls: [],
    current: { active: true, paused: false, startedAt: 1000, controlSerial: 0, ...initial },
    state: () => ({ ...player.current }),
    control: async (action, { source } = {}) => {
      player.calls.push(action)
      // Like MediaPlayer: pauses from anyone but pause while talking are counted.
      if (action === 'pause' && source !== 'talk_pause') {
        player.current = { ...player.current, controlSerial: player.current.controlSerial + 1 }
      }
      if (action === 'pause') player.current = { ...player.current, paused: true }
      if (action === 'resume') player.current = { ...player.current, paused: false }
      return { status: 'ok', action }
    },
  }
  return player
}

const on = { mediaPauseWhileTalking: true }

test('pauses when the user starts talking and resumes once the answer has settled', async () => {
  const player = fakePlayer()
  let responding = true
  const pause = new MediaTalkPause({ player, getSettings: () => on, isResponding: () => responding })
  pause.speechStarted()
  pause.speechStarted()
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause'])
  responding = false
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause', 'resume'])
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause', 'resume'])
})

test('does nothing when the setting is off, nothing plays, or playback is already paused', async () => {
  for (const [settings, state] of [
    [{ mediaPauseWhileTalking: false }, {}],
    [on, { active: false }],
    [on, { paused: true }],
  ]) {
    const player = fakePlayer(state)
    const pause = new MediaTalkPause({ player, getSettings: () => settings })
    pause.speechStarted()
    await pause.turnEnded()
    assert.deepEqual(player.calls, [])
  }
  const withoutPlayer = new MediaTalkPause({ getSettings: () => on })
  withoutPlayer.speechStarted()
  await withoutPlayer.turnEnded()
})

test('stays paused when the user asked to pause or stop in that turn', async () => {
  const player = fakePlayer()
  const pause = new MediaTalkPause({ player, getSettings: () => on })
  pause.speechStarted()
  pause.keepPaused()
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause'])
  // The next turn starts fresh; the player is paused now, so nothing is held.
  pause.speechStarted()
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause'])
})

test('does not resume new playback started during the turn', async () => {
  const player = fakePlayer()
  const pause = new MediaTalkPause({ player, getSettings: () => on })
  pause.speechStarted()
  player.current = { active: true, paused: true, startedAt: 2000, controlSerial: 0 }
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause'])
})

test('a failed pause leaves nothing to resume, and closing resumes a held pause', async () => {
  const failing = fakePlayer()
  failing.control = async action => {
    failing.calls.push(action)
    throw Object.assign(new Error('Now Playing is another app'), { code: 'transport_unavailable' })
  }
  const warnings = []
  const first = new MediaTalkPause({
    player: failing,
    getSettings: () => on,
    logger: { warn: (event, fields) => warnings.push([event, fields.code]) },
  })
  first.speechStarted()
  await first.turnEnded()
  assert.deepEqual(failing.calls, ['pause'])
  assert.deepEqual(warnings, [['media.talk_pause.pause_failed', 'transport_unavailable']])

  const player = fakePlayer()
  const second = new MediaTalkPause({ player, getSettings: () => on, isResponding: () => true })
  second.speechStarted()
  await second.close()
  assert.deepEqual(player.calls, ['pause', 'resume'])
})

test('a pause asked for elsewhere while the talk pause is held is not undone', async () => {
  const player = fakePlayer()
  const pause = new MediaTalkPause({ player, getSettings: () => on })
  pause.speechStarted()
  // A backend tool pauses the player that is already paused: no paused event,
  // same startedAt, only controlSerial changes.
  await player.control('pause')
  await pause.turnEnded()
  assert.deepEqual(player.calls, ['pause', 'pause'])
  assert.equal(player.current.paused, true)

  // Skipping or seeking during the turn is not a pause, so playback resumes.
  const skipped = fakePlayer()
  const second = new MediaTalkPause({ player: skipped, getSettings: () => on })
  second.speechStarted()
  await skipped.control('next')
  await second.turnEnded()
  assert.deepEqual(skipped.calls, ['pause', 'next', 'resume'])
})

test('speech that starts while the last resume is still on its way pauses again', async () => {
  const player = fakePlayer()
  // Like MediaPlayer: paused changes only once the transport call has finished.
  const waiting = []
  player.control = action => {
    player.calls.push(action)
    return new Promise(resolve => waiting.push(() => {
      player.current = { ...player.current, paused: action === 'pause' }
      resolve({ status: 'ok', action })
    }))
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const settle = async () => {
    await tick()
    while (waiting.length) {
      waiting.shift()()
      await tick()
    }
  }
  const pause = new MediaTalkPause({ player, getSettings: () => on })
  pause.speechStarted()
  await settle()

  const ended = pause.turnEnded()
  await tick()
  assert.deepEqual(player.calls, ['pause', 'resume'])
  assert.equal(player.current.paused, true)
  // The next request starts before that resume has landed.
  pause.speechStarted()
  await settle()
  await ended
  assert.deepEqual(player.calls, ['pause', 'resume', 'pause'])
  assert.equal(player.current.paused, true)

  // That request's answer settles: playback resumes once.
  const again = pause.turnEnded()
  await settle()
  await again
  assert.deepEqual(player.calls, ['pause', 'resume', 'pause', 'resume'])
  assert.equal(player.current.paused, false)
})

test('Spotify the user paused in the app is not started again by a talk turn', async () => {
  const calls = []
  const apps = {
    playing: true,
    async playSpotify(uri) { calls.push(['playSpotify', uri]) },
    async openStremio(url) { calls.push(['openStremio', url]) },
    async spotifyControl(action) { calls.push(['spotifyControl', action]) },
    async spotifyPlaying() {
      calls.push(['spotifyPlaying'])
      return apps.playing
    },
  }
  const refuse = () => { throw new Error('tests never spawn or exec') }
  const player = new MediaPlayer({
    getSettings: () => on,
    configDir: '/nonexistent',
    platform: 'linux',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    detectBrowsers: () => [],
    spawnImpl: refuse,
    execFileImpl: refuse,
    appServices: apps,
  })
  await player.play({ url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', service: 'spotify' })
  // Paused in the Spotify app: the Gateway's own record still says playing.
  apps.playing = false
  const pause = new MediaTalkPause({ player, getSettings: () => on })
  pause.speechStarted()
  await pause.turnEnded()
  assert.equal(calls.some(call => call[1] === 'resume'), false, JSON.stringify(calls))
  assert.equal(calls.some(call => call[1] === 'pause'), false, JSON.stringify(calls))
  assert.equal(player.state().paused, true)
})
