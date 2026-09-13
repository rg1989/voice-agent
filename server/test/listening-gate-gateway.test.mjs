// Drives the listening gate through the real Gateway WebSocket path with a
// fake Realtime frontend and a fake wake-word detector.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket from 'ws'
import { attachRealtimeGateway } from '../src/voice/realtime-gateway.mjs'
import { LiveSettings } from '../src/core/live-settings.mjs'
import { buildFrontendInstructions, frontendTools } from '../src/frontend/frontend-tools.mjs'
import { conversationSync } from '../src/conversation/conversation-sync.mjs'

const chunk = tag => Buffer.alloc(3200, tag).toString('base64')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function startGateway(t, {
  listeningMode = 'wake_word',
  followUpSeconds = 5,
  responseStartTimeoutMs,
  backendRuntime = null,
} = {}) {
  const frontends = []
  const detectors = []
  const liveSettings = new LiveSettings({ listeningMode, followUpSeconds })
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
      deleted: [],
      cancels: 0,
      functionOutputs: [],
      ensuredResponses: [],
      agentContexts: [options.agentContext],
      connect: async () => { frontend.ready = true },
      close: () => { frontend.ready = false },
      appendAudio: audio => frontend.appended.push(audio),
      deleteConversationItem: itemId => frontend.deleted.push(itemId),
      cancel: () => { frontend.cancels += 1 },
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
    identityManager: {
      resolveUpgrade: () => ({ ownerId: 'owner-listening-test' }),
    },
    memoryService: { list: () => [] },
    notesStore: null,
    backendRuntime,
    backendAvailability: {
      snapshot: () => ({
        configured: Boolean(backendRuntime),
        ok: Boolean(backendRuntime),
        known: true,
      }),
    },
    respondAuthorization: async () => ({}),
    permissionPolicy: {
      resolveDecision: () => null,
      rememberDecision: () => {},
    },
    realtimeFrontendFactory,
    liveSettings,
    wakeWordDetectorFactory: options => {
      const detector = {
        options,
        pushed: [],
        closed: false,
        ready: Promise.resolve(),
        push: audio => detector.pushed.push(audio),
        reset: () => {},
        close: () => { detector.closed = true },
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

async function connect(server, { clientType = 'web' } = {}) {
  const { port } = server.address()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=listening-test`)
  const received = []
  socket.on('message', raw => received.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'connect',
        clientType,
        voiceEnabled: true,
        inputEnabled: true,
        outputEnabled: true,
        textOnly: false,
      }))
      resolve()
    })
  })
  await waitFor(received, event => event.type === 'voice.ready')
  const client = {
    socket,
    received,
    send: event => socket.send(JSON.stringify(event)),
    listening: () => received.filter(event => event.type === 'voice.listening').at(-1),
  }
  return client
}

async function waitFor(received, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const event = received.find(predicate)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Gateway event was not received: ${JSON.stringify(received.map(event => event.type))}`)
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Gateway condition was not met')
}

async function wake(client, detectors) {
  client.send({ type: 'audio.append', audio: chunk(0) })
  await waitUntil(() => detectors.at(-1)?.pushed.length > 0)
  detectors.at(-1).options.onDetected()
  await waitUntil(() => client.listening()?.state === 'awake')
}

function userTurn(frontend, itemId, transcript) {
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId })
  if (transcript !== undefined) transcribe(frontend, itemId, transcript)
}

function transcribe(frontend, itemId, transcript) {
  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  })
}

const audioDeltaCount = client => client.received.filter(event => event.type === 'audio.delta').length
const unverifiedClears = client => client.received.filter(event => (
  event.type === 'playback.clear' && event.reason === 'wake_word_unverified'
))
const storedUserText = () => conversationSync
  .list({ ownerId: 'owner-listening-test', sessionId: 'listening-test' })
  .filter(message => message.role === 'user')
  .map(message => message.content)

test('armed audio never reaches the Realtime provider until the wake word is heard', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  const first = client.received.find(event => event.type === 'voice.listening')
  assert.equal(first.state, 'armed')
  assert.equal(first.wakeWord, 'hey_jarvis')

  for (let index = 1; index <= 20; index += 1) {
    client.send({ type: 'audio.append', audio: chunk(index) })
  }
  await waitUntil(() => detectors[0]?.pushed.length === 20)
  assert.deepEqual(frontends[0].appended, [])
  assert.equal(frontends.length, 1)

  detectors[0].options.onDetected()
  const awake = await waitFor(client.received, event => (
    event.type === 'voice.listening' && event.state === 'awake'
  ))
  assert.equal(awake.reason, 'wake_word')
  // A second and a half of pre-roll keeps the whole wake phrase.
  assert.deepEqual(
    frontends[0].appended,
    Array.from({ length: 15 }, (_, index) => chunk(index + 6)),
  )
  client.send({ type: 'audio.append', audio: chunk(21) })
  await waitUntil(() => frontends[0].appended.length === 16)
  assert.equal(detectors[0].pushed.length, 20)
  client.socket.close()
})

test('the follow-up window starts when playback ends, not when the response is done', async t => {
  const { server, frontends, detectors } = await startGateway(t, { followUpSeconds: 0 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-1', 'Hey Jarvis, tell me a joke.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } })
  await waitFor(client.received, event => event.type === 'audio.done')
  assert.equal(client.listening().state, 'awake')

  client.send({ type: 'playback.started', responseId: 'resp-1' })
  client.send({ type: 'playback.ended', responseId: 'resp-1' })
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'follow_up_expired')
  client.socket.close()
})

test('a bare stop phrase cancels the answer and re-arms without speaking', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  const audioDeltas = () => client.received.filter(event => event.type === 'audio.delta').length

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-2' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-2' })
  frontend.emit({ type: 'response.created', response: { id: 'resp-2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-2', delta: chunk(1) })
  // Held while the wake word is unconfirmed.
  await sleep(50)
  assert.equal(audioDeltas(), 0)
  const cancelsBefore = frontend.cancels

  frontend.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-2',
    transcript: 'Hey Jarvis, stop listening.',
  })
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'stop')
  assert.ok(client.received.some(event => (
    event.type === 'playback.clear' && event.reason === 'stop_listening'
  )))
  assert.ok(frontend.cancels > cancelsBefore)

  // Output that was already on its way, or a late response, stays unheard.
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-2', delta: chunk(2) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-2', status: 'cancelled' } })
  frontend.emit({ type: 'response.created', response: { id: 'resp-3' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-3', delta: chunk(3) })
  frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-3',
    call_id: 'call-late',
    name: 'get_current_time',
    arguments: '{}',
  })
  await waitUntil(() => frontend.functionOutputs.length === 1)
  assert.equal(frontend.functionOutputs[0][1].status, 'superseded')
  assert.equal(frontend.functionOutputs[0][3].createResponse, false)
  assert.equal(audioDeltas(), 0)
  // Not even a start for the stopped turn's responses.
  assert.equal(client.received.some(event => event.type === 'response.started'), false)
  assert.deepEqual(frontend.ensuredResponses, [])
  client.socket.close()
})

test('ignore_input stays silent, keeps listening, and does not trip the response watchdog', async t => {
  const { server, frontends, detectors } = await startGateway(t, { responseStartTimeoutMs: 150 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-3' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-3' })
  frontend.emit({ type: 'response.created', response: { id: 'resp-4' } })
  frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-4',
    call_id: 'call-ignore',
    name: 'ignore_input',
    arguments: '{}',
  })
  frontend.emit({ type: 'response.done', response: { id: 'resp-4', status: 'completed' } })
  await sleep(50)
  assert.equal(client.listening().state, 'awake')
  transcribe(frontend, 'item-3', 'Hey Jarvis, the TV is on.')

  // Only that input is dropped: the follow-up window runs again.
  await waitUntil(() => client.listening().reason === 'follow_up')
  assert.equal(client.listening().state, 'awake')
  await waitUntil(() => frontend.functionOutputs.length === 1)
  assert.deepEqual(frontend.functionOutputs[0][1], { status: 'ignored' })
  assert.equal(frontend.functionOutputs[0][3].createResponse, false)

  // Well past the watchdog: no recovery reconnect and no follow-up response.
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(frontends.length, 1)
  assert.deepEqual(frontend.ensuredResponses, [])
  assert.equal(client.received.some(event => event.type === 'error'), false)
  assert.equal(
    client.received.filter(event => event.type === 'voice.state').at(-1).state,
    'idle',
  )
  client.socket.close()
})

test('listening mode changes apply to an open connection', async t => {
  const { server, frontends, detectors, liveSettings } = await startGateway(t, {
    listeningMode: 'always',
  })
  const client = await connect(server)
  const frontend = frontends[0]
  assert.equal(client.listening().state, 'always')
  const toolNames = context => frontendTools(context).map(tool => tool.function.name)
  assert.equal(toolNames(frontend.agentContexts.at(-1)).includes('stop_listening'), false)
  assert.equal(toolNames(frontend.agentContexts.at(-1)).includes('ignore_input'), true)
  assert.doesNotMatch(buildFrontendInstructions(frontend.agentContexts.at(-1)), /Hey Jarvis/)

  client.send({ type: 'audio.append', audio: chunk(1) })
  await waitUntil(() => frontend.appended.length === 1)

  liveSettings.update({ listeningMode: 'wake_word' })
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'mode_changed')
  assert.equal(toolNames(frontend.agentContexts.at(-1)).includes('stop_listening'), true)
  // The model is told its wake word, so it never "corrects" the user.
  assert.match(buildFrontendInstructions(frontend.agentContexts.at(-1)), /“Hey Jarvis”/)
  client.send({ type: 'audio.append', audio: chunk(2) })
  await waitUntil(() => detectors[0]?.pushed.length === 1)
  assert.equal(frontend.appended.length, 1)

  liveSettings.update({ listeningMode: 'always' })
  await waitUntil(() => client.listening().state === 'always')
  assert.equal(detectors[0].closed, true)
  client.send({ type: 'audio.append', audio: chunk(3) })
  await waitUntil(() => frontend.appended.length === 2)

  client.socket.close()
  await waitUntil(() => liveSettings.listenerCount('change') === 0)
})

test('a persona saved in Settings is resent to an open connection', async t => {
  const { server, frontends, liveSettings } = await startGateway(t, { listeningMode: 'always' })
  const client = await connect(server)
  const frontend = frontends[0]
  const updates = frontend.agentContexts.length

  // Instructions only reach the model on session.update, so an open session
  // keeps the old persona unless the save refreshes it.
  liveSettings.emit('persona')
  await waitUntil(() => frontend.agentContexts.length === updates + 1)

  client.socket.close()
  await waitUntil(() => liveSettings.listenerCount('persona') === 0)
})

test('a wake whose request names the wake word is answered', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  const request = 'Hey Jarvis, what time is it?'

  userTurn(frontend, 'item-v1')
  frontend.emit({ type: 'response.created', response: { id: 'resp-v1' } })
  transcribe(frontend, 'item-v1', request)
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-v1', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)

  assert.equal(client.listening().state, 'awake')
  assert.ok(client.received.some(event => (
    event.type === 'transcript.final' && event.role === 'user' && event.content === request
  )))
  assert.ok(storedUserText().includes(request))
  assert.deepEqual(unverifiedClears(client), [])
  client.socket.close()
})

test('a wake whose request never names the wake word is cancelled unheard and re-armed', async t => {
  const { server, frontends, detectors } = await startGateway(t, { responseStartTimeoutMs: 150 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  const request = 'hey travis what time is it'

  // Transcript first: the response has not started yet.
  userTurn(frontend, 'item-u1', request)
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'unverified')
  assert.equal(unverifiedClears(client).length, 1)
  assert.ok(client.received.some(event => (
    event.type === 'transcript.discard'
    && event.role === 'user'
    && event.reason === 'wake_word_unverified'
  )))
  frontend.emit({ type: 'response.created', response: { id: 'resp-u1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-u1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-u1', status: 'cancelled' } })

  // Armed again: audio feeds only the detector.
  const appended = frontend.appended.length
  client.send({ type: 'audio.append', audio: chunk(2) })
  await waitUntil(() => detectors[0].pushed.length === 2)
  assert.equal(frontend.appended.length, appended)

  // Well past the watchdog: no recovery reconnect, no error, back to idle.
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(frontends.length, 1)
  assert.deepEqual(frontend.ensuredResponses, [])
  assert.equal(client.received.some(event => event.type === 'error'), false)
  assert.equal(
    client.received.filter(event => event.type === 'voice.state').at(-1).state,
    'idle',
  )

  // Response already in flight when the transcript arrives: held, never heard.
  await wake(client, detectors)
  userTurn(frontend, 'item-u2')
  frontend.emit({ type: 'response.created', response: { id: 'resp-u2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-u2', delta: chunk(2) })
  await sleep(50)
  assert.equal(audioDeltaCount(client), 0)
  assert.equal(client.received.some(event => event.type === 'response.started'), false)
  const cancelsBefore = frontend.cancels
  transcribe(frontend, 'item-u2', 'Hey Travis, turn off the lights')
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'unverified')
  assert.ok(frontend.cancels > cancelsBefore)
  assert.equal(unverifiedClears(client).length, 2)
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-u2', delta: chunk(3) })
  frontend.emit({
    type: 'response.done',
    response: {
      id: 'resp-u2',
      status: 'cancelled',
      output: [{ id: 'item-answer-u2', type: 'message', role: 'assistant' }],
    },
  })
  await sleep(50)

  assert.equal(audioDeltaCount(client), 0)
  assert.equal(client.received.some(event => event.type === 'response.started'), false)
  // Forgotten by the provider too, so a later answer cannot repeat it.
  assert.deepEqual(frontend.deleted, ['item-u1', 'item-u2', 'item-answer-u2'])
  assert.equal(client.received.some(event => (
    event.type === 'transcript.final' && event.role === 'user'
  )), false)
  const stored = storedUserText()
  assert.equal(stored.includes(request), false)
  assert.equal(stored.includes('Hey Travis, turn off the lights'), false)
  client.socket.close()
})

// Regression: a bare "Hey Jarvis." was answered aloud ("I'm not Jarvis").
test('a bare wake word is neither answered nor remembered, and keeps listening', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-w1')
  frontend.emit({ type: 'response.created', response: { id: 'resp-w1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-w1', delta: chunk(1) })
  transcribe(frontend, 'item-w1', 'Hey Jarvis.')
  await waitFor(client.received, event => (
    event.type === 'transcript.discard' && event.reason === 'wake_word_only'
  ))
  frontend.emit({
    type: 'response.done',
    response: {
      id: 'resp-w1',
      status: 'cancelled',
      output: [{ id: 'item-answer-w1', type: 'message', role: 'assistant' }],
    },
  })
  await sleep(50)
  assert.equal(client.listening().state, 'awake')
  assert.equal(audioDeltaCount(client), 0)
  assert.equal(client.received.some(event => event.type === 'response.started'), false)
  assert.equal(client.received.some(event => (
    event.type === 'transcript.final' && event.role === 'user'
  )), false)
  assert.equal(storedUserText().includes('Hey Jarvis.'), false)
  assert.deepEqual(frontend.deleted, ['item-w1', 'item-answer-w1'])

  userTurn(frontend, 'item-w2', 'What is the weather like today?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-w2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-w2', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  assert.equal(client.listening().state, 'awake')
  assert.ok(storedUserText().includes('What is the weather like today?'))
  assert.deepEqual(unverifiedClears(client), [])
  client.socket.close()
})

test('a follow-up turn inside the follow-up window needs no wake word', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-f1', 'Hey Jarvis, what is on my calendar?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-f1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-f1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-f1', status: 'completed' } })
  await waitFor(client.received, event => event.type === 'audio.done')
  const voiceStates = () => client.received.filter(event => event.type === 'voice.state').length
  const statesBefore = voiceStates()
  client.send({ type: 'playback.started', responseId: 'resp-f1' })
  client.send({ type: 'playback.ended', responseId: 'resp-f1' })
  await waitUntil(() => voiceStates() > statesBefore)
  assert.equal(client.listening().state, 'awake')

  userTurn(frontend, 'item-f2', 'And tomorrow?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-f2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-f2', delta: chunk(2) })
  await waitUntil(() => audioDeltaCount(client) === 2)
  assert.equal(client.listening().state, 'awake')
  assert.ok(storedUserText().includes('And tomorrow?'))
  assert.deepEqual(unverifiedClears(client), [])
  client.socket.close()
})

// Regression: a side-effecting tool call that the provider sent before the
// transcript reached the brain even though the wake was then rejected.
test('tool calls wait for the wake word check and do nothing for a false wake', async t => {
  const runs = []
  const backendRuntime = {
    run: async payload => {
      runs.push(payload)
      return new Promise(() => {})
    },
    cancel: async () => ({}),
  }
  const { server, frontends, detectors } = await startGateway(t, { backendRuntime })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  const spawn = (responseId, callId, objective) => frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: responseId,
    call_id: callId,
    name: 'spawn_thinking',
    arguments: JSON.stringify({ objective }),
  })

  userTurn(frontend, 'item-t1')
  frontend.emit({ type: 'response.created', response: { id: 'resp-t1' } })
  spawn('resp-t1', 'call-t1', 'Email Bob the contract')
  frontend.emit({ type: 'response.done', response: { id: 'resp-t1', status: 'completed' } })
  await sleep(100)
  assert.deepEqual(runs, [])
  assert.deepEqual(frontend.functionOutputs, [])

  transcribe(frontend, 'item-t1', 'Hey Travis, email Bob the contract')
  await waitUntil(() => frontend.functionOutputs.length === 1)
  assert.equal(client.listening().reason, 'unverified')
  assert.equal(frontend.functionOutputs[0][1].status, 'superseded')
  await sleep(100)
  assert.deepEqual(runs, [])
  assert.equal(client.received.some(event => event.type.startsWith('task.')), false)

  // A confirmed wake runs the held call.
  await wake(client, detectors)
  userTurn(frontend, 'item-t2')
  frontend.emit({ type: 'response.created', response: { id: 'resp-t2' } })
  spawn('resp-t2', 'call-t2', 'Check my calendar')
  transcribe(frontend, 'item-t2', 'Hey Jarvis, check my calendar')
  await waitUntil(() => runs.length === 1)
  client.socket.close()
})

// Regression: a detection landing after the client lost the microphone
// flushed the pre-roll and reopened the provider session.
test('a detection that lands after the microphone is released sends nothing', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  for (let index = 1; index <= 5; index += 1) {
    client.send({ type: 'audio.append', audio: chunk(index) })
  }
  await waitUntil(() => detectors[0]?.pushed.length === 5)
  client.send({ type: 'mute' })
  await waitUntil(() => frontends[0].ready === false)
  detectors[0].options.onDetected()
  await sleep(100)
  assert.equal(frontends.length, 1)
  assert.deepEqual(frontends[0].appended, [])
  client.socket.close()
})

// Regression: a turn that never got a settled response left the gate awake
// with no timer.
test('a turn with no response, or an invalid turn, still ends the awake window', async t => {
  const { server, frontends, detectors } = await startGateway(t, {
    followUpSeconds: 0,
    responseStartTimeoutMs: 150,
  })
  const client = await connect(server)
  await wake(client, detectors)
  userTurn(frontends[0], 'item-n1', 'Hey Jarvis, what time is it?')
  await waitUntil(() => client.listening().state === 'armed', 3000)
  assert.equal(client.listening().reason, 'follow_up_expired')

  await waitUntil(() => frontends.length === 2 && frontends[1].ready)
  await wake(client, detectors)
  const frontend = frontends.at(-1)
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-n2' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-n2', reason: 'turn_invalid' })
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'follow_up_expired')
  client.socket.close()
})

// Regression: arming while the provider still heard speech left that turn
// open, blocking announcements and merging it into the next wake.
test('re-arming mid-speech ends that turn here and at the provider', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-s1')
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-s2' })
  const appendedBefore = frontend.appended.length
  transcribe(frontend, 'item-s1', 'and in other news the weather is fine')
  await waitUntil(() => client.listening().state === 'armed')

  // Trailing silence lets the provider's VAD close the open turn.
  const silence = frontend.appended.slice(appendedBefore)
  assert.ok(silence.length >= 15)
  assert.ok(silence.every(audio => Buffer.from(audio, 'base64').every(byte => byte === 0)))
  assert.equal(client.received.filter(event => event.type === 'voice.state').at(-1).state, 'idle')

  // Its late end, transcript and response stay unheard and forgotten.
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-s2' })
  transcribe(frontend, 'item-s2', 'the weather is fine')
  frontend.emit({ type: 'response.created', response: { id: 'resp-s2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-s2', delta: chunk(1) })
  await sleep(50)
  assert.equal(audioDeltaCount(client), 0)
  assert.ok(client.received.some(event => (
    event.type === 'transcript.discard' && event.reason === 'listening_armed'
  )))
  assert.equal(client.received.some(event => (
    event.type === 'transcript.final' && event.role === 'user'
  )), false)
  assert.equal(client.received.filter(event => event.type === 'voice.state').at(-1).state, 'idle')
  assert.deepEqual(frontend.deleted, ['item-s1', 'item-s2'])

  // The next wake is a fresh, checked turn.
  await wake(client, detectors)
  userTurn(frontend, 'item-s3', 'Hey Jarvis, turn off the lights')
  frontend.emit({ type: 'response.created', response: { id: 'resp-s3' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-s3', delta: chunk(2) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  client.socket.close()
})

// Regression: the desktop orb (its own wake word, no armed state shown) had
// every command silently dropped in wake word mode.
test('the wake word gate is WebUI-only: a desktop client keeps listening', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server, { clientType: 'desktop' })
  await waitUntil(() => client.listening()?.state === 'always')
  client.send({ type: 'audio.append', audio: chunk(1) })
  await waitUntil(() => frontends[0].appended.length === 1)
  assert.equal(detectors.length, 0)
  const toolNames = frontendTools(frontends[0].agentContexts.at(-1)).map(tool => tool.function.name)
  assert.equal(toolNames.includes('stop_listening'), false)
  client.socket.close()
})

// Regression (live): DashScope ended a real request without a speech start,
// so it was filed under the refused false wake before it and dropped.
test('speech the provider never announced after a refused wake gets its own check', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  userTurn(frontend, 'item-g1', 'Hey Travis, what is two plus two?')
  await waitUntil(() => client.listening().state === 'armed')

  // A real wake: only speech_stopped arrives for its item.
  await wake(client, detectors)
  const turnsBefore = client.received.filter(event => event.type === 'turn.started').length
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-g2' })
  frontend.emit({ type: 'input_audio_buffer.committed', item_id: 'item-g2' })
  frontend.emit({ type: 'response.created', response: { id: 'resp-g2' } })
  transcribe(frontend, 'item-g2', 'Hey Jarvis, what did I just ask you?')
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-g2', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  assert.equal(client.received.filter(event => event.type === 'turn.started').length, turnsBefore + 1)
  assert.ok(client.received.some(event => (
    event.type === 'transcript.final'
    && event.role === 'user'
    && event.content === 'Hey Jarvis, what did I just ask you?'
  )))
  assert.equal(frontend.deleted.includes('item-g2'), false)

  // The same gap on a false wake is still checked and refused.
  frontend.emit({ type: 'response.done', response: { id: 'resp-g2', status: 'completed' } })
  client.send({ type: 'playback.started', responseId: 'resp-g2' })
  client.send({ type: 'playback.ended', responseId: 'resp-g2' })
  client.send({ type: 'audio.append', audio: chunk(9) })
  await sleep(50)
  client.socket.close()
})

test('unannounced speech right after a wake that never names the wake word is refused', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-h1' })
  frontend.emit({ type: 'response.created', response: { id: 'resp-h1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-h1', delta: chunk(1) })
  transcribe(frontend, 'item-h1', 'Hey Travis, turn off the lights')
  await waitUntil(() => client.listening().state === 'armed')
  assert.equal(client.listening().reason, 'unverified')
  await sleep(50)
  assert.equal(audioDeltaCount(client), 0)
  assert.deepEqual(frontend.deleted, ['item-h1'])
  client.socket.close()
})

const interruptions = client => client.received.filter(event => (
  event.type === 'playback.clear' && event.reason === 'user_interruption'
)).length
const countdowns = client => client.received.filter(event => (
  event.type === 'voice.listening' && event.followUpMs !== undefined
))

// Regression: the interrupted answer's late cancel started the follow-up
// window while the new turn still waited for its answer, so a slow answer
// played re-armed and could no longer be talked over.
test('speech over an answer interrupts it and is answered, however late the answer starts', async t => {
  const { server, frontends, detectors } = await startGateway(t, { followUpSeconds: 1 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-i1', 'Hey Jarvis, tell me a long story.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-i1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-i1', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  client.send({ type: 'playback.started', responseId: 'resp-i1' })
  await sleep(50)

  // Talking over it stops playback, as in always mode.
  const clearsBefore = interruptions(client)
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-i2' })
  await waitUntil(() => interruptions(client) > clearsBefore)
  client.send({ type: 'playback.cancelled', responseId: 'resp-i1', reason: 'user_interruption' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-i2' })
  // The provider's cancel lands after the speech ended, and the answer is slow.
  frontend.emit({ type: 'response.done', response: { id: 'resp-i1', status: 'cancelled' } })
  transcribe(frontend, 'item-i2', 'Actually, what time is it?')
  await sleep(1_800)
  assert.equal(client.listening().state, 'awake')
  assert.deepEqual(countdowns(client), [])

  frontend.emit({ type: 'response.created', response: { id: 'resp-i2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-i2', delta: chunk(2) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-i2', status: 'completed' } })
  await waitUntil(() => audioDeltaCount(client) === 2)
  client.send({ type: 'playback.started', responseId: 'resp-i2' })
  const appended = frontend.appended.length
  client.send({ type: 'audio.append', audio: chunk(3) })
  await waitUntil(() => frontend.appended.length === appended + 1)
  assert.equal(client.listening().state, 'awake')

  // Finished talking: the countdown starts, and silence re-arms after it.
  client.send({ type: 'playback.ended', responseId: 'resp-i2' })
  await waitUntil(() => countdowns(client).length === 1)
  const countdown = countdowns(client)[0]
  assert.equal(countdown.state, 'awake')
  assert.equal(countdown.reason, 'follow_up')
  assert.equal(countdown.followUpMs, 1000)
  // A short hidden grace follows the visible countdown.
  await sleep(1_150)
  assert.equal(client.listening().state, 'awake')
  await waitUntil(() => client.listening().state === 'armed', 1_000)
  assert.equal(client.listening().reason, 'follow_up_expired')
  assert.equal(client.listening().followUpMs, undefined)
  client.socket.close()
})

test('speech a few seconds after the answer reaches the provider and needs no wake word', async t => {
  const { server, frontends, detectors } = await startGateway(t)
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-b1', 'Hey Jarvis, what is on my calendar?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-b1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-b1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-b1', status: 'completed' } })
  await waitUntil(() => audioDeltaCount(client) === 1)
  const voiceStates = () => client.received.filter(event => event.type === 'voice.state').length
  const statesBefore = voiceStates()
  client.send({ type: 'playback.started', responseId: 'resp-b1' })
  client.send({ type: 'playback.ended', responseId: 'resp-b1' })
  await waitUntil(() => voiceStates() > statesBefore + 1)

  await sleep(4_000)
  const appended = frontend.appended.length
  client.send({ type: 'audio.append', audio: chunk(5) })
  await waitUntil(() => frontend.appended.length === appended + 1)
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-b2' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-b2' })
  transcribe(frontend, 'item-b2', 'And tomorrow?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-b2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-b2', delta: chunk(2) })
  await waitUntil(() => audioDeltaCount(client) === 2)
  assert.equal(client.listening().state, 'awake')
  assert.ok(storedUserText().includes('And tomorrow?'))

  // The countdown was shown, then hidden once the user spoke.
  assert.equal(countdowns(client).length, 1)
  assert.equal(countdowns(client)[0].followUpMs, 5000)
  assert.notEqual(client.listening().reason, 'follow_up')
  assert.equal(client.listening().followUpMs, undefined)
  client.socket.close()
})

test('a failed answer starts the countdown once its audio stops', async t => {
  const { server, frontends, detectors } = await startGateway(t, { followUpSeconds: 1 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-e1', 'Hey Jarvis, tell me a story.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-e1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-e1', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  client.send({ type: 'playback.started', responseId: 'resp-e1' })
  await sleep(50)
  frontend.emit({ type: 'error', response_id: 'resp-e1', error: { message: 'Internal server error' } })
  await sleep(50)
  assert.deepEqual(countdowns(client), [])
  client.send({ type: 'playback.ended', responseId: 'resp-e1' })
  await waitUntil(() => countdowns(client).length === 1)
  assert.equal(countdowns(client)[0].followUpMs, 1000)
  client.socket.close()
})

test('input the model ignores does not extend the follow-up window', async t => {
  const { server, frontends, detectors } = await startGateway(t, { followUpSeconds: 1 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-g1', 'Hey Jarvis, what time is it?')
  frontend.emit({ type: 'response.created', response: { id: 'resp-g1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-g1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-g1', status: 'completed' } })
  await waitUntil(() => audioDeltaCount(client) === 1)
  client.send({ type: 'playback.started', responseId: 'resp-g1' })
  client.send({ type: 'playback.ended', responseId: 'resp-g1' })
  await waitUntil(() => countdowns(client).length === 1)
  const started = Date.now()

  // The TV talks, and the model ignores it.
  await sleep(500)
  userTurn(frontend, 'item-g2')
  frontend.emit({ type: 'response.created', response: { id: 'resp-g2' } })
  frontend.emit({
    type: 'response.function_call_arguments.done',
    response_id: 'resp-g2',
    call_id: 'call-g2',
    name: 'ignore_input',
    arguments: '{}',
  })
  frontend.emit({ type: 'response.done', response: { id: 'resp-g2', status: 'completed' } })
  transcribe(frontend, 'item-g2', 'and now the weather for the weekend')
  await waitUntil(() => countdowns(client).length === 2)
  const resumed = countdowns(client)[1].followUpMs
  assert.ok(resumed > 0 && resumed < 1000, String(resumed))
  await waitUntil(() => client.listening().state === 'armed', 2_000)
  assert.ok(Date.now() - started < 1_800)
  client.socket.close()
})

// Regression: the provider announces speech a few hundred ms after it
// starts, so speech begun at the end of the window was cut by the arm.
test('speech begun just before the window ends is not cut off', async t => {
  const { server, frontends, detectors } = await startGateway(t, { followUpSeconds: 1 })
  const client = await connect(server)
  await wake(client, detectors)
  const frontend = frontends[0]

  userTurn(frontend, 'item-l1', 'Hey Jarvis, set a timer.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-l1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-l1', delta: chunk(1) })
  frontend.emit({ type: 'response.done', response: { id: 'resp-l1', status: 'completed' } })
  await waitUntil(() => audioDeltaCount(client) === 1)
  const voiceStates = () => client.received.filter(event => event.type === 'voice.state').length
  const statesBefore = voiceStates()
  client.send({ type: 'playback.started', responseId: 'resp-l1' })
  client.send({ type: 'playback.ended', responseId: 'resp-l1' })
  await waitUntil(() => voiceStates() > statesBefore + 1)

  await sleep(900)
  const appended = frontend.appended.length
  client.send({ type: 'audio.append', audio: chunk(6) })
  await waitUntil(() => frontend.appended.length === appended + 1)
  await sleep(250)
  frontend.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-l2' })
  frontend.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-l2' })
  transcribe(frontend, 'item-l2', 'For ten minutes.')
  frontend.emit({ type: 'response.created', response: { id: 'resp-l2' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-l2', delta: chunk(2) })
  await waitUntil(() => audioDeltaCount(client) === 2)
  assert.equal(client.listening().state, 'awake')
  assert.equal(client.received.some(event => event.reason === 'listening_armed'), false)
  client.socket.close()
})

test('speech the assistant starts on its own opens the follow-up window', async t => {
  const { server, frontends } = await startGateway(t)
  const client = await connect(server)
  await waitUntil(() => client.listening()?.state === 'armed')
  const frontend = frontends[0]

  // A task result spoken while armed: nobody said the wake word.
  frontend.emit({ type: 'response.created', response: { id: 'resp-s1' } })
  frontend.emit({ type: 'response.output_audio.delta', response_id: 'resp-s1', delta: chunk(1) })
  await waitUntil(() => audioDeltaCount(client) === 1)
  assert.equal(client.listening().state, 'armed')
  client.send({ type: 'playback.started', responseId: 'resp-s1' })
  await waitUntil(() => client.listening().state === 'awake')
  assert.equal(client.listening().reason, 'assistant_speaking')

  // The microphone reaches the provider, so the user can talk over it.
  const appended = frontend.appended.length
  client.send({ type: 'audio.append', audio: chunk(5) })
  await waitUntil(() => frontend.appended.length === appended + 1)

  frontend.emit({ type: 'response.done', response: { id: 'resp-s1', status: 'completed' } })
  client.send({ type: 'playback.ended', responseId: 'resp-s1' })
  await waitUntil(() => countdowns(client).length === 1)
  assert.equal(countdowns(client)[0].followUpMs, 5000)
  assert.equal(client.listening().state, 'awake')
  client.socket.close()
})
