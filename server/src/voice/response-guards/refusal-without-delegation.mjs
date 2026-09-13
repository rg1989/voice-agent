// The voice model tends to disclaim ("I don't have real-time data", "我无法查询")
// instead of handing the request to the backend, which can actually look it up
// or do it. Only a turn without any tool call qualifies: relaying a tool or
// backend outcome such as "that failed" is not giving up. Patterns stay
// first-person capability disclaimers so advice, chit-chat and clarifying
// questions ("I can't open it without the name") never trigger a correction.
const REFUSAL_PATTERNS = Object.freeze([
  /\bI(?:'m|\s+am)?\s+(?:really\s+|currently\s+)?(?:can't|cannot|can not|unable to|not able to|have no way to)\s+(?:\w+\s+)?(?:see|view|read|watch|hear|browse|search|check|access|open|look|find|get|retrieve|provide|reach|tell|remember)\b(?![^.?!]*\bwithout\b)/i,
  /\bI\s+(?:do not|don't)\s+have\s+(?:any\s+)?(?:access|(?:(?:that|this|the|real[-\s]?time|current|live|up[-\s]to[-\s]date|latest)\s+)+(?:\w+\s+)?(?:information|info|data|details|results|prices?|news))\b/i,
  /\bI\s+have\s+no\s+(?:access|real[-\s]?time|live)\b/i,
  /\bI\s+(?:really\s+)?(?:do not|don't)\s+know\s+(?:what|who|where|when|which|whether|if|how much|how many|your|her|his|their)\b(?!\s+you\s+mean)/i,
  /\bnot\s+something\s+I(?:'m|\s+am)?\s+(?:able|can)\b/i,
  /(?:无法|不能|没办法)(?:直接|实时)?(?:获取|查询|查看|访问|提供|联网|浏览|打开|搜索|看到|读取)/,
  /我(?:目前|暂时|现在)?(?:做不到|查不到|看不到|看不见|听不到|不知道(?:您|你)的)/,
  /没有(?:实时|最新|联网|权限|访问|(?:这方面的?|相关的?)(?:信息|资料|数据))/,
  /(?:您|你)(?:可以|最好|不妨)?自己(?:去)?(?:查询|查一下|搜索|搜一下|上网)/,
  /建议(?:您|你)?(?:自己)?(?:去)?(?:上网)?(?:查询|查一下|搜索)/,
])

export function containsRefusal(content) {
  const text = String(content || '').replace(/[‘’]/g, "'")
  return REFUSAL_PATTERNS.some(pattern => pattern.test(text))
}

export const refusalWithoutDelegationGuard = Object.freeze({
  id: 'refusal-without-delegation',
  // DashScope treats per-response instructions as a replacement prompt without
  // native tool calling: the model then writes the call out as text. This
  // correction must produce a real call, so it goes into the conversation.
  asUserContext: true,
  instructions: [
    '你刚才没有尝试就放弃了：说了不知道、无法访问、没有实时数据、做不到，或让用户自己去查。后台能够去查、去做，应当先交给它尝试。',
    '现在直接发起 spawn_thinking 函数调用，不要改用其他工具，objective 忠实转达用户本轮的原始请求；调用前不要输出任何文字，不要把调用写成文本或标签，也不要道歉或解释刚才的回答。工具返回后只自然确认一次。',
  ].join(' '),
  matches({
    origin = 'model',
    failed = false,
    suppressed = false,
    hasFunctionCall = false,
    turnHasFunctionCall = false,
    delegationAvailable = true,
    transcript = '',
  } = {}) {
    if (origin !== 'model' || failed || suppressed || !delegationAvailable) return false
    if (hasFunctionCall || turnHasFunctionCall) return false
    return containsRefusal(transcript)
  },
})
