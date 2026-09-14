import {
  BACKEND_INPUT_RESPONSE_CAPABILITY,
  PERMISSION_RESPONSE_CAPABILITY,
  SPAWN_THINKING_TOOL_NAME,
} from './features/agent-task-tools.mjs'
import { FRONTEND_RECALL_CAPABILITY } from './features/retrieval-tools.mjs'
import { WAKE_WORD_LISTENING_CAPABILITY } from './features/listening-tools.mjs'
import { MEDIA_PLAYER_CAPABILITY } from './features/media-tools.mjs'
import { optionalFrontendFeatures } from '../optional-features.mjs'

// Use the same availability projection for model schemas and tool dispatch.
// Only an explicitly unconfigured backend removes execution; a temporarily
// disconnected backend keeps its tool and reports its current error at runtime.
export function buildFrontendToolContext({
  disabledTools = [],
  backendAvailability = null,
  frontendRetrieval = null,
  frontendKnowledge = null,
  memoryService = null,
  sessionDigests = null,
  permissionPending = false,
  inputPending = false,
  liveSettings = null,
  mediaPlayer = null,
} = {}) {
  const backendConfigured = backendAvailability?.snapshot()?.configured !== false
  return {
    backendConfigured,
    disabledTools: [...new Set([
      ...disabledTools,
      ...(!backendConfigured ? [SPAWN_THINKING_TOOL_NAME] : []),
    ])],
    capabilities: [...new Set([
      ...(frontendRetrieval?.capabilities?.() || []),
      ...optionalFrontendFeatures.flatMap(feature => (
        feature.capabilities?.({ memoryService, frontendKnowledge }) || []
      )),
      ...(sessionDigests ? [FRONTEND_RECALL_CAPABILITY] : []),
      ...(permissionPending ? [PERMISSION_RESPONSE_CAPABILITY] : []),
      ...(inputPending ? [BACKEND_INPUT_RESPONSE_CAPABILITY] : []),
      ...(liveSettings?.wakeWord ? [WAKE_WORD_LISTENING_CAPABILITY] : []),
      ...(mediaPlayer ? [MEDIA_PLAYER_CAPABILITY] : []),
    ])],
    ...(liveSettings?.wakeWord ? { wakeWord: liveSettings.wakeWord } : {}),
  }
}
