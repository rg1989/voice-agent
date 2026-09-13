import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { gatewayFetch } from './gateway-transport.js'

// 历史会话选择器。
//
// 会话本来就一条条写在 Gateway 的 Session Journal 里，这里只是把它们列出来 ——
// 不另存一份会话清单，也就没有会和日志对不上的第二份真相。标题就是用户说的
// 第一句话。

function formatWhen(value) {
  const time = Date.parse(value || '')
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleString(navigator.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export default function SessionHistory({ currentSessionId, onOpen, onDeleted, onClose }) {
  const [sessions, setSessions] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  // 删除不可恢复：第一下只把按钮变成「确认删除」，第二下才真删。
  const [confirming, setConfirming] = useState('')

  const refresh = useCallback(async () => {
    try {
      const response = await gatewayFetch('api/sessions', { cache: 'no-store' })
      if (!response.ok) throw new Error(String(response.status))
      const payload = await response.json()
      setSessions(payload.sessions || [])
    } catch {
      setSessions([])
      setError(t('读不到会话历史'))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const remove = useCallback(async sessionId => {
    if (busy) return
    if (confirming !== sessionId) {
      setConfirming(sessionId)
      return
    }
    setConfirming('')
    setBusy(sessionId)
    setError('')
    try {
      const response = await gatewayFetch(`api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error(String(response.status))
      setSessions(items => (items || []).filter(item => item.sessionId !== sessionId))
      // 删掉的正是当前这一场时，界面上还留着它的消息，下一句话又会用同一个 id
      // 重新建出日志来。交给上层换一场新的。
      if (sessionId === currentSessionId) onDeleted?.(sessionId)
    } catch {
      setError(t('删除失败'))
    } finally {
      setBusy('')
    }
  }, [busy, confirming, currentSessionId, onDeleted])

  // 盖在界面上面的浮层：打开它不能挪动对话区里的任何东西。外观沿用设置面板。
  return <div
    className="session-history-backdrop"
    role="presentation"
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
  ><aside
    className="settings-panel session-history"
    role="dialog"
    aria-modal="true"
    aria-label={t('会话历史')}
  >
    <header>
      <b>{t('会话历史')}</b>
      <button type="button" className="header-action" onClick={onClose} aria-label={t('关闭')} title={t('关闭')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button>
    </header>

    {error && <p className="settings-error" role="alert">{error}</p>}

    {sessions === null && <p className="settings-hint">{t('正在读取会话历史…')}</p>}
    {sessions?.length === 0 && !error && <p className="settings-hint">
      {t('还没有别的会话。')}
    </p>}

    {sessions?.length > 0 && <ul className="session-history-list">
      {sessions.map(session => {
        const current = session.sessionId === currentSessionId
        const armed = confirming === session.sessionId
        return <li key={session.sessionId} className={current ? 'current' : ''}>
          <button
            type="button"
            className="session-open"
            disabled={Boolean(busy)}
            aria-current={current || undefined}
            onClick={() => onOpen(session.sessionId)}
          >
            <b>{session.title || t('无标题会话')}</b>
            <small>
              {formatWhen(session.updatedAt)}
              {' · '}
              {session.messages === 1
                ? t('1 条消息')
                : t('{count} 条消息', { count: session.messages })}
              {current ? ` · ${t('当前')}` : ''}
            </small>
          </button>
          <button
            type="button"
            className={`session-delete${armed ? ' confirming' : ''}`}
            disabled={Boolean(busy)}
            aria-label={armed ? t('确认删除') : t('删除这个会话')}
            title={armed ? t('确认删除') : t('删除这个会话')}
            onClick={() => remove(session.sessionId)}
            onBlur={() => { if (armed) setConfirming('') }}
          >
            {armed
              ? t('确认删除')
              : <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12" />
              </svg>}
          </button>
        </li>
      })}
    </ul>}
  </aside></div>
}
