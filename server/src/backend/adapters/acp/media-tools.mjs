// Media playback for backend Agents.
//
// Every backend Session that accepts session MCP servers gets this loopback
// server. Unlike the computer-use gate it asks nobody: playing a title is what
// the user asked for, and the player accepts only a fixed set of services.
// Calls go to the Gateway's shared MediaPlayer, so the voice tools and the
// Agent drive the same playback. No browser profile, cookie or account detail
// is ever put in a result.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { logger as gatewayLogger } from '../../../core/logger.mjs'

export const MEDIA_TOOL_SERVER_NAME = 'qwen_audio_media'
const MEDIA_TOOL_PATH = '/media'
const PLAY_TOOL = 'qwen_audio_agent_media_play'
const CONTROL_TOOL = 'qwen_audio_agent_media_control'
const MEDIA_SERVICES = Object.freeze(['youtube', 'youtube_music', 'netflix', 'spotify', 'stremio'])
const MEDIA_ACTIONS = Object.freeze(['pause', 'resume', 'stop', 'next', 'previous', 'seek'])

const OUTSIDE_TURN = 'Media playback is only available while working on a request from the user.'

// omp puts server instructions into its system prompt, so the routing rules
// work even where the media-playback skill is not installed.
const INSTRUCTIONS = [
  'These tools play media for the user on this computer and control what is playing.',
  'Find the exact link first, then call qwen_audio_agent_media_play once with it.',
  'youtube and youtube_music take https youtube.com or music.youtube.com links; netflix takes https://www.netflix.com/watch/<id>;',
  'spotify takes a spotify: URI (convert an open.spotify.com link; never use the Spotify Web API);',
  'stremio takes stremio:///detail/<movie|series>/<imdbId>/<imdbId> and only opens the title page.',
  'The media-playback skill has the full lookup steps. Never ask for or type account passwords.',
].join(' ')

// Static, so tools/list never touches the player: omp fails the whole Session
// if an offered MCP server fails to answer.
export const MEDIA_TOOLS = Object.freeze([
  {
    name: PLAY_TOOL,
    description: 'Play a link for the user: YouTube, YouTube Music or Netflix in the player browser, a Spotify URI in the Spotify app, or open a Stremio title page. Replaces whatever is playing. Returns what started.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'An https YouTube, YouTube Music or Netflix link, a spotify: URI, or a stremio:///detail/... link',
        },
        title: { type: 'string', description: 'Title of what is played, spoken to the user' },
        service: { type: 'string', enum: [...MEDIA_SERVICES] },
      },
      required: ['url', 'service'],
      additionalProperties: false,
    },
  },
  {
    name: CONTROL_TOOL,
    description: 'Control what is playing: pause, resume, stop, next, previous, or seek by a signed number of seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MEDIA_ACTIONS] },
        seconds: { type: 'number', description: 'Only for seek: seconds to move, negative to go back' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
])

export const MEDIA_TOOL_NAMES = Object.freeze(MEDIA_TOOLS.map(tool => tool.name))

// Player messages can carry local paths, so only these fixed texts leave.
const ERROR_TEXT = Object.freeze({
  no_browser: 'No supported player browser is installed.',
  url_not_allowed: 'That link cannot be played by this service. YouTube and YouTube Music need https links on youtube.com or music.youtube.com, Netflix needs https://www.netflix.com/watch/<id>, Spotify needs a spotify: URI, Stremio needs stremio:///detail/<movie|series>/<imdbId>/<imdbId>.',
  launch_failed: 'The player could not be started.',
  not_playing: 'Nothing is playing.',
  transport_unavailable: 'The playing media cannot be controlled right now.',
  not_found: 'Nothing matching was found.',
  resolver_unavailable: 'The search tool is not available.',
})

function jsonResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function failure(code, message) {
  return jsonResult({ status: 'failed', error: code, message }, true)
}

function fromError(error) {
  return Object.hasOwn(ERROR_TEXT, error?.code)
    ? failure(error.code, ERROR_TEXT[error.code])
    : failure('failed', 'Media playback failed.')
}

export class MediaTools {
  constructor({ player, logger = gatewayLogger } = {}) {
    if (!player || typeof player.play !== 'function') {
      throw new TypeError('MediaTools requires a media player')
    }
    this.player = player
    this.logger = logger
    this.registrations = new Set()
  }

  // resolveSession returns the live Gateway Session object at call time.
  async register(toolServer, resolveSession) {
    const registration = await toolServer.registerServer({
      name: MEDIA_TOOL_SERVER_NAME,
      path: MEDIA_TOOL_PATH,
      createServer: () => this.createServer(resolveSession),
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

  createServer(resolveSession) {
    const server = new Server(
      { name: MEDIA_TOOL_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: MEDIA_TOOLS,
    }))
    server.setRequestHandler(CallToolRequestSchema, async request => this.call(
      resolveSession(),
      request.params.name,
      request.params.arguments || {},
    ))
    return server
  }

  async call(session, name, args = {}) {
    if (!MEDIA_TOOL_NAMES.includes(name)) return failure('unknown_tool', `Unknown media tool: ${name}`)
    // A call that arrives after the Session's turn ended must not start or
    // change playback that nobody is waiting for.
    if (!session?.permissionScopeId) return failure('outside_turn', OUTSIDE_TURN)
    try {
      return name === PLAY_TOOL ? await this.play(args) : await this.control(args)
    } catch (error) {
      // The Agent gets a fixed text; the Gateway log keeps the cause. One code
      // can have several causes, and an uncoded error would otherwise leave
      // no trace at all.
      this.logger.warn('media.agent_tool.failed', {
        tool: name,
        code: String(error?.code || ''),
        error: String(error?.message || error),
      })
      return fromError(error)
    }
  }

  async play({ url, title, service } = {}) {
    if (typeof url !== 'string' || !url.trim()) {
      return failure('invalid_arguments', 'url must be a non-empty string.')
    }
    if (!MEDIA_SERVICES.includes(service)) {
      return failure('invalid_arguments', `service must be one of: ${MEDIA_SERVICES.join(', ')}.`)
    }
    if (title !== undefined && typeof title !== 'string') {
      return failure('invalid_arguments', 'title must be a string.')
    }
    const result = await this.player.play({ url: url.trim(), title: title?.trim() || null, service })
    return jsonResult({
      status: result?.status,
      title: result?.title ?? null,
      url: result?.url ?? null,
      service: result?.service ?? null,
    })
  }

  async control({ action, seconds } = {}) {
    if (!MEDIA_ACTIONS.includes(action)) {
      return failure('invalid_arguments', `action must be one of: ${MEDIA_ACTIONS.join(', ')}.`)
    }
    if (action === 'stop') {
      const result = await this.player.stop({ reason: 'user' })
      return jsonResult({ status: result?.status ?? 'stopped' })
    }
    if (action === 'seek') {
      if (!Number.isFinite(seconds) || seconds === 0) {
        return failure('invalid_arguments', 'seek needs a non-zero number of seconds.')
      }
      const result = await this.player.control('seek_relative', { seconds })
      return jsonResult({ status: result?.status ?? 'ok', action })
    }
    const result = await this.player.control(action)
    return jsonResult({ status: result?.status ?? 'ok', action })
  }

  async close() {
    for (const registration of this.registrations) registration.release()
    this.registrations.clear()
  }
}
