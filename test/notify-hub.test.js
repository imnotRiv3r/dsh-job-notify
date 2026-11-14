import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { buildWebNotification, normalizeConfig, WEB_KINDS } from '../lib/format.js'
import { EVENTS_PATH, NotifyHub, sseFrame } from '../lib/notify-hub.js'

/** A stand-in for an HTTP response the hub writes frames into. */
class FakeResponse extends EventEmitter {
  written = []
  status = undefined
  headers = undefined
  ended = false

  writeHead(status, headers) {
    this.status = status
    this.headers = headers
    return this
  }

  write(text) {
    this.written.push(text)
    return true
  }

  end() {
    this.ended = true
  }
}

test('sseFrame keeps the payload on one line', () => {
  const frame = sseFrame({ title: 'a\nb', body: 'line' })
  // A literal newline inside `data:` would end the frame early.
  assert.equal(frame.includes('\n\n'), true)
  assert.equal(frame.slice(0, frame.length - 2).includes('\n'), false)
  assert.deepEqual(JSON.parse(frame.slice(6)), { title: 'a\nb', body: 'line' })
})

test('buildWebNotification carries the toast title and body', () => {
  const frame = buildWebNotification(WEB_KINDS.completed, { title: '后台任务已完成', body: 'npm test · 3 秒' }, {
    tag: 'job:bash-1',
    sessionId: 's1',
  })
  assert.equal(frame.kind, 'job-completed')
  assert.equal(frame.title, '后台任务已完成')
  assert.equal(frame.body, 'npm test · 3 秒')
  assert.equal(frame.tag, 'job:bash-1')
  assert.equal(frame.sessionId, 's1')
  assert.equal(frame.requireInteraction, false)
})

test('buildWebNotification refuses an empty title', () => {
  assert.equal(buildWebNotification(WEB_KINDS.turn, { title: '', body: 'x' }), undefined)
  assert.equal(buildWebNotification(WEB_KINDS.turn, undefined), undefined)
})

test('buildWebNotification keeps an urgent kind interactive', () => {
  const frame = buildWebNotification(WEB_KINDS.question, { title: '需要你选择', body: 'q' }, {
    requireInteraction: true,
  })
  assert.equal(frame.requireInteraction, true)
})

test('the hub admits a stream and broadcasts to every open page', () => {
  const hub = new NotifyHub({ heartbeatMs: 0 })
  const first = new FakeResponse()
  const second = new FakeResponse()
  hub.add(first)
  hub.add(second)
  assert.equal(hub.size, 2)
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'text/event-stream; charset=utf-8')

  hub.broadcast({ title: 'done' })
  assert.equal(first.written.at(-1), sseFrame({ title: 'done' }))
  assert.equal(second.written.at(-1), sseFrame({ title: 'done' }))
  hub.close()
})

test('a closed stream leaves the hub', () => {
  const hub = new NotifyHub({ heartbeatMs: 0 })
  const res = new FakeResponse()
  hub.add(res)
  assert.equal(hub.size, 1)
  res.emit('close')
  assert.equal(hub.size, 0)
  hub.close()
})

test('the hub drops the oldest stream past its cap', () => {
  const hub = new NotifyHub({ heartbeatMs: 0, limit: 2 })
  const first = new FakeResponse()
  const second = new FakeResponse()
  const third = new FakeResponse()
  hub.add(first)
  hub.add(second)
  hub.add(third)
  assert.equal(hub.size, 2)
  assert.equal(first.ended, true)
  hub.close()
})

test('closing the hub ends every stream', () => {
  const hub = new NotifyHub({ heartbeatMs: 0 })
  const res = new FakeResponse()
  hub.add(res)
  hub.close()
  assert.equal(res.ended, true)
  assert.equal(hub.size, 0)
})

test('broadcast with no listeners writes nothing', () => {
  const hub = new NotifyHub({ heartbeatMs: 0 })
  // No throw, no state: an idle Host must not accumulate anything.
  hub.broadcast({ title: 'nobody home' })
  assert.equal(hub.size, 0)
  hub.close()
})

test('the route path matches the documented endpoint', () => {
  assert.equal(EVENTS_PATH, '/api/job-notify/events')
})

test('normalizeConfig defaults the browser switches on', () => {
  const settings = normalizeConfig({})
  assert.equal(settings.notifyWeb, true)
  assert.equal(settings.webFallback, true)
  const off = normalizeConfig({ notifyWeb: false, webFallback: false })
  assert.equal(off.notifyWeb, false)
  assert.equal(off.webFallback, false)
})
