import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createToastRunner, encodePayload, ToastQueue } from '../lib/toast.js'

/** A stand-in for a spawned PowerShell that the test drives by hand. */
class FakeChild extends EventEmitter {
  killed = false
  kill() {
    this.killed = true
  }
}

test('encodePayload round-trips Unicode and quotes', () => {
  const payload = { title: '中文 "标题"', body: '100% 完成', appId: 'com.deepseek.dsh' }
  const decoded = JSON.parse(Buffer.from(encodePayload(payload), 'base64').toString('utf8'))
  assert.deepEqual(decoded, payload)
})

test('the toast runner reports the PowerShell exit status', async () => {
  const child = new FakeChild()
  const calls = []
  const run = createToastRunner({
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options })
      return child
    },
    resolvePowershell: () => 'powershell.exe',
    scriptPath: 'C:\\plugin\\toast.ps1',
  })

  const success = run({ title: '标题', body: '正文', appId: 'com.deepseek.dsh' })
  child.emit('exit', 0)
  assert.deepEqual(await success, { ok: true })
  assert.equal(calls[0].command, 'powershell.exe')
  assert.ok(calls[0].args.includes('-PayloadBase64'))
  assert.equal(calls[0].options.windowsHide, true)

  const failedChild = new FakeChild()
  const failureRun = createToastRunner({ spawnImpl: () => failedChild })
  const failure = failureRun({ title: '标题' })
  failedChild.emit('exit', 1)
  assert.deepEqual(await failure, { ok: false, reason: 'PowerShell exit 1' })
})

test('the toast runner contains spawn errors', async () => {
  const child = new FakeChild()
  const run = createToastRunner({ spawnImpl: () => child })
  const outcome = run({ title: '标题' })
  child.emit('error', new Error('spawn failed'))
  assert.equal((await outcome).ok, false)
  assert.match((await outcome).reason, /spawn failed/)
})

test('the toast runner kills a wedged PowerShell at the deadline', async () => {
  const child = new FakeChild()
  const run = createToastRunner({ spawnImpl: () => child, timeoutMs: 10 })
  const outcome = await run({ title: '标题' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /timed out after 10 ms/)
  assert.equal(child.killed, true)
})

test('ToastQueue drains one payload at a time, in order', async () => {
  const seen = []
  const queue = new ToastQueue({
    run: async payload => {
      seen.push(payload.title)
      return { ok: true }
    },
  })
  queue.enqueue({ title: 'first' })
  queue.enqueue({ title: 'second' })
  await queue.whenIdle()
  assert.deepEqual(seen, ['first', 'second'])
  assert.equal(queue.size, 0)
})

test('ToastQueue drops the oldest payload when full', async () => {
  const warnings = []
  let release
  const seen = []
  const queue = new ToastQueue({
    run: payload => {
      seen.push(payload.title)
      return new Promise(resolve => {
        release = resolve
      })
    },
    logger: { warn: message => warnings.push(message) },
    limit: 2,
  })
  queue.enqueue({ title: 'running' })
  queue.enqueue({ title: 'a' })
  queue.enqueue({ title: 'b' })
  queue.enqueue({ title: 'c' })
  assert.equal(queue.size, 2)
  assert.ok(warnings.some(message => /queue full/.test(message)))
  release({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen[0], 'running')
  queue.close()
})

test('ToastQueue logs a failed delivery without stopping the queue', async () => {
  const warnings = []
  const seen = []
  const queue = new ToastQueue({
    run: async payload => {
      seen.push(payload.title)
      return payload.title === 'bad' ? { ok: false, reason: 'PowerShell exit 1' } : { ok: true }
    },
    logger: { warn: message => warnings.push(message) },
  })
  queue.enqueue({ title: 'bad' })
  queue.enqueue({ title: 'good' })
  await queue.whenIdle()
  assert.deepEqual(seen, ['bad', 'good'])
  assert.ok(warnings.some(message => /PowerShell exit 1/.test(message)))
})

test('ToastQueue stops accepting work after close', async () => {
  const seen = []
  const queue = new ToastQueue({
    run: async payload => {
      seen.push(payload.title)
      return { ok: true }
    },
  })
  queue.close()
  assert.equal(queue.enqueue({ title: 'late' }), false)
  await queue.whenIdle()
  assert.deepEqual(seen, [])
})
