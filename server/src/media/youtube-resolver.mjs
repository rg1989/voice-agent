import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MediaError } from './media-error.mjs'

const execFileAsync = promisify(execFile)
// Under the 30 s a backend MCP call may take, so the backend tool can reuse it.
const SEARCH_TIMEOUT_MS = 20_000
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const PRINT_TEMPLATE = '%(id)s\t%(title)s\t%(channel,uploader|)s'

// yt-dlp is used for search only: --flat-playlist lists results without
// extracting streams, and nothing is downloaded. The ytsearch prefix also keeps
// a query that starts with "-" from being read as an option.
function searchTarget(query, service) {
  return service === 'youtube_music'
    ? `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`
    : `ytsearch1:${query}`
}

function watchUrl(videoId, service) {
  return service === 'youtube_music'
    ? `https://music.youtube.com/watch?v=${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`
}

export async function resolveYouTube(query, {
  service = 'youtube',
  execFileImpl = execFileAsync,
  ytDlpPath = 'yt-dlp',
} = {}) {
  const text = String(query || '').trim()
  if (!text) throw new MediaError('not_found', 'empty search')
  let stdout = ''
  try {
    ;({ stdout } = await execFileImpl(ytDlpPath, [
      '--flat-playlist', '--no-warnings', '--playlist-items', '1',
      '--print', PRINT_TEMPLATE,
      searchTarget(text, service),
    ], { timeout: SEARCH_TIMEOUT_MS }))
  } catch (error) {
    throw new MediaError(
      'resolver_unavailable',
      error?.code === 'ENOENT' ? 'yt-dlp is not installed' : `yt-dlp failed: ${error?.message || error}`,
    )
  }
  const line = String(stdout || '').split('\n').find(entry => entry.trim()) || ''
  const [videoId = '', title = '', channel = ''] = line.split('\t').map(field => field.trim())
  if (!VIDEO_ID.test(videoId)) throw new MediaError('not_found', `nothing found for ${text}`)
  return {
    url: watchUrl(videoId, service),
    title: title && title !== 'NA' ? title : text,
    channel: channel && channel !== 'NA' ? channel : null,
    videoId,
  }
}
