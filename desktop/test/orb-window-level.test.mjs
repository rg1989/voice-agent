import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyOrbWindowLevel,
  orbAlwaysOnTopLevel,
} from '../src/orb-window-level.mjs'

test('raises the macOS orb to the screen-saver level only while media plays', () => {
  assert.equal(
    orbAlwaysOnTopLevel({ platform: 'darwin', mediaActive: true }),
    'screen-saver',
  )
  assert.equal(
    orbAlwaysOnTopLevel({ platform: 'darwin', mediaActive: false }),
    'floating',
  )
  // Wayland ignores window levels; Hyprland rules pin the orb instead.
  assert.equal(
    orbAlwaysOnTopLevel({ platform: 'linux', mediaActive: true }),
    'floating',
  )
  assert.equal(
    orbAlwaysOnTopLevel({ platform: 'win32', mediaActive: true }),
    'floating',
  )
})

test('applies the level to the orb window', () => {
  const applied = []
  const window = {
    setAlwaysOnTop: (...parameters) => applied.push(parameters),
  }
  applyOrbWindowLevel(window, { platform: 'darwin', mediaActive: true })
  applyOrbWindowLevel(window, { platform: 'darwin', mediaActive: false })
  assert.deepEqual(applied, [[true, 'screen-saver'], [true, 'floating']])
})
