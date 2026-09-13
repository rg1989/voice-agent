import assert from 'node:assert/strict'
import test from 'node:test'

// 单独一个文件：core/config 在 import 时就把环境变量固定下来了。

process.env.QWEN_AUDIO_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
process.env.QWEN_AUDIO_TURN_THRESHOLD = '0.6'
process.env.QWEN_AUDIO_TURN_SILENCE_MS = '1400'

const { dashscopeProvider, tunedTurnDetection } = await import(
  '../src/voice/providers/dashscope.mjs'
)

function turnDetection() {
  return dashscopeProvider.buildSession({
    configured: false,
    agentContext: {},
    sessionOptions: {},
  }).turn_detection
}

test('设置里调过的断句参数会随 session 一起发给服务商', () => {
  assert.deepEqual(turnDetection(), {
    type: 'semantic_vad',
    threshold: 0.6,
    silence_duration_ms: 1400,
  })
})

test('没配置的字段不加进去，保留模型自己的默认行为', () => {
  // 只有显式配置过的字段才覆盖：给不认识这两个字段的模型族发多余参数没有好处。
  const defaults = { type: 'smart_turn' }
  assert.deepEqual(
    tunedTurnDetection(defaults, { turnDetectionThreshold: null, turnDetectionSilenceMs: null }),
    { type: 'smart_turn' },
  )
  assert.deepEqual(
    tunedTurnDetection(defaults, { turnDetectionThreshold: null, turnDetectionSilenceMs: 1400 }),
    { type: 'smart_turn', silence_duration_ms: 1400 },
  )
})
