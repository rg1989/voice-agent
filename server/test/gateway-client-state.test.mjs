import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGatewayClientState,
  reduceGatewayClientState,
} from '../../shared/gateway/client-state.mjs'
import { parseGatewayServerMessage } from '../../shared/protocol/gateway-events.mjs'

test('client state tracks the listening gate', () => {
  let state = createGatewayClientState()
  assert.equal(state.listeningState, 'always')
  assert.equal(state.listeningWakeWord, '')

  state = reduceGatewayClientState(state, {
    type: 'voice.listening',
    state: 'armed',
    reason: 'connected',
    wakeWord: 'hey_jarvis',
  })
  assert.equal(state.listeningState, 'armed')
  assert.equal(state.listeningWakeWord, 'hey_jarvis')

  state = reduceGatewayClientState(state, { type: 'voice.listening', state: 'awake' })
  assert.equal(state.listeningState, 'awake')
  assert.equal(state.listeningWakeWord, 'hey_jarvis')
})

test('voice.listening is a valid server event with a known state', () => {
  assert.equal(parseGatewayServerMessage({
    type: 'voice.listening',
    state: 'awake',
    reason: 'wake_word',
    wakeWord: 'alexa',
  }).state, 'awake')
  assert.throws(() => parseGatewayServerMessage({ type: 'voice.listening', state: 'dozing' }))
})
