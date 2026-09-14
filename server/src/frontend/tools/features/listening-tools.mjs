export const IGNORE_INPUT_TOOL_NAME = 'ignore_input'
export const STOP_LISTENING_TOOL_NAME = 'stop_listening'
// Present while there is a wake word to stop listening for: the WebUI, in
// either listening mode.
export const WAKE_WORD_LISTENING_CAPABILITY = 'listening.wake_word'

const noArguments = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const ignoreInputTool = {
  type: 'function',
  function: {
    name: IGNORE_INPUT_TOOL_NAME,
    description: 'Silently drop the latest user audio. Call it, and say nothing at all, when that audio is background noise, a cut-off fragment, speech not addressed to you (other people, TV, music), or makes no sense. Do not call it for short but meaningful input such as yes, no, thanks, or an answer to your question.',
    parameters: noArguments,
  },
}

const stopListeningTool = {
  type: 'function',
  function: {
    name: STOP_LISTENING_TOOL_NAME,
    description: 'Stop listening until the wake word is heard again. Call it immediately, and say nothing, when the user asks you to stop listening, go quiet, or says they are done, in any wording. A bare “stop” or “wait” only interrupts you: keep listening. Do not use it to cancel background work.',
    parameters: noArguments,
  },
}

// hey_jarvis -> Hey Jarvis, the phrase the user actually says.
function wakeWordPhrase(wakeWord = '') {
  return String(wakeWord || '')
    .split('_')
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

// The model is not told otherwise, so it "corrects" the user ("I'm not Jarvis").
export function wakeWordInstructions(wakeWord) {
  const phrase = wakeWordPhrase(wakeWord)
  return [
    '# Wake word',
    phrase
      ? `The user wakes you by saying “${phrase}”. That phrase is how they address you, not your name and not a request: never correct it or comment on it, just answer what they ask.`
      : 'The user wakes you by saying a wake word. It is how they address you, not your name and not a request: never correct it or comment on it, just answer what they ask.',
  ].join('\n\n')
}

export const IGNORE_INPUT_INSTRUCTIONS = [
  '# Input not meant for you',
  'Not everything the microphone picks up is meant for you. If the latest audio is noise, a fragment, not addressed to you, or makes no sense, call `ignore_input` and say nothing: no reply, no apology, no question.',
].join('\n\n')

export const listeningToolEntries = [
  { definition: ignoreInputTool },
  {
    definition: stopListeningTool,
    policy: {
      requiredCapabilities: [WAKE_WORD_LISTENING_CAPABILITY],
    },
  },
]

// Both tools are silent: the output creates no response, and the response
// that called them is terminal so it never waits for a tool follow-up.
export function silentOutput(runtime, { callId, turnId, callContext, event }, output) {
  runtime.markTerminalToolResponse(callContext?.responseId || event?.response_id)
  return runtime.sendOutput(callId, output, turnId, null, { createResponse: false })
}

export function listeningToolHandlers(runtime) {
  return {
    // Drops only that input: an awake exchange keeps its follow-up window,
    // without extending it.
    [IGNORE_INPUT_TOOL_NAME]: context => {
      runtime.listeningGate?.inputIgnored(context.callContext?.responseId || context.event?.response_id)
      return silentOutput(runtime, context, { status: 'ignored' })
    },
    [STOP_LISTENING_TOOL_NAME]: context => {
      const stopped = runtime.listeningGate?.stopListening(
        context.callContext?.responseId || context.event?.response_id,
      ) === true
      return silentOutput(
        runtime,
        context,
        { status: stopped ? 'stopped_listening' : 'unavailable' },
      )
    },
  }
}
