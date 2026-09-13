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
    { id: 'hey_lisa', label: 'Hey Lisa' },
    { id: 'hey_megan', label: 'Hey Megan' },
    { id: 'hey_mycroft', label: 'Hey Mycroft' },
    { id: 'glados', label: 'GLaDOS' },
  ],
  followUpSeconds: 5,
  followUpDefaults: { seconds: 5, min: 0, max: 10 },
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
      'Hey Lisa',
      'Hey Megan',
      'Hey Mycroft',
      'GLaDOS',
    ])
    assert.ok(html.includes(`<b>Hey Jarvis</b><small>${recommended}</small>`))
    assert.ok(html.includes('<b>Hey Lisa</b></button>'))
    const slider = html.match(/<input type="range"[^>]*>/)?.[0] || ''
    assert.match(slider, /min="0"/)
    assert.match(slider, /max="10"/)
    assert.match(slider, /step="1"/)
    assert.match(slider, /value="5"/)
    assert.doesNotMatch(html, /type="number"/)
    // Visible stops 0..10 under the track.
    const marks = html.match(/<span class="settings-slider-marks"[^>]*>(.*?)<\/span><small/)?.[1] || ''
    assert.deepEqual(
      [...marks.matchAll(/<span>(\d+)<\/span>/g)].map(match => Number(match[1])),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    )
    assert.ok(html.includes(`<small>${seconds}</small>`))
    assert.doesNotMatch(html, /camera|相机/i)
  }
})

test('follow-up falls back to the server default and stays inside the slider range', () => {
  setRuntimeLanguage('en')
  const fallback = markup({ listeningMode: 'wake_word', followUpSeconds: undefined, followUpDefaults: { seconds: 7, min: 0, max: 30 } })
  assert.match(fallback, /value="7"/)
  // An older gateway or config may still allow more than 10 seconds.
  const clamped = markup({ listeningMode: 'wake_word', followUpSeconds: 25, followUpDefaults: { seconds: 5, min: 0, max: 30 } })
  assert.match(clamped, /max="10"/)
  assert.match(clamped, /value="10"/)
  const rounded = markup({ listeningMode: 'wake_word', followUpSeconds: 4.6 })
  assert.match(rounded, /value="5"/)
})

test('renders nothing when the gateway has no listening settings', () => {
  assert.equal(markup({ listeningModes: undefined }), '')
})
