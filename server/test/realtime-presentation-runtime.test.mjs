import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function harness({
  nonVoiceClient = false,
  turnCitations = null,
  terminalToolResponses = [],
  resultSummaryResponses = [],
  perResponseInstructions = false,
  conversationItems = false,
} = {}) {
  const events = []
  const records = []
  const calls = []
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  let responseTurnCandidate = null
  const frontend = {
    ready: true,
    provider: { outputSampleRate: 24000 },
    capabilities: { perResponseInstructions, conversationItems },
    ensureResponse: async (...args) => calls.push(['ensureResponse', ...args]),
  }
  const terminalResponses = new Set(terminalToolResponses)
  const runtime = new RealtimePresentationRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    conversationSync: { record: value => records.push(value) },
    announcementWindow: {
      queueAudio: (...args) => calls.push(['queueAudio', ...args]),
      startPlayback: (...args) => calls.push(['startPlayback', ...args]),
      finishPlayback: (...args) => calls.push(['finishPlayback', ...args]),
      responseDone: (...args) => calls.push(['responseDone', ...args]),
    },
    announcements: {
      confirmMany: ids => calls.push(['confirmMany', ids]),
      retryMany: ids => calls.push(['retryMany', ids]),
      flush: () => calls.push(['flush']),
    },
    toolCalls: {
      requiresToolResultSummary: id => resultSummaryResponses.includes(id),
      consumeTerminalToolResponse: id => {
        calls.push(['consumeTerminalToolResponse', id])
        return terminalResponses.delete(id)
      },
      finishToolResponse: async (...args) => calls.push([
        'finishToolResponse',
        ...args,
      ]),
    },
    send: event => events.push(event),
    getFrontend: () => frontend,
    getOutputEnabled: () => true,
    getNonVoiceClient: () => nonVoiceClient,
    getResponseTurnCandidate: () => responseTurnCandidate,
    clearResponseCandidate: () => {
      responseTurnCandidate = null
      calls.push(['clearResponseCandidate'])
    },
    announcementQuietMs: 60_000,
    responseContextCleanupMs: 60_000,
    turnCitations,
    onResponseSettled: (context, id) => calls.push(['settled', id]),
  })
  return {
    runtime,
    frontend,
    turns,
    events,
    records,
    calls,
    setResponseTurnCandidate(value) {
      responseTurnCandidate = value
    },
  }
}

test('projects turn citations once on the final assistant transcript', () => {
  const stored = [{
    id: 'source_1',
    title: '杭州天气',
    url: 'https://example.com/weather',
  }]
  let consumed = false
  const setup = harness({
    turnCitations: {
      consume(turnId) {
        assert.equal(turnId, 'turn-1')
        if (consumed) return []
        consumed = true
        return stored
      },
    },
  })

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-1',
    text: '今天晴。',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })

  const final = setup.events.find(event => event.type === 'transcript.final')
  assert.deepEqual(final.citations, stored)
  assert.deepEqual(setup.records[0].citations, stored)
})

test('does not persist a model-generated Gateway protocol envelope', () => {
  const setup = harness()
  const content = [
    '<permission_request>',
    'task_id=fake',
    '</permission_request>',
  ].join(' ')

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-fake-protocol',
    text: content,
    __voiceContext: {
      origin: 'model',
      turnId: 'turn-1',
      turnGeneration: 1,
    },
  })

  assert.equal(setup.records.length, 0)
  assert.equal(
    setup.events.some(event => (
      event.type === 'transcript.final' && event.content === content
    )),
    true,
  )
})

test('allows only one protocol correction per user turn, including repeated invalid corrections', () => {
  const setup = harness({ perResponseInstructions: true })
  const invalidResponse = id => {
    const context = setup.turns.committed()
    deliver(setup.runtime, {
      type: 'response.text.done', response_id: id,
      text: '<permission_request>fake</permission_request>', __voiceContext: context,
    })
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' } })
  }
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.commit(first)
  invalidResponse('response-1')
  invalidResponse('response-2')
  invalidResponse('response-3')
  const corrections = () => setup.calls.filter(([name]) => name === 'ensureResponse')
  assert.equal(corrections().length, 1)
  assert.equal(corrections()[0][2].shouldCreate(), true)
  const second = setup.turns.beginVoice('input-2').context
  setup.turns.endSpeech()
  setup.turns.commit(second)
  assert.equal(corrections()[0][2].shouldCreate(), false)
  invalidResponse('response-4')
  assert.equal(corrections().length, 2)
})

test('corrects a refusal only in a turn without any tool call', () => {
  const setup = harness({ conversationItems: true })
  const corrections = () => setup.calls.filter(([name]) => name === 'ensureResponse')
  const refusal = id => {
    deliver(setup.runtime, {
      type: 'response.text.done', response_id: id,
      text: "Sorry, I can't open that file.", __voiceContext: setup.turns.committed(),
    })
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' } })
  }
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.commit(first)
  deliver(setup.runtime, {
    type: 'response.created',
    response: { id: 'response-tool' },
    __voiceContext: setup.turns.committed(),
  })
  setup.runtime.markFunctionCall('response-tool')
  deliver(setup.runtime, { type: 'response.done', response: { id: 'response-tool', status: 'completed' } })
  refusal('response-relay')
  assert.equal(corrections().length, 0)

  const second = setup.turns.beginVoice('input-2').context
  setup.turns.endSpeech()
  setup.turns.commit(second)
  refusal('response-refusal')
  assert.equal(corrections().length, 1)
  assert.equal(corrections()[0][2].response, undefined)
  assert.match(corrections()[0][2].userContext, /^（系统提示：[\s\S]*spawn_thinking/)
})

test('does not correct a follow-up that relays a task result or when delegation is unavailable', () => {
  const setup = harness({ conversationItems: true })
  const corrections = () => setup.calls.filter(([name]) => name === 'ensureResponse')
  const turn = inputId => {
    const context = setup.turns.beginVoice(inputId).context
    setup.turns.endSpeech()
    setup.turns.commit(context)
  }
  const refusal = id => {
    deliver(setup.runtime, {
      type: 'response.text.done', response_id: id,
      text: "I don't have access to your email account yet.", __voiceContext: setup.turns.committed(),
    })
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' } })
  }
  turn('input-1')
  deliver(setup.runtime, {
    type: 'response.created',
    response: { id: 'response-result' },
    __voiceOrigin: 'announcement',
    __voiceContext: { ...setup.turns.committed(), taskIds: ['task-1'] },
  })
  deliver(setup.runtime, { type: 'response.done', response: { id: 'response-result', status: 'completed' } })
  turn('input-2')
  refusal('response-relay')
  assert.equal(corrections().length, 0)

  setup.frontend.agentContext = { frontend: { disabledTools: ['spawn_thinking'] } }
  turn('input-3')
  refusal('response-unconfigured')
  assert.equal(corrections().length, 0)

  setup.frontend.agentContext = {}
  turn('input-4')
  refusal('response-refusal')
  assert.equal(corrections().length, 1)
})

function deliver(runtime, event) {
  runtime.begin(event)
  runtime.handle(event)
}

test('correlates an implicit provider response with the pending voice turn', () => {
  const setup = harness()
  const candidate = setup.turns.beginVoice('item-1').context
  setup.turns.endSpeech()
  setup.setResponseTurnCandidate(candidate)

  deliver(setup.runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
  })

  assert.deepEqual(setup.turns.committed(), candidate)
  assert.equal(setup.events[0].type, 'response.started')
  assert.equal(setup.events[1].type, 'audio.delta')
  assert.equal(setup.events[1].sampleRate, 24000)
  assert.equal(
    setup.calls.some(([name]) => name === 'clearResponseCandidate'),
    true,
  )
})

test('holds audio transcripts until playback starts and records them once', () => {
  const { runtime, events, records, calls } = harness()
  const context = {
    turnId: 'turn-1',
    turnGeneration: 1,
    taskIds: ['work-1'],
    consumesTaskNotification: true,
  }

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: context,
  })
  deliver(runtime, {
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    delta: '后台任务',
  })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '后台任务完成了',
  })
  assert.equal(events.some(event => event.type === 'transcript.final'), false)

  runtime.startPlayback('response-1')

  assert.deepEqual(
    events.filter(event => event.type.startsWith('transcript.')).map(event => ({
      type: event.type,
      content: event.content,
    })),
    [
      { type: 'transcript.delta', content: '后台任务' },
      { type: 'transcript.final', content: '后台任务完成了' },
    ],
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'realtime-direct')
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    1,
  )
})

test('retires an audio response only after response, transcript and playback end', () => {
  const { runtime } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '完成',
  })
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  assert.equal(runtime.has('response-1'), true)

  runtime.finishPlayback('response-1')

  assert.equal(runtime.has('response-1'), false)
})

test('keeps processing while a foreground tool result is pending', () => {
  const { runtime, events } = harness()

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing'],
  )
})

test('returns to idle after a terminal tool response', () => {
  const { runtime, events } = harness({
    terminalToolResponses: ['response-1'],
  })

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing', 'idle'],
  )
})

test('releases a spoken function-call turn when its tool follow-up is suppressed', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  runtime.finishPlayback('response-1')

  assert.equal(events.at(-1).type, 'voice.state')
  assert.equal(events.at(-1).state, 'idle')
  assert.deepEqual(
    calls.find(([name]) => name === 'finishToolResponse'),
    ['finishToolResponse', 'response-1', {
      suppressResponse: false,
      sourceHasSpeech: true,
    }],
  )
  assert.deepEqual(
    calls.find(([name]) => name === 'responseDone'),
    ['responseDone', {
      turnId: 'turn-1',
      origin: 'model',
      hasAudio: true,
      awaitsToolFollowUp: false,
      suppressed: false,
      failed: false,
    }],
  )
})

test('keeps a spoken inline-tool turn open until its results can be summarized', () => {
  const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
    'finishToolResponse', 'response-1', { suppressResponse: false, sourceHasSpeech: true },
  ])
  assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, true)
})

for (const status of ['failed', 'cancelled', 'incomplete']) {
  test(`suppresses even an inline result summary when the source response is ${status}`, () => {
    const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
    deliver(runtime, {
      type: 'response.created',
      response: { id: 'response-1' },
      __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
    })
    runtime.markFunctionCall('response-1')
    deliver(runtime, { type: 'response.done', response: { id: 'response-1', status } })
    assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
      'finishToolResponse', 'response-1', { suppressResponse: true, sourceHasSpeech: false },
    ])
    assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, false)
  })
}

test('user interruption confirms an announcement and suppresses late output', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })
  runtime.startPlayback('response-1')
  runtime.cancelPlayback('response-1', { reason: 'user_interruption' })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '不应出现',
  })

  assert.equal(
    events.filter(event => event.type === 'transcript.final').length,
    0,
  )
  assert.equal(
    events.filter(event => event.type === 'response.interrupted').length,
    1,
  )
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    3,
  )
  assert.equal(calls.some(([name]) => name === 'retryMany'), false)
})

test('a failed answer still playing settles once its playback stops', () => {
  const { runtime, calls } = harness()
  const settled = () => calls.filter(([name]) => name === 'settled').length
  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.startPlayback('response-1')
  runtime.failResponse({ type: 'error', response_id: 'response-1' })
  assert.equal(settled(), 1)
  runtime.cancelPlayback('response-1', { reason: 'provider_content_safety' })
  assert.deepEqual(calls.filter(([name]) => name === 'settled').at(-1), ['settled', 'response-1'])
  assert.equal(settled(), 2)
  runtime.cancelPlayback('response-1')
  assert.equal(settled(), 2)
})

test('a provider failure retries an undelivered announcement', () => {
  const { runtime, calls } = harness()
  runtime.begin({
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })

  runtime.failResponse({ type: 'error', response_id: 'response-1' })

  assert.equal(runtime.has('response-1'), false)
  assert.deepEqual(
    calls.find(([name]) => name === 'retryMany'),
    ['retryMany', ['work-1']],
  )
})
