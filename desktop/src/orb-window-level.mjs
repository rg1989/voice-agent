// Kiosk/fullscreen Chromium may cover the 'floating' level on macOS (verified
// manually in Task 9). While a video is on screen the orb uses the
// 'screen-saver' level so it stays visible over it. mediaActive is the
// renderer's mediaOnScreen (web/src/desktop/desktop-hide.js): Spotify audio
// does not raise the orb. Other platforms
// keep the orb-shell recipe: Wayland ignores levels and Hyprland rules pin it.
export function orbAlwaysOnTopLevel({
  platform = process.platform,
  mediaActive = false,
} = {}) {
  return platform === 'darwin' && mediaActive === true
    ? 'screen-saver'
    : 'floating'
}

export function applyOrbWindowLevel(window, options = {}) {
  window.setAlwaysOnTop(true, orbAlwaysOnTopLevel(options))
}
