import { ClientActionName } from './client-action-port.mjs'
import { GatewayServerEvent } from '../../../shared/protocol/realtime-events.mjs'

// Playback that the user stopped, that ended, or whose window the user closed
// returns to the assistant. Replaced playback does not: the next item is
// already starting.
const RETURN_REASONS = new Set(['user', 'ended', 'exited'])
const STATE_EVENTS = Object.freeze(['started', 'paused', 'resumed'])

export function mediaStateEvent(state = {}) {
  return {
    type: GatewayServerEvent.MEDIA_STATE,
    active: state?.active === true,
    title: typeof state?.title === 'string' && state.title ? state.title : null,
    service: typeof state?.service === 'string' && state.service
      ? state.service
      : null,
  }
}

/**
 * One MediaPlayer serves the whole Gateway, while Client Actions travel on
 * per-connection ports. The bridge sends player changes to every connected
 * Client and asks the Clients that can show the conversation to do so.
 */
export class MediaClientBridge {
  constructor({ mediaPlayer, getSettings = () => ({}), logger = null }) {
    this.mediaPlayer = mediaPlayer
    this.getSettings = getSettings
    this.logger = logger
    this.clients = new Set()
    this.onStateChange = () => this.broadcast()
    this.onStopped = event => {
      this.broadcast()
      this.returnToAssistant(event)
    }
    for (const name of STATE_EVENTS) mediaPlayer.on(name, this.onStateChange)
    mediaPlayer.on('stopped', this.onStopped)
  }

  // client: { send(event), clientActions: ClientActionPort,
  //           isActiveVoiceClient?(): boolean }
  attach(client) {
    this.clients.add(client)
    client.send(mediaStateEvent(this.mediaPlayer.state()))
    return () => {
      this.clients.delete(client)
    }
  }

  broadcast() {
    const event = mediaStateEvent(this.mediaPlayer.state())
    for (const client of this.clients) client.send(event)
  }

  returnToAssistant({ reason } = {}) {
    if (!RETURN_REASONS.has(reason)) return []
    if (this.getSettings()?.mediaReturnToAssistant !== true) return []
    const capable = [...this.clients].filter(client => (
      client.clientActions?.supports(ClientActionName.SHOW_CONVERSATION)
    ))
    // The desktop the user is talking to opens its panel. A second desktop
    // paired to the same Gateway is asked only when no capable Client holds
    // the voice.
    const speaking = capable.filter(client => (
      client.isActiveVoiceClient?.() === true
    ))
    return (speaking.length ? speaking : capable)
      .map(client => client.clientActions.request(
        ClientActionName.SHOW_CONVERSATION,
        { reason },
        { idempotencyKey: 'media.show_conversation' },
      ).catch(error => {
        this.logger?.warn('media.show_conversation_failed', {
          code: String(error?.code || 'client_action_failed'),
          error: String(error?.message || error),
        })
        return null
      }))
  }

  close() {
    for (const name of STATE_EVENTS) {
      this.mediaPlayer.off(name, this.onStateChange)
    }
    this.mediaPlayer.off('stopped', this.onStopped)
    this.clients.clear()
  }
}
