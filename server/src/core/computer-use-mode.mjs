// How computer control is offered to backend Agents, from QWEN_AUDIO_AGENT_COMPUTER_USE:
//   off           not offered at all
//   per_task      ask the first time a task needs the computer, then allow it for that task
//   every_action  ask before every screenshot, click and keystroke
//   always        never ask
// Older on/off spellings keep working.
export const COMPUTER_USE_MODES = Object.freeze(['off', 'per_task', 'every_action', 'always'])

const OFF = new Set(['false', 'off', '0', 'no', 'disabled'])

export function computerUseMode(env = process.env) {
  const value = String(env?.QWEN_AUDIO_AGENT_COMPUTER_USE ?? '').trim().toLowerCase()
  if (OFF.has(value)) return 'off'
  if (COMPUTER_USE_MODES.includes(value)) return value
  // Unset, a legacy "on", or a typo: the mode that asks.
  return 'per_task'
}
