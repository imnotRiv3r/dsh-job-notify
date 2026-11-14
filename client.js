/**
 * Browser half: the configuration section in the Plugins panel, plus the
 * notification channel that actually reaches the user in `dsh web`.
 *
 * Two jobs, one bundle:
 *
 * 1. **Config section** — registers into `plugins.bundle.config`, which the
 *    bundle's detail page renders between its description and its rows. The page
 *    does not hand a `form` to a bundle-wide section, so this half resolves the
 *    Host-owned form itself from the shared `configForms` service and writes
 *    through its `mutate`, exactly as the shipped settings pages do.
 * 2. **Notification delivery** — subscribes to the Host's Server-Sent Event
 *    stream and shows each notification natively, or as an in-page banner when
 *    the page is not a secure context (see {@link detectChannel}).
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BUNDLE = 'dsh-job-notify'
    // The Host keys a settings namespace by the Loader entry's declared id. The
    // row id is `job-notify`; the other spellings only matter for a composition
    // that names the row differently.
    const NAMESPACES = ['job-notify', BUNDLE, '@local/dsh-job-notify', 'include:job-notify']
    const EMPTY_SNAPSHOT = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
    }

    function pickSharedForm(forms) {
      if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
      for (const key of NAMESPACES) {
        try {
          const form = forms.get(key)
          if (form === undefined || form === null || typeof form.getSnapshot !== 'function') continue
          const snapshot = form.getSnapshot()
          if (snapshot !== undefined && snapshot !== null && snapshot.status !== 'unavailable') return form
        } catch {
          // A namespace the settings mirror does not serve is simply not this one.
        }
      }
      return undefined
    }

    /** The Host route this page subscribes to; mirrors EVENTS_PATH in lib/notify-hub.js. */
    const EVENTS_PATH = '/api/job-notify/events'

    /**
     * Kinds urgent enough to bypass the "user is already looking at the page"
     * suppression.
     */
    const URGENT_KINDS = new Set(['attention-question', 'attention-approval'])

    /** How long an in-page banner stays before it fades on its own. */
    const BANNER_MS = 8000

    /**
     * Classify what this page can actually do.
     */
    function detectChannel() {
      const secure = window.isSecureContext === true
      const hasApi = typeof window.Notification !== 'undefined'
      if (!secure) {
        return {
          kind: 'insecure',
          native: false,
          reason: '页面不是安全上下文（http 局域网地址），浏览器禁止系统通知',
        }
      }
      if (!hasApi) return { kind: 'unsupported', native: false, reason: '这个浏览器没有 Notification API' }
      const permission = window.Notification.permission
      if (permission === 'granted') return { kind: 'native', native: true, permission }
      if (permission === 'denied') {
        return {
          kind: 'denied',
          native: false,
          permission,
          reason: '浏览器已拒绝通知权限，需要在地址栏的站点设置里重新允许',
        }
      }
      return { kind: 'prompt', native: false, permission, reason: '尚未授权通知' }
    }

    async function requestPermission() {
      if (typeof window.Notification === 'undefined') return 'unsupported'
      if (window.isSecureContext !== true) return 'insecure'
      if (window.Notification.permission === 'granted') return 'granted'
      if (window.Notification.permission === 'denied') return 'denied'
      try {
        return await window.Notification.requestPermission()
      } catch {
        return window.Notification.permission
      }
    }

    function shouldShow(frame) {
      const watching =
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        (typeof document.hasFocus !== 'function' || document.hasFocus())
      if (!watching) return true
      return URGENT_KINDS.has(frame.kind)
    }

    function showNative(frame) {
      if (typeof window.Notification === 'undefined') return undefined
      if (window.Notification.permission !== 'granted') return undefined
      try {
        const notification = new window.Notification(frame.title, {
          body: frame.body === '' ? undefined : frame.body,
          tag: frame.tag,
          renotify: false,
          requireInteraction: frame.requireInteraction === true,
        })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {}
          try {
            notification.close()
          } catch {}
        }
        return notification
      } catch {
        return undefined
      }
    }

    function connectStream(onFrame, onState) {
      if (typeof window.EventSource !== 'function') {
        onState('unsupported')
        return () => {}
      }
      let closed = false
      let source
      let retryTimer
      const schedule = () => {
        if (closed) return
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        retryTimer = setTimeout(open, 5000)
      }
      function open() {
        if (closed) return
        try {
          source = new window.EventSource(EVENTS_PATH)
        } catch {
          onState('error')
          schedule()
          return
        }
        source.onopen = () => onState('open')
        source.onerror = () => {
          if (source !== undefined && source.readyState === 2) {
            onState('error')
            schedule()
          }
        }
        source.onmessage = (event) => {
          let frame
          try {
            frame = JSON.parse(event.data)
          } catch {
            return
          }
          if (frame === null || typeof frame !== 'object') return
          onFrame(frame)
        }
      }
      open()
      return () => {
        closed = true
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        try {
          source?.close()
        } catch {}
      }
    }

    const BANNER_TONE = {
      'job-completed': 'success',
      'job-failed': 'error',
      'job-killed': 'warning',
      'turn-end': 'info',
      'attention-question': 'warning',
      'attention-approval': 'warning',
    }

    const bannerHost = { el: null }
    function ensureBannerHost() {
      if (bannerHost.el !== null && bannerHost.el.isConnected) return bannerHost.el
      if (typeof document === 'undefined' || document.body === null) return null
      const root = document.createElement('div')
      root.setAttribute('data-dsh-job-notify', 'banners')
      Object.assign(root.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483000',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: '360px',
        pointerEvents: 'none',
      })
      document.body.appendChild(root)
      bannerHost.el = root
      return root
    }

    function showBanner(frame) {
      const root = ensureBannerHost()
      if (root === null) return
      const tone = BANNER_TONE[frame.kind] ?? 'info'
      const accent =
        tone === 'success'
          ? 'var(--dsw-alias-state-success-primary, #22c55e)'
          : tone === 'error'
            ? 'var(--dsw-alias-state-error-primary, #ef4444)'
            : tone === 'warning'
              ? 'var(--dsw-alias-state-warning-primary, #f59e0b)'
              : 'var(--dsw-alias-state-business-primary, #3b82f6)'

      const card = document.createElement('div')
      Object.assign(card.style, {
        pointerEvents: 'auto',
        display: 'flex',
        gap: '10px',
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
        borderLeft: `3px solid ${accent}`,
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        boxShadow: '0 6px 20px rgba(0,0,0,.16)',
        color: 'var(--dsw-alias-label-primary, #111)',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        cursor: 'pointer',
        animation: 'dsh-job-notify-in .18s ease-out',
      })

      const body = document.createElement('div')
      Object.assign(body.style, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' })

      const title = document.createElement('div')
      title.textContent = frame.title
      Object.assign(title.style, { fontWeight: '600' })

      body.appendChild(title)
      if (typeof frame.body === 'string' && frame.body !== '') {
        const detail = document.createElement('div')
        detail.textContent = frame.body
        Object.assign(detail.style, {
          color: 'var(--dsw-alias-label-secondary, #555)',
          overflowWrap: 'anywhere',
        })
        body.appendChild(detail)
      }

      card.appendChild(body)
      card.addEventListener('click', () => card.remove())
      root.appendChild(card)
      setTimeout(() => card.remove(), BANNER_MS)
    }

    // ── Permission-free attention signals ─────────────────────────────────
    //
    // When the Notification API is unavailable (insecure context, denied
    // permission, embargo), these three signals fire alongside the banner so
    // the user still notices even when the tab is in the background:
    //
    // 1. **Title flash** — prepend `(N)` to the tab title and blink it so a
    //    background tab stands out in the tab strip.
    // 2. **Sound** — a short chime generated via Web Audio API, no audio file
    //    needed. Browsers allow audio after the first user interaction on the
    //    page (any click satisfies this), so it works without explicit
    //    permission.
    // 3. **Favicon badge** — draw a red dot with a count onto the favicon so
    //    the tab icon changes even without the title.

    /** How many unread notifications the tab is currently announcing. */
    let unreadCount = 0
    /** The original document title, captured before the first flash. */
    let originalTitle = null
    /** The favicon link element, captured lazily. */
    let faviconLink = null
    /** The original favicon href, captured before the first badge. */
    let originalFavicon = null
    /** Timer driving the title blink. */
    let blinkTimer = null
    /** Whether the title is currently showing the notification or the original. */
    let blinkOn = false
    let attentionWired = false

    /** A crystalline tri-tone bell: three quick ascending strikes (C6 → E6 → G6). */
    function playChime() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (Ctor === undefined) return
        const ctx = new Ctor()
        const master = ctx.createGain()
        master.gain.value = 0.55
        master.connect(ctx.destination)

        /**
         * One crystalline strike: fundamental sine + two inharmonic partials
         * that decay faster than the root, giving the bell a "ting" that
         * brightens then focuses.
         */
        const strike = (base, start, loudness) => {
          const partials = [
            [1, 1.0, 0.28],
            [2.0, 0.18, 0.18],
            [3.5, 0.08, 0.10],
          ]
          for (const [mult, level, decay] of partials) {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.connect(gain)
            gain.connect(master)
            osc.type = 'sine'
            osc.frequency.value = base * mult
            gain.gain.setValueAtTime(0, start)
            gain.gain.linearRampToValueAtTime(loudness * level, start + 0.004)
            gain.gain.exponentialRampToValueAtTime(0.0008, start + decay)
            osc.start(start)
            osc.stop(start + decay + 0.03)
          }
        }

        // C6, E6, G6 — ascending major triad, each note ~90 ms apart.
        const gap = 0.09
        const notes = [1046.5, 1318.5, 1568.0]
        notes.forEach((freq, i) => {
          strike(freq, ctx.currentTime + i * gap, 0.28)
        })

        setTimeout(() => {
          try {
            ctx.close()
          } catch {}
        }, 700)
      } catch {
        // AudioContext blocked before any user gesture — silently skip.
      }
    }

    /** How many unread notifications the tab is currently announcing. */

    /** Draw a red badge with a count onto the favicon and swap it in. */
    function setFaviconBadge(count) {
      if (typeof document === 'undefined') return
      if (faviconLink === null) {
        faviconLink = document.querySelector('link[rel="icon"]') || document.querySelector('link[rel="shortcut icon"]')
        if (faviconLink !== null) originalFavicon = faviconLink.href
      }
      if (faviconLink === null) {
        faviconLink = document.createElement('link')
        faviconLink.rel = 'icon'
        document.head.appendChild(faviconLink)
      }
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const g = canvas.getContext('2d')
      if (g === null) return
      if (typeof originalFavicon === 'string' && originalFavicon !== '') {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
          g.drawImage(img, 0, 0, 32, 32)
          drawBadge(g, count)
        }
        img.onerror = () => {
          drawBadge(g, count)
        }
        img.src = originalFavicon
      } else {
        drawBadge(g, count)
      }
    }

    /** Draw a red badge with a count onto the favicon and swap it in. */
    function drawBadge(g, count) {
      const r = 8
      const cx = 32 - r - 1
      const cy = 32 - r - 1
      g.beginPath()
      g.arc(cx, cy, r, 0, 2 * Math.PI)
      g.fillStyle = '#ef4444'
      g.fill()
      g.fillStyle = '#fff'
      g.font = 'bold 10px sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(String(count > 9 ? '9+' : count), cx, cy + 0.5)
      try {
        faviconLink.href = canvasToHref(g)
      } catch {
        // canvas tainted
      }
    }

    function canvasToHref(g) {
      return g.canvas.toDataURL('image/png')
    }

    function clearFaviconBadge() {
      if (faviconLink !== null && typeof originalFavicon === 'string') {
        faviconLink.href = originalFavicon
      }
    }

    /** Start blinking the tab title with the unread count. */
    function startTitleBlink() {
      if (typeof document === 'undefined') return
      if (originalTitle === null) originalTitle = document.title
      if (blinkTimer !== null) return
      blinkOn = false
      blinkTimer = setInterval(() => {
        blinkOn = !blinkOn
        document.title = blinkOn
          ? `(${unreadCount}) ${originalTitle}`
          : originalTitle
      }, 800)
    }

    /** Stop blinking and restore the title and favicon. */
    function stopTitleBlink() {
      if (blinkTimer !== null) {
        clearInterval(blinkTimer)
        blinkTimer = null
      }
      if (originalTitle !== null) {
        document.title = originalTitle
      }
      clearFaviconBadge()
      unreadCount = 0
    }

    /** Restore the favicon to its original href. */
    function clearFaviconBadge() {
      if (faviconLink !== null && typeof originalFavicon === 'string') {
        faviconLink.href = originalFavicon
      }
    }

    /** Wire the one-time listener that clears attention when the user returns. */
    function ensureAttentionCleanup() {
      if (attentionWired || typeof document === 'undefined') return
      attentionWired = true
      const clear = () => {
        if (document.visibilityState === 'visible' || document.hasFocus?.()) {
          stopTitleBlink()
        }
      }
      document.addEventListener('visibilitychange', clear)
      window.addEventListener('focus', clear)
    }

    /**
     * Fire every permission-free signal for one notification.
     */
    function flashAttention(frame) {
      ensureAttentionCleanup()
      unreadCount += 1
      playChime()
      setFaviconBadge(unreadCount)
      startTitleBlink()
    }

    function pickSharedForm(forms) {
      if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
      for (const key of NAMESPACES) {
        try {
          const form = forms.get(key)
          if (form === undefined || form === null || typeof form.getSnapshot !== 'function') continue
          const snapshot = form.getSnapshot()
          if (snapshot !== undefined && snapshot !== null && snapshot.status !== 'unavailable') return form
        } catch {
          // A namespace the settings mirror does not serve is simply not this one.
        }
      }
      return undefined
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 },
      heading: { margin: '4px 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' },
      textBlock: { display: 'flex', flexDirection: 'column', gap: 2 },
      label: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      status: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      notice: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      divider: { height: 1, margin: '6px 0', background: 'var(--dsw-alias-border-l1)' },
      fieldLabel: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 30,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 13,
      },
      checkbox: { marginTop: 3, width: 14, height: 14, accentColor: 'var(--dsw-alias-brand-primary)' },
      button: {
        alignSelf: 'flex-start',
        marginTop: 4,
        padding: '0 12px',
        height: 28,
        font: 'inherit',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        cursor: 'pointer',
      },
    }

    function statusLine(text) {
      return h('p', { style: S.status }, text)
    }

    function Toggle({ text, hint, checked, disabled, onChange }) {
      return h(
        'label',
        { style: { ...S.row, opacity: disabled ? 0.6 : 1 } },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
          style: S.checkbox,
        }),
        h(
          'span',
          { style: S.textBlock },
          h('span', { style: S.label }, text),
          hint === undefined ? null : h('span', { style: S.hint }, hint),
        ),
      )
    }

    /**
     * Live report of what this page can do, plus the one action a user must
     * take themselves.
     */
    function BrowserNotice() {
      const [channel, setChannel] = React.useState(() => detectChannel())
      const [busy, setBusy] = React.useState(false)

      const refresh = React.useCallback(() => setChannel(detectChannel()), [])

      React.useEffect(() => {
        window.addEventListener('focus', refresh)
        return () => window.removeEventListener('focus', refresh)
      }, [refresh])

      const ask = async () => {
        setBusy(true)
        try {
          await requestPermission()
        } finally {
          setBusy(false)
          refresh()
        }
      }

      const tone =
        channel.native === true
          ? { color: 'var(--dsw-alias-state-success-primary)' }
          : { color: 'var(--dsw-alias-state-warning-primary)' }

      return h(
        'div',
        { style: S.textBlock },
        h(
          'p',
          { style: { ...S.hint, ...tone } },
          channel.native === true
            ? '本页可以弹系统通知。'
            : `${channel.reason ?? '无法弹系统通知'}。`,
        ),
        channel.kind === 'prompt'
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: ask,
                style: S.button,
              },
              busy ? '正在请求…' : '允许通知',
            )
          : null,
        channel.kind === 'insecure'
          ? h(
              'p',
              { style: S.hint },
              '系统通知要求 HTTPS 或 localhost。想让这个地址也能弹通知，需要给 dsh web 配证书（--tls-cert / --tls-key），或用隧道给它一个 https 域名。',
            )
          : null,
      )
    }

    function Toggle({ text, hint, checked, disabled, onChange }) {
      return h(
        'label',
        { style: { ...S.row, opacity: disabled ? 0.6 : 1 } },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
          style: S.checkbox,
        }),
        h(
          'span',
          { style: S.textBlock },
          h('span', { style: S.label }, text),
          hint === undefined ? null : h('span', { style: S.hint }, hint),
        ),
      )
    }

    function JobNotifyConfig(props) {
      const form = props.pluginForm
      const subscribe = React.useCallback(
        (callback) => (form === undefined ? () => {} : form.subscribe(callback)),
        [form],
      )
      const getSnapshot = React.useCallback(
        () => (form === undefined ? EMPTY_SNAPSHOT : form.getSnapshot()),
        [form],
      )
      const state = React.useSyncExternalStore(subscribe, getSnapshot)
      const [notice, setNotice] = React.useState('')
      const [appIdDraft, setAppIdDraft] = React.useState(null)
      // Settings writes are revision-checked by the Host. Two fast clicks used
      // to race with the same revision, so the second write was rejected as a
      // conflict; chaining the writes and re-reading the revision makes every
      // click land on the version the previous one produced.
      const writeChain = React.useRef(Promise.resolve())

      if (form === undefined) {
        return statusLine('没有拿到配置表单：这个 profile 没有为 job-notify 这个配置命名空间提供表单服务。')
      }
      if (state.status === 'loading') return statusLine('正在读取配置…')
      if (state.status === 'unavailable') return statusLine('配置命名空间没有暴露给当前客户端。')

      const value = state.value !== null && typeof state.value === 'object' ? state.value : {}
      const writable = state.writable !== false

      const write = (key, next) => {
        setNotice('')
        writeChain.current = writeChain.current
          .then(async () => {
            const latest = form.getSnapshot()
            const revision = latest !== null && latest !== undefined ? latest.revision : state.revision
            const ok = await form.mutate([{ op: 'set', path: [key], value: next }], revision)
            if (!ok) setNotice('Host 拒绝了这次修改。')
          })
          .catch((error) => {
            const message = String((error && error.message) || error)
            setNotice(
              /changed since it was read/i.test(message)
                ? '设置已被其他窗口修改，已读取最新值，请再试一次。'
                : `写入失败：${message}`,
            )
          })
      }

      const appId = typeof value.appId === 'string' && value.appId !== '' ? value.appId : 'com.deepseek.dsh'

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.heading }, '总开关'),
        h(Toggle, {
          text: '启用通知',
          hint: '关闭后不再订阅任务与轮次事件，已排队的通知仍可能弹出。',
          checked: value.enabled !== false,
          disabled: !writable,
          onChange: (next) => write('enabled', next),
        }),
        h('div', { style: S.divider }),
        h('div', { style: S.heading }, '通知内容'),
        h('p', { style: S.hint }, '关掉某项后，通知正文不再包含对应部分。'),
        h(Toggle, {
          text: '显示任务标签',
          hint: '通知正文带上命令或任务名。',
          checked: value.showLabel !== false,
          disabled: !writable,
          onChange: (next) => write('showLabel', next),
        }),
        h(Toggle, {
          text: '显示耗时',
          hint: '后台任务与对话轮次都显示耗时。',
          checked: value.showDuration !== false,
          disabled: !writable,
          onChange: (next) => write('showDuration', next),
        }),
        h(Toggle, {
          text: '显示退出码 / 失败原因',
          checked: value.showExitCode !== false,
          disabled: !writable,
          onChange: (next) => write('showExitCode', next),
        }),
        h('div', { style: S.divider }),
        h('div', { style: S.heading }, '提醒时机'),
        h(Toggle, {
          text: '后台任务完成',
          checked: value.onCompleted !== false,
          disabled: !writable,
          onChange: (next) => write('onCompleted', next),
        }),
        h(Toggle, {
          text: '后台任务失败或异常退出',
          checked: value.onFailed !== false,
          disabled: !writable,
          onChange: (next) => write('onFailed', next),
        }),
        h(Toggle, {
          text: '后台任务被停止',
          checked: value.onKilled !== false,
          disabled: !writable,
          onChange: (next) => write('onKilled', next),
        }),
        h(Toggle, {
          text: '每轮对话结束',
          hint: '只提醒你自己这条会话，子代理与工作流轮次不提醒。',
          checked: value.notifyTurnEnd !== false,
          disabled: !writable,
          onChange: (next) => write('notifyTurnEnd', next),
        }),
        h(Toggle, {
          text: '需要你选择时',
          hint: 'agent 通过 ask_user_question 等你回答时提醒。',
          checked: value.notifyQuestions !== false,
          disabled: !writable,
          onChange: (next) => write('notifyQuestions', next),
        }),
        h(Toggle, {
          text: '需要你批准时',
          hint: '工具调用等待你审批时提醒。',
          checked: value.notifyApprovals !== false,
          disabled: !writable,
          onChange: (next) => write('notifyApprovals', next),
        }),
        h(Toggle, {
          text: '只提醒后台任务',
          hint: '前台命令、以及 agent 正在等待的任务保持安静；不影响对话轮次提醒。',
          checked: value.skipAwaited !== false,
          disabled: !writable,
          onChange: (next) => write('skipAwaited', next),
        }),
        h('div', { style: S.divider }),
        h('div', { style: S.heading }, '浏览器通知（dsh web）'),
        h(Toggle, {
          text: '在浏览器里也提醒',
          hint: 'Host 把任务与轮次事件推到这个页面，由浏览器弹出系统通知。',
          checked: value.notifyWeb !== false,
          disabled: !writable,
          onChange: (next) => write('notifyWeb', next),
        }),
        h(Toggle, {
          text: '弹不出系统通知时，改用页面内提示条',
          hint: 'http 局域网地址不是安全上下文，浏览器会禁止系统通知；关掉后这类地址就完全不提醒。',
          checked: value.webFallback !== false,
          disabled: !writable,
          onChange: (next) => write('webFallback', next),
        }),
        h(Toggle, {
          text: '浏览器端提醒时播放提示音',
          hint: '可在插件设置里关闭铃声。',
          checked: value.webSound !== false,
          disabled: !writable,
          onChange: (next) => write('webSound', next),
        }),
        h('div', { style: S.divider }),
        h('label', { style: S.fieldLabel }, 'Toast AppUserModelID'),
        h('input', {
          type: 'text',
          value: appIdDraft === null ? appId : appIdDraft,
          disabled: !writable,
          spellCheck: false,
          onChange: (event) => setAppIdDraft(event.target.value),
          onBlur: () => {
            const draft = appIdDraft
            setAppIdDraft(null)
            if (draft === null) return
            const next = draft.trim()
            if (next === '' || next === appId) return
            if (next.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(next)) {
              setNotice('AppUserModelID 只能包含字母、数字、点、下划线和连字符，且不超过 128 个字符。')
              return
            }
            write('appId', next)
          },
          style: S.input,
        }),
        h('p', { style: S.hint }, '默认 com.deepseek.dsh，也就是 Harness 自己的通知来源。'),
        notice === '' ? null : h('p', { style: S.notice }, notice),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * Check if the fallback banner is enabled in config.
         */
        function fallbackEnabled() {
          const form = pickSharedForm(ctx.get('configForms'))
          if (form === undefined) return true
          try {
            const snapshot = form.getSnapshot()
            const value = snapshot?.value
            if (value === null || typeof value !== 'object') return true
            return value.webFallback !== false
          } catch {
            return true
          }
        }

        /**
         * Check if the chime sound is enabled in config.
         */
        function soundEnabled() {
          const form = pickSharedForm(ctx.get('configForms'))
          if (form === undefined) return true
          try {
            const snapshot = form.getSnapshot()
            const value = snapshot?.value
            if (value === null || typeof value !== 'object') return true
            return value.webSound !== false
          } catch {
            return true
          }
        }

        // The stream is independent of the settings UI: a user who never opens
        // the Plugins panel still gets notifications while the page is open.
        const offStream = connectStream(
          (frame) => {
            if (!shouldShow(frame)) return
            const channel = detectChannel()
            const shown = channel.native ? showNative(frame) : undefined
            if (shown === undefined && fallbackEnabled()) {
              showBanner(frame)
              flashAttention(frame)
            } else if (shown === undefined) {
              flashAttention(frame)
            }
          },
          () => {},
        )
        ctx.effect(() => () => {
          offStream()
          stopTitleBlink()
        }, 'job-notify: browser notifications')

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE,
              inject: () => ({ pluginForm: pickSharedForm(ctx.get('configForms')) }),
            },
            JobNotifyConfig,
          ),
        )
      },
    }
  },
})