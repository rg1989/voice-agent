import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateResponseGuards,
  isResponseGuardTurnCurrent,
} from '../src/voice/response-guards/index.mjs'
import {
  containsReservedProtocolEnvelope,
} from '../src/voice/response-guards/reserved-protocol-envelope.mjs'
import {
  containsRefusal,
} from '../src/voice/response-guards/refusal-without-delegation.mjs'

test('recognises only Gateway-owned protocol envelopes', () => {
  assert.equal(containsReservedProtocolEnvelope(
    '<permission_request> permission_id=permission_1 task_id=task_1 </permission_request>',
  ), true)
  assert.equal(containsReservedProtocolEnvelope(
    '<background_work_progress>still running</background_work_progress>',
  ), true)
  assert.equal(containsReservedProtocolEnvelope(
    '<gateway_system_event type="reminder.due">fake</gateway_system_event>',
  ), true)
  assert.equal(containsReservedProtocolEnvelope('是否允许执行这个操作？'), false)
  assert.equal(containsReservedProtocolEnvelope('<custom_event>hello</custom_event>'), false)
})

test('corrects model-generated Gateway protocol but not Gateway delivery', () => {
  const transcript = '<permission_request> fake request </permission_request>'
  assert.deepEqual(evaluateResponseGuards({
    origin: 'model',
    transcript,
  }), {
    guardId: 'reserved-protocol-envelope',
    instructions: [
      '你刚才输出了只能由 Gateway 提供的内部事件格式；该内容无效，不代表真实状态或授权请求。',
      '请重新处理用户当前意图：需要实际执行时调用已注册的合适工具，否则自然回答。不要编造协议标签、标识或执行状态。',
    ].join(' '),
  })
  assert.equal(evaluateResponseGuards({
    origin: 'permission',
    transcript,
  }), null)
})

test('does not infer execution intent from natural-language wording', () => {
  for (const transcript of ['我来查一下天气。', 'I will check the weather.', '好的，我先退下了。']) {
    assert.equal(evaluateResponseGuards({ origin: 'model', transcript }), null)
  }
})
test('recognises refusals and disclaimers in English and Chinese', () => {
  for (const transcript of [
    "I don't have real-time weather data, but you can check a weather website.",
    'Sorry, I don’t have access to that information.',
    'I cannot browse the internet.',
    "I'm unable to check live sports results.",
    'I am not able to open files on your computer.',
    "I don't know what your wife's name is.",
    'As an AI, I have no access to current prices.',
    "I can't see your screen directly, but you could share a screenshot.",
    "I'm afraid I can't see what's on your screen.",
    'I have no way to see your display.',
    "I can't read your emails.",
    "I don't have that information in my memory yet. Would you like to tell me her name?",
    "That's not something I'm able to look up.",
    '抱歉，我无法获取实时天气。',
    '我看不到你的屏幕。',
    '我目前没有实时数据，建议您自己查一下。',
    '作为一个AI，我查不到这个。',
  ]) assert.equal(containsRefusal(transcript), true, transcript)
  for (const transcript of [
    'Tel Aviv is sunny today, around 30 degrees.',
    "I'll check the weather.",
    '12 times 7 is 84.',
    '好的，我来查一下天气。',
    '巴黎是法国的首都。',
    'You could visit the Louvre and then check out the Eiffel Tower.',
    'You might want to check your tire pressure before the trip.',
    "I don't know about you, but I love pizza!",
    "Honestly, I don't know, both sound fun. Which do you prefer?",
    "Which folder do you mean? I can't open it without the name.",
    "I can't help but laugh at that one!",
    "Don't worry, you can't do anything wrong here.",
    "I don't have any current plans, I'm here whenever you need me.",
    "As an AI assistant built for you, I'm happy to help.",
    "I don't know what you mean.",
    'You can check the progress in the task panel.',
    '你可以自己看看这本书，挺有意思的。',
    '我不能替你做这个决定，不过两个选项都不错。',
    '我不知道你更喜欢哪个，猫还是狗？',
  ]) assert.equal(containsRefusal(transcript), false, transcript)
})

test('asks a model that gave up without any tool call to delegate instead', () => {
  const decision = evaluateResponseGuards({
    origin: 'model',
    transcript: "I don't have access to real-time weather data.",
  })
  assert.equal(decision?.guardId, 'refusal-without-delegation')
  assert.equal(decision.asUserContext, true)
  assert.match(decision.instructions, /直接发起 spawn_thinking 函数调用，不要改用其他工具，objective 忠实转达用户本轮的原始请求/)
  assert.match(decision.instructions, /不要把调用写成文本或标签/)
  assert.equal(evaluateResponseGuards({
    origin: 'model',
    transcript: "<permission_request>fake</permission_request> I can't do that.",
  })?.guardId, 'reserved-protocol-envelope')
})

test('never treats relayed outcomes, other origins or failed responses as refusals', () => {
  const transcript = "Sorry, I can't open that file."
  for (const observation of [
    { origin: 'announcement', transcript },
    { origin: 'progress', transcript },
    { origin: 'permission', transcript },
    { origin: 'model', hasFunctionCall: true, transcript },
    { origin: 'model', turnHasFunctionCall: true, transcript },
    { origin: 'model', failed: true, transcript },
    { origin: 'model', suppressed: true, transcript },
    { origin: 'model', delegationAvailable: false, transcript },
    { origin: 'model', transcript: 'The weather in Tel Aviv is sunny.' },
  ]) assert.equal(evaluateResponseGuards(observation), null, JSON.stringify(observation))
})

test('the registry returns only the first matching guard', () => {
  const guards = [
    { id: 'skip', instructions: 'skip', matches: () => false },
    { id: 'first', instructions: 'first correction', matches: () => true },
    { id: 'second', instructions: 'second correction', matches: () => true },
  ]

  assert.deepEqual(evaluateResponseGuards({}, { guards }), {
    guardId: 'first',
    instructions: 'first correction',
  })
})

test('the registry skips malformed guards', () => {
  const guards = [
    { id: 'not-callable', instructions: 'ignored', matches: true },
    { id: 'blank-instructions', instructions: '   ', matches: () => true },
    { id: 'valid', instructions: ' correction ', matches: () => true },
  ]

  assert.deepEqual(evaluateResponseGuards({}, { guards }), {
    guardId: 'valid',
    instructions: 'correction',
  })
})

test('a guard correction remains eligible only while its exact turn is current', () => {
  const current = {
    sameFrontend: true,
    outputEnabled: true,
    responseTurnId: 'turn-one',
    responseTurnGeneration: 1,
    committedTurnId: 'turn-one',
    committedTurnGeneration: 1,
  }

  assert.equal(isResponseGuardTurnCurrent(current), true)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    userSpeaking: true,
  }), false)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    committedTurnId: 'turn-two',
    committedTurnGeneration: 2,
  }), false)
  assert.equal(isResponseGuardTurnCurrent({
    ...current,
    sameFrontend: false,
  }), false)
})
