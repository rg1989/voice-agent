import { toolFailure } from '../tool-result.mjs'
import { silentOutput } from './listening-tools.mjs'

export const PLAY_MEDIA_TOOL_NAME = 'play_media'
export const CONTROL_MEDIA_TOOL_NAME = 'control_media'
// Present while the Gateway has a media player.
export const MEDIA_PLAYER_CAPABILITY = 'media.player'
export const MEDIA_SERVICES = Object.freeze(['youtube', 'youtube_music'])
export const MEDIA_CONTROL_ACTIONS = Object.freeze(['pause', 'resume', 'stop', 'next', 'previous', 'seek'])

const playMediaTool = {
  type: 'function',
  function: {
    name: PLAY_MEDIA_TOOL_NAME,
    description: 'Play a video or song from YouTube or YouTube Music on this computer, full screen. Call it right away when the user asks to play, put on or watch something there, without asking first. It searches and plays the top result; when it returns, say only what is now playing, in a few words. Not for Netflix, Spotify or any other service.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for: title, artist, channel or topic, in the user’s words.',
        },
        service: {
          type: 'string',
          enum: [...MEDIA_SERVICES],
          description: 'youtube_music for songs, albums and artists; youtube for everything else.',
        },
      },
      required: ['query', 'service'],
      additionalProperties: false,
    },
  },
}

const controlMediaTool = {
  type: 'function',
  function: {
    name: CONTROL_MEDIA_TOOL_NAME,
    description: 'Control what the full-screen player is playing: pause, resume, stop (closes the player), next, previous, or seek forward or back. Call it immediately, and say nothing, when the user asks to pause, continue, stop, skip, go back or jump within the video or music.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MEDIA_CONTROL_ACTIONS] },
        seconds: {
          type: 'number',
          description: 'Only for seek: seconds to move, negative to go back.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
}

export const mediaToolEntries = [
  {
    definition: playMediaTool,
    policy: { requiredCapabilities: [MEDIA_PLAYER_CAPABILITY] },
  },
  {
    definition: controlMediaTool,
    // pause, resume and pause again in one turn are separate requests.
    policy: { requiredCapabilities: [MEDIA_PLAYER_CAPABILITY], repeatHandling: 'handler' },
  },
]

const FAILURE_MESSAGES = Object.freeze({
  no_browser: 'No player browser is installed. Install Google Chrome, Microsoft Edge, Brave or Chromium.',
  url_not_allowed: 'The player only opens YouTube and YouTube Music.',
  launch_failed: 'The player browser did not start.',
  not_playing: 'Nothing is playing right now.',
  transport_unavailable: 'The player cannot be controlled right now.',
  not_found: 'Nothing matched that search.',
  resolver_unavailable: 'Search is not available: yt-dlp is missing or failed.',
  invalid_arguments: 'That media request was incomplete.',
  media_failed: 'Playback failed.',
})
const RETRYABLE = new Set(['launch_failed', 'transport_unavailable', 'resolver_unavailable'])

function mediaFailure(code) {
  const known = Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'media_failed'
  return toolFailure(known, FAILURE_MESSAGES[known], { retryable: RETRYABLE.has(known) })
}

function sendFailure(runtime, { callId, turnId }, code) {
  return runtime.sendOutput(callId, mediaFailure(code), turnId, null, { createResponse: true })
}

// The spoken failure is short; the log keeps the cause. One code can have
// several causes (transport_unavailable, resolver_unavailable), and an
// uncoded error would otherwise leave no trace at all.
function logFailure(toolName, error) {
  const code = error?.code
  const known = Object.hasOwn(FAILURE_MESSAGES, code)
  const message = error?.message || String(error)
  console.warn(`${toolName} failed: ${code || 'no code'}: ${message}${known || !error?.stack ? '' : `\n${error.stack}`}`)
}

async function playMedia(runtime, context) {
  const { callId, turnId, args } = context
  const query = String(args?.query || '').trim()
  const service = MEDIA_SERVICES.includes(args?.service) ? args.service : 'youtube'
  if (!query) return sendFailure(runtime, context, 'invalid_arguments')
  try {
    const found = await runtime.resolveMedia(query, { service })
    const playing = await runtime.mediaPlayer.play({ url: found.url, title: found.title, service })
    // No URL: the result is spoken, and the voice never reads links aloud.
    return await runtime.sendOutput(callId, {
      status: 'playing',
      title: playing.title,
      ...(found.channel ? { channel: found.channel } : {}),
      service,
    }, turnId)
  } catch (error) {
    logFailure(PLAY_MEDIA_TOOL_NAME, error)
    return sendFailure(runtime, context, error?.code)
  }
}

async function controlMedia(runtime, context) {
  const action = context.args?.action
  const seconds = Number(context.args?.seconds)
  if (
    !MEDIA_CONTROL_ACTIONS.includes(action)
    || (action === 'seek' && (!Number.isFinite(seconds) || seconds === 0))
  ) return sendFailure(runtime, context, 'invalid_arguments')
  // A pause or stop the user asked for outlasts pause while talking.
  if (action === 'pause' || action === 'stop') runtime.mediaTalkPause?.keepPaused()
  try {
    if (action === 'stop') await runtime.mediaPlayer.stop({ reason: 'user' })
    else if (action === 'seek') await runtime.mediaPlayer.control('seek_relative', { seconds })
    else await runtime.mediaPlayer.control(action, {})
    return await silentOutput(runtime, context, { status: 'ok', action })
  } catch (error) {
    logFailure(CONTROL_MEDIA_TOOL_NAME, error)
    return sendFailure(runtime, context, error?.code)
  }
}

export function mediaToolHandlers(runtime) {
  return {
    [PLAY_MEDIA_TOOL_NAME]: context => playMedia(runtime, context),
    [CONTROL_MEDIA_TOOL_NAME]: context => controlMedia(runtime, context),
  }
}
