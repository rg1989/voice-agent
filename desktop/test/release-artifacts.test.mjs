import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('builds and uploads both install and automatic-update macOS artifacts', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

  assert.match(builder, /target:\s*\n\s*- dmg\s*\n\s*- zip/)
  assert.match(manifest.scripts['desktop:build'], /--mac dmg zip/)
  assert.match(workflow, /dist\/desktop\/\*\.dmg/)
  assert.match(workflow, /dist\/desktop\/\*\.zip/)
})

test('copies only backend runtime scripts outside the desktop archive', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const scriptsResource = builder.match(
    /  - from: scripts\r?\n[\s\S]*?(?=\r?\n  - from:|$)/,
  )?.[0]
  assert.ok(scriptsResource)
  assert.match(scriptsResource, /- "runtime\/\*\*\/\*"/)
  assert.doesNotMatch(scriptsResource, /- "\*\*\/\*"/)
})

test('gives the Linux window the qwen-audio-agent app id in packaged and source runs', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const desktopManifest = JSON.parse(
    readFileSync(new URL('desktop/package.json', root), 'utf8'),
  )
  // Electron sets the Wayland app_id and the X11 WM_CLASS to package.json
  // desktopName without ".desktop". Hyprland window rules match on it.
  // Packaged builds read the root manifest; `npm run desktop` reads desktop/.
  assert.equal(manifest.desktopName, 'qwen-audio-agent.desktop')
  assert.equal(desktopManifest.desktopName, manifest.desktopName)
  assert.match(builder, /linux:[\s\S]*?syncDesktopName: true/)
})

test('lets the macOS app and its Gateway helper control Spotify through Apple Events', () => {
  const builder = readFileSync(new URL('desktop/electron-builder.yml', root), 'utf8')
  const mac = builder.match(/^mac:\r?\n[\s\S]*?(?=^\S)/m)?.[0]
  assert.ok(mac, 'electron-builder.yml has a mac section')
  assert.match(mac, /\n {2}extendInfo:\r?\n(?: {4}\S.*\r?\n)*? {4}NSAppleEventsUsageDescription: \S/)
  for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const entitlements = readFileSync(new URL(`desktop/build/${file}`, root), 'utf8')
    assert.match(
      entitlements,
      /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/,
      `${file} allows Apple Events`,
    )
  }
})
