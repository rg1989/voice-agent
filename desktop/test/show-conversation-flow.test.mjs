import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ClientActionPort } from '../../server/src/client/client-action-port.mjs'
import { MediaClientBridge } from '../../server/src/client/media-client-bridge.mjs'
import { performDesktopClientAction } from '../../web/src/desktop/desktop-hide.js'
import { DesktopPresence } from '../src/desktop-presence.mjs'
import { bindOrbShell, ORB_CHANNELS } from '../src/orb-shell.mjs'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
} from '../../shared/protocol/gateway-client-protocol.mjs'

test('playback ending opens and focuses the desktop conversation panel', async () => {
  const window = {
    calls: [],
    webContents: { send() {} },
    isDestroyed: () => false,
    isMinimized: () => false,
    show() { this.calls.push('show') },
    focus() { this.calls.push('focus') },
    hide() { this.calls.push('hide') },
  }
  const presence = new DesktopPresence({
    getWindow: () => window,
    globalShortcut: {
      register: () => true,
      unregister() {},
      unregisterAll() {},
    },
  })
  const handlers = new Map()
  let surface = 'orb'
  bindOrbShell({
    ipc: {
      on() {},
      removeListener() {},
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
    getWindow: () => window,
    presence,
    onLoadSurface: () => surface,
    // Copy of desktop/src/main.mjs onSetSurface without the macOS
    // app.focus branch. Task 9 Step 5 checks that branch on hardware.
    onSetSurface: mode => {
      surface = mode
      if (mode === 'panel') presence.wake('panel')
      return surface
    },
  })

  const rendererSurfaces = []
  let clientActions
  clientActions = new ClientActionPort({
    getCapabilities: () => [
      GatewayClientCapability.CLIENT_ACTION_SHOW_CONVERSATION,
    ],
    createEventId: () => 'evt_gateway_show_conversation',
    send: async event => {
      const result = await performDesktopClientAction(event, {
        desktop: true,
        bridge: {
          setSurface: async mode => handlers.get(ORB_CHANNELS.surfaceSet)(
            { sender: window.webContents },
            mode,
          ),
        },
        onSurface: mode => rendererSurfaces.push(mode),
      })
      clientActions.receive({
        type: GatewayClientProtocolEvent.CLIENT_ACTION_RESULT,
        event_id: 'evt_client_show_conversation',
        request_event_id: event.event_id,
        ...result,
      })
    },
  })
  const player = new EventEmitter()
  player.state = () => ({ active: false, title: null, service: null })
  const bridge = new MediaClientBridge({
    mediaPlayer: player,
    getSettings: () => ({ mediaReturnToAssistant: true }),
  })
  bridge.attach({ send() {}, clientActions })

  const [result] = await Promise.all(
    bridge.returnToAssistant({ reason: 'ended' }),
  )

  assert.equal(result?.status, 'completed')
  assert.deepEqual(result.output, { mode: 'panel' })
  assert.equal(surface, 'panel')
  assert.deepEqual(rendererSurfaces, ['panel'])
  assert.deepEqual(window.calls, ['show', 'focus'])
  bridge.close()
})
