import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ClientActionName } from '../src/client/client-action-port.mjs'
import {
  MediaClientBridge,
  mediaStateEvent,
} from '../src/client/media-client-bridge.mjs'

function fakePlayer(state = {}) {
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
    ...state,
  }
  player.state = () => player.current
  return player
}

function fakeClient({
  showsConversation = false,
  activeVoice = false,
  request,
} = {}) {
  const client = {
    sent: [],
    requests: [],
    send: event => client.sent.push(event),
    isActiveVoiceClient: () => activeVoice,
    clientActions: {
      supports: name => (
        showsConversation && name === ClientActionName.SHOW_CONVERSATION
      ),
      request: (name, args, options) => {
        client.requests.push([name, args, options])
        return request ? request() : Promise.resolve({ status: 'completed' })
      },
    },
  }
  return client
}

test('projects player state onto the media.state event', () => {
  assert.deepEqual(mediaStateEvent({
    active: true,
    paused: true,
    title: 'Kind of Blue',
    service: 'youtube_music',
    pid: 42,
  }), {
    type: 'media.state',
    active: true,
    title: 'Kind of Blue',
    service: 'youtube_music',
  })
  assert.deepEqual(mediaStateEvent({ active: 1, title: '', service: 7 }), {
    type: 'media.state',
    active: false,
    title: null,
    service: null,
  })
})

test('sends media.state on connect and on every player change', () => {
  const player = fakePlayer()
  const bridge = new MediaClientBridge({ mediaPlayer: player })
  const client = fakeClient()
  const detach = bridge.attach(client)
  assert.deepEqual(client.sent, [
    { type: 'media.state', active: false, title: null, service: null },
  ])

  player.current = {
    ...player.current,
    active: true,
    title: 'Lo-fi beats',
    service: 'youtube',
  }
  player.emit('started', player.current)
  player.emit('paused', player.current)
  player.emit('resumed', player.current)
  assert.equal(client.sent.length, 4)
  assert.deepEqual(client.sent[1], {
    type: 'media.state',
    active: true,
    title: 'Lo-fi beats',
    service: 'youtube',
  })

  player.current = { ...player.current, active: false, title: null, service: null }
  player.emit('stopped', { reason: 'user', title: 'Lo-fi beats', service: 'youtube' })
  assert.deepEqual(client.sent.at(-1), {
    type: 'media.state',
    active: false,
    title: null,
    service: null,
  })

  detach()
  player.emit('started', player.current)
  assert.equal(client.sent.length, 5)
  bridge.close()
})

test('asks only Clients that can show the conversation to return after playback', async () => {
  const player = fakePlayer()
  const bridge = new MediaClientBridge({
    mediaPlayer: player,
    getSettings: () => ({ mediaReturnToAssistant: true }),
  })
  const desktop = fakeClient({ showsConversation: true })
  const web = fakeClient()
  bridge.attach(desktop)
  bridge.attach(web)

  for (const reason of ['user', 'ended', 'exited', 'replaced']) {
    player.emit('stopped', { reason, title: 'Song', service: 'youtube' })
  }
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(desktop.requests, ['user', 'ended', 'exited'].map(reason => [
    ClientActionName.SHOW_CONVERSATION,
    { reason },
    { idempotencyKey: 'media.show_conversation' },
  ]))
  assert.deepEqual(web.requests, [])
  bridge.close()
})

test('asks only the desktop that holds the voice when one does', async () => {
  const player = fakePlayer()
  const bridge = new MediaClientBridge({
    mediaPlayer: player,
    getSettings: () => ({ mediaReturnToAssistant: true }),
  })
  const speaking = fakeClient({ showsConversation: true, activeVoice: true })
  const paired = fakeClient({ showsConversation: true })
  bridge.attach(speaking)
  bridge.attach(paired)

  await Promise.all(bridge.returnToAssistant({ reason: 'ended' }))

  assert.deepEqual(speaking.requests, [[
    ClientActionName.SHOW_CONVERSATION,
    { reason: 'ended' },
    { idempotencyKey: 'media.show_conversation' },
  ]])
  assert.deepEqual(paired.requests, [])
  bridge.close()
})

test('stays on the player when returning to the assistant is off', () => {
  const player = fakePlayer()
  const bridge = new MediaClientBridge({
    mediaPlayer: player,
    getSettings: () => ({ mediaReturnToAssistant: false }),
  })
  const desktop = fakeClient({ showsConversation: true })
  bridge.attach(desktop)
  player.emit('stopped', { reason: 'ended', title: 'Song', service: 'youtube' })
  assert.deepEqual(desktop.requests, [])
  assert.equal(desktop.sent.length, 2)
  bridge.close()
})

test('logs a failed return request instead of throwing', async () => {
  const warnings = []
  const player = fakePlayer()
  const bridge = new MediaClientBridge({
    mediaPlayer: player,
    getSettings: () => ({ mediaReturnToAssistant: true }),
    logger: { warn: (name, fields) => warnings.push([name, fields]) },
  })
  bridge.attach(fakeClient({
    showsConversation: true,
    request: () => Promise.reject(Object.assign(
      new Error('Client Action timed out: show_conversation'),
      { code: 'client_action_timeout' },
    )),
  }))
  const results = await Promise.all(bridge.returnToAssistant({ reason: 'user' }))
  assert.deepEqual(results, [null])
  assert.deepEqual(warnings, [['media.show_conversation_failed', {
    code: 'client_action_timeout',
    error: 'Client Action timed out: show_conversation',
  }]])
  bridge.close()
})

test('close stops listening to the player', () => {
  const player = fakePlayer()
  const bridge = new MediaClientBridge({ mediaPlayer: player })
  bridge.close()
  for (const name of ['started', 'stopped', 'paused', 'resumed']) {
    assert.equal(player.listenerCount(name), 0)
  }
})
