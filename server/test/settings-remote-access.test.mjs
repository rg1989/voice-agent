import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

// A file of its own: the settings API writes config.env in the config directory
// that core/config fixes at import time. Point it at a temporary directory
// before importing anything, so these tests never touch a real config.env.
const configDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-settings-access-'))
process.env.QWAUDIO_CONFIG_DIR = configDirectory
after(() => rmSync(configDirectory, { recursive: true, force: true }))

const { config } = await import('../src/core/config.mjs')
const { createGatewayApplication } = await import('../src/app/gateway-application.mjs')
const { ConversationSync } = await import('../src/conversation/conversation-sync.mjs')
const { SessionJournalRegistry } = await import('../src/session/session-journal-registry.mjs')
const { TaskManager } = await import('../src/task/task-manager.mjs')
const { TaskStore } = await import('../src/task/task-store.mjs')

const ACCESS_TOKEN = 'settings-remote-access-token-over-24-characters'
const REMOTE = { Host: 'gateway.example.test', Authorization: `Bearer ${ACCESS_TOKEN}` }

function disabledBackend() {
  return {
    enabled: false,
    describe: () => ({ configured: false, enabled: false, protocol: 'none', label: 'No backend', capabilities: {} }),
    start: async () => ({ ok: false, configured: false }),
    health: async () => ({ ok: false, configured: false }),
    submit: async () => { throw new Error('Backend is disabled') },
    status: async () => null,
    cancel: async () => ({ state: 'not_found' }),
    respondAuthorization: async () => ({ state: 'not_found' }),
    respondInput: async () => ({ state: 'not_found' }),
    subscribe: () => () => {},
    close: async () => {},
    canRecoverDelegatedWork: () => false,
    recoverDelegatedWork: async () => null,
  }
}

async function startGateway(t) {
  const runtime = mkdtempSync(join(tmpdir(), 'qwaudio-settings-runtime-'))
  const taskStore = new TaskStore({ filePath: join(runtime, 'tasks.json') })
  const sessionJournal = new SessionJournalRegistry({ directory: join(runtime, 'sessions') })
  const application = createGatewayApplication({
    config: {
      ...config,
      host: '0.0.0.0',
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      gatewayAccessToken: ACCESS_TOKEN,
      gatewayAccessKeys: '',
      gatewayDeviceStatePath: join(runtime, 'gateway-devices.json'),
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    publicEndpoint: null,
    conversationSync: new ConversationSync(),
    taskStore,
    sessionJournal,
    taskManager: new TaskManager({ store: taskStore, sessionJournal }),
  })
  t.after(async () => {
    await application.close()
    rmSync(runtime, { recursive: true, force: true })
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  return application.server.address().port
}

function requestJson({ port, path, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null })
      })
    })
    request.once('error', reject)
    if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}

test('a paired remote device cannot change settings that reconfigure this computer', async t => {
  const port = await startGateway(t)
  // Invalid values on purpose: if this guard ever breaks, the request fails
  // validation instead of saving the setting and restarting a real Gateway.
  for (const body of [
    { brain: 'no-such-brain' },
    { folder: join(configDirectory, 'no-such-folder') },
    { computerUse: 'no-such-mode' },
    { turnThreshold: 'not-a-number' },
  ]) {
    const saved = await requestJson({ port, path: '/api/settings', method: 'POST', headers: REMOTE, body })
    assert.equal(saved.status, 403, Object.keys(body)[0])
  }
})

test('a paired remote device can still change how the assistant sounds and listens', async t => {
  const port = await startGateway(t)
  const saved = await requestJson({
    port,
    path: '/api/settings',
    method: 'POST',
    headers: REMOTE,
    body: { roboticVoice: true },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.changed, ['roboticVoice'])
  assert.equal(saved.body.restarting, false)
})

test('only the Gateway computer can browse its folders', async t => {
  const port = await startGateway(t)
  const path = `/api/settings/folders?path=${encodeURIComponent(configDirectory)}`
  assert.equal((await requestJson({ port, path, headers: REMOTE })).status, 403)
  assert.equal((await requestJson({ port, path, headers: { Host: `127.0.0.1:${port}` } })).status, 200)
})
