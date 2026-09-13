import { t } from './i18n.js'

const decisions = [
  { value: 'task', label: '允许此任务', title: '允许此任务及后续操作，任务结束后失效' },
  { value: 'always', label: '始终允许', title: '本会话后续权限请求自动允许' },
  { value: 'reject', label: '拒绝', title: '拒绝当前操作' },
]

export default function PermissionActions({ authorization, onRespond }) {
  // 电脑控制没有「始终允许」；允许的范围（整个任务还是只这一步）由设置决定，
  // 卡片上的说明已经写明，按钮就不能再说「允许此任务」。
  const available = authorization.category === 'computer_use'
    ? [{ value: 'task', label: '允许', title: '按上面说明的范围允许电脑控制' },
      decisions.find(({ value }) => value === 'reject')]
    : decisions
  return <div className="permission-controls" aria-busy={Boolean(authorization.submitting)}>
    <div className="permission-actions" role="group" aria-label={t('权限决定')}>
      {available.map(({ value, label, title }) => <button
        key={value}
        type="button"
        className={`permission-${value}`}
        title={t(title)}
        aria-label={`${t(label)}：${t(title)}`}
        disabled={authorization.submitting}
        onClick={() => onRespond(value)}
      >{t(label)}</button>)}
    </div>
    {authorization.submitting && <small role="status">{t('正在提交')}</small>}
    {authorization.error && <small className="permission-error" role="alert">
      {authorization.error}
    </small>}
  </div>
}
