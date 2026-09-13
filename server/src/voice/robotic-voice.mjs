// Robotic finish for the assistant's voice, applied to the PCM16 audio the
// gateway relays. It keeps state between chunks, so any chunking gives the same
// result, and every chunk keeps its length because playback tracking counts
// samples. It mirrors the ffmpeg chain the voice samples were made with:
//   asetrate=24000*1.05,aresample=24000,atempo=1/1.05   pitch up 5%, same tempo
//   aecho=0.8:0.5:14:0.3                                short metallic echo
//   flanger=delay=2:depth=2:speed=0.25                   slow sweep
//   highpass=f=160,lowpass=f=7500                        thinner band

// Past samples; read(0) is the newest, with linear interpolation between samples.
function history(length) {
  const buffer = new Float64Array(length)
  let next = 0
  const at = index => buffer[((index % length) + length) % length]
  return {
    push(sample) {
      buffer[next] = sample
      next = (next + 1) % length
    },
    read(delay) {
      const position = next - 1 - delay
      const base = Math.floor(position)
      const fraction = position - base
      return at(base) * (1 - fraction) + at(base + 1) * fraction
    },
  }
}

// Delay-line pitch shifter: two taps half a window apart sweep through a short
// delay faster than real time and crossfade, so the wrap of each tap is silent.
function pitchShifter(ratio, sampleRate) {
  const window = Math.round(0.03 * sampleRate)
  const past = history(window + 2)
  const gain = delay => Math.sin(Math.PI * delay / window) ** 2
  let delay = window / 2
  return sample => {
    past.push(sample)
    delay -= ratio - 1
    if (delay < 0) delay += window
    const other = (delay + window / 2) % window
    return past.read(delay) * gain(delay) + past.read(other) * gain(other)
  }
}

function echo(sampleRate, { inGain = 0.8, outGain = 0.5, delayMs = 14, decay = 0.3 } = {}) {
  const delay = Math.round(delayMs * sampleRate / 1000)
  const past = history(delay + 1)
  return sample => {
    past.push(sample)
    return outGain * (inGain * sample + decay * past.read(delay))
  }
}

function flanger(sampleRate, { delayMs = 2, depthMs = 2, speedHz = 0.25, width = 0.71 } = {}) {
  const past = history(Math.ceil((delayMs + depthMs) * sampleRate / 1000) + 2)
  const step = 2 * Math.PI * speedHz / sampleRate
  let phase = 0
  return sample => {
    past.push(sample)
    const delayed = past.read((delayMs + depthMs * (0.5 + 0.5 * Math.sin(phase))) * sampleRate / 1000)
    phase = (phase + step) % (2 * Math.PI)
    return (sample + width * delayed) / (1 + width)
  }
}

// RBJ cookbook biquad, Q = 1/sqrt(2).
function biquad(type, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) * Math.SQRT1_2
  const b = type === 'lowpass'
    ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
    : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  return x => {
    const y = (b[0] * x + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}

export function createRoboticVoice({ sampleRate = 24000 } = {}) {
  let stages
  const reset = () => {
    stages = [
      pitchShifter(1.05, sampleRate),
      echo(sampleRate),
      flanger(sampleRate),
      biquad('highpass', 160, sampleRate),
      biquad('lowpass', 7500, sampleRate),
    ]
  }
  reset()

  const process = samples => {
    const output = new Int16Array(samples.length)
    for (let index = 0; index < samples.length; index += 1) {
      let value = samples[index]
      for (const stage of stages) value = stage(value)
      output[index] = Math.max(-32768, Math.min(32767, Math.round(value)))
    }
    return output
  }

  return {
    reset,
    process,
    // Base64 PCM16LE in, base64 of the same byte length out.
    processBase64(audio) {
      const bytes = Buffer.from(String(audio || ''), 'base64')
      const count = bytes.length >> 1
      const input = new Int16Array(count)
      for (let index = 0; index < count; index += 1) input[index] = bytes.readInt16LE(index * 2)
      const output = process(input)
      const result = Buffer.alloc(bytes.length)
      for (let index = 0; index < count; index += 1) result.writeInt16LE(output[index], index * 2)
      // ponytail: an odd trailing byte passes through; providers send whole samples.
      if (bytes.length & 1) result[bytes.length - 1] = bytes[bytes.length - 1]
      return result.toString('base64')
    },
  }
}
