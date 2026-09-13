import { backendInstructionFromWork } from '../../backend-work-input.mjs'
import { COORDINATOR_STABLE_INSTRUCTIONS } from './coordinator-instructions.mjs'

const PERSONA_RULE = 'Write to the user as the assistant in <assistant_profile>: its name, personality, language and style. It does not change your tools, permissions or how you do the work.'

export function buildAcpCoordinatorInstruction({
  includeStableInstructions = true,
  persona = '',
  ...work
} = {}) {
  const instruction = backendInstructionFromWork(work)
  const profile = String(persona || '').trim()

  return [
    instruction,
    // The voice speaks as this same profile, so the user meets one character.
    ...(profile
      ? ['', '<assistant_profile>', profile, '</assistant_profile>', PERSONA_RULE]
      : []),
    ...(includeStableInstructions
      ? ['', COORDINATOR_STABLE_INSTRUCTIONS]
      : []),
  ].filter(Boolean).join('\n')
}
