import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import FolderPicker from './FolderPicker.jsx'
import { fetchSettings, saveSettings, waitForGatewayThenReload } from './settings-api.js'

// Header 正中的工作区指示器。
//
// 后台 Agent 在哪个文件夹里干活是随时都要一眼看见的事 —— 对着错的项目说话，
// 代价比任何其他设置都大。所以它不藏在设置里，而是常驻 header，点开就能换。

function basename(path) {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || '/'
}

export default function WorkspaceSwitcher() {
  const [folder, setFolder] = useState(null)
  const [open, setOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef(null)

  useEffect(() => {
    let live = true
    fetchSettings()
      .then(settings => { if (live) setFolder(settings.folder || '') })
      .catch(() => { if (live) setFolder('') })
    return () => { live = false }
  }, [])

  // 点面板外面或按 Esc 收起，和别的下拉一致
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = useCallback(async path => {
    if (applying) return
    setApplying(true)
    setError('')
    try {
      const payload = await saveSettings({ folder: path })
      if (payload.restarting) {
        const ok = await waitForGatewayThenReload()
        if (!ok) {
          setApplying(false)
          setError(t('重启超时，请手动刷新页面'))
        }
        return
      }
      setFolder(payload.settings?.folder || path)
      setOpen(false)
      setApplying(false)
    } catch (caught) {
      setError(caught.message || t('保存失败'))
      setApplying(false)
    }
  }, [applying])

  if (folder === null) return null

  const name = basename(folder)
  const label = name || t('默认暂存目录')

  return <div className="workspace-switch" ref={rootRef}>
    <button
      type="button"
      className={`workspace-chip${open ? ' open' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={folder || t('默认暂存目录')}
      onClick={() => setOpen(value => !value)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M1.75 3.5h4l1.4 1.6h7.1a.75.75 0 0 1 .75.75v6.65a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75V4.25a.75.75 0 0 1 .75-.75Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      <span className="workspace-name">{label}</span>
      <span className="workspace-caret" aria-hidden="true">▾</span>
    </button>

    {open && <div className="workspace-dropdown" role="dialog" aria-label={t('工作目录')}>
      <div className="workspace-dropdown-head">
        <b>{t('工作目录')}</b>
        <small>{folder || t('默认暂存目录')}</small>
      </div>
      {applying
        ? <p className="settings-notice" role="status">
          {t('正在重启 Gateway，稍后自动刷新…')}
        </p>
        : <>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <FolderPicker
            initialPath={folder}
            confirmLabel={t('在这里工作')}
            onPick={pick}
            onCancel={() => setOpen(false)}
          />
        </>}
    </div>}
  </div>
}
