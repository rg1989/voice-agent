import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_ORB_TITLE,
  DESKTOP_PANEL_TITLE,
  desktopWindowTitle,
} from '../src/desktop-window-title.mjs'

test('titles the panel apart from the orb so the Hyprland orb rules skip it', () => {
  assert.equal(DESKTOP_ORB_TITLE, 'qwen-audio-agent')
  assert.equal(DESKTOP_PANEL_TITLE, 'qwen-audio-agent-panel')
  assert.equal(desktopWindowTitle('orb'), 'qwen-audio-agent')
  assert.equal(desktopWindowTitle('panel'), 'qwen-audio-agent-panel')
  // setDesktopSurfaceMode treats anything but 'panel' as the orb.
  assert.equal(desktopWindowTitle(undefined), 'qwen-audio-agent')
  assert.equal(desktopWindowTitle('settings'), 'qwen-audio-agent')
  // P4 anchors its rule as ^qwen-audio-agent$, which must not match the panel.
  assert.equal(/^qwen-audio-agent$/.test(desktopWindowTitle('panel')), false)
  assert.equal(/^qwen-audio-agent$/.test(desktopWindowTitle('orb')), true)
})
