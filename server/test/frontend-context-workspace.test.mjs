import assert from 'node:assert/strict'
import test from 'node:test'

// 单独一个文件：core/config 在 import 时就把环境变量读成了常量，所以得先设好
// 后台和工作目录，再动态 import 用到它的模块。和别的用例同处一个文件的话，
// 那边的静态 import 已经先把 config 定下来了。

process.env.AGENT_PROTOCOL = 'acp'
process.env.ACP_COMMAND = '/bin/false'
process.env.QWAUDIO_WORKSPACE = '/tmp/qwaudio-test-workspace'

const { buildFrontendContext, normalizeClientContext } = await import(
  '../src/conversation/frontend-agent-context.mjs'
)

test('客户端没给工作目录时，回落到后台 Agent 的实际工作目录', () => {
  // 浏览器没有文件系统，发不出这个字段；PROMPT.md 又要求它缺失时不要猜，
  // 于是前台会说「我看不到当前目录」，哪怕 header 上正显示着它。
  const context = buildFrontendContext({ client: { timeZone: 'UTC', locale: 'en-US' } })
  // Windows 上工作目录会解析成带盘符的路径（D:\tmp\...）。
  assert.match(context, /client_working_directory="(?:[A-Za-z]:)?[\\/]+tmp[\\/]+qwaudio-test-workspace"/)
})

test('客户端自己给了工作目录时以它为准', () => {
  const normalized = normalizeClientContext({
    timeZone: 'UTC',
    locale: 'en-US',
    workingDirectory: '/tmp/from-the-client',
  })
  assert.equal(normalized.workingDirectory, '/tmp/from-the-client')
})
