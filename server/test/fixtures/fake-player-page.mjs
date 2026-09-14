import { PAGE_SCRIPTS } from '../../src/media/fullscreen.mjs'
import { FakeDevToolsBrowser } from './fake-devtools-browser.mjs'

const MODES = new Map(Object.entries(PAGE_SCRIPTS).map(([mode, expression]) => [expression, mode]))
const SERVICES = Object.freeze({
  'www.youtube.com': 'youtube',
  'music.youtube.com': 'youtube_music',
  'www.netflix.com': 'netflix',
})

// The player page as PAGE_SCRIPTS would find it, answering the fullscreen
// routine's commands. The first `playsAfterPolls` state reads say the video
// is not playing yet.
// - button: 'works' | 'broken' (a click changes nothing) | 'missing'
// - key: 'works' (f toggles full screen, as on YouTube) | 'ignored'
// - element: 'works' | 'refused'
export class FakePlayerPage {
  constructor({
    url,
    targetId = 'page-1',
    playsAfterPolls = 0,
    button = 'works',
    key = 'works',
    element = 'works',
    typing = false,
    extraTargets = [],
  }) {
    Object.assign(this, { url, targetId, playsAfterPolls, button, key, element, typing, extraTargets })
    this.fullscreen = false
    this.polls = 0
    this.evaluations = []
    this.keys = []
  }

  get service() {
    return SERVICES[new URL(this.url).hostname] ?? null
  }

  target() {
    return { targetId: this.targetId, type: 'page', title: '', url: this.url, attached: false }
  }

  read(method = null) {
    return {
      service: this.service,
      hasVideo: true,
      playing: this.polls > this.playsAfterPolls,
      fullscreen: this.fullscreen,
      typing: this.typing,
      method,
    }
  }

  evaluate(mode) {
    this.evaluations.push(mode)
    if (mode === 'state') {
      this.polls += 1
      return this.read()
    }
    const before = this.read()
    if (!before.playing || before.fullscreen) return before
    if (mode === 'button') {
      if (this.button === 'missing') return this.read('button_missing')
      if (this.button === 'works') this.fullscreen = true
      return this.read('button')
    }
    if (this.element === 'works') {
      this.fullscreen = true
      return this.read('element')
    }
    return { ...this.read('element'), error: 'NotAllowedError' }
  }

  press(type) {
    this.keys.push(type)
    if (type === 'keyDown' && this.key === 'works' && !this.typing) this.fullscreen = !this.fullscreen
  }

  handlers(browser) {
    const targets = () => [...this.extraTargets, this.target()]
    return {
      'Target.setDiscoverTargets': () => {
        setImmediate(() => {
          for (const targetInfo of targets()) browser.event('Target.targetCreated', { targetInfo })
        })
        return {}
      },
      'Target.getTargets': () => ({ targetInfos: targets() }),
      'Target.attachToTarget': params => ({ sessionId: `session-${params.targetId}` }),
      'Runtime.evaluate': params => ({
        result: { type: 'object', value: this.evaluate(MODES.get(params.expression)) },
      }),
      'Input.dispatchKeyEvent': params => {
        this.press(params.type)
        return {}
      },
    }
  }
}

// A fake browser showing one player page. `answers: false` gives a browser
// that never replies (its pipe handler refused to start).
export function fakePlayerBrowser({ toBrowser, fromBrowser, answers = true, ...pageOptions }) {
  const page = new FakePlayerPage(pageOptions)
  const browser = new FakeDevToolsBrowser({ toBrowser, fromBrowser })
  if (answers) browser.handlers = page.handlers(browser)
  return {
    browser,
    page,
    navigate(url) {
      page.url = url
      browser.event('Target.targetInfoChanged', { targetInfo: page.target() })
    },
  }
}
