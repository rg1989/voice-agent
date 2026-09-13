// Wake chime: a short rising two-tone cue played on the shared AudioContext
// when the wake word is heard. It stays outside the playback tracker, so it
// sends no playback receipts and stopPlayback does not cut it. The microphone
// keeps sending while it plays: the user often speaks straight after the wake
// word, and echo cancellation already removes the page's own output.

export const WAKE_CHIME_TONES = Object.freeze([
  Object.freeze({ frequency: 659.25, offset: 0, duration: 0.13 }), // E5
  Object.freeze({ frequency: 987.77, offset: 0.1, duration: 0.15 }), // B5
])
export const WAKE_CHIME_PEAK_GAIN = 0.12
export const WAKE_CHIME_ATTACK_SECONDS = 0.015
const SILENT_GAIN = 0.0001
const LEAD_SECONDS = 0.02

export function wakeChimeDuration() {
  return Math.max(...WAKE_CHIME_TONES.map(tone => tone.offset + tone.duration))
}

export function wakeChimeSchedule(startTime = 0) {
  return WAKE_CHIME_TONES.map(tone => {
    const start = startTime + tone.offset
    return {
      frequency: tone.frequency,
      start,
      peakAt: start + WAKE_CHIME_ATTACK_SECONDS,
      end: start + tone.duration,
      peak: WAKE_CHIME_PEAK_GAIN,
    }
  })
}

// Returns the seconds until the chime ends, or 0 when nothing was played.
export async function playWakeChime(context) {
  if (!context || context.state === 'closed') return 0
  if (context.state === 'suspended') await context.resume()
  const start = context.currentTime + LEAD_SECONDS
  for (const tone of wakeChimeSchedule(start)) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(tone.frequency, tone.start)
    gain.gain.setValueAtTime(SILENT_GAIN, tone.start)
    gain.gain.linearRampToValueAtTime(tone.peak, tone.peakAt)
    gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, tone.end)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
    oscillator.start(tone.start)
    oscillator.stop(tone.end + 0.01)
  }
  return LEAD_SECONDS + wakeChimeDuration()
}
