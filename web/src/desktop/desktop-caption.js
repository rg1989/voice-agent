// The orb caption keeps a conversation readable over a fullscreen video: what
// the user is saying and what the assistant is doing. Background work is not a
// caption state, because task cards already show it.
export const DESKTOP_CAPTION_LINGER_MS = 4000
export const DESKTOP_CAPTION_FADE_MS = 300
export const DESKTOP_CAPTION_MAX_CHARACTERS = 120

export const DESKTOP_CAPTION_HIDDEN = Object.freeze({
  phase: 'hidden',
  status: null,
  text: '',
})

const CAPTION_STATUSES = new Map([
  ['listening', 'listening'],
  ['processing', 'working'],
  ['speaking', 'replying'],
])

const CAPTION_DELAYS = new Map([
  ['lingering', DESKTOP_CAPTION_LINGER_MS],
  ['fading', DESKTOP_CAPTION_FADE_MS],
])

export function desktopCaptionStatus(visualState) {
  return CAPTION_STATUSES.get(visualState) || null
}

export function desktopCaption({ messages = [], visualState = 'idle' } = {}) {
  // Only the current turn: when the assistant speaks on its own (a reminder,
  // a task result) an older question must not reappear under it.
  const latest = messages.at(-1)
  const user = latest && messages.findLast(message => (
    message.role === 'user'
    && message.voice === true
    && message.turnId === latest.turnId
  ))
  const text = String(user?.content || '')
  return {
    status: desktopCaptionStatus(visualState),
    text: text.length > DESKTOP_CAPTION_MAX_CHARACTERS
      ? `…${text.slice(-(DESKTOP_CAPTION_MAX_CHARACTERS - 1))}`
      : text,
  }
}

// hidden -> shown while a conversation state lasts -> lingering after it ends
// -> fading -> hidden. Timers make the last two steps with expireDesktopCaption.
export function nextDesktopCaption(current, { available, status, text }) {
  if (!available) return DESKTOP_CAPTION_HIDDEN
  if (status) {
    return (
      current.phase === 'shown'
      && current.status === status
      && current.text === text
    )
      ? current
      : { phase: 'shown', status, text }
  }
  return current.phase === 'shown'
    ? { ...current, phase: 'lingering' }
    : current
}

export function desktopCaptionDelay(phase) {
  return CAPTION_DELAYS.get(phase) ?? null
}

export function expireDesktopCaption(current, phase) {
  if (current.phase !== phase) return current
  if (phase === 'lingering') return { ...current, phase: 'fading' }
  if (phase === 'fading') return DESKTOP_CAPTION_HIDDEN
  return current
}
