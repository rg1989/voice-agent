// The orb and the conversation panel are one window with one Linux class.
// The Hyprland rules for the orb (float, pin, no_initial_focus) match the orb
// title, so the panel takes a different title and those rules skip it.
export const DESKTOP_ORB_TITLE = 'qwen-audio-agent'
export const DESKTOP_PANEL_TITLE = 'qwen-audio-agent-panel'

export function desktopWindowTitle(mode) {
  return mode === 'panel' ? DESKTOP_PANEL_TITLE : DESKTOP_ORB_TITLE
}
