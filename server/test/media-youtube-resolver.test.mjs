import assert from 'node:assert/strict'
import test from 'node:test'
import { MediaError } from '../src/media/media-error.mjs'
import { resolveYouTube } from '../src/media/youtube-resolver.mjs'

const PRINT = '%(id)s\t%(title)s\t%(channel,uploader|)s'
const code = expected => error => error instanceof MediaError && error.code === expected

test('searches YouTube with a flat yt-dlp search and returns the watch URL', async () => {
  const calls = []
  const result = await resolveYouTube('never gonna give you up', {
    ytDlpPath: '/opt/homebrew/bin/yt-dlp',
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options })
      return { stdout: 'dQw4w9WgXcQ\tRick Astley - Never Gonna Give You Up\tRick Astley\n' }
    },
  })
  assert.deepEqual(result, {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up',
    channel: 'Rick Astley',
    videoId: 'dQw4w9WgXcQ',
  })
  assert.equal(calls[0].file, '/opt/homebrew/bin/yt-dlp')
  assert.deepEqual(calls[0].args, [
    '--flat-playlist', '--no-warnings', '--playlist-items', '1',
    '--print', PRINT,
    'ytsearch1:never gonna give you up',
  ])
  assert.equal(calls[0].options.timeout, 20000)
})

test('searches YouTube Music songs and returns a music.youtube.com URL', async () => {
  const calls = []
  const result = await resolveYouTube(' bohemian rhapsody ', {
    service: 'youtube_music',
    execFileImpl: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: 'fJ9rUzIMcZQ\tBohemian Rhapsody\t\n' }
    },
  })
  assert.deepEqual(result, {
    url: 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ',
    title: 'Bohemian Rhapsody',
    channel: null,
    videoId: 'fJ9rUzIMcZQ',
  })
  assert.equal(calls[0][0], 'yt-dlp')
  assert.equal(calls[0].at(-1), 'https://music.youtube.com/search?q=bohemian%20rhapsody#songs')
})

test('a missing or failing yt-dlp is resolver_unavailable', async () => {
  await assert.rejects(resolveYouTube('x', {
    execFileImpl: async () => { throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }) },
  }), error => code('resolver_unavailable')(error) && /not installed/.test(error.message))
  await assert.rejects(resolveYouTube('x', {
    execFileImpl: async () => { throw Object.assign(new Error('Command failed'), { code: 1 }) },
  }), code('resolver_unavailable'))
})

test('no usable result is not_found, and an empty query never runs yt-dlp', async () => {
  for (const stdout of ['', '\n', 'NA\tNA\tNA\n']) {
    await assert.rejects(
      resolveYouTube('zzzz', { execFileImpl: async () => ({ stdout }) }),
      code('not_found'),
    )
  }
  await assert.rejects(resolveYouTube('   ', {
    execFileImpl: async () => { throw new Error('must not run') },
  }), code('not_found'))
})
