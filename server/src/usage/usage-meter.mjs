import { JsonSnapshotStore } from '../core/json-snapshot-store.mjs'

// 本地用量计费表。
//
// Realtime 的 response.done 带着这一轮的 usage，按 text / audio 分开计数 ——
// 两者单价差五倍左右，所以必须分开算。把它们累起来就是这个应用自己花掉的钱，
// 即时、准确到 token、不需要任何额外凭据。
//
// 它是账单的估算，不是账单本身：价目表要人工跟着官方调整，而且只看得见这个
// 应用的消耗，账号上别处的用量它一无所知。免费额度余额没有任何 API 可查，
// 所以那一项只能按「额度总量减去本地计数」估，并明确标成估算。
//
// 计费口径见 https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio
// 每轮的 input_tokens 会把上下文窗口里的历史重新算一遍，这是官方的计费方式，
// 所以逐轮累加 total_tokens 不是重复计算。

const FILE_VERSION = 1

// 新加坡站单价，USD / 每百万 token。
const PRICES = Object.freeze({
  'qwen3.5-omni-flash-realtime': { textIn: 0.55, audioIn: 4.50, textOut: 3.30, audioOut: 17.70 },
  'qwen3.5-omni-plus-realtime': { textIn: 2.10, audioIn: 16.50, textOut: 12.40, audioOut: 62.00 },
  'qwen-audio-3.0-realtime-plus': { textIn: 0.80, audioIn: 6.40, textOut: 6.40, audioOut: 24.00 },
  'qwen-audio-3.0-realtime-flash': { textIn: 0.45, audioIn: 4.50, textOut: 4.50, audioOut: 15.00 },
})

// 新用户免费额度：每个模型各自一份，输入输出共用一个池子。
const FREE_QUOTA_TOKENS = 1_000_000

const EMPTY = Object.freeze({
  textIn: 0, audioIn: 0, textOut: 0, audioOut: 0, total: 0, turns: 0,
})

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function add(into, delta) {
  return {
    textIn: into.textIn + delta.textIn,
    audioIn: into.audioIn + delta.audioIn,
    textOut: into.textOut + delta.textOut,
    audioOut: into.audioOut + delta.audioOut,
    total: into.total + delta.total,
    turns: into.turns + 1,
  }
}

const int = value => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * Pull the counters out of a response.done event.
 *
 * The block sits at event.response.usage, not event.usage, and the detail keys
 * are input_tokens_details / output_tokens_details -- plural "tokens", unlike
 * OpenAI's singular form. Reading the OpenAI shape here silently yields zeros.
 * Tool-call turns omit audio_tokens entirely, so every field is defaulted.
 */
export function readUsage(event) {
  const usage = event?.response?.usage
  if (!usage) return null
  const inputDetails = usage.input_tokens_details || {}
  const outputDetails = usage.output_tokens_details || {}
  const textIn = int(inputDetails.text_tokens)
  const audioIn = int(inputDetails.audio_tokens)
  const textOut = int(outputDetails.text_tokens)
  const audioOut = int(outputDetails.audio_tokens)
  const total = int(usage.total_tokens)
    || (textIn + audioIn + textOut + audioOut)
  if (!total) return null
  return { textIn, audioIn, textOut, audioOut, total }
}

export function costOf(counters, model) {
  const price = PRICES[model]
  if (!price) return null
  return (
    counters.textIn * price.textIn
    + counters.audioIn * price.audioIn
    + counters.textOut * price.textOut
    + counters.audioOut * price.audioOut
  ) / 1_000_000
}

export class UsageMeter {
  constructor({
    filePath = null,
    store = null,
    now = () => Date.now(),
    onWarning = () => {},
    retentionDays = 90,
  } = {}) {
    this.store = store || (filePath
      ? new JsonSnapshotStore({
          filePath,
          fileVersion: FILE_VERSION,
          label: '用量计费',
          requiredKeys: ['days'],
          now,
          onWarning,
        })
      : null)
    this.now = now
    this.retentionDays = retentionDays
    this.days = new Map()
    this.session = { ...EMPTY }
    this.quotaExhausted = {}
    this.loaded = false
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    const snapshot = this.store?.load()
    for (const [day, models] of Object.entries(snapshot?.days || {})) {
      this.days.set(day, new Map(Object.entries(models)))
    }
    this.quotaExhausted = { ...(snapshot?.quotaExhausted || {}) }
    return this
  }

  // 只保留最近 N 天，免得这份文件无限长下去。
  #prune() {
    if (this.days.size <= this.retentionDays) return
    const keep = [...this.days.keys()].sort().slice(-this.retentionDays)
    const kept = new Set(keep)
    for (const day of [...this.days.keys()]) {
      if (!kept.has(day)) this.days.delete(day)
    }
  }

  #persist() {
    if (!this.store) return
    const days = {}
    for (const [day, models] of this.days) days[day] = Object.fromEntries(models)
    this.store.save({ days, quotaExhausted: this.quotaExhausted })
  }

  record(event, model) {
    this.load()
    const counters = readUsage(event)
    if (!counters || !model) return null
    const day = dayKey(this.now())
    if (!this.days.has(day)) this.days.set(day, new Map())
    const models = this.days.get(day)
    models.set(model, add(models.get(model) || { ...EMPTY }, counters))
    this.session = add(this.session, counters)
    this.#prune()
    this.#persist()
    return counters
  }

  // 额度耗尽是唯一可信的实时信号：开了「仅用免费额度」之后，额度用完时接口
  // 直接返回 403 AllocationQuota.FreeTierOnly。余额本身查不到，这个查得到。
  markQuotaExhausted(model, exhausted = true) {
    this.load()
    if (!model) return
    if (exhausted) this.quotaExhausted[model] = dayKey(this.now())
    else delete this.quotaExhausted[model]
    this.#persist()
  }

  #shape(counters, model) {
    const cost = costOf(counters, model)
    return {
      ...counters,
      ...(cost === null ? { cost: null, priced: false } : { cost, priced: true }),
    }
  }

  snapshot(model) {
    this.load()
    const today = this.days.get(dayKey(this.now())) || new Map()
    const todayForModel = today.get(model) || { ...EMPTY }
    let quotaUsed = 0
    for (const models of this.days.values()) {
      quotaUsed += (models.get(model) || EMPTY).total
    }
    return {
      model,
      currency: 'USD',
      priced: Boolean(PRICES[model]),
      session: this.#shape(this.session, model),
      today: this.#shape(todayForModel, model),
      quota: {
        // 估算：本地只看得见这个应用的消耗，额度是整个账号（含所有 RAM 用户）
        // 共用的，官方也没有可查余额的接口。
        estimate: true,
        grantTokens: FREE_QUOTA_TOKENS,
        usedTokens: quotaUsed,
        remainingTokens: Math.max(0, FREE_QUOTA_TOKENS - quotaUsed),
        exhausted: Boolean(this.quotaExhausted[model]),
        exhaustedOn: this.quotaExhausted[model] || null,
      },
    }
  }
}

export const USAGE_PRICES = PRICES
export const USAGE_FREE_QUOTA_TOKENS = FREE_QUOTA_TOKENS
