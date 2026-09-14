import { PassThrough } from 'node:stream'

// Encodes one message the way both ends of --remote-debugging-pipe frame it:
// a UTF-8 JSON text followed by one NUL byte.
export function frame(message) {
  return Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])])
}

// Plays Chromium's side of --remote-debugging-pipe for tests. It reads the
// gateway's commands from `toBrowser` (the browser's fd 3) and answers on
// `fromBrowser` (its fd 4). A handler returns the result, `{ error }` for an
// error reply, or undefined for no reply. A method without a handler is never
// answered, like a browser whose pipe handler did not start.
export class FakeDevToolsBrowser {
  constructor({ toBrowser = new PassThrough(), fromBrowser = new PassThrough(), handlers = {} } = {}) {
    this.toBrowser = toBrowser
    this.fromBrowser = fromBrowser
    this.handlers = handlers
    this.calls = []
    let pending = Buffer.alloc(0)
    toBrowser.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      for (let end = pending.indexOf(0); end !== -1; end = pending.indexOf(0)) {
        const message = JSON.parse(pending.subarray(0, end).toString('utf8'))
        pending = pending.subarray(end + 1)
        this.calls.push(message)
        this.#answer(message)
      }
    })
  }

  methods() {
    return this.calls.map(call => call.method)
  }

  send(message) {
    if (!this.fromBrowser.destroyed && !this.fromBrowser.writableEnded) this.fromBrowser.write(frame(message))
  }

  event(method, params, sessionId = null) {
    this.send(sessionId ? { method, params, sessionId } : { method, params })
  }

  #answer(message) {
    const handler = this.handlers[message.method]
    if (!handler) return
    setImmediate(() => {
      const reply = handler(message.params, message)
      if (reply === undefined) return
      this.send(reply.error ? { id: message.id, error: reply.error } : { id: message.id, result: reply })
    })
  }
}
