// Gated computer control for backend Agents.
//
// Agents reach open-computer-use only through this loopback MCP server. The first
// computer-use call in a task asks the user; once they allow it, every later call
// in that task goes straight through. A refusal holds for the rest of the task.
//
// Why the Gateway and not the Agent: omp asks the Gateway for permission only
// before bash/edit/delete/move and runs MCP tools unasked. A gate here works the
// same for every Agent, whatever that Agent's own permission model is.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

export const COMPUTER_USE_SERVER_NAME = 'computer-use'
const COMPUTER_USE_PATH = '/computer-use'
// Every call has to fit inside what the Agent will wait for (omp: 180 s, raised in
// drivers/generic-acp.mjs). A call that has not started upstream within
// START_DEADLINE_MS of arriving is refused, so START_DEADLINE_MS + CALL_TIMEOUT_MS
// (165 s) stays under that however long the approval or the queue took.
const APPROVAL_TIMEOUT_MS = 100_000
const START_DEADLINE_MS = 120_000
const CALL_TIMEOUT_MS = 45_000
const MAX_REMEMBERED_TASKS = 500
const ABANDONED = Symbol('abandoned')

const OUTSIDE_TASK = 'Computer control is only available while working on a task the user asked for.'
const DENIED = 'The user did not allow computer control for this task. Do not use these tools again for this task.'
const UNANSWERED = 'The user has not allowed computer control yet. Ask them before trying again.'
const ABANDONED_TEXT = 'Not carried out: the request ended while waiting for the user to decide.'
const TOO_LATE = 'Not carried out: it waited too long to start. Try the step again.'
const PER_TASK_NOTE = 'If you allow it, it can use your screen, mouse and keyboard until this task ends.'
const SINGLE_STEP_NOTE = 'Allowing this covers only this one step.'

const INSTRUCTIONS = [
  "These tools control the user's computer: they see the screen and use the mouse and keyboard.",
  'Call get_app_state for an app before acting on it; element indices come from its accessibility tree.',
  'If a call says it was not allowed, stop using these tools for this task and tell the user.',
].join(' ')

const app = { type: 'string', description: 'App name or bundle identifier' }
const coordinate = description => ({ type: 'number', description })

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false }
}

// Mirrors the tool list @qwen-code/open-computer-use 0.2.3 reports, so tools/list
// is answered without launching it: omp fails the whole Session if any MCP server
// fails to connect, and launching it can raise macOS permission prompts.
// ponytail: hand-kept copy. If an upgrade changes a schema, the upstream server
// still validates each call and returns its own error; refresh this list then.
export const COMPUTER_USE_TOOLS = Object.freeze([
  {
    name: 'list_apps',
    description: 'List the apps on this computer: the ones running now and the ones used in the last 14 days, with how often each is used.',
    inputSchema: schema({}, []),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_app_state',
    description: "Start an app use session if needed, then get the state of the app's key window: a screenshot and the accessibility tree. Call it once per turn before interacting with the app.",
    inputSchema: schema({ app }, ['app']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'click',
    description: 'Click an element by its index from get_app_state, or a point in screenshot pixel coordinates.',
    inputSchema: schema({
      app,
      element_index: { type: 'string', description: 'Element index to click' },
      x: coordinate('X coordinate in screenshot pixel coordinates'),
      y: coordinate('Y coordinate in screenshot pixel coordinates'),
      click_count: { type: 'integer', description: 'Number of clicks. Defaults to 1' },
      mouse_button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button to click. Defaults to left.',
      },
    }, ['app']),
  },
  {
    name: 'perform_secondary_action',
    description: 'Invoke a secondary accessibility action exposed by an element.',
    inputSchema: schema({
      app,
      element_index: { type: 'string', description: 'Element identifier' },
      action: { type: 'string', description: 'Secondary accessibility action name' },
    }, ['app', 'element_index', 'action']),
  },
  {
    name: 'scroll',
    description: 'Scroll an element by a number of pages.',
    inputSchema: schema({
      app,
      direction: { type: 'string', description: 'Scroll direction: up, down, left, or right' },
      element_index: { type: 'string', description: 'Element index to scroll' },
      pages: { type: 'number', description: 'Number of pages to scroll. Fractional values are supported. Defaults to 1' },
    }, ['app', 'element_index', 'direction']),
  },
  {
    name: 'drag',
    description: 'Drag from one point to another using pixel coordinates.',
    inputSchema: schema({
      app,
      from_x: coordinate('Start X coordinate'),
      from_y: coordinate('Start Y coordinate'),
      to_x: coordinate('End X coordinate'),
      to_y: coordinate('End Y coordinate'),
    }, ['app', 'from_x', 'from_y', 'to_x', 'to_y']),
  },
  {
    name: 'type_text',
    description: 'Type literal text into the focused text field using keyboard input.',
    inputSchema: schema({
      app,
      text: { type: 'string', description: 'Literal text to type' },
    }, ['app', 'text']),
  },
  {
    name: 'press_key',
    description: "Press a key or key combination in xdotool syntax, such as 'Return', 'Tab', 'super+c' or 'Up'.",
    inputSchema: schema({
      app,
      key: { type: 'string', description: 'Key or key combination to press' },
    }, ['app', 'key']),
  },
  {
    name: 'set_value',
    description: 'Set the value of a settable accessibility element.',
    inputSchema: schema({
      app,
      element_index: { type: 'string', description: 'Element index to set' },
      value: { type: 'string', description: 'Value to assign' },
    }, ['app', 'element_index', 'value']),
  },
])

const TOOL_NAMES = new Set(COMPUTER_USE_TOOLS.map(tool => tool.name))

function short(value, max = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

// One plain phrase for the prompt the user hears: "The assistant wants to ...".
export function describeComputerUse(name, args = {}) {
  const target = short(args.app) || 'an app'
  switch (name) {
    case 'list_apps': return 'see which apps you have open'
    case 'get_app_state': return `look at ${target}`
    case 'click': return `click in ${target}`
    case 'perform_secondary_action': return `open a menu in ${target}`
    case 'scroll': return `scroll in ${target}`
    case 'drag': return `drag in ${target}`
    case 'type_text': return `type "${short(args.text, 40)}" into ${target}`
    case 'press_key': return `press ${short(args.key, 30)} in ${target}`
    case 'set_value': return `change a field in ${target}`
    default: return `use ${target}`
  }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function anySignal(...signals) {
  const live = signals.filter(Boolean)
  return live.length > 1 ? AbortSignal.any(live) : live[0]
}

// Resolves early with ABANDONED when the caller gives up. The shared approval
// keeps going: a late answer still counts for the task's next call.
function untilAborted(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(ABANDONED)
  return new Promise(resolve => {
    const onAbort = () => resolve(ABANDONED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

async function connectOpenComputerUse(binPath) {
  const client = new Client({ name: 'qwen-audio-agent', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [binPath, 'mcp'],
    // The SDK's safe defaults (HOME, PATH, USER, ...) plus what the launcher
    // needs. Deliberately no OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: a
    // click accessibility cannot perform is refused rather than sent as a real
    // pointer event that could land on another window.
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stderr: 'ignore',
  }))
  return client
}

export class ComputerUseGate {
  constructor({
    binPath,
    requestApproval,
    // per_task | every_action | always (see core/computer-use-mode.mjs; "off"
    // never builds a gate).
    mode = 'per_task',
    connectUpstream = connectOpenComputerUse,
    onLaunch = () => {},
    approvalTimeoutMs = APPROVAL_TIMEOUT_MS,
    startDeadlineMs = START_DEADLINE_MS,
    callTimeoutMs = CALL_TIMEOUT_MS,
    now = () => Date.now(),
  } = {}) {
    if (typeof requestApproval !== 'function') {
      throw new TypeError('ComputerUseGate requires requestApproval')
    }
    this.binPath = binPath
    this.requestApproval = requestApproval
    this.mode = mode
    this.connectUpstream = connectUpstream
    this.onLaunch = onLaunch
    this.approvalTimeoutMs = approvalTimeoutMs
    this.startDeadlineMs = startDeadlineMs
    this.callTimeoutMs = callTimeoutMs
    this.now = now
    this.decisions = new Map()
    this.approvals = new Map()
    this.registrations = new Set()
    this.upstream = null
    this.queue = Promise.resolve()
    this.closed = false
  }

  // resolveSession returns the live Gateway Session object at call time, so a
  // call is judged against that Session's current task and prompt scope.
  async register(toolServer, resolveSession) {
    const registration = await toolServer.registerServer({
      name: COMPUTER_USE_SERVER_NAME,
      path: COMPUTER_USE_PATH,
      createServer: ({ signal } = {}) => this.createServer(resolveSession, signal),
    })
    this.registrations.add(registration)
    return {
      descriptor: registration.descriptor,
      release: () => {
        this.registrations.delete(registration)
        return registration.release()
      },
    }
  }

  createServer(resolveSession, requestSignal) {
    const server = new Server(
      { name: COMPUTER_USE_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: COMPUTER_USE_TOOLS,
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => this.call(
      resolveSession(),
      request.params.name,
      request.params.arguments || {},
      anySignal(extra?.signal, requestSignal),
    ))
    return server
  }

  async call(session, name, args = {}, signal) {
    const arrivedAt = this.now()
    if (!TOOL_NAMES.has(name)) return errorResult(`Unknown computer-use tool: ${name}`)
    const scope = session?.permissionScopeId
    if (!session?.coordinationRunId || !scope) return errorResult(OUTSIDE_TASK)
    const decision = await this.decide(session, describeComputerUse(name, args), signal)
    if (decision === 'denied') return errorResult(DENIED)
    if (decision !== 'allowed') {
      return errorResult(decision === ABANDONED ? ABANDONED_TEXT : UNANSWERED)
    }
    // Approval can take a while. Act only if the caller is still waiting and the
    // task's turn has not ended meanwhile: never a click nobody is waiting for.
    if (this.closed || signal?.aborted || session.permissionScopeId !== scope) {
      return errorResult(ABANDONED_TEXT)
    }
    return this.forward({ session, scope, name, args, signal, arrivedAt })
  }

  decide(session, action, signal) {
    if (this.mode === 'always') return Promise.resolve('allowed')
    const key = JSON.stringify([session.ownerId, session.coordinationRunId])
    const known = this.decisions.get(key)
    // A refusal holds for the task in every mode; an approval only in per_task.
    if (known === 'denied' || (known === 'allowed' && this.mode === 'per_task')) {
      return Promise.resolve(known)
    }
    let approval = this.approvals.get(key)
    if (this.mode === 'per_task') {
      // Concurrent calls in one task share a single prompt.
      if (!approval) approval = this.track(key, this.ask(key, session, action, PER_TASK_NOTE))
    } else {
      // every_action: each call gets its own prompt, one at a time per task.
      approval = this.track(key, (approval || Promise.resolve()).then(() => (
        this.decisions.get(key) === 'denied'
          ? 'denied'
          : this.ask(key, session, action, SINGLE_STEP_NOTE)
      )))
    }
    return untilAborted(approval, signal)
  }

  ask(key, session, action, note) {
    return new Promise(resolve => resolve(this.requestApproval(session, {
      description: `The assistant wants to ${action}. ${note}`,
      signal: AbortSignal.timeout(this.approvalTimeoutMs),
    }))).catch(() => 'cancelled').then(result => {
      // Only a real answer is remembered; an unanswered prompt asks again.
      if (result === 'allowed' || result === 'denied') this.remember(key, result)
      return result
    })
  }

  track(key, approval) {
    this.approvals.set(key, approval)
    approval.then(() => {
      if (this.approvals.get(key) === approval) this.approvals.delete(key)
    })
    return approval
  }

  remember(key, decision) {
    this.decisions.delete(key)
    this.decisions.set(key, decision)
    // ponytail: task IDs never repeat, so a decision only matters while its task
    // runs; keep the newest few hundred rather than tracking task completion.
    while (this.decisions.size > MAX_REMEMBERED_TASKS) {
      this.decisions.delete(this.decisions.keys().next().value)
    }
  }

  forward({ session, scope, name, args, signal, arrivedAt }) {
    // open-computer-use handles one call at a time; keep calls in order.
    const result = this.queue.then(async () => {
      // Re-check just before acting. While this call waited in line the task's
      // turn may have ended, the gate may have closed, or the wait may have run
      // past what the Agent is still waiting for.
      if (this.closed || signal?.aborted || session.permissionScopeId !== scope) {
        return errorResult(ABANDONED_TEXT)
      }
      if (this.now() - arrivedAt > this.startDeadlineMs) return errorResult(TOO_LATE)
      const client = await this.connection()
      return client.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout: this.callTimeoutMs },
      )
    }).catch(error => errorResult(`Computer control failed: ${error?.message || error}`))
    this.queue = result
    return result
  }

  connection() {
    if (this.closed) return Promise.reject(new Error('computer control is shutting down'))
    if (!this.upstream) {
      this.onLaunch()
      const upstream = Promise.resolve()
        .then(() => this.connectUpstream(this.binPath))
        .then(client => {
          // If open-computer-use exits later, forget this client so the next call
          // relaunches it instead of failing with "Not connected" from then on.
          const previous = client.onclose
          client.onclose = () => {
            previous?.()
            if (this.upstream === upstream) this.upstream = null
          }
          return client
        })
      upstream.catch(() => {
        if (this.upstream === upstream) this.upstream = null
      })
      this.upstream = upstream
    }
    return this.upstream
  }

  async close() {
    this.closed = true
    for (const registration of this.registrations) registration.release()
    this.registrations.clear()
    const upstream = this.upstream
    this.upstream = null
    if (upstream) await upstream.then(client => client.close()).catch(() => {})
  }
}
