import {
  AgentDeliveryMode,
  createAgentDelivery,
} from '../delivery/agent-delivery.mjs'
import { config } from '../core/config.mjs'

// ponytail: fail closed — only a backend-authored VOICE: line reaches the
// cloud speech model. No line, no detail. The screen still gets the full text
// via the task record, which does not pass through this runtime.
const VOICE_LINE = /^[ \t>*-]*VOICE:[ \t]*(.+)$/im
const FALLBACK = 'Done. The full result is on screen.'
// 一句话装不下一份调研的要点，前台就会拿训练数据把空缺补上 —— 听起来笃定，
// 其实没人核实过。给足长度，让真正的结论本身进得来。
const MAX_SPOKEN_CHARS = 900

// 超长时断在最后一个句号上，而不是切在半个词中间。
function boundedSpoken(line) {
  if (line.length <= MAX_SPOKEN_CHARS) return line
  const clipped = line.slice(0, MAX_SPOKEN_CHARS)
  const lastStop = Math.max(
    clipped.lastIndexOf('. '), clipped.lastIndexOf('。'),
    clipped.lastIndexOf('! '), clipped.lastIndexOf('? '),
  )
  return lastStop > MAX_SPOKEN_CHARS / 2
    ? clipped.slice(0, lastStop + 1).trim()
    : clipped.trim()
}
// Only backend-authored text is sanitized. Reminders, permission prompts and
// client events are Gateway-authored and must pass through untouched.
const BACKEND_ORIGINS = new Set(['announcement', 'progress'])

export function voiceSafe(text, origin, { enabled = config.voiceSummaryOnly } = {}) {
  if (!enabled) return text
  if (!BACKEND_ORIGINS.has(origin)) return text
  const match = String(text || '').match(VOICE_LINE)
  return match ? boundedSpoken(match[1].trim()) : FALLBACK
}

/**
 * Projects provider-neutral AgentDelivery values into one Realtime frontend.
 * Blocking remains Gateway policy; provider dialects never escape this class.
 */
export class RealtimeAgentDeliveryRuntime {
  constructor({
    getFrontend,
    isDeliveryBlocked = () => false,
  } = {}) {
    this.getFrontend = getFrontend
    this.isDeliveryBlocked = isDeliveryBlocked
  }

  async deliver(value, { shouldDeliver, injectContext = true } = {}) {
    const delivery = createAgentDelivery(value)
    if (delivery.mode === AgentDeliveryMode.HANDLE) {
      return { completed: true, handled: true, mode: delivery.mode }
    }
    if (this.isDeliveryBlocked()) {
      return { completed: false, blocked: true, mode: delivery.mode }
    }
    const frontend = this.getFrontend?.()
    const inject = typeof frontend?.injectDelivery === 'function'
      ? frontend.injectDelivery.bind(frontend)
      : delivery.mode === AgentDeliveryMode.RESPOND
        && typeof frontend?.injectResult === 'function'
        ? (text, origin, context, options) => frontend.injectResult(
            text,
            origin,
            context,
            {
              injectContext: options.injectContext,
              instructions: options.instructions,
            },
          )
        : null
    // Older code-level embedders did not expose an explicit ready flag. Keep
    // that interface working while requiring a concrete injection primitive.
    if (frontend?.ready === false || !inject) {
      return { completed: false, unavailable: true, mode: delivery.mode }
    }
    return inject(
      voiceSafe(delivery.text, delivery.origin),
      delivery.origin,
      delivery.correlation,
      {
        route: delivery.mode,
        injectContext,
        instructions: delivery.presentation?.instructions || '',
        allowTools: delivery.presentation?.allowTools === true,
        contextTiming: delivery.presentation?.contextTiming || 'response',
        shouldRespond: shouldDeliver,
      },
    )
  }
}
