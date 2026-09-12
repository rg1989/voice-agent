import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageMeter, readUsage, costOf } from '../src/usage/usage-meter.mjs'

// A real response.done captured from DashScope, trimmed to the parts that matter.
const event = (over = {}) => ({
  type: 'response.done',
  response: {
    status: 'completed',
    usage: {
      total_tokens: 2105,
      input_tokens: 2024,
      output_tokens: 81,
      input_tokens_details: { text_tokens: 2024 },
      output_tokens_details: { text_tokens: 21, audio_tokens: 60 },
      ...over,
    },
  },
})

const MODEL = 'qwen3.5-omni-flash-realtime'
const meter = () => new UsageMeter({ store: null, now: () => Date.UTC(2026, 8, 13) }).load()

test('reads usage from response.usage, not the top level', () => {
  assert.deepEqual(readUsage(event()), {
    textIn: 2024, audioIn: 0, textOut: 21, audioOut: 60, total: 2105,
  })
  // OpenAI's singular field names must not be mistaken for these
  assert.equal(readUsage({ response: { usage: { input_token_details: { text_tokens: 9 } } } }), null)
  assert.equal(readUsage({ usage: { total_tokens: 10 } }), null)
  assert.equal(readUsage({}), null)
})

test('tool-call turns omit audio_tokens without breaking the maths', () => {
  const counters = readUsage(event({
    output_tokens_details: { text_tokens: 43 },
    total_tokens: 567,
  }))
  assert.equal(counters.audioOut, 0)
  assert.equal(counters.total, 567)
})

test('prices text and audio separately', () => {
  // 2024 text in @ $0.55/M + 21 text out @ $3.30/M + 60 audio out @ $17.70/M
  const expected = (2024 * 0.55 + 21 * 3.30 + 60 * 17.70) / 1_000_000
  assert.ok(Math.abs(costOf(readUsage(event()), MODEL) - expected) < 1e-12)
})

test('an unknown model reports unpriced rather than guessing a rate', () => {
  assert.equal(costOf(readUsage(event()), 'some-future-model'), null)
  const m = meter()
  m.record(event(), 'some-future-model')
  const snap = m.snapshot('some-future-model')
  assert.equal(snap.priced, false)
  assert.equal(snap.session.cost, null)
  assert.equal(snap.session.total, 2105)
})

test('accumulates across turns, as Alibaba bills', () => {
  const m = meter()
  m.record(event(), MODEL)
  m.record(event(), MODEL)
  const snap = m.snapshot(MODEL)
  assert.equal(snap.session.turns, 2)
  assert.equal(snap.session.total, 4210)
  assert.equal(snap.today.total, 4210)
})

test('quota remaining is derived and labelled an estimate', () => {
  const m = meter()
  m.record(event(), MODEL)
  const { quota } = m.snapshot(MODEL)
  assert.equal(quota.estimate, true)
  assert.equal(quota.usedTokens, 2105)
  assert.equal(quota.remainingTokens, 1_000_000 - 2105)
  assert.equal(quota.exhausted, false)
})

test('quota exhaustion is recorded from the 403, not inferred from the estimate', () => {
  const m = meter()
  m.markQuotaExhausted(MODEL)
  assert.equal(m.snapshot(MODEL).quota.exhausted, true)
  m.markQuotaExhausted(MODEL, false)
  assert.equal(m.snapshot(MODEL).quota.exhausted, false)
})

test('usage for one model does not count against another model quota', () => {
  const m = meter()
  m.record(event(), MODEL)
  assert.equal(m.snapshot('qwen-audio-3.0-realtime-plus').quota.usedTokens, 0)
})
