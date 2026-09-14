// Drives the media tools (and pause while talking) through the real Gateway
// WebSocket path with a fake Realtime frontend and a fake media player.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'
import { LiveSettings } from '../src/core/live-settings.mjs'
import { frontendTools } from '../src/frontend/frontend-tools.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const toolNames = context => frontendTools(context).map(tool => tool.function.name)

// An EventEmitter like MediaPlayer, so anything that subscribes to the player
// the Gateway receives (on, off, state) works with it.
function fakeMediaPlayer() {
  const player = Object.assign(new EventEmitter(), {
    calls: [],
    current: {
      active: true,
      paused: false,
      title: 'Lo-fi beats',
      url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
      service: 'youtube',
      browser: 'edge',
      pid: 501,
      startedAt: 1000,
      controlSerial: 0,
    },
    state: () => ({ ...player.current }),
    play: async options => {
      player.calls.push(['play', options])
      player.current = {
        ...player.current,
        ...options,
        active: true,
        paused: false,
        startedAt: player.current.startedAt + 1,
      }
      return { status: 'playing', title: options.title, url: options.url, service: options.service, browser: 'edge' }
    },
    stop: async options => {
      player.calls.push(['stop', options])
      player.current = { ...player.current, active: false, paused: false }
      return { status: 'stopped' }
    },
    control: async (action, options = {}) => {
      player.calls.push(['control', action, options])
      // Like MediaPlayer: pauses from anyone but pause while talking are counted.
      if (action === 'pause' && options.source !== 'talk_pause') {
        player.current = { ...player.current, controlSerial: player.current.controlSerial + 1 }
      }
      if (action === 'pause') player.current = { ...player.current, paused: true }
      if (action === 'resume') player.current = { ...player.current, paused: false }
      return { status: 'ok', action }
    },
  })
  return player
}

async function startGateway(t, {
  mediaPlayer = null,
  liveSettings = new LiveSettings({}),
  responseStartTimeoutMs,
} = {}) {
  const frontends = []
  const detectors = []
  const realtimeFrontendFactory = options => {
    const base = options.providerRegistry.resolve(options.providerName)
    const provider = responseStartTimeoutMs
      ? Object.create(base, { responseStartTimeoutMs: { value: responseStartTimeoutMs } })
      : base
    const frontend = {
      provider,
      capabilities: base.capabilities,
      ready: false,
      appended: [],
      functionOutputs: [],
      ensuredResponses: [],
      agentContexts: [options.agentContext],
      connect: async () => { frontend.ready = true },
      close: () => { frontend.ready = false },
      appendAudio: audio => frontend.appended.push(audio),
      deleteConversationItem: () => {},
      cancel: () => {},
      updateAgentContext: context => frontend.agentContexts.push(context),
      ensureResponse: async (...args) => { frontend.ensuredResponses.push(args) },
      sendFunctionOutput: async (...args) => { frontend.functionOutputs.push(args) },
      injectDelivery: async () => ({ completed: true }),
      whenIdle: async () => {},
      emit: event => options.onEvent(event),
    }
    frontends.push(frontend)
    return frontend
  }
  const server = createServer()
  const gateway = attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: () => ({ ownerId: 'owner-media-test' }) },
    memoryService: { list: () => [] },
    notesStore: null,
    backendRuntime: null,
    backendAvailability: { snapshot: () => ({ configured: false, ok: false, known: true }) },
    respondAuthorization: async () => ({}),
    permissionPolicy: { resolveDecision: () => null, rememberDecision: () => {} },
    realtimeFrontendFactory,
    liveSettings,
    mediaPlayer,
    resolveMedia: async query => ({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: `Top result for ${query}`,
      channel: null,
      videoId: 'dQw4w9WgXcQ',
    }),
    wakeWordDetectorFactory: options => {
      const detector = {
        options,
        pushed: [],
        ready: Promise.resolve(),
        push: audio => detector.pushed.push(audio),
        reset: () => {},
        close: () => {},
      }
      detectors.push(detector)
      return detector
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await gateway.close()
    await new Promise(resolve => server.close(resolve))
  })
  return { server, frontends, detectors, liveSettings }
}

async function waitFor(received, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const event = received.find(predicate)
    if (event) return event
    await sleep(10)
  }
  throw new Error(`Gateway event was not received: ${JSON.stringify(received.map(event => event.type))}`)
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('Gateway condition was not met')
}

async function connect(server) {
  const { port } = server.address()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=media-test`)
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'connect',
        clientType: 'web',
        voiceEnabled: true,
        inputEnabled: true,
        outputEnabled: true,
        textOnly: false,
      }))
      resolve()
    })
  })
  await waitFor(received, event => event.type === 'voice.ready')
  return {
    socket,
    received,
    send: event => socket.send(JSON.stringify(event)),
  }
}

function userSpeech(frontend, itemId, transcript) {
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  })
}

test('the voice model is offered the media tools only when the Gateway has a player', async t => {
  const withPlayer = await startGateway(t, { mediaPlayer: fakeMediaPlayer() })
  const client = await connect(withPlayer.server)
  const offered = toolNames(withPlayer.frontends[0].agentContexts.at(-1))
  assert.equal(offered.includes('play_media'), true)
  assert.equal(offered.includes('control_media'), true)
  client.socket.close()

  const withoutPlayer = await startGateway(t)
  const other = await connect(withoutPlayer.server)
  assert.equal(toolNames(withoutPlayer.frontends[0].agentContexts.at(-1)).includes('play_media'), false)
  other.socket.close()
})

test('a play_media call from the voice model reaches the Gateway player', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends } = await startGateway(t, { mediaPlayer })
  const client = await connect(server)
  const frontend = frontends[0]

  userSpeech(frontend, 'item-play', 'Play Rick Astley.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-play' } })
  frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-play',
    call_id: 'call-play',
    name: 'play_media',
    arguments: JSON.stringify({ query: 'rick astley', service: 'youtube' }),
  })
  await waitUntil(() => frontend.functionOutputs.length === 1)
  assert.deepEqual(frontend.functionOutputs[0][1], {
    status: 'playing',
    title: 'Top result for rick astley',
    service: 'youtube',
  })
  assert.deepEqual(mediaPlayer.calls.find(call => call[0] === 'play'), ['play', {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Top result for rick astley',
    service: 'youtube',
  }])
  client.socket.close()
})

const audioChunk = Buffer.alloc(3200, 1).toString('base64')

test('the player pauses while the user talks and resumes once the answer has been heard', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends } = await startGateway(t, { mediaPlayer })
  const client = await connect(server)
  const frontend = frontends[0]

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' })
  await waitUntil(() => mediaPlayer.current.paused)
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-1' })
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-1',
    transcript: 'What time is it?',
  })
  frontend.emit({ type: 'response.created', response: { id: 'resp-1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-1', delta: audioChunk })
  frontend.emit({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } })
  await waitFor(client.received, event => event.type === 'audio.done')
  await sleep(30)
  // Still being heard.
  assert.equal(mediaPlayer.current.paused, true)

  client.send({ type: 'playback.started', responseId: 'resp-1' })
  client.send({ type: 'playback.ended', responseId: 'resp-1' })
  await waitUntil(() => !mediaPlayer.current.paused)
  assert.deepEqual(mediaPlayer.calls, [
    ['control', 'pause', { source: 'talk_pause' }],
    ['control', 'resume', { source: 'talk_pause' }],
  ])
  client.socket.close()
})

test('a pause the user asks for keeps the player paused after the answer', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends } = await startGateway(t, { mediaPlayer })
  const client = await connect(server)
  const frontend = frontends[0]

  userSpeech(frontend, 'item-2', 'Pause the video.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-2' } })
  frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-2',
    call_id: 'call-pause',
    name: 'control_media',
    arguments: JSON.stringify({ action: 'pause' }),
  })
  await waitUntil(() => frontend.functionOutputs.length === 1)
  frontend.emit({ type: 'response.done', response: { id: 'resp-2', status: 'completed' } })
  await sleep(100)
  assert.equal(mediaPlayer.current.paused, true)
  // The talk pause first, then the pause the user asked for.
  assert.deepEqual(mediaPlayer.calls, [['control', 'pause', { source: 'talk_pause' }], ['control', 'pause', {}]])
  client.socket.close()
})

test('turning pause while talking off applies to the next speech without a restart', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends, liveSettings } = await startGateway(t, { mediaPlayer })
  const client = await connect(server)
  const frontend = frontends[0]

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-3' })
  await waitUntil(() => mediaPlayer.current.paused)
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-3' })
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-3',
    transcript: 'Hello there.',
  })
  // Noise the provider rejects ends that turn with no answer, so playback resumes.
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'noise-3' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'noise-3', reason: 'turn_invalid' })
  await waitUntil(() => !mediaPlayer.current.paused)

  liveSettings.update({ mediaPauseWhileTalking: false })
  userSpeech(frontend, 'item-4', 'And now?')
  await sleep(50)
  assert.equal(mediaPlayer.current.paused, false)
  assert.deepEqual(mediaPlayer.calls, [
    ['control', 'pause', { source: 'talk_pause' }],
    ['control', 'resume', { source: 'talk_pause' }],
  ])
  client.socket.close()
})

test('a turn that never gets a response still resumes the player', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends } = await startGateway(t, { mediaPlayer, responseStartTimeoutMs: 150 })
  const client = await connect(server)
  const frontend = frontends[0]

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-5' })
  await waitUntil(() => mediaPlayer.current.paused)
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-5' })
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-5',
    transcript: 'Are you there?',
  })
  // The response-start watchdog gives up on the turn and reconnects.
  await waitUntil(() => !mediaPlayer.current.paused, 3000)
  assert.deepEqual(mediaPlayer.calls, [
    ['control', 'pause', { source: 'talk_pause' }],
    ['control', 'resume', { source: 'talk_pause' }],
  ])
  client.socket.close()
})

test('a refused wake that never gets a response still resumes the player', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends, detectors } = await startGateway(t, {
    mediaPlayer,
    liveSettings: new LiveSettings({ listeningMode: 'wake_word' }),
    responseStartTimeoutMs: 150,
  })
  const client = await connect(server)
  const frontend = frontends[0]
  client.send({ type: 'audio.append', audio: audioChunk })
  await waitUntil(() => detectors.at(-1)?.pushed.length > 0)
  detectors.at(-1).options.onDetected()
  await waitFor(client.received, event => event.type === 'voice.listening' && event.state === 'awake')

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-6' })
  await waitUntil(() => mediaPlayer.current.paused)
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-6' })
  // A false wake: the request never names the wake word, and no response
  // follows. The watchdog is skipped for a refused turn.
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-6',
    transcript: 'hey travis what time is it',
  })
  await waitUntil(() => !mediaPlayer.current.paused, 1000)
  assert.deepEqual(mediaPlayer.calls, [
    ['control', 'pause', { source: 'talk_pause' }],
    ['control', 'resume', { source: 'talk_pause' }],
  ])
  client.socket.close()
})

test('a bare wake word keeps the player paused until the request has been answered', async t => {
  const mediaPlayer = fakeMediaPlayer()
  const { server, frontends, detectors } = await startGateway(t, {
    mediaPlayer,
    liveSettings: new LiveSettings({ listeningMode: 'wake_word' }),
  })
  const client = await connect(server)
  const frontend = frontends[0]
  client.send({ type: 'audio.append', audio: audioChunk })
  await waitUntil(() => detectors.at(-1)?.pushed.length > 0)
  detectors.at(-1).options.onDetected()
  await waitFor(client.received, event => event.type === 'voice.listening' && event.state === 'awake')

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-7' })
  await waitUntil(() => mediaPlayer.current.paused)
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-7' })
  frontend.emit({ type: 'response.created', response: { id: 'resp-7' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-7', delta: audioChunk })
  // Only the wake word: the gate keeps listening for the request, and the
  // answer already under way is cancelled unheard.
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-7',
    transcript: 'Hey Jarvis.',
  })
  await waitFor(client.received, event => (
    event.type === 'transcript.discard' && event.reason === 'wake_word_only'
  ))
  frontend.emit({ type: 'response.done', response: { id: 'resp-7', status: 'cancelled' } })
  await sleep(50)
  assert.equal(mediaPlayer.current.paused, true)
  assert.deepEqual(mediaPlayer.calls, [['control', 'pause', { source: 'talk_pause' }]])

  userSpeech(frontend, 'item-8', 'What time is it?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-8' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-8', delta: audioChunk })
  frontend.emit({ type: 'response.done', response: { id: 'resp-8', status: 'completed' } })
  await waitFor(client.received, event => event.type === 'audio.done' && event.responseId === 'resp-8')
  await sleep(30)
  assert.equal(mediaPlayer.current.paused, true)

  client.send({ type: 'playback.started', responseId: 'resp-8' })
  client.send({ type: 'playback.ended', responseId: 'resp-8' })
  await waitUntil(() => !mediaPlayer.current.paused)
  await sleep(30)
  assert.deepEqual(mediaPlayer.calls, [
    ['control', 'pause', { source: 'talk_pause' }],
    ['control', 'resume', { source: 'talk_pause' }],
  ])
  client.socket.close()
})
