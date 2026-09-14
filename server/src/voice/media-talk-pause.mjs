// Pauses the Gateway media player while the user talks to the assistant and
// resumes it once the answer has been heard. A pause or stop the user asked
// for in that turn stays, and so does anything that replaced the playback or
// a pause from another tool (a changed controlSerial).
export class MediaTalkPause {
  #player
  #getSettings
  #isResponding
  #logger
  #held = null
  // The release of the last hold, until it settles.
  #resuming = null

  constructor({
    player = null,
    getSettings = () => ({}),
    isResponding = () => false,
    logger = null,
  } = {}) {
    this.#player = player
    this.#getSettings = getSettings
    this.#isResponding = isResponding
    this.#logger = logger
  }

  speechStarted() {
    if (!this.#player || this.#held || !this.#getSettings()?.mediaPauseWhileTalking) return
    const held = { startedAt: null, controlSerial: null, keep: false, pausing: false }
    this.#held = held
    // The last turn's resume has not landed yet: the player still reads as
    // paused but is about to play, so pause again once that resume settles.
    const resuming = this.#resuming
    held.pausing = resuming ? resuming.then(() => this.#pause(held)) : this.#pause(held)
  }

  keepPaused() {
    if (this.#held) this.#held.keep = true
  }

  async turnEnded({ force = false } = {}) {
    const held = this.#held
    if (!held || (!force && this.#isResponding())) return
    this.#held = null
    const resuming = this.#release(held)
    this.#resuming = resuming
    try {
      await resuming
    } finally {
      if (this.#resuming === resuming) this.#resuming = null
    }
  }

  // A connection that closes mid-answer must not leave the video paused.
  close() {
    return this.turnEnded({ force: true })
  }

  // True once this hold has paused the player; false when nothing plays, the
  // player is already paused, or the pause failed (nothing to resume).
  #pause(held) {
    const state = this.#player.state()
    if (!state.active || state.paused) {
      if (this.#held === held) this.#held = null
      return false
    }
    held.startedAt = state.startedAt
    held.controlSerial = state.controlSerial
    return this.#player.control('pause', { source: 'talk_pause' }).then(() => true, error => {
      this.#warn('media.talk_pause.pause_failed', error)
      if (this.#held === held) this.#held = null
      return false
    })
  }

  async #release(held) {
    if (!(await held.pausing) || held.keep) return
    const state = this.#player.state()
    if (!state.active || !state.paused || state.startedAt !== held.startedAt) return
    // A pause from another tool during the turn (a backend tool) hit a player
    // that was already paused: no event, same startedAt, only the serial moved.
    if (state.controlSerial !== held.controlSerial) return
    try {
      await this.#player.control('resume', { source: 'talk_pause' })
    } catch (error) {
      this.#warn('media.talk_pause.resume_failed', error)
    }
  }

  #warn(event, error) {
    this.#logger?.warn?.(event, {
      code: String(error?.code || ''),
      error: String(error?.message || error),
    })
  }
}
