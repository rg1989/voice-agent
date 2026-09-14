import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { playerLaunchArgs } from '../src/media/browsers.mjs'
import { DevToolsPipe } from '../src/media/devtools-pipe.mjs'
import { playerCommandAllowed, startPlayerFullscreen } from '../src/media/fullscreen.mjs'
import {
  MediaError,
  MediaPlayer,
  PLAYER_BROWSER_IDS,
  playerUrlAllowed,
} from '../src/media/player.mjs'
import { MediaTalkPause } from '../src/voice/media-talk-pause.mjs'
import { FakeDevToolsBrowser } from './fixtures/fake-devtools-browser.mjs'
import { fakePlayerBrowser } from './fixtures/fake-player-page.mjs'

const EDGE = {
  id: 'edge',
  label: 'Microsoft Edge',
  binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  bundleId: 'com.microsoft.edgemac',
}
const CHROMIUM = { id: 'chromium', label: 'Chromium', binary: '/usr/lib/chromium/chromium', bundleId: null }
const A = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'A', service: 'youtube' }
const B = { url: 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ', title: 'B', service: 'youtube_music' }
const code = expected => error => error instanceof MediaError && error.code === expected
const tick = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(2)
  }
}

class FakeChild extends EventEmitter {
  constructor(pid, { ignoreTerm, stdio }) {
    super()
    this.pid = pid
    this.signals = []
    // Whether the browser's fd 3 was still open when each signal went out.
    this.inputOpenAtSignal = []
    this.ignoreTerm = ignoreTerm
    this.stdio = Array.isArray(stdio)
      ? stdio.map(kind => (kind === 'pipe' ? new PassThrough() : null))
      : [null, null, null]
  }

  kill(signal) {
    this.signals.push(signal)
    const input = this.stdio[3]
    this.inputOpenAtSignal.push(input ? !input.destroyed && !input.writableEnded : null)
    if (!(signal === 'SIGTERM' && this.ignoreTerm)) setImmediate(() => this.emit('exit', null, signal))
    return true
  }
}

// Chromium's side of Browser.close on a playback child's pipe. The handler
// returns `reply` ({} for success, { error } for an error reply, undefined for
// none). `endPipe` ends fd 4 first and `exit` makes the child exit after
// `exitAfterMs`, as Chromium's silent exit does. signalsAtClose shows which
// signals had already gone out when the command arrived.
function browserClose(child, { reply = {}, exit = true, endPipe = false, exitAfterMs = 5 } = {}) {
  const signalsAtClose = []
  const browser = new FakeDevToolsBrowser({ toBrowser: child.stdio[3], fromBrowser: child.stdio[4] })
  browser.handlers = {
    'Browser.close': () => {
      signalsAtClose.push([...child.signals])
      if (endPipe) child.stdio[4].end()
      if (exit) setTimeout(() => child.emit('exit', 0, null), exitAfterMs)
      return reply
    },
  }
  return { browser, signalsAtClose }
}

function harness(t, {
  platform = 'darwin',
  mediaBrowser = 'auto',
  detected = [EDGE],
  execFileImpl,
  ignoreTerm = false,
  spawnError = null,
  readLinkImpl,
  killImpl,
  fullscreenImpl = null,
  closeGraceMs = 20,
} = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'qwaudio-player-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  const spawned = []
  const events = []
  const fullscreen = []
  const logs = []
  let nextPid = 500
  const player = new MediaPlayer({
    getSettings: () => ({ mediaBrowser, mediaReturnToAssistant: false, mediaPauseWhileTalking: true }),
    configDir,
    platform,
    detectBrowsers: options => {
      assert.equal(options.platform, platform)
      return detected
    },
    spawnImpl: (binary, args, options) => {
      nextPid += 1
      const child = new FakeChild(nextPid, { ignoreTerm, stdio: options?.stdio })
      spawned.push({ binary, args, options, child })
      setImmediate(() => (spawnError ? child.emit('error', spawnError) : child.emit('spawn')))
      return child
    },
    execFileImpl,
    logger: {
      info: (event, fields) => logs.push([event, fields]),
      warn: (event, fields) => logs.push([event, fields]),
    },
    stopTimeoutMs: 30,
    closeGraceMs,
    readLinkImpl,
    killImpl,
    // By default a recorder stands in for the routine. signalsAtDispose shows
    // whether it ended before the browser got a signal.
    fullscreenImpl: fullscreenImpl || (options => {
      const routine = {
        options,
        eventsAtStart: events.map(([name]) => name),
        disposed: false,
        signalsAtDispose: null,
        dispose() {
          this.disposed = true
          this.signalsAtDispose = [...spawned.at(-1).child.signals]
        },
      }
      fullscreen.push(routine)
      return routine
    }),
  })
  for (const name of ['started', 'stopped', 'paused', 'resumed']) {
    player.on(name, payload => events.push([name, payload]))
  }
  const logged = event => logs.filter(([name]) => name === event).map(([, fields]) => fields)
  return { player, spawned, events, configDir, fullscreen, logs, logged }
}

test('exports the contract browser ids and accepts only https player hosts', () => {
  assert.deepEqual(PLAYER_BROWSER_IDS, ['auto', 'chrome', 'edge', 'chromium', 'brave'])
  for (const url of [
    'https://www.youtube.com/watch?v=x',
    'https://youtube.com/watch?v=x',
    'https://m.youtube.com/watch?v=x',
    'https://music.youtube.com/watch?v=x',
    'https://www.netflix.com/watch/80100172',
  ]) assert.equal(playerUrlAllowed(url), true, url)
  for (const url of [
    'http://www.youtube.com/watch?v=x',
    'https://www.youtube.com.evil.example/watch',
    'https://evil.example/',
    'https://user:pass@www.youtube.com/',
    'https://www.youtube.com:8443/',
    'file:///etc/passwd',
    'not a url',
    '',
  ]) assert.equal(playerUrlAllowed(url), false, url)
})

test('play launches the player browser in its own profile folder', async t => {
  const kit = harness(t)
  const result = await kit.player.play(A)
  assert.deepEqual(result, { status: 'playing', title: 'A', url: A.url, service: 'youtube', browser: 'edge' })
  const profileDir = join(kit.configDir, 'player', 'edge')
  assert.equal(existsSync(profileDir), true)
  assert.equal(kit.spawned.length, 1)
  assert.equal(kit.spawned[0].binary, EDGE.binary)
  assert.deepEqual(kit.spawned[0].args, playerLaunchArgs({ platform: 'darwin', profileDir, url: A.url, devtoolsPipe: true }))
  const state = kit.player.state()
  assert.deepEqual({ ...state, startedAt: typeof state.startedAt }, {
    active: true,
    paused: false,
    title: 'A',
    url: A.url,
    service: 'youtube',
    browser: 'edge',
    pid: 501,
    startedAt: 'number',
    controlSerial: 0,
  })
  assert.deepEqual(kit.events, [['started', state]])
})

test('refuses URLs outside the allowed hosts and missing browsers without launching', async t => {
  const kit = harness(t)
  await assert.rejects(kit.player.play({ ...A, url: 'https://evil.example/watch' }), code('url_not_allowed'))
  const none = harness(t, { detected: [] })
  await assert.rejects(none.player.play(A), code('no_browser'))
  const named = harness(t, { mediaBrowser: 'chrome', detected: [EDGE] })
  await assert.rejects(named.player.play(A), code('no_browser'))
  assert.equal(kit.spawned.length + none.spawned.length + named.spawned.length, 0)
})

test('a failed launch is launch_failed and leaves nothing active', async t => {
  const kit = harness(t, { spawnError: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) })
  await assert.rejects(kit.player.play(A), code('launch_failed'))
  assert.equal(kit.player.state().active, false)
  assert.deepEqual(kit.events, [])
})

test('new playback replaces the current one', async t => {
  const kit = harness(t)
  await kit.player.play(A)
  await kit.player.play(B)
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  assert.deepEqual(kit.events.map(([name, payload]) => (name === 'stopped' ? [name, payload] : [name])), [
    ['started'],
    ['stopped', { reason: 'replaced', title: 'A', service: 'youtube' }],
    ['started'],
  ])
  assert.equal(kit.player.state().pid, 502)
  assert.equal(kit.player.state().url, B.url)
})

test('concurrent play calls run one after the other', async t => {
  const kit = harness(t)
  await Promise.all([kit.player.play(A), kit.player.play(B)])
  assert.equal(kit.spawned.length, 2)
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  assert.equal(kit.player.state().url, B.url)
})

test('stop sends SIGTERM, then SIGKILL when the browser does not exit in time', async t => {
  const kit = harness(t, { ignoreTerm: true })
  await kit.player.play(A)
  assert.deepEqual(await kit.player.stop(), { status: 'stopped' })
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(kit.events.at(-1), ['stopped', { reason: 'user', title: 'A', service: 'youtube' }])
  assert.equal(kit.player.state().active, false)
  assert.deepEqual(await kit.player.stop(), { status: 'idle' })
})

test('closing the player window reports stopped with reason exited', async t => {
  const kit = harness(t)
  await kit.player.play(A)
  kit.spawned[0].child.emit('exit', 0, null)
  await tick()
  assert.equal(kit.player.state().active, false)
  assert.deepEqual(kit.events.at(-1), ['stopped', { reason: 'exited', title: 'A', service: 'youtube' }])
  assert.deepEqual(await kit.player.stop(), { status: 'idle' })
})

test('control drives the transport of the launched PID and reports pause changes once', async t => {
  const calls = []
  const kit = harness(t, {
    platform: 'linux',
    detected: [CHROMIUM],
    execFileImpl: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: args[0] === '-l' ? 'chromium.instance501\n' : '' }
    },
  })
  await kit.player.play(A)
  assert.deepEqual(await kit.player.control('pause'), { status: 'ok', action: 'pause' })
  assert.equal(kit.player.state().paused, true)
  await kit.player.control('pause')
  assert.deepEqual(await kit.player.control('resume'), { status: 'ok', action: 'resume' })
  await kit.player.control('next')
  assert.deepEqual(kit.events.map(([name]) => name), ['started', 'paused', 'resumed'])
  assert.deepEqual(calls.filter(call => call[1] === '-p'), [
    ['playerctl', '-p', 'chromium.instance501', 'pause'],
    ['playerctl', '-p', 'chromium.instance501', 'pause'],
    ['playerctl', '-p', 'chromium.instance501', 'play'],
    ['playerctl', '-p', 'chromium.instance501', 'next'],
  ])
  await assert.rejects(kit.player.control('rewind'), TypeError)
  await assert.rejects(kit.player.control('constructor'), TypeError)
})

// The Gateway's record says playing, but the user paused the video in the page
// (click, Space, a media key) or it ended: a talk turn must not start it again.
for (const [platform, detected, realState] of [
  ['darwin', EDGE, { 'media-control get': JSON.stringify({
    bundleIdentifier: 'com.microsoft.edgemac',
    processIdentifier: 501,
    playing: false,
  }) }],
  ['linux', CHROMIUM, { 'playerctl -l': 'chromium.instance501\n', 'playerctl -p chromium.instance501 status': 'Paused\n' }],
]) {
  test(`a browser video paused outside the Gateway is not started again by a talk turn (${platform})`, async t => {
    const calls = []
    const kit = harness(t, {
      platform,
      detected: [detected],
      execFileImpl: async (file, args) => {
        calls.push([file, ...args])
        return { stdout: realState[[file, ...args].join(' ')] ?? '' }
      },
    })
    await kit.player.play(A)
    await assert.rejects(kit.player.control('pause', { source: 'talk_pause' }), code('not_playing'))
    const sent = () => calls.map(call => call.at(-1))
    assert.equal(sent().includes('pause'), false, JSON.stringify(calls))
    // The record is left alone: the user may resume in the page, and the next
    // talk pause must still pause it.
    assert.equal(kit.player.state().paused, false)
    assert.deepEqual(kit.events.map(([name]) => name), ['started'])
    const pause = new MediaTalkPause({ player: kit.player, getSettings: () => ({ mediaPauseWhileTalking: true }) })
    pause.speechStarted()
    await pause.turnEnded()
    assert.equal(sent().includes('play'), false, JSON.stringify(calls))
    assert.equal(sent().includes('pause'), false, JSON.stringify(calls))
  })
}

test('control counts pauses from anyone but pause while talking', async t => {
  const kit = harness(t, {
    platform: 'linux',
    detected: [CHROMIUM],
    execFileImpl: async (file, args) => ({
      stdout: args[0] === '-l' ? 'chromium.instance501\n' : args.at(-1) === 'status' ? 'Playing\n' : '',
    }),
  })
  assert.equal(kit.player.state().controlSerial, 0)
  await kit.player.play(A)
  await kit.player.control('pause', { source: 'talk_pause' })
  await kit.player.control('resume', { source: 'talk_pause' })
  assert.equal(kit.player.state().controlSerial, 0)
  await kit.player.control('pause')
  assert.equal(kit.player.state().controlSerial, 1)
  // A second pause while already paused raises no 'paused' event but still counts.
  await kit.player.control('pause', { source: 'backend' })
  assert.equal(kit.player.state().controlSerial, 2)
  assert.deepEqual(kit.events.map(([name]) => name), ['started', 'paused', 'resumed', 'paused'])
  await kit.player.control('resume')
  await kit.player.control('next')
  assert.equal(kit.player.state().controlSerial, 2)
})

test('control without playback is not_playing', async t => {
  const kit = harness(t)
  await assert.rejects(kit.player.control('pause'), code('not_playing'))
  await kit.player.setup()
  await assert.rejects(kit.player.control('pause'), code('not_playing'))
})

test('setup opens a normal window on YouTube that is not playback', async t => {
  const kit = harness(t)
  assert.deepEqual(await kit.player.setup(), { status: 'opened', browser: 'edge' })
  const { args } = kit.spawned[0]
  assert.equal(args.includes('--kiosk'), false)
  assert.equal(args.at(-1), 'https://www.youtube.com')
  assert.equal(args[0], `--user-data-dir=${join(kit.configDir, 'player', 'edge')}`)
  assert.equal(kit.player.state().active, false)
  await kit.player.play(A)
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  assert.deepEqual(kit.events.map(([name]) => name), ['started'])
})

test('a player browser left over from an earlier gateway is stopped before a new launch', async t => {
  const looked = []
  const signals = []
  let alive = true
  const kit = harness(t, {
    readLinkImpl: path => {
      looked.push(path)
      return `${hostname()}-4242`
    },
    killImpl: (pid, signal) => {
      // The spawn count shows every signal went out before the new launch.
      signals.push([pid, signal, kit.spawned.length])
      if (signal === 'SIGTERM') alive = false
      if (signal === 0 && !alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    },
    execFileImpl: async (file, args) => {
      assert.deepEqual([file, ...args], ['ps', '-ww', '-o', 'args=', '-p', '4242'])
      const profileDir = join(kit.configDir, 'player', 'edge')
      return { stdout: `${EDGE.binary} --user-data-dir=${profileDir} --kiosk ${A.url}\n` }
    },
  })
  await kit.player.play(B)
  assert.deepEqual(looked, [join(kit.configDir, 'player', 'edge', 'SingletonLock')])
  assert.deepEqual(signals, [[4242, 0, 0], [4242, 'SIGTERM', 0], [4242, 0, 0]])
  assert.equal(kit.spawned.length, 1)
  assert.equal(kit.player.state().url, B.url)
})

test('a profile lock from another host or an unrelated process is left alone', async t => {
  for (const [lock, command, expected] of [
    ['other-host.local-4242', '', []],
    [`${hostname()}-4242`, '/usr/bin/vim notes.txt', [[4242, 0]]],
  ]) {
    const signals = []
    const kit = harness(t, {
      readLinkImpl: () => lock,
      killImpl: (pid, signal) => {
        signals.push([pid, signal])
        return true
      },
      execFileImpl: async () => ({ stdout: `${command}\n` }),
    })
    await kit.player.play(A)
    assert.deepEqual(signals, expected, lock)
    assert.equal(kit.spawned.length, 1)
  }
})

test('killNow sends SIGTERM at once for a gateway process that is exiting', async t => {
  const kit = harness(t, { ignoreTerm: true })
  kit.player.killNow()
  await kit.player.play(A)
  const { browser } = browserClose(kit.spawned[0].child)
  kit.player.killNow()
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  // It only signals; the routine and the pipe end with the browser's exit.
  assert.equal(kit.fullscreen[0].disposed, false)
  assert.equal(kit.fullscreen[0].options.pipe.closed, false)
  await tick()
  assert.deepEqual(browser.calls, [])
})

test('killNow still signals a browser that is waiting out the Browser.close grace period', async t => {
  const kit = harness(t, { closeGraceMs: 5000 })
  await kit.player.play(A)
  const { child } = kit.spawned[0]
  // The browser accepts Browser.close but does not exit, as a hung or ignoring build would.
  const { browser } = browserClose(child, { exit: false })
  const started = Date.now()
  const stopping = kit.player.stop()
  await until(() => browser.calls.length === 1, 'Browser.close')
  kit.player.killNow()
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.deepEqual(await stopping, { status: 'stopped' })
  assert.ok(Date.now() - started < 1000, 'the exit ended the grace period')
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('stop and replace close the browser over its DevTools pipe and send no signal when it exits', async t => {
  const kit = harness(t, { closeGraceMs: 5000 })
  await kit.player.play(A)
  const first = browserClose(kit.spawned[0].child)
  await kit.player.play(B)
  const second = browserClose(kit.spawned[1].child)
  assert.deepEqual(await kit.player.stop(), { status: 'stopped' })
  for (const [index, { browser, signalsAtClose }] of [first, second].entries()) {
    // The browser endpoint, without a sessionId, and before any signal.
    assert.deepEqual(browser.calls, [{ id: 1, method: 'Browser.close', params: {} }])
    assert.deepEqual(signalsAtClose, [[]])
    assert.deepEqual(kit.spawned[index].child.signals, [])
  }
  assert.deepEqual(kit.events.map(([name, payload]) => (name === 'stopped' ? [name, payload.reason] : [name])), [
    ['started'],
    ['stopped', 'replaced'],
    ['started'],
    ['stopped', 'user'],
  ])
  assert.deepEqual(kit.logged('media.player.closed'), [
    { kind: 'playback', pid: 501, method: 'devtools' },
    { kind: 'playback', pid: 502, method: 'devtools' },
  ])
  assert.equal(kit.player.state().active, false)
})

test('a browser still running after the grace period gets SIGTERM, then SIGKILL after the stop timeout', async t => {
  const kit = harness(t, { closeGraceMs: 60 })
  await kit.player.play(A)
  const answered = browserClose(kit.spawned[0].child, { exit: false })
  const started = Date.now()
  await kit.player.play(B)
  // A reply alone does not end playback; only the exit does.
  assert.ok(Date.now() - started >= 50, 'waited for the grace period')
  assert.deepEqual(answered.signalsAtClose, [[]])
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  assert.deepEqual(kit.spawned[0].child.inputOpenAtSignal, [true])

  const stubborn = harness(t, { closeGraceMs: 20, ignoreTerm: true })
  await stubborn.player.play(A)
  const silent = browserClose(stubborn.spawned[0].child, { reply: undefined, exit: false })
  assert.deepEqual(await stubborn.player.stop(), { status: 'stopped' })
  assert.deepEqual(silent.signalsAtClose, [[]])
  assert.deepEqual(stubborn.spawned[0].child.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(stubborn.spawned[0].child.inputOpenAtSignal, [true, true])
  assert.deepEqual(kit.logged('media.player.closed'), [{ kind: 'playback', pid: 501, method: 'sigterm' }])
  assert.deepEqual(stubborn.logged('media.player.closed'), [{ kind: 'playback', pid: 501, method: 'sigkill' }])
})

test('a closed pipe, a refused pipe, an error reply or a pipe error goes straight to SIGTERM', async t => {
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  for (const [what, prepare, commands] of [
    ['closed', child => child.stdio[4].end(), 0],
    ['refused', child => child.stdio[2].write('ERROR: DevTools remote debugging is disallowed by the system admin.\n'), 0],
    ['error reply', () => {}, 1],
    ['pipe error while waiting', () => {}, 1],
  ]) {
    const kit = harness(t, { closeGraceMs: 5000 })
    await kit.player.play(A)
    const { child } = kit.spawned[0]
    const { browser } = browserClose(child, { reply: { error: { code: -32000, message: 'Not supported' } }, exit: false })
    if (what === 'pipe error while waiting') {
      browser.handlers['Browser.close'] = () => {
        child.stdio[3].emit('error', epipe())
      }
    }
    prepare(child)
    await tick()
    const started = Date.now()
    assert.deepEqual(await kit.player.stop(), { status: 'stopped' }, what)
    assert.ok(Date.now() - started < 1000, `${what}: no grace period`)
    assert.equal(browser.calls.length, commands, what)
    assert.deepEqual(child.signals, ['SIGTERM'], what)
    assert.deepEqual(kit.logged('media.player.closed'), [{ kind: 'playback', pid: 501, method: 'sigterm' }], what)
  }
})

test('the pipe ending while the browser exits after Browser.close sends no signal', async t => {
  const kit = harness(t, { closeGraceMs: 5000 })
  await kit.player.play(A)
  const { child } = kit.spawned[0]
  const { browser } = browserClose(child, { reply: undefined, endPipe: true, exitAfterMs: 20 })
  assert.deepEqual(await kit.player.stop(), { status: 'stopped' })
  assert.equal(browser.calls.length, 1)
  assert.deepEqual(child.signals, [])
  assert.deepEqual(kit.logged('media.player.closed'), [{ kind: 'playback', pid: 501, method: 'devtools' }])
})

test('stopping the setup window, which has no pipe, sends SIGTERM at once', async t => {
  const kit = harness(t, { closeGraceMs: 5000 })
  await kit.player.setup()
  const started = Date.now()
  assert.deepEqual(await kit.player.stop(), { status: 'stopped' })
  assert.ok(Date.now() - started < 1000, 'no grace period')
  assert.deepEqual(kit.spawned[0].child.signals, ['SIGTERM'])
  assert.deepEqual(kit.logged('media.player.closed'), [{ kind: 'setup', pid: 501, method: 'sigterm' }])
  assert.deepEqual(kit.events, [])
})

test('playback gets a private DevTools pipe and starts full screen after started; setup gets neither', async t => {
  const kit = harness(t)
  await kit.player.setup()
  assert.equal(kit.spawned[0].options.stdio, 'ignore')
  assert.deepEqual(kit.spawned[0].args.filter(arg => /remote-debugging/.test(arg)), [])
  assert.equal(kit.fullscreen.length, 0)

  await kit.player.play(A)
  const { args, options, child } = kit.spawned[1]
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'])
  assert.deepEqual(args.filter(arg => /remote-debugging/.test(arg)), ['--remote-debugging-pipe'])
  assert.equal(kit.fullscreen.length, 1)
  const [{ options: started, eventsAtStart }] = kit.fullscreen
  assert.deepEqual(eventsAtStart, ['started'])
  assert.equal(started.urlAllowed, playerUrlAllowed)
  assert.equal(typeof started.logger.warn, 'function')
  assert.equal(started.pipe instanceof DevToolsPipe, true)

  // The pipe writes to the browser's fd 3, reads its fd 4, and refuses
  // anything outside the player's allowlist.
  const written = []
  child.stdio[3].on('data', chunk => written.push(String(chunk)))
  const reply = started.pipe.send('Target.getTargets', {})
  await tick()
  assert.deepEqual(written, ['{"id":1,"method":"Target.getTargets","params":{}}\0'])
  child.stdio[4].write('{"id":1,"result":{"targetInfos":[]}}\0')
  assert.deepEqual(await reply, { targetInfos: [] })
  await assert.rejects(started.pipe.send('Storage.getCookies', {}), { code: 'not_allowed' })
})

test('replace, stop and exit end the full-screen routine and close the pipe before any signal', async t => {
  const kit = harness(t)
  await kit.player.play(A)
  await kit.player.play(B)
  const [first] = kit.fullscreen
  assert.equal(first.disposed, true)
  assert.deepEqual(first.signalsAtDispose, [])
  assert.equal(first.options.pipe.closeReason, 'replaced')
  assert.deepEqual(kit.spawned[0].child.inputOpenAtSignal, [true])
  assert.equal(kit.spawned[0].child.stdio.slice(2).every(stream => stream.destroyed), true)

  await kit.player.stop()
  const second = kit.fullscreen[1]
  assert.equal(second.disposed, true)
  assert.deepEqual(second.signalsAtDispose, [])
  assert.equal(second.options.pipe.closeReason, 'user')
  assert.deepEqual(kit.spawned[1].child.inputOpenAtSignal, [true])

  await kit.player.play(A)
  const third = kit.fullscreen[2]
  kit.spawned[2].child.emit('exit', 0, null)
  await tick()
  assert.equal(third.disposed, true)
  assert.equal(third.options.pipe.closeReason, 'exited')
  assert.equal(kit.spawned[2].child.stdio.slice(2).every(stream => stream.destroyed), true)
  assert.deepEqual(kit.events.at(-1), ['stopped', { reason: 'exited', title: 'A', service: 'youtube' }])
})

test('pipe errors and a pipe the browser closed never stop playback or reach the gateway as errors', async t => {
  const kit = harness(t)
  await kit.player.play(A)
  const { child } = kit.spawned[0]
  for (const fd of [2, 3, 4]) {
    child.stdio[fd].emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
  }
  child.stdio[4].end()
  await tick()
  assert.equal(kit.fullscreen[0].options.pipe.closed, true)
  assert.equal(kit.player.state().active, true)
  assert.deepEqual(kit.events.map(([name]) => name), ['started'])
  assert.deepEqual(child.signals, [])
})

test('with the real routine, playback goes full screen over the child pipe and stop ends it', async t => {
  let fake = null
  const kit = harness(t, {
    fullscreenImpl: options => {
      const { child } = kit.spawned.at(-1)
      fake = fakePlayerBrowser({ url: A.url, toBrowser: child.stdio[3], fromBrowser: child.stdio[4], playsAfterPolls: 1 })
      return startPlayerFullscreen({
        ...options,
        timing: { pollMs: 5, playDeadlineMs: 1000, attempts: 2, retryMs: 5, keySettleMs: 5 },
      })
    },
  })
  await kit.player.play(A)
  await until(() => fake.page.fullscreen, 'the video full screen')
  assert.deepEqual(fake.page.evaluations, ['state', 'state', 'button'])
  assert.equal(
    fake.browser.calls.every(call => playerCommandAllowed(call.method, call.params, { sessionId: call.sessionId })),
    true,
  )
  await kit.player.stop()
  const calls = fake.browser.calls.length
  await sleep(30)
  assert.equal(fake.browser.calls.length, calls)
})
