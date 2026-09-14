import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  DEVTOOLS_PIPE_STDIO,
  DevToolsPipe,
  DevToolsPipeError,
} from '../src/media/devtools-pipe.mjs'
import { FakeDevToolsBrowser, frame } from './fixtures/fake-devtools-browser.mjs'

const allowAll = () => true
const tick = () => new Promise(resolve => setImmediate(resolve))
const code = expected => error => error instanceof DevToolsPipeError && error.code === expected

function open({ handlers = {}, ...options } = {}) {
  const browser = new FakeDevToolsBrowser({ handlers })
  const pipe = new DevToolsPipe({
    toBrowser: browser.toBrowser,
    fromBrowser: browser.fromBrowser,
    allow: allowAll,
    ...options,
  })
  return { browser, pipe }
}

test('the player spawns with stdin and stdout ignored and stderr, fd 3 and fd 4 as pipes', () => {
  assert.deepEqual(DEVTOOLS_PIPE_STDIO, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'])
  assert.equal(Object.isFrozen(DEVTOOLS_PIPE_STDIO), true)
})

test('send writes one NUL-terminated JSON frame per command and resolves with the matching result', async () => {
  const written = []
  const toBrowser = new PassThrough()
  toBrowser.on('data', chunk => written.push(chunk))
  const fromBrowser = new PassThrough()
  const pipe = new DevToolsPipe({ toBrowser, fromBrowser, allow: allowAll })
  const first = pipe.send('Target.getTargets')
  const second = pipe.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S1' })
  await tick()
  assert.equal(
    Buffer.concat(written).toString('utf8'),
    '{"id":1,"method":"Target.getTargets","params":{}}\0'
      + '{"id":2,"method":"Runtime.evaluate","params":{"expression":"1"},"sessionId":"S1"}\0',
  )
  fromBrowser.write(frame({ id: 2, result: { result: { type: 'number', value: 1 } } }))
  fromBrowser.write(frame({ id: 1, result: { targetInfos: [] } }))
  assert.deepEqual(await second, { result: { type: 'number', value: 1 } })
  assert.deepEqual(await first, { targetInfos: [] })
})

test('frames split across chunks, several frames in one chunk and characters cut between chunks decode', async () => {
  const { browser, pipe } = open()
  const events = []
  pipe.onEvent(event => events.push(event))
  const title = 'Große Bühne — 音楽'
  const bytes = Buffer.concat([
    frame({ method: 'Target.targetInfoChanged', params: { targetInfo: { title } } }),
    frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'S9' }, sessionId: 'S9' }),
  ])
  const cut = bytes.indexOf(Buffer.from('音')) + 1
  browser.fromBrowser.write(bytes.subarray(0, cut))
  await tick()
  assert.deepEqual(events, [])
  browser.fromBrowser.write(bytes.subarray(cut))
  await tick()
  const expected = [
    { method: 'Target.targetInfoChanged', params: { targetInfo: { title } }, sessionId: null },
    { method: 'Target.detachedFromTarget', params: { sessionId: 'S9' }, sessionId: 'S9' },
  ]
  assert.deepEqual(events, expected)
  events.length = 0
  for (const byte of bytes) browser.fromBrowser.write(Buffer.from([byte]))
  await tick()
  assert.deepEqual(events, expected)
})

test('error replies reject with protocol; unknown ids and bad frames are ignored', async () => {
  const { browser, pipe } = open({
    handlers: {
      'Target.attachToTarget': () => ({ error: { code: -32602, message: 'No target with given id found' } }),
    },
  })
  const events = []
  pipe.onEvent(event => events.push(event.method))
  browser.fromBrowser.write(Buffer.from('not json\0'))
  browser.fromBrowser.write(frame({ id: 99, result: {} }))
  browser.fromBrowser.write(frame(['not', 'a', 'message']))
  browser.event('Target.targetCreated', { targetInfo: {} })
  await assert.rejects(
    pipe.send('Target.attachToTarget', { targetId: 'nope', flatten: true }),
    error => error.code === 'protocol' && /No target with given id found/.test(error.message),
  )
  assert.deepEqual(events, ['Target.targetCreated'])
  assert.equal(pipe.closed, false)
})

test('a command with no reply rejects with timeout and leaves the pipe open', async () => {
  const { pipe } = open({ timeoutMs: 20 })
  await assert.rejects(pipe.send('Target.setDiscoverTargets', { discover: true }), code('timeout'))
  assert.equal(pipe.closed, false)
})

test('a command the allow rule refuses is never written, and nothing is allowed by default', async () => {
  const written = []
  const toBrowser = new PassThrough()
  toBrowser.on('data', chunk => written.push(chunk))
  const strict = new DevToolsPipe({ toBrowser, fromBrowser: new PassThrough() })
  await assert.rejects(strict.send('Target.getTargets'), code('not_allowed'))
  const asked = []
  const picky = new DevToolsPipe({
    toBrowser,
    fromBrowser: new PassThrough(),
    allow: (method, params, options) => {
      asked.push([method, params, options])
      return false
    },
  })
  await assert.rejects(picky.send('Storage.getCookies', {}, { sessionId: 'S1' }), code('not_allowed'))
  await tick()
  assert.deepEqual(written, [])
  assert.deepEqual(asked, [['Storage.getCookies', {}, { sessionId: 'S1' }]])
})

test('the browser closing or breaking its end rejects pending and later commands, and the pipe never ends fd 3', async () => {
  for (const [finish, reason] of [
    [browser => browser.fromBrowser.end(), 'browser_closed'],
    [browser => browser.fromBrowser.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 'pipe_error'],
    [browser => browser.toBrowser.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 'pipe_error'],
  ]) {
    const { browser, pipe } = open()
    const reasons = []
    pipe.onClose(closed => reasons.push(closed))
    const pending = pipe.send('Target.setDiscoverTargets', { discover: true })
    finish(browser)
    await assert.rejects(pending, code('closed'))
    await assert.rejects(pipe.send('Target.getTargets'), code('closed'))
    assert.deepEqual(reasons, [reason])
    assert.equal(pipe.closeReason, reason)
    assert.equal(browser.toBrowser.writableEnded, false)
    assert.equal(browser.toBrowser.destroyed, false)
  }
})

test('close() by the owner stops events but leaves both streams open', async () => {
  const { browser, pipe } = open()
  const events = []
  pipe.onEvent(event => events.push(event.method))
  pipe.close('stopped')
  pipe.close('again')
  browser.event('Target.targetCreated', { targetInfo: {} })
  await tick()
  assert.deepEqual(events, [])
  assert.equal(pipe.closeReason, 'stopped')
  const late = []
  pipe.onClose(reason => late.push(reason))
  await tick()
  assert.deepEqual(late, ['stopped'])
  for (const stream of [browser.toBrowser, browser.fromBrowser]) {
    assert.equal(stream.destroyed, false)
    assert.equal(stream.writableEnded, false)
  }
})

test('a partial frame larger than the cap closes the pipe', async () => {
  const { browser, pipe } = open({ maxFrameBytes: 64 })
  const pending = pipe.send('Target.getTargets')
  browser.fromBrowser.write(Buffer.alloc(40, 0x61))
  await tick()
  assert.equal(pipe.closed, false)
  browser.fromBrowser.write(Buffer.alloc(40, 0x61))
  await assert.rejects(pending, code('closed'))
  assert.equal(pipe.closeReason, 'frame_too_large')
})

test('the reason Chromium refused the pipe is read from stderr, even when split across chunks', async () => {
  for (const [line, reason] of [
    ['DevTools remote debugging is disallowed by the system admin.\n', 'disallowed_by_policy'],
    [
      'DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.\n',
      'default_data_dir',
    ],
  ]) {
    const stderr = new PassThrough()
    const { pipe } = open({ stderr })
    stderr.write('[0914/101010.000000:WARNING:example.cc(12)] unrelated\n')
    stderr.write(line.slice(0, 20))
    await tick()
    assert.equal(pipe.refusal, null)
    stderr.write(line.slice(20))
    await tick()
    assert.equal(pipe.refusal, reason)
    stderr.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  }
})
