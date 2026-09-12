import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { fetchFolders } from './settings-api.js'

// 目录选择器：服务端列目录，点进去走。
//
// 浏览器的 <input type="file"> 拿不到真实路径 —— 那是安全限制，不是偷懒。
// Gateway 本来就跑在本机，由它列目录比让人手抄路径好得多。

export default function FolderPicker({
  initialPath,
  disabled = false,
  confirmLabel,
  onPick,
  onCancel,
}) {
  const [listing, setListing] = useState(null)
  const [typed, setTyped] = useState(initialPath || '')
  const [error, setError] = useState('')

  const load = useCallback(async path => {
    setError('')
    try {
      const payload = await fetchFolders(path)
      setListing(payload)
      setTyped(payload.path)
      if (payload.error) setError(payload.error)
    } catch {
      setError(t('读不到这个目录'))
    }
  }, [])

  useEffect(() => { load(initialPath) }, [load, initialPath])

  return <div className="folder-picker">
    <form onSubmit={event => { event.preventDefault(); load(typed) }}>
      <input
        type="text"
        value={typed}
        spellCheck={false}
        disabled={disabled}
        aria-label={t('目录路径')}
        onChange={event => setTyped(event.target.value)}
      />
      <button type="submit" disabled={disabled}>{t('前往')}</button>
    </form>

    {error && <p className="settings-error" role="alert">{error}</p>}

    <div className="folder-list" role="listbox" aria-label={t('子目录')}>
      {listing?.parent && <button
        type="button"
        className="folder-row up"
        disabled={disabled}
        onClick={() => load(listing.parent)}
      >{t('← 返回上一级')}</button>}

      {listing && !listing.entries.length && !listing.error && <p className="settings-hint">
        {t('这里没有子文件夹。')}
      </p>}

      {listing?.entries.map(entry => <button
        key={entry.path}
        type="button"
        className="folder-row"
        disabled={disabled}
        onClick={() => load(entry.path)}
      >{entry.name}</button>)}
    </div>

    <div className="folder-actions">
      <button
        type="button"
        className="primary"
        disabled={disabled || !listing}
        onClick={() => onPick(listing.path)}
      >{confirmLabel || t('用这个文件夹')}</button>
      {onCancel && <button type="button" disabled={disabled} onClick={onCancel}>
        {t('取消')}
      </button>}
    </div>
  </div>
}
