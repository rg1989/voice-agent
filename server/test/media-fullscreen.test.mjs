import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'
import { DevToolsPipe } from '../src/media/devtools-pipe.mjs'
import {
  FULLSCREEN_TIMING,
  PAGE_SCRIPTS,
  playerCommandAllowed,
  startPlayerFullscreen,
  videoKey,
} from '../src/media/fullscreen.mjs'
import { playerUrlAllowed } from '../src/media/player.mjs'
import { fakePlayerBrowser } from './fixtures/fake-player-page.mjs'

const FAST = Object.freeze({ pollMs: 5, playDeadlineMs: 300, attempts: 2, retryMs: 5, keySettleMs: 5 })
const WATCH = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(2)
  }
}

function run(t, { timing = FAST, pipeTimeoutMs = 1000, stderr = null, url = WATCH, ...page } = {}) {
  const fake = fakePlayerBrowser({ url, ...page })
  const pipe = new DevToolsPipe({
    toBrowser: fake.browser.toBrowser,
    fromBrowser: fake.browser.fromBrowser,
    stderr,
    allow: playerCommandAllowed,
    timeoutMs: pipeTimeoutMs,
  })
  const logs = []
  const logger = {
    info: (event, fields) => logs.push(['info', event, fields]),
    warn: (event, fields) => logs.push(['warn', event, fields]),
  }
  const routine = startPlayerFullscreen({ pipe, logger, urlAllowed: playerUrlAllowed, timing })
  t.after(() => {
    routine.dispose()
    pipe.close('test_done')
  })
  const logged = event => logs.filter(entry => entry[1] === event)
  return { ...fake, pipe, logs, logged, routine }
}

test('by default it polls every 500 ms for up to 45 s and makes three attempts', () => {
  assert.deepEqual(FULLSCREEN_TIMING, { pollMs: 500, playDeadlineMs: 45_000, attempts: 3, retryMs: 2000, keySettleMs: 1000 })
})

test('videoKey names the video of a watch URL and nothing else', () => {
  for (const [url, key] of [
    ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'youtube:aqz-KE-bpKQ'],
    ['https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=42s&pp=abc', 'youtube:aqz-KE-bpKQ'],
    ['https://youtube.com/watch?v=aqz-KE-bpKQ#comments', 'youtube:aqz-KE-bpKQ'],
    ['https://m.youtube.com/watch?v=aqz-KE-bpKQ', 'youtube:aqz-KE-bpKQ'],
    ['https://music.youtube.com/watch?v=BSTsnWoslP4&list=RDAMVM', 'youtube_music:BSTsnWoslP4'],
    ['https://www.netflix.com/watch/80100172?trackId=14170286', 'netflix:80100172'],
    ['https://www.youtube.com/', null],
    ['https://www.youtube.com/watch', null],
    ['https://www.youtube.com/results?search_query=big+buck+bunny', null],
    ['https://www.netflix.com/browse', null],
    ['https://consent.youtube.com/m?continue=https://www.youtube.com/watch?v=aqz-KE-bpKQ', null],
    ['http://www.youtube.com/watch?v=aqz-KE-bpKQ', null],
    ['about:blank', null],
    ['', null],
  ]) assert.equal(videoKey(url), key, url)
})

test('the pipe allows only discovery, attaching, the fixed page scripts, the f key and closing the browser', () => {
  const page = { sessionId: 'S1' }
  const browser = {}
  const evaluate = (expression, userGesture, extra = {}) => ({
    expression, awaitPromise: true, returnByValue: true, userGesture, ...extra,
  })
  for (const [method, params, options] of [
    ['Target.setDiscoverTargets', { discover: true }, browser],
    ['Target.getTargets', {}, browser],
    ['Target.attachToTarget', { targetId: 'T1', flatten: true }, browser],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.state, false), page],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.button, true), page],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.element, true), page],
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' }, page],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 }, page],
    ['Browser.close', {}, browser],
  ]) assert.equal(playerCommandAllowed(method, params, options), true, method)
  for (const [method, params, options] of [
    ['Storage.getCookies', {}, browser],
    ['Network.getAllCookies', {}, browser],
    ['Network.getCookies', {}, page],
    ['Network.enable', {}, page],
    ['Page.navigate', { url: 'https://evil.example/' }, page],
    ['Browser.close', {}, page],
    ['Browser.close', { force: true }, browser],
    ['Browser.crash', {}, browser],
    ['Target.createTarget', { url: 'https://evil.example/' }, browser],
    ['Target.setDiscoverTargets', { discover: true, filter: [{}] }, browser],
    ['Target.setDiscoverTargets', { discover: true }, page],
    ['Target.attachToTarget', { targetId: 'T1' }, browser],
    ['Target.attachToTarget', { targetId: 'T1', flatten: true, waitForDebuggerOnStart: true }, browser],
    ['Runtime.evaluate', evaluate('document.cookie', false), page],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.state, true), page],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.button, false), page],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.button, true), browser],
    ['Runtime.evaluate', evaluate(PAGE_SCRIPTS.button, true, { includeCommandLineAPI: true }), page],
    ['Runtime.callFunctionOn', { functionDeclaration: 'function () {}' }, page],
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, text: 'g' }, page],
    ['Input.dispatchKeyEvent', { type: 'char', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' }, page],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 }, browser],
    ['Input.insertText', { text: 'f' }, page],
  ]) assert.equal(playerCommandAllowed(method, params, options), false, `${method} ${JSON.stringify(params)}`)
  assert.equal(playerCommandAllowed('Target.getTargets', null), false)
})

const playingVideo = (extra = {}) => ({ paused: false, readyState: 4, currentTime: 3, ...extra })

function fakeDocument({ videos = [], button = null, player = null, fullscreen = false, activeTag = 'BODY' } = {}) {
  const listeners = new Set()
  const document = {
    fullscreenElement: fullscreen ? { id: 'already' } : null,
    activeElement: { tagName: activeTag, isContentEditable: false },
    documentElement: null,
    clicks: 0,
    querySelectorAll: selector => (selector === 'video' ? videos : []),
    querySelector: selector => ({
      '#movie_player .ytp-fullscreen-button': button,
      '[data-uia="control-fullscreen-enter"]': button,
      '#movie_player': player,
      'ytmusic-player': player,
      ':root': document.documentElement,
    })[selector] ?? null,
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    enter: element => {
      document.fullscreenElement = element
      for (const listener of [...listeners]) listener()
    },
  }
  return document
}

function fullscreenable(document, id, { refuse = false } = {}) {
  const element = {
    id,
    requestFullscreen: () => {
      if (refuse) return Promise.reject(Object.assign(new Error('Permissions check failed'), { name: 'NotAllowedError' }))
      document.enter(element)
      return Promise.resolve()
    },
  }
  return element
}

async function inPage(mode, href, document) {
  const value = await vm.runInNewContext(PAGE_SCRIPTS[mode], { location: new URL(href), document, setTimeout, clearTimeout })
  return JSON.parse(JSON.stringify(value))
}

test('the page scripts touch nothing on a page outside the player hosts', async () => {
  const untouchable = new Proxy({}, { get: () => assert.fail('the page script read the DOM') })
  for (const href of ['https://consent.youtube.com/m', 'https://evil.example/watch?v=x', 'http://www.youtube.com/watch?v=x', 'about:blank']) {
    for (const mode of ['state', 'button', 'element']) {
      assert.deepEqual(await inPage(mode, href, untouchable), {
        service: null, hasVideo: false, playing: false, fullscreen: false, typing: false, method: null,
      }, `${mode} ${href}`)
    }
  }
})

test('state reads the playing video, full screen and a focused text field without changing anything', async () => {
  const document = fakeDocument({ videos: [playingVideo({ paused: true }), playingVideo()], activeTag: 'INPUT' })
  assert.deepEqual(await inPage('state', WATCH, document), {
    service: 'youtube', hasVideo: true, playing: true, fullscreen: false, typing: true, method: null,
  })
  const loading = fakeDocument({ videos: [playingVideo({ readyState: 1, currentTime: 0 })] })
  assert.equal((await inPage('state', 'https://www.netflix.com/watch/80100172', loading)).playing, false)
})

test('button clicks the site control once, never while full screen or before the video plays', async () => {
  const document = fakeDocument({ videos: [playingVideo()] })
  const player = fullscreenable(document, 'movie_player')
  document.querySelector = (original => selector => (
    selector === '#movie_player .ytp-fullscreen-button'
      ? { click: () => { document.clicks += 1; document.enter(player) } }
      : original(selector)
  ))(document.querySelector)
  assert.deepEqual(await inPage('button', WATCH, document), {
    service: 'youtube', hasVideo: true, playing: true, fullscreen: true, typing: false, method: 'button',
  })
  assert.equal((await inPage('button', WATCH, document)).method, null)
  assert.equal(document.clicks, 1)
  const idle = fakeDocument({ videos: [playingVideo({ paused: true })], button: { click: () => assert.fail('clicked') } })
  assert.equal((await inPage('button', WATCH, idle)).method, null)
  const music = fakeDocument({ videos: [playingVideo()] })
  assert.equal((await inPage('button', 'https://music.youtube.com/watch?v=BSTsnWoslP4', music)).method, 'button_missing')
})

test('element asks the site player element, or the whole Netflix page, for full screen', async () => {
  const youtube = fakeDocument({ videos: [playingVideo()] })
  const player = fullscreenable(youtube, 'movie_player')
  youtube.querySelector = selector => (selector === '#movie_player' ? player : null)
  const entered = await inPage('element', WATCH, youtube)
  assert.equal(entered.method, 'element')
  assert.equal(entered.fullscreen, true)
  assert.equal(youtube.fullscreenElement, player)

  const netflix = fakeDocument({ videos: [playingVideo()] })
  netflix.documentElement = fullscreenable(netflix, 'root')
  assert.equal((await inPage('element', 'https://www.netflix.com/watch/80100172', netflix)).fullscreen, true)
  assert.equal(netflix.fullscreenElement.id, 'root')

  const bare = fakeDocument()
  const parent = fullscreenable(bare, 'video-parent')
  bare.querySelectorAll = selector => (selector === 'video' ? [playingVideo({ parentElement: parent })] : [])
  assert.equal((await inPage('element', WATCH, bare)).fullscreen, true)
  assert.equal(bare.fullscreenElement, parent)

  const refused = fakeDocument({ videos: [playingVideo()] })
  const locked = fullscreenable(refused, 'movie_player', { refuse: true })
  refused.querySelector = selector => (selector === '#movie_player' ? locked : null)
  assert.deepEqual(await inPage('element', WATCH, refused), {
    service: 'youtube', hasVideo: true, playing: true, fullscreen: false, typing: false, method: 'element', error: 'NotAllowedError',
  })
})

test('waits until the video plays, then clicks the site button once', async t => {
  const kit = run(t, { playsAfterPolls: 2 })
  await until(() => kit.logged('media.fullscreen.entered').length === 1, 'entered')
  assert.deepEqual(kit.logged('media.fullscreen.entered')[0], [
    'info', 'media.fullscreen.entered', { service: 'youtube', method: 'button', attempt: 1 },
  ])
  assert.deepEqual(kit.page.evaluations, ['state', 'state', 'state', 'button'])
  assert.deepEqual(kit.browser.methods().slice(0, 2), ['Target.setDiscoverTargets', 'Target.getTargets'])
  const attaches = kit.browser.calls.filter(call => call.method === 'Target.attachToTarget')
  assert.deepEqual(attaches.map(call => [call.params, call.sessionId]), [[{ targetId: 'page-1', flatten: true }, undefined]])
  const evaluations = kit.browser.calls.filter(call => call.method === 'Runtime.evaluate')
  assert.equal(evaluations.every(call => call.sessionId === 'session-page-1'), true)
  assert.deepEqual(evaluations.map(call => call.params.userGesture), [false, false, false, true])
  assert.equal(kit.page.fullscreen, true)
  await sleep(30)
  assert.equal(kit.page.evaluations.length, 4)
})

test('without a working button it presses f, then asks the player element', async t => {
  const keyed = run(t, { button: 'missing' })
  await until(() => keyed.logged('media.fullscreen.entered').length === 1, 'entered by key')
  assert.deepEqual(keyed.logged('media.fullscreen.entered')[0][2], { service: 'youtube', method: 'key', attempt: 1 })
  assert.deepEqual(keyed.page.keys, ['keyDown', 'keyUp'])
  const down = keyed.browser.calls.find(call => call.method === 'Input.dispatchKeyEvent')
  assert.deepEqual(down.params, { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' })
  assert.equal(down.sessionId, 'session-page-1')

  const element = run(t, { button: 'broken', key: 'ignored' })
  await until(() => element.logged('media.fullscreen.entered').length === 1, 'entered by element')
  assert.deepEqual(element.logged('media.fullscreen.entered')[0][2], { service: 'youtube', method: 'element', attempt: 1 })
  assert.deepEqual(element.page.evaluations, ['state', 'button', 'state', 'state', 'element'])
})

test('it never presses f while focus is in a text field', async t => {
  const kit = run(t, { button: 'missing', typing: true })
  await until(() => kit.logged('media.fullscreen.entered').length === 1, 'entered')
  assert.equal(kit.logged('media.fullscreen.entered')[0][2].method, 'element')
  assert.deepEqual(kit.page.keys, [])
  assert.equal(kit.browser.methods().includes('Input.dispatchKeyEvent'), false)
})

test('it gives up after the bounded attempts when the page refuses full screen', async t => {
  const kit = run(t, { button: 'broken', key: 'ignored', element: 'refused' })
  await until(() => kit.logged('media.fullscreen.gave_up').length === 1, 'gave up')
  assert.deepEqual(kit.logged('media.fullscreen.gave_up')[0], [
    'warn', 'media.fullscreen.gave_up', { reason: 'refused', service: 'youtube', attempts: 2 },
  ])
  const buttons = () => kit.page.evaluations.filter(mode => mode === 'button').length
  assert.equal(buttons(), 2)
  await sleep(40)
  assert.equal(buttons(), 2)
})

test('it gives up when the video does not play before the deadline, without touching the page', async t => {
  const kit = run(t, { playsAfterPolls: Infinity, timing: { ...FAST, playDeadlineMs: 40 } })
  await until(() => kit.logged('media.fullscreen.gave_up').length === 1, 'gave up')
  assert.deepEqual(kit.logged('media.fullscreen.gave_up')[0][2], { reason: 'not_playing', service: 'youtube' })
  assert.equal(kit.page.evaluations.every(mode => mode === 'state'), true)
  assert.deepEqual(kit.page.keys, [])
})

test('after Esc it leaves the video alone, and on the next video re-applies only when full screen dropped', async t => {
  const kit = run(t)
  await until(() => kit.logged('media.fullscreen.entered').length === 1, 'first video')
  kit.page.fullscreen = false
  kit.navigate(`${WATCH}&t=30s`)
  await sleep(40)
  assert.equal(kit.page.fullscreen, false)
  assert.equal(kit.logged('media.fullscreen.entered').length, 1)

  const before = kit.page.evaluations.length
  kit.navigate('https://www.youtube.com/watch?v=next-video-1')
  await until(() => kit.logged('media.fullscreen.entered').length === 2, 'second video')
  assert.deepEqual(kit.logged('media.fullscreen.entered')[1][2], { service: 'youtube', method: 'button', attempt: 1 })

  kit.navigate('https://www.youtube.com/watch?v=next-video-2')
  await until(() => kit.logged('media.fullscreen.entered').length === 3, 'third video')
  assert.deepEqual(kit.logged('media.fullscreen.entered')[2][2], { service: 'youtube', method: 'already', attempt: 0 })
  assert.equal(kit.page.evaluations.slice(before).filter(mode => mode === 'button').length, 1)
  assert.equal(kit.page.fullscreen, true)
  assert.equal(kit.browser.methods().filter(method => method === 'Target.attachToTarget').length, 1)
})

test('it attaches only to the player page target', async t => {
  const kit = run(t, {
    extraTargets: [
      { targetId: 'worker-1', type: 'service_worker', title: '', url: 'https://www.youtube.com/sw.js', attached: false },
      { targetId: 'frame-1', type: 'iframe', title: '', url: 'https://www.youtube.com/embed/x', attached: false },
      { targetId: 'other-1', type: 'page', title: '', url: 'https://accounts.google.com/', attached: false },
    ],
  })
  await until(() => kit.logged('media.fullscreen.entered').length === 1, 'entered')
  kit.browser.event('Target.targetInfoChanged', {
    targetInfo: { targetId: 'other-1', type: 'page', title: '', url: 'https://www.youtube.com/watch?v=other', attached: false },
  })
  await sleep(30)
  const attaches = kit.browser.calls.filter(call => call.method === 'Target.attachToTarget')
  assert.deepEqual(attaches.map(call => call.params.targetId), ['page-1'])
})

test('YouTube Music and Netflix pages are handled with their own service', async t => {
  const music = run(t, { url: 'https://music.youtube.com/watch?v=BSTsnWoslP4', button: 'missing' })
  const netflix = run(t, { url: 'https://www.netflix.com/watch/80100172' })
  await until(() => music.logged('media.fullscreen.entered').length === 1, 'music entered')
  await until(() => netflix.logged('media.fullscreen.entered').length === 1, 'netflix entered')
  assert.deepEqual(music.logged('media.fullscreen.entered')[0][2], { service: 'youtube_music', method: 'key', attempt: 1 })
  assert.deepEqual(netflix.logged('media.fullscreen.entered')[0][2], { service: 'netflix', method: 'button', attempt: 1 })
})

test('a browser that never answers is logged as unavailable with the stderr reason, and nothing throws', async t => {
  const stderr = new PassThrough()
  const kit = run(t, { answers: false, stderr, pipeTimeoutMs: 30 })
  stderr.write('DevTools remote debugging is disallowed by the system admin.\n')
  await until(() => kit.logged('media.fullscreen.unavailable').length === 1, 'unavailable')
  assert.equal(kit.logged('media.fullscreen.unavailable')[0][2].reason, 'disallowed_by_policy')
  assert.deepEqual(kit.browser.methods(), ['Target.setDiscoverTargets'])
  assert.equal(kit.pipe.closed, false)
})

test('dispose stops the routine, and a pipe the browser closed ends it quietly', async t => {
  const waiting = { playsAfterPolls: Infinity, timing: { ...FAST, playDeadlineMs: 10_000 } }
  const kit = run(t, waiting)
  await until(() => kit.page.evaluations.length >= 2, 'polling')
  kit.routine.dispose()
  await sleep(20)
  const count = kit.page.evaluations.length
  await sleep(40)
  assert.equal(kit.page.evaluations.length, count)

  const closed = run(t, waiting)
  await until(() => closed.page.evaluations.length >= 2, 'polling')
  closed.browser.fromBrowser.end()
  await until(() => closed.logged('media.fullscreen.pipe_closed').length === 1, 'pipe closed')
  assert.deepEqual(closed.logged('media.fullscreen.pipe_closed')[0][2], { reason: 'browser_closed' })
  const after = closed.page.evaluations.length
  await sleep(40)
  assert.equal(closed.page.evaluations.length, after)
  assert.equal(closed.logs.some(([level]) => level === 'warn'), false)
})
