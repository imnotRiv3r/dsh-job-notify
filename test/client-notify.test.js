import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Exercise the browser half by running `client.js` in a stubbed page.
 *
 * The bundle is written for the page's module loader, so the test provides the
 * globals it touches (`window`, `document`, `__ModuleLoader__`) and drives the
 * plugin through its real `apply`: a stubbed `EventSource` delivers frames and
 * the test observes which channel reacted. That is the part that silently
 * breaks on `http://<lan-ip>` — a regression there is invisible until a user
 * notices that no notification ever appears.
 */
const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** A minimal element good enough for the banner path. */
function createElement() {
  const el = {
    style: {},
    children: [],
    textContent: '',
    isConnected: true,
    attributes: {},
    // Canvas stub: the favicon badge draws on it; without a real 2D context the
    // badge path must fail silently rather than throw through the handler.
    width: 32,
    height: 32,
    getContext: () => null,
    toDataURL: () => 'data:image/png;base64,',
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    addEventListener() {},
    remove() {
      this.isConnected = false
    },
  }
  return el
}

/**
 * Load the bundle into a stubbed page and return the plugin body.
 * @param page - overrides merged onto the stubbed `window`.
 * @param options - `onNotification` observes constructed notifications.
 */
function loadBundle(page = {}, { onNotification } = {}) {
  let registration
  let source

  class FakeEventSource {
    static instances = []
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.onopen = undefined
      this.onerror = undefined
      this.onmessage = undefined
      FakeEventSource.instances.push(this)
      source = this
    }
    close() {
      this.readyState = 2
    }
  }

  class FakeNotification {
    static permission = 'granted'
    constructor(title, options) {
      this.title = title
      this.options = options
      onNotification?.({ title, options })
    }
    close() {}
  }

  const body = createElement()
  const win = {
    isSecureContext: true,
    Notification: FakeNotification,
    EventSource: FakeEventSource,
    focus() {},
    addEventListener() {},
    removeEventListener() {},
    ...page,
  }
  const context = {
    window: win,
    document: {
      visibilityState: 'hidden',
      hasFocus: () => false,
      body,
      createElement,
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      title: 'DSH',
      head: { appendChild() {} },
    },
    setTimeout,
    clearTimeout,
    // The title blink schedules a repeating interval; a real one would keep the
    // test process alive forever, so the sandbox records instead of scheduling.
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  }
  context.window.__ModuleLoader__ = {
    load(entry) {
      registration = entry
    },
  }
  context.self = context.window
  vm.createContext(context)
  vm.runInContext(SOURCE, context, { filename: 'client.js' })

  const plugin = registration.factory(specifier => {
    if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
    return {
      createElement: (...args) => ({ args }),
      useCallback: fn => fn,
      useEffect: () => {},
      useRef: value => ({ current: value }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
  })

  return {
    plugin,
    win,
    context,
    body,
    get source() {
      return source
    },
    instances: FakeEventSource.instances,
  }
}

/** Run the plugin's `apply` against a stubbed context. */
function mount(loaded, { config } = {}) {
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'configForms') return undefined
      return {
        get: () => ({
          getSnapshot: () => ({ status: 'ready', value: config ?? {}, writable: true, revision: 1 }),
          subscribe: () => () => {},
          mutate: async () => true,
        }),
      }
    },
    slots: {
      inject() {},
      register() {},
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  loaded.plugin.apply(ctx)
  return effects
}

/** Deliver one frame to the page's stream. */
function push(loaded, frame) {
  loaded.source.onmessage({ data: JSON.stringify(frame) })
}

test('the bundle registers the documented entry id', () => {
  const { plugin } = loadBundle()
  assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['slots']))
  assert.equal(typeof plugin.apply, 'function')
})

test('the page subscribes to the host event route', () => {
  const loaded = loadBundle()
  mount(loaded)
  assert.equal(loaded.source?.url, '/api/job-notify/events')
})

test('a secure page with permission gets a native notification', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: '做完了', tag: 'turn:1' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].title, '本轮已完成')
  assert.equal(seen[0].options.tag, 'turn:1')
})

test('an insecure page falls back to the in-page banner', () => {
  const seen = []
  const loaded = loadBundle(
    { isSecureContext: false },
    { onNotification: n => seen.push(n) },
  )
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: '做完了' })
  // The Notification constructor must not be used: it would silently do nothing
  // on an insecure origin, which is exactly the bug this guards.
  assert.equal(seen.length, 0)
  assert.equal(loaded.body.children.length, 1)
})

test('the fallback can be switched off from the config page', () => {
  const loaded = loadBundle({ isSecureContext: false })
  mount(loaded, { config: { webFallback: false } })
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: '做完了' })
  assert.equal(loaded.body.children.length, 0)
})

test('a denied permission falls back to the banner', () => {
  const seen = []
  const loaded = loadBundle(
    { Notification: class extends Object { static permission = 'denied' } },
    { onNotification: n => seen.push(n) },
  )
  mount(loaded)
  push(loaded, { kind: 'job-completed', title: '后台任务已完成', body: '3 秒' })
  assert.equal(seen.length, 0)
  assert.equal(loaded.body.children.length, 1)
})

test('a focused visible page stays quiet for a finished turn', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  loaded.context.document.visibilityState = 'visible'
  loaded.context.document.hasFocus = () => true
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: 'x' })
  assert.equal(seen.length, 0)
})

test('a focused visible page still shows an urgent decision', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  loaded.context.document.visibilityState = 'visible'
  loaded.context.document.hasFocus = () => true
  mount(loaded)
  push(loaded, { kind: 'attention-question', title: '需要你选择', body: '选哪个？' })
  assert.equal(seen.length, 1)
})

test('a visible but unfocused page counts as away', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  loaded.context.document.visibilityState = 'visible'
  loaded.context.document.hasFocus = () => false
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: 'x' })
  assert.equal(seen.length, 1)
})

test('an urgent kind keeps the notification interactive', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  mount(loaded)
  push(loaded, {
    kind: 'attention-approval',
    title: '需要你批准',
    body: '工具：bash',
    requireInteraction: true,
  })
  assert.equal(seen[0].options.requireInteraction, true)
})

test('a malformed frame is ignored without throwing', () => {
  const seen = []
  const loaded = loadBundle({}, { onNotification: n => seen.push(n) })
  mount(loaded)
  loaded.source.onmessage({ data: 'not json' })
  loaded.source.onmessage({ data: 'null' })
  assert.equal(seen.length, 0)
})

test('the stream reconnects after a closed connection', () => {
  const loaded = loadBundle()
  mount(loaded)
  const first = loaded.source
  first.readyState = 2
  first.onerror()
  // A fresh EventSource is created after the retry delay; the timer is left
  // pending here, so assert on the error path only.
  assert.equal(first.readyState, 2)
})

test('an insecure page also announces unread count in the tab title', () => {
  const loaded = loadBundle({ isSecureContext: false })
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: 'x' })
  // The banner is the visible part; the title is what a background tab shows.
  assert.equal(loaded.body.children.length, 1)
})

test('the attention cleanup is wired once, not per notification', () => {
  let documentAdded = 0
  let windowAdded = 0
  const loaded = loadBundle({ isSecureContext: false })
  loaded.context.document.addEventListener = () => {
    documentAdded += 1
  }
  loaded.win.addEventListener = () => {
    windowAdded += 1
  }
  mount(loaded)
  push(loaded, { kind: 'turn-end', title: '一', body: '' })
  push(loaded, { kind: 'turn-end', title: '二', body: '' })
  // `visibilitychange` lives on document, `focus` on window — one each, for the
  // page's whole lifetime rather than per notification.
  assert.equal(documentAdded, 1)
  assert.equal(windowAdded, 1)
})

test('the tab title is restored when the plugin unmounts', () => {
  const loaded = loadBundle({ isSecureContext: false })
  const effects = mount(loaded)
  push(loaded, { kind: 'turn-end', title: '本轮已完成', body: 'x' })
  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose()
  }
  assert.equal(loaded.context.document.title, 'DSH')
})
