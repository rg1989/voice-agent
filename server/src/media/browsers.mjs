import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// Chromium-family browsers the media player launches directly. Each runs with
// its own --user-data-dir, so it is a separate process from the user's
// everyday browser and never sees that browser's cookies.
//
// Playback launches add --remote-debugging-pipe and nothing else from the
// DevTools family: never --remote-debugging-port or --remote-debugging-address
// (a TCP port any local process could reach), never --enable-automation. The
// pipe exists only between the gateway and the player process it spawned.

export const PLAYER_BROWSER_LABELS = Object.freeze({
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  chromium: 'Chromium',
  brave: 'Brave',
})

export const AUTO_BROWSER_ORDER = Object.freeze({
  darwin: Object.freeze(['chrome', 'edge', 'brave', 'chromium']),
  linux: Object.freeze(['chromium', 'chrome', 'brave', 'edge']),
})

const MAC_BROWSERS = Object.freeze({
  chrome: { app: 'Google Chrome.app/Contents/MacOS/Google Chrome', bundleId: 'com.google.Chrome' },
  edge: { app: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
  brave: { app: 'Brave Browser.app/Contents/MacOS/Brave Browser', bundleId: 'com.brave.Browser' },
  chromium: { app: 'Chromium.app/Contents/MacOS/Chromium', bundleId: 'org.chromium.Chromium' },
})

// Real binaries first: wrappers on PATH (Arch's /usr/bin/chromium) add the
// flags and extensions from ~/.config/chromium-flags.conf.
const LINUX_CANDIDATES = Object.freeze({
  chromium: ['/usr/lib/chromium/chromium', 'chromium'],
  chrome: ['/opt/google/chrome/chrome', 'google-chrome-stable'],
  brave: ['/opt/brave-bin/brave', '/opt/brave.com/brave/brave', 'brave'],
  edge: ['/opt/microsoft/msedge/msedge', 'microsoft-edge-stable'],
})

export function whichOnPath(name, { existsImpl = existsSync, path = process.env.PATH || '' } = {}) {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name)
    if (existsImpl(candidate)) return candidate
  }
  return null
}

function macBinary(id, existsImpl) {
  return ['/Applications', join(homedir(), 'Applications')]
    .map(directory => join(directory, MAC_BROWSERS[id].app))
    .find(candidate => existsImpl(candidate)) || null
}

function linuxBinary(id, existsImpl, whichImpl) {
  for (const candidate of LINUX_CANDIDATES[id]) {
    const found = candidate.startsWith('/')
      ? (existsImpl(candidate) ? candidate : null)
      : whichImpl(candidate)
    if (found) return found
  }
  return null
}

export function detectPlayerBrowsers({
  platform = process.platform,
  existsImpl = existsSync,
  whichImpl = name => whichOnPath(name, { existsImpl }),
} = {}) {
  return (AUTO_BROWSER_ORDER[platform] || []).flatMap(id => {
    const binary = platform === 'darwin'
      ? macBinary(id, existsImpl)
      : linuxBinary(id, existsImpl, whichImpl)
    if (!binary) return []
    return [{
      id,
      label: PLAYER_BROWSER_LABELS[id],
      binary,
      bundleId: platform === 'darwin' ? MAC_BROWSERS[id].bundleId : null,
    }]
  })
}

export function resolvePlayerBrowser(settingId, detected = []) {
  if (!settingId || settingId === 'auto') return detected[0] || null
  return detected.find(entry => entry.id === settingId) || null
}

export function playerLaunchArgs({
  platform = process.platform,
  profileDir,
  url,
  kiosk = true,
  devtoolsPipe = false,
}) {
  // The sign-in window (kiosk: false) never gets the pipe: it would mark the
  // Google sign-in page as automated and hand that page to the gateway.
  if (devtoolsPipe && !kiosk) throw new TypeError('the DevTools pipe is only for kiosk playback')
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-session-crashed-bubble',
    // Current Chromium ignores the switch above; this one hides "Restore
    // pages?" after a SIGKILL or a crash.
    '--hide-crash-restore-bubble',
    ...(kiosk ? ['--kiosk'] : []),
    // A unique Wayland app_id / X11 class, so window rules never touch the
    // user's own Chromium windows.
    ...(platform === 'linux' ? ['--class=qwaudio-player'] : []),
    // The bare switch: JSON messages over fds 3 and 4 (the value 'cbor' would
    // change the format). It also makes navigator.webdriver true in pages.
    ...(devtoolsPipe ? ['--remote-debugging-pipe'] : []),
    url,
  ]
}
