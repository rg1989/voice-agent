import assert from 'node:assert/strict'
import test from 'node:test'
import { MediaError } from '../src/media/media-error.mjs'
import { createTransport } from '../src/media/transport.mjs'

function fakeExec(responses) {
  const calls = []
  const execFileImpl = async (file, args, options) => {
    calls.push([file, ...args])
    assert.equal(options.timeout, 5000)
    const response = responses[[file, ...args].join(' ')]
    if (response instanceof Error) throw response
    return { stdout: response ?? '', stderr: '' }
  }
  return { calls, execFileImpl }
}

const unavailable = error => error instanceof MediaError && error.code === 'transport_unavailable'

test('Linux commands target the MPRIS player of the launched browser PID', async () => {
  const exec = fakeExec({ 'playerctl -l': 'chromium.instance111\nbrave.instance4242\nspotify\n' })
  const transport = createTransport({ platform: 'linux', pid: 4242, execFileImpl: exec.execFileImpl })
  await transport.pause()
  await transport.resume()
  await transport.next()
  await transport.previous()
  assert.deepEqual(exec.calls.filter(call => call[1] === '-p'), [
    ['playerctl', '-p', 'brave.instance4242', 'pause'],
    ['playerctl', '-p', 'brave.instance4242', 'play'],
    ['playerctl', '-p', 'brave.instance4242', 'next'],
    ['playerctl', '-p', 'brave.instance4242', 'previous'],
  ])
})

test('Linux relative seek reads the position and seeks to an absolute one, never below zero', async () => {
  const exec = fakeExec({
    'playerctl -l': 'chromium.instance7\n',
    'playerctl -p chromium.instance7 position': '100.5\n',
  })
  const transport = createTransport({ platform: 'linux', pid: 7, execFileImpl: exec.execFileImpl })
  await transport.seekRelative(-30)
  assert.deepEqual(exec.calls.at(-1), ['playerctl', '-p', 'chromium.instance7', 'position', '70.5'])
  await transport.seekRelative(-500)
  assert.deepEqual(exec.calls.at(-1), ['playerctl', '-p', 'chromium.instance7', 'position', '0'])
})

test('Linux refuses to act on another player or without playerctl', async () => {
  const other = fakeExec({ 'playerctl -l': 'chromium.instance111\n' })
  await assert.rejects(
    createTransport({ platform: 'linux', pid: 222, execFileImpl: other.execFileImpl }).pause(),
    unavailable,
  )
  assert.deepEqual(other.calls, [['playerctl', '-l']])
  const missing = fakeExec({
    'playerctl -l': Object.assign(new Error('spawn playerctl ENOENT'), { code: 'ENOENT' }),
  })
  await assert.rejects(
    createTransport({ platform: 'linux', pid: 1, execFileImpl: missing.execFileImpl }).pause(),
    error => unavailable(error) && /playerctl is not installed/.test(error.message),
  )
})

test('macOS commands go to media-control only while the player browser is Now Playing', async () => {
  const exec = fakeExec({
    'media-control get': JSON.stringify({ bundleIdentifier: 'com.microsoft.edgemac', playing: true, elapsedTime: 42 }),
    // elapsedTime is from the last Now Playing update; --now adds
    // elapsedTimeNow, estimated for this moment.
    'media-control get --now': JSON.stringify({
      bundleIdentifier: 'com.microsoft.edgemac',
      playing: true,
      elapsedTime: 42,
      elapsedTimeNow: 50.5,
    }),
  })
  const transport = createTransport({
    platform: 'darwin',
    pid: 900,
    bundleId: 'com.microsoft.edgemac',
    execFileImpl: exec.execFileImpl,
  })
  await transport.pause()
  await transport.resume()
  await transport.next()
  await transport.previous()
  await transport.seekRelative(30)
  assert.deepEqual(exec.calls.filter(call => call[1] !== 'get'), [
    ['media-control', 'pause'],
    ['media-control', 'play'],
    ['media-control', 'next-track'],
    ['media-control', 'previous-track'],
    ['media-control', 'seek', '80.5'],
  ])
  // Only the seek reads the position with --now; the rest only check the owner.
  assert.deepEqual(exec.calls.filter(call => call[1] === 'get'), [
    ['media-control', 'get'],
    ['media-control', 'get'],
    ['media-control', 'get'],
    ['media-control', 'get'],
    ['media-control', 'get', '--now'],
  ])
})

test('macOS accepts the parent application bundle id as the player', async () => {
  const exec = fakeExec({
    'media-control get': JSON.stringify({
      bundleIdentifier: 'com.google.Chrome.helper',
      parentApplicationBundleIdentifier: 'com.google.Chrome',
    }),
  })
  await createTransport({ platform: 'darwin', bundleId: 'com.google.Chrome', execFileImpl: exec.execFileImpl }).pause()
  assert.deepEqual(exec.calls.at(-1), ['media-control', 'pause'])
})

test('macOS sends nothing when another app owns Now Playing or nothing plays', async () => {
  for (const stdout of [JSON.stringify({ bundleIdentifier: 'com.spotify.client' }), 'null', 'not json']) {
    const exec = fakeExec({ 'media-control get': stdout })
    await assert.rejects(
      createTransport({ platform: 'darwin', bundleId: 'com.google.Chrome', execFileImpl: exec.execFileImpl }).pause(),
      unavailable,
    )
    assert.deepEqual(exec.calls, [['media-control', 'get']])
  }
})

test('macOS refuses to act when processIdentifier names a different process than the player', async () => {
  const exec = fakeExec({
    'media-control get': JSON.stringify({
      bundleIdentifier: 'com.google.Chrome',
      processIdentifier: 55555,
    }),
  })
  await assert.rejects(
    createTransport({ platform: 'darwin', pid: 69216, bundleId: 'com.google.Chrome', execFileImpl: exec.execFileImpl }).pause(),
    error => unavailable(error) && /69216/.test(error.message) && /55555/.test(error.message),
  )
  assert.deepEqual(exec.calls, [['media-control', 'get']])
})

test('macOS sends the command when bundle id and processIdentifier both match the player', async () => {
  const exec = fakeExec({
    'media-control get': JSON.stringify({
      bundleIdentifier: 'com.google.Chrome',
      processIdentifier: 69216,
    }),
  })
  await createTransport({
    platform: 'darwin',
    pid: 69216,
    bundleId: 'com.google.Chrome',
    execFileImpl: exec.execFileImpl,
  }).pause()
  assert.deepEqual(exec.calls.at(-1), ['media-control', 'pause'])
})

test('macOS falls back to bundle-id-only matching when processIdentifier is absent', async () => {
  const exec = fakeExec({
    'media-control get': JSON.stringify({ bundleIdentifier: 'com.google.Chrome' }),
  })
  await createTransport({
    platform: 'darwin',
    pid: 69216,
    bundleId: 'com.google.Chrome',
    execFileImpl: exec.execFileImpl,
  }).pause()
  assert.deepEqual(exec.calls.at(-1), ['media-control', 'pause'])
})

test('Linux reports whether the player of the launched browser PID really plays', async () => {
  for (const [status, playing] of [['Playing\n', true], ['Paused\n', false], ['Stopped\n', false]]) {
    const exec = fakeExec({
      'playerctl -l': 'chromium.instance111\nchromium.instance7\n',
      'playerctl -p chromium.instance7 status': status,
    })
    assert.equal(await createTransport({ platform: 'linux', pid: 7, execFileImpl: exec.execFileImpl }).playing(), playing)
    assert.deepEqual(exec.calls.at(-1), ['playerctl', '-p', 'chromium.instance7', 'status'])
  }
})

test('macOS reports whether the player browser really plays, only while it is Now Playing', async () => {
  for (const playing of [true, false]) {
    const exec = fakeExec({
      'media-control get': JSON.stringify({ bundleIdentifier: 'com.google.Chrome', processIdentifier: 69216, playing }),
    })
    const transport = createTransport({
      platform: 'darwin',
      pid: 69216,
      bundleId: 'com.google.Chrome',
      execFileImpl: exec.execFileImpl,
    })
    assert.equal(await transport.playing(), playing)
    assert.deepEqual(exec.calls, [['media-control', 'get']])
  }
  const other = fakeExec({
    'media-control get': JSON.stringify({ bundleIdentifier: 'com.google.Chrome', processIdentifier: 55555, playing: true }),
  })
  await assert.rejects(
    createTransport({ platform: 'darwin', pid: 69216, bundleId: 'com.google.Chrome', execFileImpl: other.execFileImpl }).playing(),
    unavailable,
  )
})

test('other platforms have no transport', async () => {
  await assert.rejects(createTransport({ platform: 'win32', pid: 1 }).resume(), unavailable)
  await assert.rejects(createTransport({ platform: 'win32', pid: 1 }).playing(), unavailable)
})
