import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let MediaSettings
let setRuntimeLanguage

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  ;({ MediaSettings } = await server.ssrLoadModule('/src/SettingsPanel.jsx'))
  ;({ setRuntimeLanguage } = await server.ssrLoadModule('/src/i18n.js'))
})

after(async () => {
  setRuntimeLanguage?.('')
  await server?.close()
})

const settings = {
  mediaBrowser: 'auto',
  mediaBrowserOptions: [
    { id: 'auto', label: 'Automatic', installed: true },
    { id: 'chrome', label: 'Google Chrome', installed: true },
    { id: 'edge', label: 'Microsoft Edge', installed: true },
    { id: 'chromium', label: 'Chromium', installed: false },
    { id: 'brave', label: 'Brave', installed: false },
  ],
  mediaReturnToAssistant: false,
  mediaPauseWhileTalking: true,
}

function markup(overrides = {}) {
  return renderToStaticMarkup(createElement(MediaSettings, {
    settings: { ...settings, ...overrides },
    disabled: false,
    save() {},
    onSetup() {},
  }))
}

const optionLabels = html => [...html.matchAll(/<button[^>]*><b>([^<]+)<\/b>/g)].map(match => match[1])

test('shows the player browsers, marks missing ones, and the two media switches', () => {
  setRuntimeLanguage('en')
  const html = markup()
  assert.match(html, /<h4>Media<\/h4>/)
  assert.deepEqual(optionLabels(html), ['Automatic', 'Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave'])
  assert.ok(html.includes('class="settings-option selected"><b>Automatic</b><small>Uses the first installed browser.</small>'))
  assert.ok(html.includes('class="settings-option"><b>Google Chrome</b></button>'))
  assert.ok(html.includes('class="settings-option" disabled=""><b>Chromium</b><small>Not installed</small>'))
  assert.ok(html.includes('<input type="checkbox" checked=""/><span><b>Pause while we talk</b>'))
  assert.ok(html.includes('<input type="checkbox"/><span><b>Return to the assistant when playback stops</b>'))
  assert.ok(html.includes('<button type="button">Set up player</button>'))
  assert.doesNotMatch(html, /No supported browser found/)
})

test('without an installed browser the setup button is off and the hint says what to install', () => {
  setRuntimeLanguage('zh')
  const html = markup({
    mediaBrowserOptions: settings.mediaBrowserOptions.map(option => ({ ...option, installed: false })),
  })
  assert.match(html, /<h4>媒体播放<\/h4>/)
  assert.match(html, /没有找到支持的浏览器/)
  assert.ok(html.includes('<button type="button" disabled="">设置播放器</button>'))
})

test('renders nothing when the gateway has no media settings', () => {
  assert.equal(markup({ mediaBrowserOptions: undefined }), '')
})
