import { gatewayFetch } from './gateway-transport.js'

// 设置的读写与「改完等 Gateway 重启回来」这件事，header 的工作区切换器和设置
// 面板都要用，所以放在一处。

const RESTART_POLL_MS = 500
const RESTART_TIMEOUT_MS = 45000

export async function fetchSettings() {
  const response = await gatewayFetch('api/settings', { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

export async function fetchFolders(path) {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await gatewayFetch(`api/settings/folders${query}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

// Gateway 重启期间 /api/health 会短暂不可达；等它回来再整页刷新，
// 这样 WebSocket 会带着新的后台、目录和音色重新握手。
export async function waitForGatewayThenReload() {
  const deadline = Date.now() + RESTART_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, RESTART_POLL_MS))
    try {
      const response = await gatewayFetch('api/health', { cache: 'no-store' })
      if (response.ok) {
        globalThis.location?.reload()
        return true
      }
    } catch {
      // 还没起来，继续等
    }
  }
  return false
}

export async function saveSettings(patch) {
  const response = await gatewayFetch('api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || String(response.status))
  return payload
}
