import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  createGatewaySessionHello,
} from '../../shared/protocol/gateway-client-protocol.mjs'
import { LIVE_SETTINGS_DEFAULTS } from '../src/core/live-settings.mjs'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'

function fakePlayer() {
  const player = new EventEmitter()
  player.current = {
    active: false,
    paused: false,
    title: null,
    url: null,
    service: null,
    browser: null,
    pid: null,
    startedAt: null,
  }
  player.state = () => player.current
  return player
}

// P1 adds the media fields to LiveSettings. A plain emitter keeps this test
// independent of how P1 normalizes them.
function fakeLiveSettings(values = {}) {
  const settings = new EventEmitter()
  settings.get = () => ({ ...LIVE_SETTINGS_DEFAULTS, ...values })
  return settings
}

async function startGateway(t, { mediaPlayer, liveSettings }) {
  const server = createServer()
  const gateway = attachRealtimeGateway(server, {
    identityManager: {
      resolveUpgrade: () => ({ ownerId: 'owner-media-test' }),
    },
    memoryService: { list: () => [] },
    notesStore: null,
    backendRuntime: null,
    backendAvailability: {
      snapshot: () => ({ configured: false, ok: false, known: true }),
    },
    respondAuthorization: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    liveSettings,
    mediaPlayer,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })
  return server
}

async function connect(server, hello) {
  const { port } = server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=media-test`,
  )
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('open', () => {
      socket.send(JSON.stringify(hello))
      resolve()
    })
  })
  return { socket, received }
}

async function waitFor(received, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const event = received.find(predicate)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Gateway event was not received: ${JSON.stringify(received)}`)
}

function desktopHello(instanceId) {
  return createGatewaySessionHello({
    eventId: `evt-${instanceId}-hello`,
    clientType: 'desktop',
    clientInstanceId: instanceId,
    capabilities: [
      GatewayClientCapability.CLIENT_ACTION_ENTER_SLEEP,
      GatewayClientCapability.CLIENT_ACTION_SHOW_CONVERSATION,
    ],
  })
}

test('sends media.state when a Client connects and when the player changes', async t => {
  const player = fakePlayer()
  const server = await startGateway(t, {
    mediaPlayer: player,
    liveSettings: fakeLiveSettings(),
  })
  const desktop = await connect(server, desktopHello('desktop-media-state'))
  const initial = await waitFor(
    desktop.received,
    event => event.type === 'media.state',
  )
  assert.deepEqual(
    { active: initial.active, title: initial.title, service: initial.service },
    { active: false, title: null, service: null },
  )

  player.current = {
    ...player.current,
    active: true,
    title: 'Blue in Green',
    service: 'youtube_music',
  }
  player.emit('started', player.current)
  const playing = await waitFor(
    desktop.received,
    event => event.type === 'media.state' && event.active === true,
  )
  assert.equal(playing.title, 'Blue in Green')
  assert.equal(playing.service, 'youtube_music')
  desktop.socket.close()
})

test('asks the connected desktop to show the conversation when playback ends', async t => {
  const player = fakePlayer()
  const server = await startGateway(t, {
    mediaPlayer: player,
    liveSettings: fakeLiveSettings({ mediaReturnToAssistant: true }),
  })
  const desktop = await connect(server, desktopHello('desktop-media-return'))
  await waitFor(desktop.received, event => event.type === 'voice.ownership')

  player.emit('stopped', {
    reason: 'ended',
    title: 'Blue in Green',
    service: 'youtube_music',
  })
  const action = await waitFor(
    desktop.received,
    event => event.type === GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST,
  )
  assert.equal(action.name, 'show_conversation')
  assert.deepEqual(action.arguments, { reason: 'ended' })
  desktop.socket.send(JSON.stringify({
    type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
    event_id: 'evt-desktop-media-return-result',
    request_event_id: action.event_id,
    status: 'completed',
    output: { mode: 'panel' },
  }))
  desktop.socket.close()
})

test('does not ask a Client that cannot show the conversation', async t => {
  const player = fakePlayer()
  const server = await startGateway(t, {
    mediaPlayer: player,
    liveSettings: fakeLiveSettings({ mediaReturnToAssistant: true }),
  })
  const web = await connect(server, createGatewaySessionHello({
    eventId: 'evt-web-media-hello',
    clientType: 'web',
    clientInstanceId: 'web-media-return',
    capabilities: [],
  }))
  await waitFor(web.received, event => event.type === 'voice.ownership')

  player.emit('stopped', {
    reason: 'user',
    title: 'Blue in Green',
    service: 'youtube_music',
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(web.received.some(event => (
    event.type === GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST
  )), false)
  assert.equal(web.received.some(event => event.type === 'media.state'), true)
  web.socket.close()
})

test('starts without media state when the player is not an event emitter', async t => {
  // Test fakes in P1 and P3 ({ setup, stop }, { setup, play, stop, control })
  // have no on/off. The Gateway must still start and serve connections.
  const idle = fakePlayer().state()
  const server = await startGateway(t, {
    mediaPlayer: {
      state: () => idle,
      setup: async () => ({}),
      play: async () => ({}),
      control: async () => ({}),
      stop: async () => {},
    },
    liveSettings: fakeLiveSettings({ mediaReturnToAssistant: true }),
  })
  const desktop = await connect(server, desktopHello('desktop-media-partial'))
  await waitFor(desktop.received, event => event.type === 'voice.ownership')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(desktop.received.some(event => event.type === 'media.state'), false)
  desktop.socket.close()
})
