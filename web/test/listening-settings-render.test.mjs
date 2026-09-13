import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let ListeningSettings
let setRuntimeLanguage

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  ;({ ListeningSettings } = await server.ssrLoadModule('/src/SettingsPanel.jsx'))
  ;({ setRuntimeLanguage } = await server.ssrLoadModule('/src/i18n.js'))
})

after(async () => {
  setRuntimeLanguage?.('')
  await server?.close()
})

const settings = {
  listeningMode: 'always',
  listeningModes: [
    { id: 'always', label: 'Always listening', detail: 'server detail' },
    { id: 'wake_word', label: 'Wake word', detail: 'server detail' },
  ],
  wakeWord: 'hey_jarvis',
  wakeWords: [
    { id: 'hey_jarvis', label: 'Hey Jarvis' },
    { id: 'alexa', label: 'Alexa' },
    { id: 'hey_mycroft', label: 'Hey Mycroft' },
  ],
  followUpSeconds: 5,
  followUpDefaults: { seconds: 5, min: 0, max: 30 },
  cameraEnabled: false,
}

function markup(overrides = {}) {
  return renderToStaticMarkup(createElement(ListeningSettings, {
    settings: { ...settings, ...overrides },
    disabled: false,
    save() {},
  }))
}

const optionLabels = html => [...html.matchAll(/<button[^>]*><b>([^<]+)<\/b>/g)].map(match => match[1])

test('always mode shows only the two listening cards', () => {
  setRuntimeLanguage('en')
  const html = markup()
  assert.match(html, /<h4>Listening<\/h4>/)
  assert.deepEqual(optionLabels(html), ['Always listening', 'Wake word'])
  assert.match(html, /class="settings-option selected"[^>]*><b>Always listening/)
  assert.doesNotMatch(html, /type="range"/)
  assert.doesNotMatch(html, /camera/i)
})

test('wake word mode adds wake words, the recommendation and a follow-up slider', () => {
  for (const [lang, recommended, seconds, wakeWord] of [
    ['en', 'Recommended', '5 s', 'Wake word'],
    ['zh', '推荐', '5 秒', '唤醒词'],
  ]) {
    setRuntimeLanguage(lang)
    const html = markup({ listeningMode: 'wake_word' })
    assert.deepEqual(optionLabels(html), [
      lang === 'en' ? 'Always listening' : '一直在听',
      wakeWord,
      'Hey Jarvis',
      'Alexa',
      'Hey Mycroft',
    ])
    assert.ok(html.includes(`<b>Hey Jarvis</b><small>${recommended}</small>`))
    assert.ok(html.includes('<b>Alexa</b></button>'))
    const slider = html.match(/<input type="range"[^>]*>/)?.[0] || ''
    assert.match(slider, /min="0"/)
    assert.match(slider, /max="15"/)
    assert.match(slider, /step="1"/)
    assert.match(slider, /value="5"/)
    assert.ok(html.includes(`<small>${seconds}</small>`))
    assert.doesNotMatch(html, /camera|相机/i)
  }
})

test('follow-up falls back to the server default and stays inside the slider range', () => {
  setRuntimeLanguage('en')
  const fallback = markup({ listeningMode: 'wake_word', followUpSeconds: undefined, followUpDefaults: { seconds: 7, min: 0, max: 30 } })
  assert.match(fallback, /value="7"/)
  const clamped = markup({ listeningMode: 'wake_word', followUpSeconds: 25 })
  assert.match(clamped, /value="15"/)
})

test('renders nothing when the gateway has no listening settings', () => {
  assert.equal(markup({ listeningModes: undefined }), '')
})
