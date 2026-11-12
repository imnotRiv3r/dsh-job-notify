/**
 * Windows toast delivery for dsh-job-notify.
 *
 * Each toast is one short-lived Windows PowerShell 5.1 process: only that
 * engine has the WinRT projection `Windows.UI.Notifications` needs. Calls are
 * serialised through {@link ToastQueue} so a burst of settlements cannot start
 * a process storm, and every call has a deadline so a wedged shell cannot stall
 * the queue forever.
 * @module dsh-job-notify/toast
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The PowerShell payload sender that ships beside `index.js`. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'toast.ps1')

/** How long one toast may take before its PowerShell process is killed. */
export const DEFAULT_TIMEOUT_MS = 10_000

/** How many undelivered toasts may wait before the oldest is dropped. */
export const DEFAULT_QUEUE_LIMIT = 8

/** Absolute path to Windows PowerShell, falling back to PATH resolution. */
export function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (typeof root !== 'string' || root === '') return 'powershell.exe'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Encode one payload for the PowerShell command line.
 *
 * Base64 keeps the argument pure ASCII, so a Chinese title, a quote, or a `%`
 * survives regardless of the console code page.
 */
export function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/**
 * Build the runner that shows one toast.
 * @param options - injectable seams for tests.
 * @returns a function resolving `{ ok: true }` or `{ ok: false, reason }`.
 */
export function createToastRunner({
  scriptPath = SCRIPT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  resolvePowershell = powershellPath,
} = {}) {
  return function runToast(payload) {
    return new Promise(resolve => {
      let settled = false
      let timer
      const finish = outcome => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(outcome)
      }

      let encoded
      try {
        encoded = encodePayload(payload)
      } catch (error) {
        finish({ ok: false, reason: `payload encoding failed: ${String(error)}` })
        return
      }

      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
        '-PayloadBase64',
        encoded,
      ]

      let child
      try {
        child = spawnImpl(resolvePowershell(), args, { windowsHide: true, stdio: 'ignore' })
      } catch (error) {
        finish({ ok: false, reason: String(error) })
        return
      }

      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The process may already be gone; the timeout outcome still stands.
        }
        finish({ ok: false, reason: `timed out after ${timeoutMs} ms` })
      }, timeoutMs)

      child.once('error', error => finish({ ok: false, reason: String(error) }))
      child.once('exit', code =>
        finish(code === 0 ? { ok: true } : { ok: false, reason: `PowerShell exit ${String(code)}` }),
      )
    })
  }
}

/**
 * A bounded, serial toast queue.
 *
 * One toast at a time keeps process creation predictable. A full queue drops
 * its oldest entry rather than growing without bound; the newest settlements
 * are the ones a user is most likely to act on.
 */
export class ToastQueue {
  #pending = []
  #draining = false
  #closed = false
  #idleWaiters = []

  /**
   * @param options - runner, logger, and queue bound.
   */
  constructor({ run, logger, limit = DEFAULT_QUEUE_LIMIT } = {}) {
    if (typeof run !== 'function') throw new TypeError('ToastQueue needs a run(payload) function')
    this.run = run
    this.logger = logger
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_QUEUE_LIMIT
  }

  /** Number of payloads waiting; the running one is not counted. */
  get size() {
    return this.#pending.length
  }

  /**
   * Queue one payload for delivery.
   * @returns true when accepted, false after {@link close}.
   */
  enqueue(payload) {
    if (this.#closed) return false
    if (this.#pending.length >= this.limit) {
      this.#pending.shift()
      this.#warn(`toast queue full (${this.limit}); dropped the oldest notification`)
    }
    this.#pending.push(payload)
    void this.#drain()
    return true
  }

  /** Resolve once the queue is empty and nothing is running. */
  whenIdle() {
    if (!this.#draining && this.#pending.length === 0) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  /** Stop accepting work and drop everything still waiting. */
  close() {
    this.#closed = true
    this.#pending.length = 0
    this.#settleIdle()
  }

  #warn(message) {
    if (this.logger !== undefined && typeof this.logger.warn === 'function') {
      this.logger.warn(`job-notify: ${message}`)
    }
  }

  #settleIdle() {
    if (this.#draining || this.#pending.length > 0) return
    const waiters = this.#idleWaiters
    this.#idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  async #drain() {
    if (this.#draining) return
    this.#draining = true
    try {
      while (!this.#closed && this.#pending.length > 0) {
        const payload = this.#pending.shift()
        try {
          const outcome = await this.run(payload)
          if (outcome === undefined || outcome.ok !== true) {
            this.#warn(`toast failed: ${outcome === undefined ? 'no outcome' : String(outcome.reason)}`)
          }
        } catch (error) {
          this.#warn(`toast pipeline failed: ${String(error)}`)
        }
      }
    } finally {
      this.#draining = false
      this.#settleIdle()
    }
  }
}
