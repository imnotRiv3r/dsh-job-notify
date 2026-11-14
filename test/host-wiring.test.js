import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { apply } from '../index.js'

/**
 * Integration test for the Host half: mount `apply` against a stubbed context
 * and drive a real `jobs.events` settlement through it.
 *
 * The unit tests cover the formatters and the hub separately; this one proves
 * the wiring between them — that a settlement the registry reports actually
 * reaches the browser stream with the right title, kind, and tag. A break here
 * would leave the plugin "working" (no errors, route registered) while never
 * sending anything.
 */
function mount({ platform, config = {} } = {}) {
  /** Every frame the browser channel published. */
  const frames = []
  /** Every payload the toast channel queued. */
  const toasts = []
  /** Registered exact routes, by path. */
  const routes = new Map()
  const effects = []

  const jobs = new EventEmitter()
  jobs.events = {
    subscribe: (_options, listener) => {
      jobs.on('event', listener)
      return () => jobs.off('event', listener)
    },
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    jobs,
    on() {
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    get(name) {
      if (name === 'webServer') return undefined
      return undefined
    },
    inject(deps, callback) {
      // Only the browser channel injects; hand it a stub server and connection.
      const child = {
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
        connection: {
          requestRejection: () => undefined,
        },
        effect(fn) {
          const dispose = fn()
          effects.push(dispose)
          return dispose
        },
      }
      callback(child)
    },
  }

  const previousPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }
  try {
    apply(ctx, { notifyWeb: true, notifyTurnEnd: false, ...config })
  } finally {
    if (previousPlatform !== undefined) {
      Object.defineProperty(process, 'platform', previousPlatform)
    }
  }

  return {
    frames,
    toasts,
    routes,
    effects,
    emit(event) {
      jobs.emit('event', event)
    },
    /** Attach a fake response to the SSE route and return it. */
    connect() {
      const route = routes.get('/api/job-notify/events')
      assert.ok(route, 'the SSE route must be registered')
      const res = new EventEmitter()
      res.written = []
      res.writeHead = () => res
      res.write = text => {
        res.written.push(text)
        // Capture the published frames for assertions.
        if (text.startsWith('data: ')) frames.push(JSON.parse(text.slice(6)))
        return true
      }
      res.end = () => {}
      route.handler({ method: 'GET', headers: {} }, res)
      return res
    },
  }
}

/** One settled background job, as the registry reports it. */
function settledJob(overrides = {}) {
  return {
    type: 'settled',
    awaited: false,
    job: {
      id: 'bash-abc123',
      kind: 'bash',
      label: 'npm test',
      owner: 'session-1',
      status: 'completed',
      startedAt: Date.now() - 3_000,
      finishedAt: Date.now(),
      output: { total: 0, earliest: 0 },
      ...overrides,
    },
  }
}

test('a settled job reaches the browser stream', () => {
  const host = mount()
  host.connect()
  host.emit(settledJob())

  assert.equal(host.frames.length, 1)
  const frame = host.frames[0]
  assert.equal(frame.kind, 'job-completed')
  assert.equal(frame.title, '后台任务已完成')
  assert.match(frame.body, /npm test/)
  assert.equal(frame.tag, 'job:bash-abc123')
  assert.equal(frame.sessionId, 'session-1')
})

test('a failed job is reported as a failure, not a completion', () => {
  const host = mount()
  host.connect()
  host.emit(settledJob({ status: 'completed', detail: 'exit code: 3' }))
  assert.equal(host.frames[0].kind, 'job-failed')
  assert.equal(host.frames[0].title, '后台任务异常退出')
})

test('an awaited settlement stays silent', () => {
  const host = mount()
  host.connect()
  // A foreground shell call has a waiting caller: it is not background work.
  host.emit({ ...settledJob(), awaited: true })
  assert.equal(host.frames.length, 0)
})

test('a teardown settlement stays silent', () => {
  const host = mount()
  host.connect()
  host.emit({ ...settledJob(), cause: 'teardown' })
  assert.equal(host.frames.length, 0)
})

test('a disabled category stays silent', () => {
  const host = mount({ config: { onCompleted: false } })
  host.connect()
  host.emit(settledJob())
  // The user turned completion notifications off; only failures should speak.
  assert.equal(host.frames.length, 0)
})

test('a failure still speaks when only completions are off', () => {
  const host = mount({ config: { onCompleted: false } })
  host.connect()
  host.emit(settledJob({ detail: 'exit code: 1' }))
  assert.equal(host.frames.length, 1)
  assert.equal(host.frames[0].kind, 'job-failed')
})

test('the browser channel is skipped when notifyWeb is off', () => {
  const routes = new Map()
  const jobs = new EventEmitter()
  jobs.events = {
    subscribe: (_options, listener) => {
      jobs.on('event', listener)
      return () => jobs.off('event', listener)
    },
  }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    jobs,
    on: () => () => {},
    effect: fn => fn(),
    get: () => undefined,
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
        connection: { requestRejection: () => undefined },
        effect: fn => fn(),
      })
    },
  }
  apply(ctx, { notifyWeb: false, notifyTurnEnd: false })
  assert.equal(routes.size, 0)
})

test('the route refuses a non-GET method', () => {
  const host = mount()
  const route = host.routes.get('/api/job-notify/events')
  const res = new EventEmitter()
  res.status = undefined
  res.writeHead = status => {
    res.status = status
    return res
  }
  res.end = () => {}
  route.handler({ method: 'POST', headers: {} }, res)
  assert.equal(res.status, 405)
})

test('the route refuses an untrusted request', () => {
  const routes = new Map()
  const jobs = new EventEmitter()
  jobs.events = { subscribe: () => () => {} }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    jobs,
    on: () => () => {},
    effect: fn => fn(),
    get: () => undefined,
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
        // The trust fence rejects: an unauthenticated page must not stream.
        connection: { requestRejection: () => 401 },
        effect: fn => fn(),
      })
    },
  }
  apply(ctx, { notifyWeb: true, notifyTurnEnd: false })

  const res = new EventEmitter()
  res.status = undefined
  res.writeHead = status => {
    res.status = status
    return res
  }
  res.end = () => {}
  routes.get('/api/job-notify/events').handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.status, 401)
})
