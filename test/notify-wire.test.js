import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { EVENTS_PATH, NotifyHub } from '../lib/notify-hub.js'

/**
 * Mount the hub on a real HTTP server and read it back over a real socket.
 *
 * The unit tests drive the hub with fake responses; this one proves the wire
 * format survives node:http — chunked encoding, the SSE framing, and the fact
 * that a frame is delivered before the response ends.
 *
 * A raw `node:http` client is used instead of `fetch` on purpose: an SSE
 * response never ends on its own, and undici's pooled connection would keep the
 * test process alive after the assertions finished.
 */
async function withServer(run) {
  const hub = new NotifyHub({ heartbeatMs: 0 })
  const server = createServer((req, res) => {
    if (req.url !== EVENTS_PATH) {
      res.writeHead(404)
      res.end()
      return
    }
    hub.add(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run({ hub, port })
  } finally {
    hub.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
}

/**
 * Open one SSE connection and hand back what arrived.
 * @returns `{ status, contentType, first, frame, close }`.
 */
function openStream(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: EVENTS_PATH, method: 'GET' }, res => {
      let buffer = ''
      let first = undefined
      const stream = {
        status: res.statusCode,
        contentType: res.headers['content-type'],
        get first() {
          return first
        },
        get frame() {
          return streamFrame(buffer)
        },
        close() {
          req.destroy()
        },
      }
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buffer += chunk
        if (first === undefined) first = buffer
      })
      res.on('error', () => {})
      resolve(stream)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Parse the first `data:` frame out of the accumulated text, if any.
 *
 * The opening `: connected` comment is its own block and carries no data, so
 * every block is scanned rather than only the first one.
 */
function streamFrame(buffer) {
  for (const block of buffer.split('\n\n')) {
    const line = block.split('\n').find(part => part.startsWith('data: '))
    if (line !== undefined) return JSON.parse(line.slice(6))
  }
  return undefined
}

/** Poll until `check()` yields a value, or the deadline passes. */
async function until(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('a notification reaches a real HTTP client', async () => {
  await withServer(async ({ hub, port }) => {
    const stream = await openStream(port)
    try {
      assert.equal(stream.status, 200)
      assert.match(stream.contentType, /text\/event-stream/)

      // Wait for the server to register the stream before publishing into it.
      await until(() => (hub.size > 0 ? true : undefined))
      hub.broadcast({ kind: 'job-completed', title: '后台任务已完成', body: 'npm test · 3 秒' })

      const frame = await until(() => stream.frame)
      assert.equal(frame?.title, '后台任务已完成')
      assert.equal(frame?.kind, 'job-completed')
    } finally {
      stream.close()
    }
  })
})

test('the stream announces itself so the page can mark itself connected', async () => {
  await withServer(async ({ port }) => {
    const stream = await openStream(port)
    try {
      const first = await until(() => stream.first)
      // The first bytes are the `: connected` comment, not a data frame.
      assert.match(first ?? '', /^: connected\n\n/)
    } finally {
      stream.close()
    }
  })
})
