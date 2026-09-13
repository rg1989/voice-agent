import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restartEnvironment } from '../src/app/runtime-settings.mjs'

test('a restart drops the workspace variables the old gateway derived, so a newly saved folder wins', () => {
  const env = restartEnvironment({
    PATH: '/usr/bin',
    QWAUDIO_WORKSPACE: '/old/folder',
    ACP_WORKSPACE: '/Users/me/.config/qwaudio/data/workspace',
    CLAUDE_WORKSPACE: '/Users/me/.config/qwaudio/data/workspace',
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal('QWAUDIO_WORKSPACE' in env, false)
  assert.equal('ACP_WORKSPACE' in env, false)
  assert.equal('CLAUDE_WORKSPACE' in env, false)
})
