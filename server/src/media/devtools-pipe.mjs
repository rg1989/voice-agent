// A minimal Chrome DevTools Protocol client over --remote-debugging-pipe.
//
// Chromium reads commands on its fd 3 and writes replies and events on its
// fd 4. Each message is one UTF-8 JSON text followed by a NUL byte, in both
// directions, and Chromium writes in 64 KB pieces, so frames arrive split.
// The player is spawned with DEVTOOLS_PIPE_STDIO: child.stdio[3] is our write
// end and child.stdio[4] our read end. Those socket ends exist only in the
// gateway (close-on-exec, so no process it starts later inherits them), and
// the channel has no port, socket path or DevToolsActivePort file another
// local process could connect to.
//
// Two rules keep playback safe:
// - This client never ends or destroys the streams. Chromium quits as soon
//   as its fd 3 reaches EOF, so the player destroys them only after the
//   browser exited.
// - A closed pipe says nothing about the browser. Chromium can shut its pipe
//   down and keep playing (for example when a policy turns remote debugging
//   off at runtime), so the player's liveness comes from 'exit' only.

export const DEVTOOLS_PIPE_STDIO = Object.freeze(['ignore', 'ignore', 'pipe', 'pipe', 'pipe'])
export const DEVTOOLS_CALL_TIMEOUT_MS = 10_000
export const DEVTOOLS_MAX_FRAME_BYTES = 16 * 1024 * 1024

const NUL = 0
const FRAME_END = Buffer.from([NUL])
const STDERR_TAIL_CHARS = 256
// Chromium says why it did not start the pipe handler only on stderr. Without
// these lines a refused pipe looks exactly like a slow one: no reply, no EOF.
const REFUSALS = Object.freeze([
  ['disallowed_by_policy', 'DevTools remote debugging is disallowed by the system admin'],
  ['default_data_dir', 'DevTools remote debugging requires a non-default data directory'],
])

export class DevToolsPipeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DevToolsPipeError'
    this.code = code
  }
}

// A listener that throws must not escape into the stream's 'data' handler,
// where it would become an uncaught exception in the gateway.
function notify(listener, value) {
  try {
    listener(value)
  } catch {
    // The listener's own failure; the pipe keeps working.
  }
}

export class DevToolsPipe {
  #toBrowser
  #allow
  #timeoutMs
  #maxFrameBytes
  #nextId = 1
  #pending = new Map()
  #chunks = []
  #chunkBytes = 0
  #eventListeners = new Set()
  #closeListeners = new Set()
  #closeReason = null
  #refusal = null
  #stderrTail = ''

  // allow(method, params, { sessionId }) -> boolean is checked before any
  // command is written. Without it nothing is allowed.
  constructor({
    toBrowser,
    fromBrowser,
    stderr = null,
    allow = () => false,
    timeoutMs = DEVTOOLS_CALL_TIMEOUT_MS,
    maxFrameBytes = DEVTOOLS_MAX_FRAME_BYTES,
  }) {
    this.#toBrowser = toBrowser
    this.#allow = allow
    this.#timeoutMs = timeoutMs
    this.#maxFrameBytes = maxFrameBytes
    // These 'error' listeners stay for the life of the streams: an EPIPE or
    // ECONNRESET after the browser died must never be an unhandled 'error'.
    toBrowser.on('error', () => this.close('pipe_error'))
    fromBrowser.on('error', () => this.close('pipe_error'))
    fromBrowser.on('data', chunk => this.#receive(chunk))
    fromBrowser.on('end', () => this.close('browser_closed'))
    fromBrowser.on('close', () => this.close('browser_closed'))
    if (stderr) {
      stderr.on('error', () => {})
      // Reading stderr to its end also keeps Chromium from blocking on it.
      stderr.on('data', chunk => this.#scanStderr(chunk))
    }
  }

  get closed() {
    return this.#closeReason !== null
  }

  get closeReason() {
    return this.#closeReason
  }

  // 'disallowed_by_policy' | 'default_data_dir' | null
  get refusal() {
    return this.#refusal
  }

  send(method, params = {}, { sessionId = null, timeoutMs = this.#timeoutMs } = {}) {
    if (this.#toBrowser.destroyed || this.#toBrowser.writableEnded) this.close('pipe_closed')
    if (this.closed) {
      return Promise.reject(new DevToolsPipeError('closed', `${method}: the DevTools pipe is closed (${this.#closeReason})`))
    }
    if (!this.#allow(method, params, { sessionId })) {
      return Promise.reject(new DevToolsPipeError('not_allowed', `${method} is not allowed on the player pipe`))
    }
    const id = this.#nextId++
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new DevToolsPipeError('timeout', `${method} got no reply within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { method, resolve, reject, timer })
      this.#toBrowser.write(Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), FRAME_END]))
    })
  }

  // listener({ method, params, sessionId }); returns a function that removes it.
  onEvent(listener) {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  // listener(reason) runs once; at once (next microtask) if already closed.
  onClose(listener) {
    if (this.closed) {
      const reason = this.#closeReason
      queueMicrotask(() => notify(listener, reason))
      return () => {}
    }
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  // Stops the client: pending commands reject with 'closed' and no more events
  // are delivered. The streams stay open (see the rules at the top).
  close(reason = 'closed') {
    if (this.closed) return
    this.#closeReason = reason
    this.#chunks = []
    this.#chunkBytes = 0
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer)
      call.reject(new DevToolsPipeError('closed', `${call.method}: the DevTools pipe closed (${reason})`))
    }
    this.#pending.clear()
    this.#eventListeners.clear()
    const listeners = [...this.#closeListeners]
    this.#closeListeners.clear()
    for (const listener of listeners) notify(listener, reason)
  }

  // Splits on raw NUL bytes before decoding, so a character cut between two
  // chunks decodes whole. Data after close is read and dropped.
  #receive(chunk) {
    if (this.closed) return
    let start = 0
    for (let end = chunk.indexOf(NUL); end !== -1; end = chunk.indexOf(NUL, start)) {
      const tail = chunk.subarray(start, end)
      const frame = this.#chunks.length ? Buffer.concat([...this.#chunks, tail]) : tail
      this.#chunks = []
      this.#chunkBytes = 0
      this.#dispatch(frame)
      if (this.closed) return
      start = end + 1
    }
    if (start >= chunk.length) return
    this.#chunks.push(chunk.subarray(start))
    this.#chunkBytes += chunk.length - start
    if (this.#chunkBytes > this.#maxFrameBytes) this.close('frame_too_large')
  }

  #dispatch(frame) {
    let message
    try {
      message = JSON.parse(frame.toString('utf8'))
    } catch {
      return // NUL framing stays in step after one bad frame
    }
    if (!message || typeof message !== 'object') return
    if (Object.hasOwn(message, 'id')) {
      const call = this.#pending.get(message.id)
      if (!call) return
      this.#pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.error) {
        call.reject(new DevToolsPipeError('protocol', `${call.method}: ${message.error.message || 'failed'}`))
      } else {
        call.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method !== 'string') return
    const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId ?? null }
    for (const listener of [...this.#eventListeners]) notify(listener, event)
  }

  #scanStderr(chunk) {
    if (this.#refusal) return
    const text = this.#stderrTail + String(chunk)
    const found = REFUSALS.find(([, line]) => text.includes(line))
    if (found) {
      this.#refusal = found[0]
      this.#stderrTail = ''
      return
    }
    this.#stderrTail = text.slice(-STDERR_TAIL_CHARS)
  }
}
