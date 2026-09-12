import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceSafe } from '../src/voice/realtime-agent-delivery-runtime.mjs'

// QWEN_AUDIO_VOICE_SUMMARY_ONLY keeps the backend Agent's full reply off the
// Realtime provider's wire. The provider still has to be told something, so
// the backend opts in by ending its reply with a VOICE: line and only that
// line is forwarded.

const RESULT = [
  'Refactored the auth module.',
  '- /Users/me/clients/acme/src/auth/session.ts',
  '- hardcoded key sk_live_8f3a9c2e1b7d4056 must be rotated',
  '',
  'VOICE: Auth refactor done, one key still needs rotating.',
].join('\n')

const SECRETS = ['sk_live_8f3a9c2e1b7d4056', 'acme', 'session.ts']

test('disabled by default, so the shipped delivery contract is unchanged', () => {
  assert.equal(voiceSafe(RESULT, 'announcement', { enabled: false }), RESULT)
})

test('enabled, only the backend-authored VOICE line reaches the provider', () => {
  const out = voiceSafe(RESULT, 'announcement', { enabled: true })
  assert.equal(out, 'Auth refactor done, one key still needs rotating.')
  for (const secret of SECRETS) assert.ok(!out.includes(secret), `leaked ${secret}`)
})

test('fails closed when the backend omits the line', () => {
  const withoutLine = RESULT.split('\n').filter(l => !l.startsWith('VOICE:')).join('\n')
  const out = voiceSafe(withoutLine, 'announcement', { enabled: true })
  assert.equal(out, 'Done. The full result is on screen.')
  for (const secret of SECRETS) assert.ok(!out.includes(secret), `leaked ${secret}`)
})

test('only backend-authored origins are summarised', () => {
  // Reminders and permission prompts are Gateway-authored: a permission prompt
  // exists so the user can give informed consent, and summarising it away
  // would mean approving commands blind.
  const reminder = 'Reminder: call the dentist at 3pm.'
  const permission = 'Agent wants to run: rm -rf ./build'
  assert.equal(voiceSafe(reminder, 'gateway-system-event', { enabled: true }), reminder)
  assert.equal(voiceSafe(permission, 'permission', { enabled: true }), permission)
})

test('a summary longer than the cap is bounded', () => {
  const long = `VOICE: ${'x'.repeat(900)}`
  assert.equal(voiceSafe(long, 'announcement', { enabled: true }).length, 400)
})
