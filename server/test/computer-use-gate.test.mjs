import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AcpSessionToolServer } from '../src/backend/adapters/acp/session-tools.mjs'
import {
  COMPUTER_USE_TOOLS,
  ComputerUseGate,
} from '../src/backend/adapters/acp/computer-use-gate.mjs'

const PNG = 'iVBORw0KGgo='
const tick = () => new Promise(resolve => setImmediate(resolve))

function task(overrides = {}) {
  return {
    ownerId: 'owner',
    sessionId: 'acp-1',
    coordinationRunId: 'task_1',
    permissionScopeId: 'prompt_1',
    ...overrides,
  }
}

// decisions: what the "user" answers, in order. A function answers later.
function harness(decisions = [], { mode } = {}) {
  const upstreamCalls = []
  const approvals = []
  let launches = 0
  const answers = [...decisions]
  const gate = new ComputerUseGate({
    binPath: '/fake/open-computer-use',
    mode,
    requestApproval: async (session, options) => {
      approvals.push({ session, ...options })
      const answer = answers.shift()
      return typeof answer === 'function' ? answer() : answer
    },
    connectUpstream: async () => {
      launches += 1
      return {
        callTool: async params => {
          upstreamCalls.push(params)
          return {
            content: [
              { type: 'text', text: `did ${params.name}` },
              { type: 'image', data: PNG, mimeType: 'image/png' },
            ],
          }
        },
        close: async () => {},
      }
    },
  })
  return { gate, upstreamCalls, approvals, launches: () => launches }
}

function later() {
  let release
  const answer = () => new Promise(resolve => { release = resolve })
  return { answer, release: value => release(value) }
}

test('lists the tools without launching open-computer-use, then passes screenshots through once allowed', async () => {
  const server = new AcpSessionToolServer()
  const { gate, upstreamCalls, approvals, launches } = harness(['allowed'])
  const session = task()
  const registration = await gate.register(server, () => session)
  assert.equal(registration.descriptor.type, 'http')
  assert.equal(registration.descriptor.name, 'computer-use')
  assert.equal(new URL(registration.descriptor.url).pathname, '/computer-use')

  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(registration.descriptor.url),
    { requestInit: { headers: Object.fromEntries(
      registration.descriptor.headers.map(header => [header.name, header.value]),
    ) } },
  ))
  const listed = await client.listTools()
  assert.deepEqual(
    listed.tools.map(tool => tool.name),
    COMPUTER_USE_TOOLS.map(tool => tool.name),
  )
  assert.equal(launches(), 0)

  const result = await client.callTool({ name: 'get_app_state', arguments: { app: 'Safari' } })
  assert.equal(approvals.length, 1)
  assert.match(approvals[0].description, /look at Safari/)
  assert.deepEqual(result.content[1], { type: 'image', data: PNG, mimeType: 'image/png' })
  assert.deepEqual(upstreamCalls, [{ name: 'get_app_state', arguments: { app: 'Safari' } }])

  await client.close()
  await gate.close()
  await server.close()
})

test('a wrong or missing token cannot reach the gate', async () => {
  const server = new AcpSessionToolServer()
  const { gate } = harness()
  const registration = await gate.register(server, () => task())
  const forged = await fetch(registration.descriptor.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-token', 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(forged.status, 404)
  registration.release()
  const released = await fetch(registration.descriptor.url, {
    method: 'POST',
    headers: {
      Authorization: registration.descriptor.headers[0].value,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert.equal(released.status, 404)
  await gate.close()
  await server.close()
})

test('asks once per task, shares one prompt between concurrent calls, and asks again for a new task', async () => {
  const pending = later()
  const { gate, upstreamCalls, approvals } = harness([pending.answer, 'allowed'])
  const session = task()
  const first = gate.call(session, 'click', { app: 'Notes', element_index: '3' })
  const second = gate.call(session, 'type_text', { app: 'Notes', text: 'hello' })
  await tick()
  assert.equal(approvals.length, 1)
  assert.equal(upstreamCalls.length, 0)

  pending.release('allowed')
  await Promise.all([first, second])
  assert.equal(upstreamCalls.length, 2)

  await gate.call(session, 'press_key', { app: 'Notes', key: 'Return' })
  assert.equal(approvals.length, 1)
  assert.equal(upstreamCalls.length, 3)

  await gate.call(task({ coordinationRunId: 'task_2' }), 'list_apps', {})
  assert.equal(approvals.length, 2)
  await gate.close()
})

test('a refusal blocks the call and the rest of that task without asking again', async () => {
  const { gate, upstreamCalls, approvals, launches } = harness(['denied'])
  const session = task()
  const refused = await gate.call(session, 'click', { app: 'Mail', element_index: '1' })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /did not allow/)
  const again = await gate.call(session, 'get_app_state', { app: 'Mail' })
  assert.equal(again.isError, true)
  assert.equal(approvals.length, 1)
  assert.equal(upstreamCalls.length, 0)
  assert.equal(launches(), 0)
  await gate.close()
})

test('an unanswered prompt is not taken as a refusal', async () => {
  const { gate, upstreamCalls, approvals } = harness(['cancelled', 'allowed'])
  const session = task()
  assert.equal((await gate.call(session, 'list_apps', {})).isError, true)
  assert.equal((await gate.call(session, 'list_apps', {})).isError, undefined)
  assert.equal(approvals.length, 2)
  assert.equal(upstreamCalls.length, 1)
  await gate.close()
})

test('refuses calls made outside a running task, and unknown tools, without asking', async () => {
  const { gate, approvals, upstreamCalls } = harness()
  for (const session of [null, task({ permissionScopeId: null }), task({ coordinationRunId: '' })]) {
    assert.equal((await gate.call(session, 'list_apps', {})).isError, true)
  }
  assert.equal((await gate.call(task(), 'run_shell', {})).isError, true)
  assert.equal(approvals.length, 0)
  assert.equal(upstreamCalls.length, 0)
  await gate.close()
})

test('never acts for a caller that gave up while the user was deciding', async () => {
  const pending = later()
  const { gate, upstreamCalls } = harness([pending.answer])
  const session = task()
  const controller = new AbortController()
  const call = gate.call(session, 'click', { app: 'Finder', element_index: '2' }, controller.signal)
  await tick()
  controller.abort()
  assert.equal((await call).isError, true)

  pending.release('allowed')
  await tick()
  assert.equal(upstreamCalls.length, 0)

  // The late answer still stands for the task, so the Agent's retry goes through.
  await gate.call(session, 'click', { app: 'Finder', element_index: '2' })
  assert.equal(upstreamCalls.length, 1)
  await gate.close()
})

test('never acts if the task turn ended while the user was deciding', async () => {
  const pending = later()
  const { gate, upstreamCalls } = harness([pending.answer])
  const session = task()
  const call = gate.call(session, 'type_text', { app: 'Terminal', text: 'ls' })
  await tick()
  session.permissionScopeId = null
  pending.release('allowed')
  assert.equal((await call).isError, true)
  assert.equal(upstreamCalls.length, 0)
  await gate.close()
})

async function until(check, attempts = 100) {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) await tick()
  assert.ok(check(), 'condition never became true')
}

function slowUpstream() {
  const slow = later()
  const calls = []
  let launches = 0
  return {
    calls,
    slow,
    launches: () => launches,
    connect: async () => {
      launches += 1
      return {
        callTool: async params => {
          calls.push(params.name)
          if (params.name === 'list_apps') await slow.answer()
          return { content: [{ type: 'text', text: 'ok' }] }
        },
        close: async () => {},
      }
    },
  }
}

test('a call waiting in line is dropped, and nothing relaunches, once the gate closes', async () => {
  const upstream = slowUpstream()
  const gate = new ComputerUseGate({
    binPath: '/fake',
    requestApproval: async () => 'allowed',
    connectUpstream: upstream.connect,
  })
  const session = task()
  const running = gate.call(session, 'list_apps', {})
  await until(() => upstream.calls.length === 1)
  const queued = gate.call(session, 'click', { app: 'Finder', element_index: '1' })
  await tick()
  const closing = gate.close()
  upstream.slow.release()
  assert.equal((await queued).isError, true)
  await running
  await closing
  assert.deepEqual(upstream.calls, ['list_apps'])
  assert.equal(upstream.launches(), 1)
})

test('a call waiting in line is dropped when its task turn ends', async () => {
  const upstream = slowUpstream()
  const gate = new ComputerUseGate({
    binPath: '/fake',
    requestApproval: async () => 'allowed',
    connectUpstream: upstream.connect,
  })
  const session = task()
  const running = gate.call(session, 'list_apps', {})
  await until(() => upstream.calls.length === 1)
  const queued = gate.call(session, 'type_text', { app: 'Terminal', text: 'rm -rf build' })
  await tick()
  session.permissionScopeId = null
  upstream.slow.release()
  assert.equal((await queued).isError, true)
  await running
  assert.deepEqual(upstream.calls, ['list_apps'])
  await gate.close()
})

test('relaunches open-computer-use on the next call after it exits', async () => {
  let launches = 0
  const clients = []
  const gate = new ComputerUseGate({
    binPath: '/fake',
    requestApproval: async () => 'allowed',
    connectUpstream: async () => {
      launches += 1
      const run = launches
      const client = {
        callTool: async () => ({ content: [{ type: 'text', text: `run ${run}` }] }),
        close: async () => {},
      }
      clients.push(client)
      return client
    },
  })
  const session = task()
  await gate.call(session, 'list_apps', {})
  clients[0].onclose()
  const result = await gate.call(session, 'list_apps', {})
  assert.equal(launches, 2)
  assert.equal(result.content[0].text, 'run 2')
  await gate.close()
})

test('refuses to start a call that waited longer than the Agent will wait', async () => {
  let now = 0
  const approval = later()
  const upstreamCalls = []
  const gate = new ComputerUseGate({
    binPath: '/fake',
    now: () => now,
    startDeadlineMs: 1_000,
    requestApproval: async () => approval.answer(),
    connectUpstream: async () => ({
      callTool: async params => {
        upstreamCalls.push(params.name)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      close: async () => {},
    }),
  })
  const call = gate.call(task(), 'click', { app: 'Mail', element_index: '4' })
  await tick()
  now = 5_000
  approval.release('allowed')
  const result = await call
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /too long/)
  assert.equal(upstreamCalls.length, 0)
  await gate.close()
})

test('in "never ask" mode it acts without prompting, but still only inside a running task', async () => {
  const { gate, upstreamCalls, approvals } = harness([], { mode: 'always' })
  assert.equal((await gate.call(task(), 'click', { app: 'Notes', element_index: '1' })).isError, undefined)
  assert.equal(
    (await gate.call(task({ permissionScopeId: null }), 'click', { app: 'Notes', element_index: '1' })).isError,
    true,
  )
  assert.equal(approvals.length, 0)
  assert.equal(upstreamCalls.length, 1)
  await gate.close()
})

test('in "ask every time" mode each step asks separately, one prompt at a time, and a refusal holds', async () => {
  const first = later()
  const { gate, upstreamCalls, approvals } = harness(
    [first.answer, 'allowed', 'denied'],
    { mode: 'every_action' },
  )
  const session = task()
  const one = gate.call(session, 'click', { app: 'Notes', element_index: '1' })
  const two = gate.call(session, 'type_text', { app: 'Notes', text: 'hi' })
  await tick()
  assert.equal(approvals.length, 1)
  assert.match(approvals[0].description, /only this one step/)
  first.release('allowed')
  await Promise.all([one, two])
  assert.equal(approvals.length, 2)
  assert.equal(upstreamCalls.length, 2)

  assert.equal((await gate.call(session, 'press_key', { app: 'Notes', key: 'Return' })).isError, true)
  assert.equal(approvals.length, 3)
  assert.equal((await gate.call(session, 'press_key', { app: 'Notes', key: 'Return' })).isError, true)
  assert.equal(approvals.length, 3)
  assert.equal(upstreamCalls.length, 2)
  await gate.close()
})
