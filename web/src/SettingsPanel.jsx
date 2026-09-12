import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'
import FolderPicker from './FolderPicker.jsx'
import {
  fetchSettings,
  saveSettings,
  waitForGatewayThenReload,
} from './settings-api.js'

// 设置面板：选后台 Agent、工作目录和音色。
//
// 这三项都在 Gateway 启动时读入，所以改完要重启。重启由服务端的分离子进程完成，
// 这里只负责等 /api/health 重新应答，然后刷新页面重新握手。
//
// 目录用服务端列目录 + 点击进入的方式选：浏览器的 <input type="file"> 拿不到
// 真实路径，那是安全限制。Gateway 本来就跑在本机，列目录比让人手抄路径好得多。

export default function SettingsPanel({ onClose }) {
  const [settings, setSettings] = useState(null)
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setSettings(await fetchSettings())
    } catch {
      setError(t('读不到设置'))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const save = useCallback(async patch => {
    if (busy || restarting) return
    setBusy(true)
    setError('')
    try {
      const payload = await saveSettings(patch)
      if (payload.restarting) {
        setRestarting(true)
        const ok = await waitForGatewayThenReload()
        if (!ok) {
          setRestarting(false)
          setError(t('重启超时，请手动刷新页面'))
        }
      } else {
        await refresh()
      }
    } catch (caught) {
      setError(caught.message || t('保存失败'))
    } finally {
      setBusy(false)
    }
  }, [busy, restarting, refresh])

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
          <p className="settings-hint">{t('后台 Agent 在哪个文件夹里干活，也就是它看得到的上下文。')}</p>
          {browsing
            ? <FolderPicker
              initialPath={settings.folder}
              disabled={disabled}
              onCancel={() => setBrowsing(false)}
              onPick={path => { setBrowsing(false); save({ folder: path }) }}
            />
            : <div className="folder-current">
              <code>{settings.folder || t('默认暂存目录')}</code>
              <button type="button" disabled={disabled} onClick={() => setBrowsing(true)}>
                {t('选择文件夹')}
              </button>
            </div>}
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
