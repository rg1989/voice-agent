import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MediaError } from '../src/media/media-error.mjs'
import {
  detectPlayerBrowsers,
  playerLaunchArgs,
  resolvePlayerBrowser,
  whichOnPath,
} from '../src/media/browsers.mjs'

const existing = paths => path => paths.includes(path)

test('macOS detection orders Chrome, Edge, Brave, Chromium and also reads ~/Applications', () => {
  const brave = join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
  const detected = detectPlayerBrowsers({
    platform: 'darwin',
    existsImpl: existing([
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      brave,
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]),
    whichImpl: () => { throw new Error('macOS never searches PATH') },
  })
  assert.deepEqual(detected, [
    {
      id: 'edge',
      label: 'Microsoft Edge',
      binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      bundleId: 'com.microsoft.edgemac',
    },
    { id: 'brave', label: 'Brave', binary: brave, bundleId: 'com.brave.Browser' },
    {
      id: 'chromium',
      label: 'Chromium',
      binary: '/Applications/Chromium.app/Contents/MacOS/Chromium',
      bundleId: 'org.chromium.Chromium',
    },
  ])
})

test('macOS Chrome is found first when installed', () => {
  const detected = detectPlayerBrowsers({
    platform: 'darwin',
    existsImpl: existing([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]),
  })
  assert.deepEqual(detected.map(entry => [entry.id, entry.bundleId]), [
    ['chrome', 'com.google.Chrome'],
    ['edge', 'com.microsoft.edgemac'],
  ])
})

test('Linux detection orders Chromium, Chrome, Brave, Edge with real binaries before PATH', () => {
  const detected = detectPlayerBrowsers({
    platform: 'linux',
    existsImpl: existing(['/opt/brave.com/brave/brave', '/usr/lib/chromium/chromium']),
    whichImpl: name => ({
      chromium: '/usr/bin/chromium',
      'google-chrome-stable': '/usr/bin/google-chrome-stable',
    })[name] || null,
  })
  assert.deepEqual(detected, [
    { id: 'chromium', label: 'Chromium', binary: '/usr/lib/chromium/chromium', bundleId: null },
    { id: 'chrome', label: 'Google Chrome', binary: '/usr/bin/google-chrome-stable', bundleId: null },
    { id: 'brave', label: 'Brave', binary: '/opt/brave.com/brave/brave', bundleId: null },
  ])
})

test('other platforms have no player browser', () => {
  assert.deepEqual(detectPlayerBrowsers({
    platform: 'win32',
    existsImpl: () => true,
    whichImpl: () => 'C:\\chrome.exe',
  }), [])
})

test('whichOnPath returns the first match on PATH', () => {
  assert.equal(
    whichOnPath('brave', { path: '/usr/local/bin:/usr/bin', existsImpl: existing(['/usr/bin/brave']) }),
    '/usr/bin/brave',
  )
  assert.equal(whichOnPath('brave', { path: '', existsImpl: () => true }), null)
})

test('auto picks the first detected browser; a named browser must be installed', () => {
  const detected = [{ id: 'edge' }, { id: 'brave' }]
  assert.equal(resolvePlayerBrowser('auto', detected), detected[0])
  assert.equal(resolvePlayerBrowser('brave', detected), detected[1])
  assert.equal(resolvePlayerBrowser('chrome', detected), null)
  assert.equal(resolvePlayerBrowser('auto', []), null)
})

test('launch flags follow the contract order with the URL last', () => {
  assert.deepEqual(playerLaunchArgs({
    platform: 'darwin',
    profileDir: '/cfg/player/chrome',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  }), [
    '--user-data-dir=/cfg/player/chrome',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--kiosk',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ])
  assert.deepEqual(playerLaunchArgs({
    platform: 'linux',
    profileDir: '/cfg/player/chromium',
    url: 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ',
  }).slice(-3), ['--kiosk', '--class=qwaudio-player', 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ'])
  const setup = playerLaunchArgs({
    platform: 'darwin',
    profileDir: '/cfg/player/edge',
    url: 'https://www.youtube.com',
    kiosk: false,
  })
  assert.equal(setup.includes('--kiosk'), false)
  assert.equal(setup.at(-1), 'https://www.youtube.com')
  assert.deepEqual(playerLaunchArgs({
    platform: 'darwin',
    profileDir: '/cfg/player/chrome',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    devtoolsPipe: true,
  }), [
    '--user-data-dir=/cfg/player/chrome',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--kiosk',
    '--remote-debugging-pipe',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ])
  assert.deepEqual(playerLaunchArgs({
    platform: 'linux',
    profileDir: '/cfg/player/chromium',
    url: 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ',
    devtoolsPipe: true,
  }).slice(-4), ['--kiosk', '--class=qwaudio-player', '--remote-debugging-pipe', 'https://music.youtube.com/watch?v=fJ9rUzIMcZQ'])
})

test('only playback gets the bare DevTools pipe flag: never a port, automation or the setup window', () => {
  const debugging = args => args.filter(arg => /remote-debugging|enable-automation|disable-blink-features/.test(arg))
  for (const platform of ['darwin', 'linux']) {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    assert.deepEqual(debugging(playerLaunchArgs({ platform, profileDir: '/p', url })), [])
    assert.deepEqual(debugging(playerLaunchArgs({ platform, profileDir: '/p', url: 'https://www.youtube.com', kiosk: false })), [])
    assert.deepEqual(debugging(playerLaunchArgs({ platform, profileDir: '/p', url, devtoolsPipe: true })), ['--remote-debugging-pipe'])
  }
  assert.throws(
    () => playerLaunchArgs({ platform: 'darwin', profileDir: '/p', url: 'https://www.youtube.com', kiosk: false, devtoolsPipe: true }),
    { name: 'TypeError', message: 'the DevTools pipe is only for kiosk playback' },
  )
})

test('MediaError carries a stable code', () => {
  const error = new MediaError('no_browser', 'no supported player browser is installed')
  assert.equal(error instanceof Error, true)
  assert.equal(error.name, 'MediaError')
  assert.equal(error.code, 'no_browser')
  assert.equal(error.message, 'no supported player browser is installed')
})
