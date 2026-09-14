import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionBroker } from '../src/backend/adapters/acp/permission-broker.mjs'

test('permission IDs stay short and distinct across independent broker lifetimes', async () => {
  const ids = new Set()
  const results = []
  for (let instance = 0; instance < 3; instance += 1) {
    const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
    for (let request = 0; request < 100; request += 1) {
      results.push(broker.request({ toolCall: { title: 'Read a file' }, options: [] }, {
        session: { ownerId: 'owner', onEvent: event => {
          if (event.type !== 'backend.permission.requested') return
          assert.match(event.permission.id, /^auth_[A-Za-z0-9_-]{12}$/)
          assert.equal(ids.has(event.permission.id), false)
          ids.add(event.permission.id)
        } },
      }))
    }
    broker.cancelAll()
  }
  await Promise.all(results)
  assert.equal(ids.size, 300)
})

test('the short public ID resolves opaque ACP option IDs and duplicate decisions remain idempotent', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
  const events = []
  const pending = broker.request({
    toolCall: { toolCallId: 'private-acp-call', title: 'Read a file' },
    options: [{ kind: 'allow_once', optionId: 'private-acp-option' }],
  }, { session: { ownerId: 'owner', onEvent: event => events.push(event) } })
  const id = events[0].permission.id
  assert.throws(() => broker.respond(id, 'once', { ownerId: 'someone-else' }))
  const resolved = broker.respond(id, 'once', { ownerId: 'owner' })
  assert.equal(resolved.id, id)
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'private-acp-option' } })
  assert.deepEqual(broker.respond(id, 'reject', { ownerId: 'owner' }), resolved)
  assert.equal(events.filter(event => event.type === 'backend.permission.resolved').length, 1)
})

test('a Gateway-raised explicit request reaches the user even in full permission mode', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'full' })
  const events = []
  const session = { ownerId: 'owner', onEvent: event => events.push(event) }
  const params = {
    toolCall: { title: 'Control your computer', kind: 'computer_use' },
    options: [
      { kind: 'allow_once', optionId: 'allow' },
      { kind: 'reject_once', optionId: 'reject' },
    ],
  }
  // Full mode still approves ordinary requests on its own.
  assert.equal((await broker.request(params, { session })).outcome.optionId, 'allow')
  assert.equal(events.length, 0)

  const pending = broker.request(params, { session, explicit: true })
  assert.equal(events.length, 1)
  assert.equal(events[0].permission.category, 'computer_use')
  broker.respond(events[0].permission.id, 'reject', { ownerId: 'owner' })
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'reject' } })
})

test('running the open-computer-use runtime through bash is asked about as computer control', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'full' })
  const events = []
  const pending = broker.request({
    toolCall: {
      title: 'bash',
      kind: 'execute',
      rawInput: {
        command: 'node node_modules/@qwen-code/open-computer-use/bin/open-computer-use call click {}',
      },
    },
    options: [
      { kind: 'allow_once', optionId: 'allow' },
      { kind: 'reject_once', optionId: 'reject' },
    ],
  }, { session: { ownerId: 'owner', onEvent: event => events.push(event) } })
  assert.equal(events.length, 1)
  assert.equal(events[0].permission.category, 'computer_use')
  broker.respond(events[0].permission.id, 'reject', { ownerId: 'owner' })
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'reject' } })
})

test('the Gateway media tools are allowed without asking, in every title form Agents use', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
  const events = []
  const session = { ownerId: 'owner', onEvent: event => events.push(event) }
  for (const title of [
    'qwen_audio_agent_media_play',
    'mcp__qwen_audio_media__qwen_audio_agent_media_play',
    'qwen_audio_agent_media_control (qwen_audio_media)',
  ]) {
    const pending = broker.request({
      toolCall: { toolCallId: `call-${title}`, title },
      options: [
        { kind: 'allow_once', optionId: 'allow' },
        { kind: 'reject_once', optionId: 'reject' },
      ],
    }, { session })
    assert.equal(events.length, 0, `${title} asked the user`)
    assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'allow' } })
  }
})

test('a lookalike media tool name still asks the user', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
  const events = []
  const pending = broker.request({
    toolCall: { title: 'media_play' },
    options: [{ kind: 'allow_once', optionId: 'allow' }],
  }, { session: { ownerId: 'owner', onEvent: event => events.push(event) } })
  assert.equal(events.length, 1)
  broker.cancelAll()
  assert.deepEqual(await pending, { outcome: { outcome: 'cancelled' } })
})
