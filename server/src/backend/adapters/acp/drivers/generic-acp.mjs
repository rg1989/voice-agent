import {
  baseEnvironment,
  clean,
  processAcpConnection,
} from './shared.mjs'
import { computerUseEnabled } from '../builtin-mcp.mjs'

// 0 means "no timeout" in omp and is left alone. Anything shorter than the
// computer-use gate's worst case (165 s) is raised, or the call fails mid-prompt.
function ompMcpTimeout(configured) {
  if (String(configured ?? '').trim() === '0') return '0'
  return String(Math.max(Number(configured) || 0, 180_000))
}

export const genericAcpBackendDriver = {
  id: 'acp',
  label: 'ACP Agent',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: false,
    nativeSessionHistory: true,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: false,
  },

  createProfile({
    directory,
    cliPath,
    args = [],
    label,
    permissionMode,
  }) {
    const command = clean(cliPath)
    if (!command) {
      throw new Error('使用通用 ACP 后端时必须设置 ACP_COMMAND')
    }
    if (permissionMode === 'full') {
      throw new Error('通用 ACP 后端无法安全地统一开启最高权限模式')
    }
    return {
      label: clean(label) || this.label,
      acpConnection: processAcpConnection({
        command,
        args: Array.isArray(args) ? args.map(String) : [],
        cwd: directory,
        // omp abandons any MCP call after 30 s, and a spoken approval for
        // computer control routinely takes longer, so the call would fail while
        // the prompt is still up. The setting is process-wide in omp, so it is
        // raised only when computer control is on.
        env: baseEnvironment('acp', computerUseEnabled()
          ? { OMP_MCP_TIMEOUT_MS: ompMcpTimeout(process.env.OMP_MCP_TIMEOUT_MS) }
          : {}),
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: false,
    }
  },
}
