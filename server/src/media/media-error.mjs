// Failures the media player reports. The code is stable and machine-readable
// (tool handlers map it to what the voice says); the message is for logs.
// Codes: no_browser, url_not_allowed, launch_failed, not_playing,
// transport_unavailable, not_found, resolver_unavailable.
export class MediaError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MediaError'
    this.code = code
  }
}
