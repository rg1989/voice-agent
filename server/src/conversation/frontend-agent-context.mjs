import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from '../core/config.mjs'
import { recentConversationMessages } from '../../../shared/conversation-history.mjs'

const PROMPT_FILE = 'PROMPT.md'
const ASSISTANT_FILE = 'ASSISTANT.md'
const MAX_PROMPT_CHARS = 16000
const MAX_ASSISTANT_CHARS = 4000
const MAX_RECENT_CHARS = 3500

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

// 浏览器客户端没有文件系统概念，发不出工作目录，于是 <runtime_context> 里没有
// client_working_directory —— PROMPT.md 明确要求这一字段缺失时不要猜测，所以前台
// 会回答「我看不到当前目录」，哪怕 header 上正显示着它。后台 Agent 实际就在这个
// 目录里干活，客户端没给时由服务端补上。
function backendWorkspace() {
  return config.backends?.[config.agentProtocol]?.directory || ''
}

export function normalizeClientContext({
  timeZone,
  locale,
  workingDirectory,
} = {}) {
  let safeTimeZone = clean(timeZone)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone }).format()
  } catch {
    safeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  let safeLocale = clean(locale).slice(0, 35) || 'zh-CN'
  try {
    new Intl.DateTimeFormat(safeLocale).format()
  } catch {
    safeLocale = 'zh-CN'
  }
  const safeWorkingDirectory = String(workingDirectory || backendWorkspace())
    .replaceAll('\0', '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1024)
  return {
    timeZone: safeTimeZone,
    locale: safeLocale,
    workingDirectory: safeWorkingDirectory || null,
  }
}

export function currentTimeSnapshot({
  timeZone,
  locale,
  now = new Date(),
} = {}) {
  const context = normalizeClientContext({ timeZone, locale })
  return {
    iso_utc: now.toISOString(),
    local_time: new Intl.DateTimeFormat(context.locale, {
      timeZone: context.timeZone,
      dateStyle: 'full',
      timeStyle: 'long',
      hour12: false,
    }).format(now),
    time_zone: context.timeZone,
    locale: context.locale,
  }
}

export function loadFrontendPrompt() {
  const content = readFileSync(
    resolve(config.frontendPromptDir, PROMPT_FILE),
    'utf8',
  ).trim()
  if (!content) throw new Error(`${PROMPT_FILE} must not be empty`)
  return [...content].slice(0, MAX_PROMPT_CHARS).join('')
}

export function loadAssistantProfile() {
  const content = readFileSync(
    config.assistantProfilePath || resolve(config.frontendPromptDir, ASSISTANT_FILE),
    'utf8',
  ).trim()
  if (!content) throw new Error(`${ASSISTANT_FILE} must not be empty`)
  return [...content].slice(0, MAX_ASSISTANT_CHARS).join('')
}

export function resolveAssistantProfile(agentContext = {}) {
  // A trusted host may select a complete profile for one live Session. Client
  // payloads never enter this field directly; the packaged/local file remains
  // the deployment-wide fallback.
  const sessionProfile = String(agentContext.assistantProfile || '').trim()
  if (!sessionProfile) return loadAssistantProfile()
  return [...sessionProfile].slice(0, MAX_ASSISTANT_CHARS).join('')
}

export function buildRecentConversationContext(messages = []) {
  const candidates = recentConversationMessages(messages)
  const selected = []
  let used = 0
  for (const message of candidates.toReversed()) {
    const content = clean(message.content)
    if (!content) continue
    const inputSummary = (message.inputs || []).map(input => [
      clean(input.ref),
      clean(input.label || input.filename || input.type),
      clean(input.filename),
      clean(input.mime),
    ].filter(Boolean).join(' · ')).filter(Boolean).join('；')
    const base = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    const line = inputSummary
      ? `${base}（可引用输入：${inputSummary}）`
      : base
    if (selected.length && used + line.length > MAX_RECENT_CHARS) break
    selected.unshift(line)
    used += line.length
  }
  if (!selected.length) return ''
  return [
    '<recent_conversation>',
    ...selected,
    '</recent_conversation>',
  ].join('\n')
}

export function buildFrontendContext({
  client = {},
} = {}) {
  const normalizedClient = normalizeClientContext(client)
  const runtimeContext = [
    '<runtime_context>',
    'channel=full_duplex_voice',
    `time_zone=${JSON.stringify(normalizedClient.timeZone)}`,
    `locale=${JSON.stringify(normalizedClient.locale)}`,
    ...(normalizedClient.workingDirectory
      ? [`client_working_directory=${JSON.stringify(normalizedClient.workingDirectory)}`]
      : []),
    '</runtime_context>',
  ].join('\n')
  return runtimeContext
}
