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

test('client state keeps the follow-up countdown only until the next listening status', () => {
  let state = createGatewayClientState()
  assert.equal(state.listeningFollowUpMs, 0)
  assert.equal(state.listeningFollowUpKey, 0)

  const followUp = { type: 'voice.listening', state: 'awake', reason: 'follow_up', followUpMs: 5000 }
  state = reduceGatewayClientState(state, followUp)
  assert.equal(state.listeningFollowUpMs, 5000)
  assert.equal(state.listeningFollowUpKey, 1)

  // A second countdown restarts the bar even with the same length.
  state = reduceGatewayClientState(state, followUp)
  assert.equal(state.listeningFollowUpKey, 2)

  state = reduceGatewayClientState(state, { type: 'voice.listening', state: 'awake', reason: 'speech' })
  assert.equal(state.listeningFollowUpMs, 0)
  assert.equal(state.listeningFollowUpKey, 2)

  state = reduceGatewayClientState(state, followUp)
  state = reduceGatewayClientState(state, { type: 'voice.listening', state: 'armed', reason: 'follow_up_expired' })
  assert.equal(state.listeningFollowUpMs, 0)

  state = reduceGatewayClientState(state, followUp)
  state = reduceGatewayClientState(state, { type: 'gateway.disconnected' })
  assert.equal(state.listeningFollowUpMs, 0)

  state = reduceGatewayClientState(state, { ...followUp, followUpMs: 0 })
  assert.equal(state.listeningFollowUpMs, 0)
  assert.equal(state.listeningFollowUpKey, 4)
})

test('voice.listening is a valid server event with a known state', () => {
  assert.equal(parseGatewayServerMessage({
    type: 'voice.listening',
    state: 'awake',
    reason: 'wake_word',
    wakeWord: 'hey_megan',
  }).state, 'awake')
  assert.throws(() => parseGatewayServerMessage({ type: 'voice.listening', state: 'dozing' }))
})
