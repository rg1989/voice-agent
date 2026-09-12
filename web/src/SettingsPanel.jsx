import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { gatewayFetch } from './gateway-transport.js'

// 设置面板：选后台 Agent、工作目录和音色。
//
// 这三项都在 Gateway 启动时读入，所以改完要重启。重启由服务端的分离子进程完成，
// 这里只负责等 /api/health 重新应答，然后刷新页面重新握手。
//
// 目录同样是「填一条本机路径」而不是文件选择器：浏览器的 <input type="file">
// 拿不到真实路径，这是安全限制，不是偷懒。

const RESTART_POLL_MS = 500
const RESTART_TIMEOUT_MS = 45000

export default function SettingsPanel({ onClose }) {
  const [settings, setSettings] = useState(null)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const response = await gatewayFetch('api/settings', { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      const payload = await response.json()
      setSettings(payload)
      setFolder(payload.folder || '')
    } catch {
      setError(t('读不到设置'))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Gateway 重启期间 /api/health 会短暂不可达；等它回来再整页刷新，
  // 这样 WebSocket 会带着新的模型和音色重新握手。
  const waitForGateway = useCallback(async () => {
    const deadline = Date.now() + RESTART_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise(done => setTimeout(done, RESTART_POLL_MS))
      try {
        const response = await gatewayFetch('api/health', { cache: 'no-store' })
        if (response.ok) {
          globalThis.location?.reload()
          return
        }
      } catch {
        // 还没起来，继续等
      }
    }
    setRestarting(false)
    setError(t('重启超时，请手动刷新页面'))
  }, [])

  const save = useCallback(async patch => {
    if (busy || restarting) return
    setBusy(true)
    setError('')
    try {
      const response = await gatewayFetch('api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || String(response.status))
      if (payload.restarting) {
        setRestarting(true)
        waitForGateway()
      } else {
        await refresh()
      }
    } catch (caught) {
      setError(caught.message || t('保存失败'))
    } finally {
      setBusy(false)
    }
  }, [busy, restarting, refresh, waitForGateway])

  const disabled = busy || restarting || !settings

  return <aside className="settings-panel" aria-label={t('设置')}>
    <header>
      <b>{t('设置')}</b>
      {onClose && <button type="button" onClick={onClose} aria-label={t('关闭')}>×</button>}
    </header>

    {restarting && <p className="settings-notice" role="status">
      {t('正在重启 Gateway，稍后自动刷新…')}
    </p>}
    {error && <p className="settings-error" role="alert">{error}</p>}

    {!settings
      ? <p className="settings-hint">{t('正在读取设置…')}</p>
      : <>
        <section className="settings-group">
          <h4>{t('大脑')}</h4>
          <p className="settings-hint">{t('谁来做真正的活儿。各自沿用自己的模型和登录。')}</p>
          <div className="settings-options">
            {settings.brains.map(option => <button
              key={option.id}
              type="button"
              className={`settings-option${settings.brain === option.id ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => save({ brain: option.id })}
            >
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </button>)}
          </div>
        </section>

        <section className="settings-group">
          <h4>{t('工作目录')}</h4>
          <p className="settings-hint">{t('后台 Agent 在哪个文件夹里干活。留空则用默认的暂存目录。')}</p>
          <form onSubmit={event => { event.preventDefault(); save({ folder }) }}>
            <input
              type="text"
              value={folder}
              spellCheck={false}
              disabled={disabled}
              placeholder={t('粘贴本机文件夹路径，例如 ~/Documents/Projects/my-app')}
              onChange={event => setFolder(event.target.value)}
            />
            <button type="submit" disabled={disabled || folder === (settings.folder || '')}>
              {t('应用')}
            </button>
          </form>
        </section>

        <section className="settings-group">
          <h4>{t('音色')}</h4>
          <p className="settings-hint">{t('助手说话的嗓音。英语默认用 Aiden 或 Jennifer。')}</p>
          <div className="settings-options">
            {settings.voices.map(option => <button
              key={option.id}
              type="button"
              className={`settings-option${settings.voice === option.id ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => save({ voice: option.id })}
            >
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </button>)}
          </div>
        </section>

        <p className="settings-hint settings-footnote">
          {t('改动会重启 Gateway，正在进行的任务会中断。')}
        </p>
      </>}
  </aside>
}
