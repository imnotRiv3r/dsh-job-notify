/**
 * Host→browser notification channel for dsh-job-notify.
 *
 * The Windows toast path only exists on the Host's own desktop. When the page
 * runs in a browser (`dsh web`), the Host is somewhere else and the only place
 * a notification can appear is the browser itself — so the Host publishes each
 * notification as a Server-Sent Event and the browser half decides how to show
 * it (native `Notification`, or the in-page fallback).
 *
 * The transport is deliberately the same one `@deepseek-ai/dsh-client-hmr`
 * uses: an exact route on `ctx.webServer`, `text/event-stream`, one JSON frame
 * per `data:` line. No new protocol, no dependency on a private service.
 *
 * @module dsh-job-notify/notify-hub
 */

/** Route the browser half subscribes to. */
export const EVENTS_PATH = '/api/job-notify/events'

/**
 * How often a comment frame is written to every open stream.
 *
 * Idle SSE connections are dropped by proxies and browsers; a comment line
 * (`: ping`) keeps the stream warm without reaching the page as a message.
 */
export const DEFAULT_HEARTBEAT_MS = 25_000

/** How many live streams may be registered before the oldest is dropped. */
export const DEFAULT_CLIENT_LIMIT = 16

/**
 * Serialise one payload as an SSE frame.
 *
 * The JSON is written on a single line: a literal newline inside `data:` would
 * terminate the frame early and the browser would drop it.
 * @param value - the payload the page should receive.
 * @returns the wire text, frame terminator included.
 */
export function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`
}

/** An SSE comment frame, used as the heartbeat. */
export const PING_FRAME = ': ping\n\n'

/**
 * Track the browsers listening for notifications.
 *
 * Every entry is one open HTTP response. A response that the browser closed
 * (tab closed, reload, network drop) is removed on its `close` event, so the
 * set never grows past the number of live pages.
 */
export class NotifyHub {
  #clients = new Set()
  #heartbeat
  #logger
  #limit

  /**
   * @param options - logger, heartbeat interval, and client cap.
   */
  constructor({ logger, heartbeatMs = DEFAULT_HEARTBEAT_MS, limit = DEFAULT_CLIENT_LIMIT } = {}) {
    this.#logger = logger
    this.#limit = limit
    if (heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#write(PING_FRAME), heartbeatMs)
      // A live page keeps the process busy enough; this timer must never be
      // the reason a Host fails to exit.
      this.#heartbeat.unref?.()
    }
  }

  /** How many pages are currently subscribed. */
  get size() {
    return this.#clients.size
  }

  /**
   * Admit one browser and keep its stream open.
   *
   * The caller has already checked authentication; this method only owns the
   * stream lifecycle.
   * @param res - the HTTP response to write frames into.
   */
  add(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      // Tell nginx and friends not to buffer: a buffered SSE stream delivers
      // every notification in one burst when the connection closes.
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')

    // Cap the fan-out: an unbounded set of streams is a memory leak when tabs
    // are opened in a loop and their close events are lost.
    while (this.#clients.size >= this.#limit) {
      const oldest = this.#clients.values().next().value
      this.#clients.delete(oldest)
      try {
        oldest.end()
      } catch {
        // The stream was already gone; nothing to release.
      }
    }

    this.#clients.add(res)
    res.on('close', () => {
      this.#clients.delete(res)
    })
    res.on('error', () => {
      this.#clients.delete(res)
    })
  }

  /**
   * Publish one notification to every subscribed page.
   * @param payload - the notification the page should show.
   */
  broadcast(payload) {
    if (this.#clients.size === 0) return
    this.#write(sseFrame(payload))
  }

  /** Write one frame to every live stream, dropping the ones that throw. */
  #write(text) {
    for (const res of [...this.#clients]) {
      try {
        res.write(text)
      } catch (error) {
        this.#clients.delete(res)
        this.#logger?.debug?.(`job-notify: dropped a browser stream: ${String(error)}`)
      }
    }
  }

  /** Stop the heartbeat and close every stream. */
  close() {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    for (const res of this.#clients) {
      try {
        res.end()
      } catch {
        // Already closed by the browser.
      }
    }
    this.#clients.clear()
  }
}
