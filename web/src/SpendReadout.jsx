import { useEffect, useState } from 'react'
import { t } from './i18n.js'
import { gatewayFetch } from './gateway-transport.js'

// 花了多少钱，就在 header 上。
//
// 数字来自 Realtime 每轮回传的 token 用量，本地按单价算出来 —— 即时、精确到
// token、不需要任何额外凭据，但它是账单的估算而非账单本身。免费额度余额没有
// 接口可查，所以那一项是「额度总量减本地计数」，只作参考。

const POLL_MS = 10_000

function money(value) {
  if (typeof value !== 'number') return null
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export default function SpendReadout() {
  const [usage, setUsage] = useState(null)

  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const response = await gatewayFetch('api/usage', { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json()
        if (live) setUsage(payload)
      } catch {
        // 读不到就先不显示，下一次轮询再说
      }
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [])

  if (!usage?.priced) return null
  // Today, not this session: the session counter restarts with the Gateway,
  // and a figure that silently resets is worse than no figure. The session
  // total is in the tooltip for anyone who wants it.
  const spend = money(usage.today?.cost)
  if (spend === null) return null

  const quota = usage.quota || {}
  const remaining = Math.max(0, Number(quota.remainingTokens) || 0)
  const share = quota.grantTokens ? remaining / quota.grantTokens : 0

  return <div
    className={`spend${quota.exhausted ? ' exhausted' : ''}`}
    title={[
      t('这一场：{tokens} tokens，约 {cost}', {
        tokens: usage.session?.total ?? 0,
        cost: spend,
      }),
      t('今天：{tokens} tokens，约 {cost}', {
        tokens: usage.today?.total ?? 0,
        cost: money(usage.today?.cost) || '$0.00',
      }),
      quota.exhausted
        ? t('免费额度已用完（服务商已拒绝请求）')
        : t('免费额度剩余约 {remaining}（估算，官方没有可查询的接口）', {
          remaining: remaining.toLocaleString(),
        }),
    ].join('\n')}
  >
    <b>{spend}</b>
    <small>{quota.exhausted
      ? t('额度已用完')
      : t('额度 {percent}%', { percent: Math.round(share * 100) })}</small>
  </div>
}
