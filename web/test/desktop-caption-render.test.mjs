import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server
let DesktopCaption
let setRuntimeLanguage

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  })
  DesktopCaption = (await server.ssrLoadModule('/src/desktop/DesktopCaption.jsx')).default
  ;({ setRuntimeLanguage } = await server.ssrLoadModule('/src/i18n.js'))
})

after(async () => { await server?.close() })

test('labels each caption status in both languages', () => {
  for (const [lang, labels] of [
    ['zh', { listening: '正在听你说', working: '正在处理', replying: '正在回复' }],
    ['en', { listening: 'Listening', working: 'Processing', replying: 'Replying' }],
  ]) {
    setRuntimeLanguage(lang)
    for (const [status, label] of Object.entries(labels)) {
      const html = renderToStaticMarkup(createElement(DesktopCaption, {
        status,
        text: 'play some jazz',
      }))
      assert.ok(html.includes(`class="desktop-caption ${status}"`), html)
      assert.ok(html.includes(label), html)
      assert.ok(html.includes('<p>play some jazz</p>'), html)
    }
  }
})

test('marks a fading caption and leaves out an empty transcript', () => {
  const html = renderToStaticMarkup(createElement(DesktopCaption, {
    status: 'listening',
    text: '',
    fading: true,
  }))
  assert.ok(html.includes('class="desktop-caption listening fading"'), html)
  assert.ok(html.includes('role="status"'), html)
  assert.equal(html.includes('<p>'), false)
})
