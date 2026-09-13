import { GatewayServerEvent } from '../../shared/protocol/realtime-events.mjs'
import { t } from './i18n.js'

// Wake-word presentation for the WebUI. The gateway gates the microphone;
// the page only reflects its state.

export const RECOMMENDED_WAKE_WORD = 'hey_jarvis'

// hey_jarvis -> Hey Jarvis, matching the gateway's option labels.
export function wakeWordLabel(id = '') {
  return String(id || '')
    .split('_')
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

// Armed only matters while the microphone is on and nothing else is shown.
export function wakeWordArmed({ listeningState, voiceEnabled, visualState } = {}) {
  return voiceEnabled === true && listeningState === 'armed' && visualState === 'idle'
}

// Length of the "keep talking" countdown to show, 0 when there is none. The
// gateway only sends followUpMs in wake-word mode.
export function followUpCountdownMs({ listeningFollowUpMs, voiceEnabled } = {}) {
  return voiceEnabled === true && listeningFollowUpMs > 0 ? listeningFollowUpMs : 0
}

export function wakeWordHint(wakeWord) {
  const label = wakeWordLabel(wakeWord)
  return label
    ? t('说“{wakeWord}”唤醒我', { wakeWord: label })
    : t('说出唤醒词唤醒我')
}

// Chime once per real wake, not when a status resend repeats the reason.
export function shouldPlayWakeChime(event, previousState = '') {
  return (
    event?.type === GatewayServerEvent.VOICE_LISTENING
    && event.state === 'awake'
    && event.reason === 'wake_word'
    && previousState !== 'awake'
  )
}
