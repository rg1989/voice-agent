import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computerUseBinPath,
  computerUseEnabled,
  computerUseMode,
  createComputerUseLifecycle,
} from '../src/backend/adapters/acp/builtin-mcp.mjs'

test('computer control is on unless explicitly disabled', () => {
  assert.equal(computerUseEnabled({}), true)
  for (const value of ['', 'true', 'on', '1', 'yes']) {
    assert.equal(computerUseEnabled({ QWEN_AUDIO_AGENT_COMPUTER_USE: value }), true, value)
  }
  for (const value of ['false', 'off', '0', 'no', 'disabled', 'OFF']) {
    assert.equal(computerUseEnabled({ QWEN_AUDIO_AGENT_COMPUTER_USE: value }), false, value)
  }
})

test('resolves the installed open-computer-use launcher', () => {
  assert.match(computerUseBinPath(), /open-computer-use/)
})

test('cleans only app-agents created after the computer-use lifecycle starts', async () => {
  let time = 0
  const processes = [
    { pid: 10, command: '/pkg/OpenComputerUse __open-computer-use-app-agent /tmp/old.sock' },
  ]
  const signals = []
  const lifecycle = createComputerUseLifecycle(true, {
    platform: 'darwin',
    discoveryMs: 100,
    now: () => time,
    delay: async ms => {
      time += ms
    },
    listProcesses: () => processes.map(item => ({ ...item })),
    killImpl(pid, signal) {
      signals.push([pid, signal])
    },
  })
  processes.push({
    pid: 20,
    command: '/pkg/OpenComputerUse __open-computer-use-app-agent /tmp/new.sock',
  })

  lifecycle.markUsed()
  await lifecycle.close()
  assert.deepEqual(signals, [
    [20, 'SIGTERM'],
    [20, 'SIGKILL'],
  ])
})

test('preserves a new app-agent while another MCP process is active', async () => {
  let time = 0
  const processes = []
  const signals = []
  const lifecycle = createComputerUseLifecycle(true, {
    platform: 'darwin',
    discoveryMs: 50,
    now: () => time,
    delay: async ms => {
      time += ms
    },
    listProcesses: () => processes.map(item => ({ ...item })),
    killImpl: (...args) => signals.push(args),
  })
  processes.push(
    {
      pid: 20,
      command: '/pkg/OpenComputerUse __open-computer-use-app-agent /tmp/new.sock',
    },
    { pid: 30, command: '/pkg/OpenComputerUse mcp' },
  )

  lifecycle.markUsed()
  await lifecycle.close()
  assert.deepEqual(signals, [])
})

test('computer-use lifecycle is a no-op off macOS or when disabled', async () => {
  let listed = false
  const options = {
    listProcesses: () => {
      listed = true
      return []
    },
  }
  await createComputerUseLifecycle(true, { ...options, platform: 'linux' }).close()
  await createComputerUseLifecycle(false, { ...options, platform: 'darwin' }).close()
  assert.equal(listed, false)
})

test('reads the computer-control mode and keeps the older on/off spellings working', () => {
  const mode = value => computerUseMode({ QWEN_AUDIO_AGENT_COMPUTER_USE: value })
  assert.equal(computerUseMode({}), 'per_task')
  for (const value of ['true', 'on', '1', 'yes', 'per_task']) assert.equal(mode(value), 'per_task', value)
  assert.equal(mode('every_action'), 'every_action')
  assert.equal(mode('ALWAYS'), 'always')
  assert.equal(mode('off'), 'off')
  // A typo must never turn into "never ask".
  assert.equal(mode('alwayz'), 'per_task')
})
