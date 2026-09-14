import { GatewayServerEvent } from '../../../shared/protocol/realtime-events.mjs'
import {
  GatewayClientActionName,
  GatewayClientProtocolEvent,
} from '../../../shared/protocol/gateway-client-protocol.mjs'

const ACTIVE_TASK_PHASES = new Set([
  'queued',
  'running',
  'delegated',
  'finalizing',
  'cancelling',
  'responding',
])

const ACTIVE_VOICE_STATES = new Set([
  'listening',
  'processing',
  'speaking',
])

export function desktopAutoHideSeconds(search = '') {
  const params = new URLSearchParams(search)
  const configured = params.has('autoHideSeconds')
    ? params.get('autoHideSeconds')
    : params.get('autoSleepSeconds')
  if (configured === null) return 60
  const value = Number(configured)
  if (value === 0) return 0
  return Number.isInteger(value) && value >= 30 && value <= 3600
    ? value
    : 60
}

export function desktopWakeWordEnabled(search = '') {
  return new URLSearchParams(search).get('wakeWordEnabled') === 'true'
}

export function desktopTasksActive(tasks = []) {
  return tasks.some(task => (
    ACTIVE_TASK_PHASES.has(task.phase)
    || task.authorization?.status === 'pending'
  ))
}

// 动画只呈现实际执行中的后台工作。等待授权仍属于 active，用于阻止
// 自动休眠，但它是一次前后台交互，不是 working 动画状态。
export function desktopTasksWorking(tasks = []) {
  return tasks.some(task => (
    ACTIVE_TASK_PHASES.has(task.phase)
    && task.authorization?.status !== 'pending'
  ))
}

export function desktopWorkSettled({
  tasks = [],
  voiceState = 'idle',
} = {}) {
  return (
    !desktopTasksActive(tasks)
    && !ACTIVE_VOICE_STATES.has(voiceState)
  )
}

// Services that play in the player browser, with a video on screen. Spotify
// plays audio in its own app and stays active until it is stopped, so it must
// not pin the orb above everything.
const ON_SCREEN_MEDIA_SERVICES = new Set(['youtube', 'youtube_music', 'netflix'])

// The one client-side reading of a media.state: playback the orb must stay
// shown and raised over. The Gateway's own active flag stays as it is for the
// bridge and returning to the assistant.
export function mediaOnScreen(state) {
  return state?.active === true && ON_SCREEN_MEDIA_SERVICES.has(state.service)
}

// While a video is on screen (mediaOnScreen) the orb stays shown: the caption
// and the raised window level need a visible window, and waking a hidden orb
// takes focus from the player.
export function desktopCanHide({
  settled,
  connectionState,
  visualError = false,
  lifecycle = 'active',
  mediaActive = false,
} = {}) {
  return (
    lifecycle === 'active'
    && settled === true
    && connectionState === 'connected'
    && visualError !== true
    && mediaActive !== true
  )
}

export function desktopCanFinishWaking(connectionState) {
  return connectionState === 'connected' || connectionState === 'unavailable'
}

export function desktopHideDeadline({
  lastInteractionAt,
  workSettledAt,
  timeoutSeconds,
}) {
  if (!timeoutSeconds) return Infinity
  return Math.max(lastInteractionAt, workSettledAt) + timeoutSeconds * 1000
}

// Client state is a provider- and Gateway-level capability. This adapter owns
// only its desktop presentation: the generic "sleeping" state hides the orb.
// 刚被用户显式唤醒的宽限期内忽略 sleeping 广播：Gateway 的休眠计时器
// 可能恰好在唤醒瞬间到期，迟到的过期指令不应把悬浮球藏回去
// （随后的 voice.wake 会重新唤醒 Gateway）。
export const DESKTOP_WAKE_GRACE_MS = 5000

async function showDesktopConversation({ bridge, onSurface }) {
  try {
    const result = await bridge.setSurface('panel')
    const mode = result?.mode === 'panel' ? 'panel' : 'orb'
    onSurface(mode)
    if (mode !== 'panel') {
      return {
        status: 'failed',
        error: {
          code: 'desktop_panel_incomplete',
          message: 'Desktop did not open the conversation panel',
        },
      }
    }
    return { status: 'completed', output: { mode } }
  } catch (error) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_panel_failed',
        message: String(error?.message || error).slice(0, 500),
      },
    }
  }
}

export async function performDesktopClientAction(event, {
  desktop = false,
  bridge,
  onLifecycle = () => {},
  onSurface = () => {},
} = {}) {
  if (event?.type !== GatewayClientProtocolEvent.CLIENT_ACTION_REQUEST) return null
  if (
    desktop
    && event.name === GatewayClientActionName.SHOW_CONVERSATION
    && typeof bridge?.setSurface === 'function'
  ) {
    // The host wakes a hidden orb and focuses the panel (main.mjs onSetSurface).
    return showDesktopConversation({ bridge, onSurface })
  }
  if (
    !desktop
    || event.name !== GatewayClientActionName.ENTER_SLEEP
    || typeof bridge?.enterHide !== 'function'
  ) {
    return {
      status: 'unsupported',
      error: {
        code: 'client_action_unsupported',
        message: `Unsupported Client Action: ${String(event?.name || '')}`,
      },
    }
  }
  try {
    // A Client Action is an explicit model/user request. It must not be
    // blocked by the grace period used only for stale automatic sleep events.
    const lifecycle = await bridge.enterHide({ explicit: true })
    if (lifecycle?.state) onLifecycle(lifecycle.state)
    if (lifecycle?.state !== 'hidden') {
      return {
        status: 'failed',
        error: {
          code: 'desktop_hide_incomplete',
          message: 'Desktop did not enter the hidden state',
        },
      }
    }
    return { status: 'completed', output: { state: 'hidden' } }
  } catch (error) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_hide_failed',
        message: String(error?.message || error).slice(0, 500),
      },
    }
  }
}

export async function applyDesktopClientState(event, {
  desktop = false,
  bridge,
  onLifecycle = () => {},
  lastWakeAt = 0,
  now = Date.now(),
  mediaActive = false,
} = {}) {
  if (
    !desktop
    || mediaActive === true
    || event?.type !== GatewayServerEvent.CLIENT_STATE
    || event.state !== 'sleeping'
    || typeof bridge?.enterHide !== 'function'
    || now - lastWakeAt < DESKTOP_WAKE_GRACE_MS
  ) return false

  const lifecycle = await bridge.enterHide()
  if (lifecycle?.state) onLifecycle(lifecycle.state)
  return lifecycle?.state === 'hidden'
}
