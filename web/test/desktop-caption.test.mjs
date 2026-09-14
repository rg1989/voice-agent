import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_CAPTION_FADE_MS,
  DESKTOP_CAPTION_HIDDEN,
  DESKTOP_CAPTION_LINGER_MS,
  desktopCaption,
  desktopCaptionDelay,
  desktopCaptionStatus,
  expireDesktopCaption,
  nextDesktopCaption,
} from '../src/desktop/desktop-caption.js'

test('names the conversation states the caption shows', () => {
  assert.equal(desktopCaptionStatus('listening'), 'listening')
  assert.equal(desktopCaptionStatus('processing'), 'working')
  assert.equal(desktopCaptionStatus('speaking'), 'replying')
  // Background work already has task cards; it is not a caption state.
  for (const state of ['idle', 'working', 'hidden', 'waking', 'error', 'constructor']) {
    assert.equal(desktopCaptionStatus(state), null)
  }
})

test('shows the live transcript of the current turn', () => {
  const messages = [
    { id: 'user:t1', role: 'user', voice: true, turnId: 't1', content: 'what time is it' },
    { id: 'voice:r1', role: 'assistant', turnId: 't1', content: 'It is noon.' },
    {
      id: 'user:t2',
      role: 'user',
      voice: true,
      live: true,
      turnId: 't2',
      content: 'play some jazz',
    },
  ]
  assert.deepEqual(desktopCaption({ messages, visualState: 'listening' }), {
    status: 'listening',
    text: 'play some jazz',
  })
  assert.deepEqual(desktopCaption({
    messages: [
      ...messages,
      { id: 'voice:r2', role: 'assistant', turnId: 't2', content: 'Playing jazz' },
    ],
    visualState: 'speaking',
  }), { status: 'replying', text: 'play some jazz' })
})

test('leaves out an earlier transcript when the assistant speaks on its own', () => {
  assert.deepEqual(desktopCaption({
    messages: [
      { id: 'user:t1', role: 'user', voice: true, turnId: 't1', content: 'remind me at five' },
      { id: 'voice:r9', role: 'assistant', turnId: 'announcement_1', content: 'Reminder' },
    ],
    visualState: 'speaking',
  }), { status: 'replying', text: '' })
  assert.deepEqual(desktopCaption(), { status: null, text: '' })
})

test('keeps the end of a long transcript', () => {
  const content = `${'a'.repeat(150)}the end`
  const { text } = desktopCaption({
    messages: [{ id: 'user:t1', role: 'user', voice: true, turnId: 't1', content }],
    visualState: 'processing',
  })
  assert.equal(text.length, 120)
  assert.ok(text.startsWith('…'))
  assert.ok(text.endsWith('the end'))
})

test('shows, lingers, fades and hides the caption', () => {
  const shown = nextDesktopCaption(DESKTOP_CAPTION_HIDDEN, {
    available: true,
    status: 'listening',
    text: 'play',
  })
  assert.deepEqual(shown, { phase: 'shown', status: 'listening', text: 'play' })
  assert.equal(nextDesktopCaption(shown, {
    available: true,
    status: 'listening',
    text: 'play',
  }), shown)

  const lingering = nextDesktopCaption(shown, {
    available: true,
    status: null,
    text: 'play',
  })
  assert.deepEqual(lingering, { phase: 'lingering', status: 'listening', text: 'play' })
  assert.equal(nextDesktopCaption(lingering, {
    available: true,
    status: null,
    text: '',
  }), lingering)
  assert.equal(DESKTOP_CAPTION_LINGER_MS, 4000)
  assert.equal(desktopCaptionDelay('lingering'), DESKTOP_CAPTION_LINGER_MS)

  const fading = expireDesktopCaption(lingering, 'lingering')
  assert.deepEqual(fading, { phase: 'fading', status: 'listening', text: 'play' })
  assert.equal(desktopCaptionDelay('fading'), DESKTOP_CAPTION_FADE_MS)
  assert.equal(expireDesktopCaption(fading, 'fading'), DESKTOP_CAPTION_HIDDEN)
  assert.equal(desktopCaptionDelay('shown'), null)
  assert.equal(desktopCaptionDelay('hidden'), null)
})

test('a new status brings a fading caption back and a stale timer changes nothing', () => {
  const fading = { phase: 'fading', status: 'listening', text: 'play' }
  const shown = nextDesktopCaption(fading, {
    available: true,
    status: 'working',
    text: 'play jazz',
  })
  assert.deepEqual(shown, { phase: 'shown', status: 'working', text: 'play jazz' })
  assert.equal(expireDesktopCaption(shown, 'lingering'), shown)
  assert.equal(nextDesktopCaption(DESKTOP_CAPTION_HIDDEN, {
    available: true,
    status: null,
    text: '',
  }), DESKTOP_CAPTION_HIDDEN)
})

test('hides at once when the orb is hidden or becomes the panel', () => {
  const shown = { phase: 'shown', status: 'replying', text: 'play' }
  assert.equal(nextDesktopCaption(shown, {
    available: false,
    status: 'replying',
    text: 'play',
  }), DESKTOP_CAPTION_HIDDEN)
})
