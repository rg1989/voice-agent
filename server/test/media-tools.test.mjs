import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AcpSessionToolServer } from '../src/backend/adapters/acp/session-tools.mjs'
import {
  MEDIA_TOOLS,
  MEDIA_TOOL_NAMES,
  MediaTools,
} from '../src/backend/adapters/acp/media-tools.mjs'

const PLAY = 'qwen_audio_agent_media_play'
const CONTROL = 'qwen_audio_agent_media_control'

function turn(overrides = {}) {
  return {
    ownerId: 'owner',
    sessionId: 'acp-1',
    coordinationRunId: 'task_1',
    permissionScopeId: 'prompt_1',
    ...overrides,
  }
}

function fakePlayer({ fail } = {}) {
  const calls = []
  return {
    calls,
    async play(options) {
      calls.push(['play', options])
      if (fail) throw fail
      return {
        status: 'playing',
        title: options.title,
        url: options.url,
        service: options.service,
        browser: 'chrome',
        profileDir: '/Users/me/.config/qwaudio/player/chrome',
      }
    },
    async stop(options) {
      calls.push(['stop', options])
      return { status: 'stopped' }
    },
    async control(action, options) {
      calls.push(['control', action, options])
      return { status: 'ok', action }
    },
  }
}

function parse(result) {
  return JSON.parse(result.content[0].text)
}

test('lists the media tools without touching the player, then plays through the shared player', async () => {
  const server = new AcpSessionToolServer()
  const player = fakePlayer()
  const tools = new MediaTools({ player })
  const registration = await tools.register(server, () => turn())
  assert.equal(registration.descriptor.type, 'http')
  assert.equal(registration.descriptor.name, 'qwen_audio_media')
  assert.equal(new URL(registration.descriptor.url).pathname, '/media')

  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    { requestInit: { headers: Object.fromEntries(
      registration.descriptor.headers.map(header => [header.name, header.value]),
    ) } },
  ))
  assert.match(client.getInstructions(), /media-playback skill/)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), MEDIA_TOOLS.map(tool => tool.name))
  assert.deepEqual(listed.tools.map(tool => tool.name), [PLAY, CONTROL])
  assert.deepEqual([...MEDIA_TOOL_NAMES], [PLAY, CONTROL])
  assert.deepEqual(player.calls, [])

  const result = await client.callTool({
    name: PLAY,
    arguments: { url: 'https://www.netflix.com/watch/70131314', title: 'Inception', service: 'netflix' },
  })
  assert.notEqual(result.isError, true)
  assert.deepEqual(parse(result), {
    status: 'playing',
    title: 'Inception',
    url: 'https://www.netflix.com/watch/70131314',
    service: 'netflix',
  })
  assert.doesNotMatch(result.content[0].text, /\.config|player\/chrome/)
  assert.deepEqual(player.calls, [[
    'play',
    { url: 'https://www.netflix.com/watch/70131314', title: 'Inception', service: 'netflix' },
  ]])

  await client.close()
  await tools.close()
  await server.close()
})

test('a wrong or released token cannot reach the media tools', async () => {
  const server = new AcpSessionToolServer()
  const tools = new MediaTools({ player: fakePlayer() })
  const registration = await tools.register(server, () => turn())
  const forged = await fetch(registration.descriptor.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-token', 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(forged.status, 404)
  registration.release()
  const released = await fetch(registration.descriptor.url, {
    method: 'POST',
    headers: {
      Authorization: registration.descriptor.headers[0].value,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(released.status, 404)
  await tools.close()
  await server.close()
})

test('maps control actions onto the player, stop and seek included', async () => {
  const player = fakePlayer()
  const tools = new MediaTools({ player })
  const session = turn()
  for (const action of ['pause', 'resume', 'next', 'previous']) {
    assert.deepEqual(parse(await tools.call(session, CONTROL, { action })), { status: 'ok', action })
  }
  assert.deepEqual(
    parse(await tools.call(session, CONTROL, { action: 'seek', seconds: -30 })),
    { status: 'ok', action: 'seek' },
  )
  assert.deepEqual(parse(await tools.call(session, CONTROL, { action: 'stop' })), { status: 'stopped' })
  assert.deepEqual(player.calls, [
    ['control', 'pause', undefined],
    ['control', 'resume', undefined],
    ['control', 'next', undefined],
    ['control', 'previous', undefined],
    ['control', 'seek_relative', { seconds: -30 }],
    ['stop', { reason: 'user' }],
  ])
})

test('refuses calls outside a running turn, unknown tools and bad arguments without touching the player', async () => {
  const player = fakePlayer()
  const tools = new MediaTools({ player })
  for (const session of [null, turn({ permissionScopeId: null })]) {
    const refused = await tools.call(session, PLAY, {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      service: 'youtube',
    })
    assert.equal(refused.isError, true)
    assert.equal(parse(refused).error, 'outside_turn')
  }
  assert.equal(parse(await tools.call(turn(), 'run_shell', {})).error, 'unknown_tool')
  for (const args of [
    { url: '', service: 'youtube' },
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', service: 'vimeo' },
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', service: 'youtube', title: 7 },
  ]) {
    assert.equal(parse(await tools.call(turn(), PLAY, args)).error, 'invalid_arguments')
  }
  for (const args of [{ action: 'rewind' }, { action: 'seek' }, { action: 'seek', seconds: 0 }]) {
    assert.equal(parse(await tools.call(turn(), CONTROL, args)).error, 'invalid_arguments')
  }
  assert.deepEqual(player.calls, [])
})

test('reports player errors by code with a fixed message and no local details', async () => {
  const error = Object.assign(
    new Error('spawn /Users/me/.config/qwaudio/player/chrome ENOENT'),
    { code: 'launch_failed' },
  )
  const tools = new MediaTools({ player: fakePlayer({ fail: error }) })
  const args = { url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', service: 'spotify' }
  const result = await tools.call(turn(), PLAY, args)
  assert.equal(result.isError, true)
  assert.deepEqual(parse(result), {
    status: 'failed',
    error: 'launch_failed',
    message: 'The player could not be started.',
  })
  const unexpected = new MediaTools({ player: fakePlayer({ fail: new Error('boom at /private/path') }) })
  assert.deepEqual(parse(await unexpected.call(turn(), PLAY, args)), {
    status: 'failed',
    error: 'failed',
    message: 'Media playback failed.',
  })
})

test('logs the real cause of a player error on the Gateway, coded or not', async () => {
  const warnings = []
  const fakeLogger = { warn: (event, fields) => warnings.push([event, fields]) }
  const args = { url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', service: 'spotify' }
  const coded = Object.assign(new Error('osascript exited with 1'), { code: 'transport_unavailable' })
  const tools = new MediaTools({ player: fakePlayer({ fail: coded }), logger: fakeLogger })
  assert.equal(parse(await tools.call(turn(), PLAY, args)).message, 'The playing media cannot be controlled right now.')
  const uncoded = new MediaTools({ player: fakePlayer({ fail: new TypeError('x is not a function') }), logger: fakeLogger })
  assert.equal(parse(await uncoded.call(turn(), PLAY, args)).error, 'failed')
  assert.deepEqual(warnings, [
    ['media.agent_tool.failed', { tool: PLAY, code: 'transport_unavailable', error: 'osascript exited with 1' }],
    ['media.agent_tool.failed', { tool: PLAY, code: '', error: 'x is not a function' }],
  ])
})

test('requires a media player', () => {
  assert.throws(() => new MediaTools({}), /requires a media player/)
})
