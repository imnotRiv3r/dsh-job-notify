/**
 * Native notifications for finished background jobs and conversation turns,
 * on both faces of the Harness.
 *
 * Subscribes to the jobs registry's `settled` events and to a Session's
 * `turn/end` events, then delivers each notification through whichever channel
 * can reach the user:
 *
 * - **Desktop (Windows Host)**: a Windows toast through Windows PowerShell
 *   5.1's WinRT ToastNotificationManager, using the Harness desktop
 *   AppUserModelID so it appears as "DeepSeek Harness" rather than a generic
 *   PowerShell source.
 * - **Browser (`dsh web`)**: a Server-Sent Event on {@link EVENTS_PATH} that
 *   the browser half turns into a system notification, or — when the page is
 *   not a secure context and the Notification API is therefore unavailable —
 *   an in-page banner.
 *
 * The two channels are independent: the browser path runs whenever the web
 * server exists, even on a Host that has no desktop at all.
 *
 * @module dsh-job-notify
 */
import z from '@deepseek-ai/schemastery'
import {
  approvalAttention,
  buildJobToast,
  buildTurnToast,
  buildWebNotification,
  elapsed,
  extractAssistantText,
  normalizeConfig,
  outcomeOf,
  questionAttention,
  TURN_REASONS,
  turnErrorMessage,
  WEB_KINDS,
} from './lib/format.js'
import { EVENTS_PATH, NotifyHub } from './lib/notify-hub.js'
import { createToastRunner, ToastQueue } from './lib/toast.js'

/** The jobs registry is the only source of job completion events.
 *
 * `webServer` is optional and read via ctx.inject so a headless profile still
 * mounts the Windows toast path.
 */
export const inject = ['jobs']

/**
 * The row's editable Config. Declaring it gives the bundle a configuration page
 * in the Plugins panel and validates anything the profile patch supplies.
 *
 * Every field is `.volatile()`: the settings service builds its editable form
 * from volatile nodes only (`volatileForm` in `@deepseek-ai/dsh-settings`), so a
 * plain field would never appear. A volatile field parses into a stable
 * reference, so `apply` reads each one through `readConfigValue`.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('总开关：关闭后不发送任何通知。'),
  notifyTurnEnd: z.boolean().default(true).volatile().description('每轮对话结束时提醒。'),
  notifyQuestions: z
    .boolean()
    .default(true)
    .volatile()
    .description('agent 通过 ask_user_question 需要你选择时提醒。'),
  notifyApprovals: z
    .boolean()
    .default(true)
    .volatile()
    .description('工具调用需要你批准时提醒。'),
  onCompleted: z.boolean().default(true).volatile().description('后台任务完成时提醒。'),
  onFailed: z.boolean().default(true).volatile().description('后台任务失败或异常退出时提醒。'),
  onKilled: z.boolean().default(true).volatile().description('后台任务被停止时提醒。'),
  skipAwaited: z
    .boolean()
    .default(true)
    .volatile()
    .description('只提醒无人等待的后台任务，前台命令保持安静。'),
  showLabel: z.boolean().default(true).volatile().description('提醒正文显示任务标签（命令内容）。'),
  showDuration: z.boolean().default(true).volatile().description('提醒正文显示耗时。'),
  showExitCode: z.boolean().default(true).volatile().description('提醒正文显示退出码或失败原因。'),
  appId: z.string().default('com.deepseek.dsh').volatile().description('Toast 使用的 AppUserModelID。'),
  notifyWeb: z.boolean().default(true).volatile().description('浏览器里也提醒（dsh web）。'),
  webFallback: z
    .boolean()
    .default(true)
    .volatile()
    .description('弹不出系统通知时改用页面内提示条。'),
  webSound: z
    .boolean()
    .default(true)
    .volatile()
    .description('浏览器端提醒时播放提示音。'),
})

/**
 * Deliver one notification per settled background job and per finished turn,
 * through every channel that can reach the user.
 *
 * The Windows toast and the browser stream are independent: a Host may be a
 * headless server with no desktop at all, in which case only the browser path
 * is meaningful, and a Windows Host may have no browser page open.
 *
 * @param ctx - the plugin context.
 * @param config - the row's optional config object.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger.debug('job-notify: disabled by config')
    return
  }

  const queue = new ToastQueue({ run: createToastRunner(), logger: ctx.logger })
  const toasts = []

  // Browser channel: registered via ctx.inject so webServer may activate after
  // this plugin. A headless profile simply never calls this.
  let hub
  if (settings.notifyWeb) {
    ctx.inject(['webServer', 'connection'], child => {
      hub = new NotifyHub({ logger: ctx.logger })
      child.webServer.register({
        kind: 'exact',
        path: EVENTS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const rejection = child.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection, {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end('dsh web authentication required\n')
            return
          }
          hub.add(res)
        },
      })
      child.effect(() => () => {
        hub?.close()
        hub = undefined
      }, 'job-notify: browser event stream')
      ctx.logger.debug('job-notify: browser channel on /api/job-notify/events')
    })
  }

  /**
   * Hand one notification to every available channel.
   *
   * `web` carries the browser-only extras (kind, tag, urgency); the toast half
   * ignores them.
   */
  const deliver = (payload, web) => {
    if (payload === undefined) return
    if (queue !== undefined) queue.enqueue(payload)
    if (hub !== undefined && web !== undefined) {
      const frame = buildWebNotification(web.kind, payload, web)
      if (frame !== undefined) hub.broadcast(frame)
    }
  }

  ctx.logger.debug(
    `job-notify: windows toast on, browser ${settings.notifyWeb ? 'pending' : 'off'}`,
  )

  const unsubscribe = ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type !== 'settled') return
    // Teardown settlements belong to unloading sessions, not to finished user work.
    if (event.cause === 'teardown') return
    const job = event.job
    const outcome = outcomeOf(job)
    if (outcome === undefined) return
    if (outcome === 'completed' && !settings.onCompleted) return
    if ((outcome === 'failed' || outcome === 'nonzero') && !settings.onFailed) return
    if (outcome === 'killed' && !settings.onKilled) return
    // `awaited` means a waiting caller already collected this settlement, which
    // covers every foreground shell call; those are not background tasks.
    if (settings.skipAwaited && event.awaited) return
    const payload = buildJobToast(settings, job)
    deliver(payload, {
      kind: WEB_KINDS[outcome] ?? WEB_KINDS.completed,
      // One job, one notification: a repeat settlement for the same job must
      // replace its predecessor instead of stacking beside it.
      tag: `job:${String(job.id)}`,
      sessionId: typeof job.owner === 'string' ? job.owner : undefined,
    })
  })

  const disposeTurns = settings.notifyTurnEnd
    ? installTurnEndReporter(ctx, settings, deliver)
    : undefined
  const disposeAttention = installAttentionReporter(ctx, settings, deliver)

  ctx.effect(() => () => {
    unsubscribe()
    disposeTurns?.()
    disposeAttention()
    queue.close()
    hub?.close()
  })
}

/**
 * Turn-completion notifications: one toast per finished turn of the user's own
 * conversation, titled with that Session's title and carrying an excerpt of the
 * answer that closed the turn.
 *
 * A Session is the source of truth here rather than the agent status: `turn/end`
 * names the reason the turn closed, and the `assistant/message` events that
 * precede it carry the text to excerpt. Subagent sessions are skipped by their
 * header origin, since their turns are not the user's conversation.
 *
 * @param ctx - the plugin context.
 * @param settings - the row's normalized config object.
 * @param deliver - hands one notification to every live channel.
 * @returns a disposer that drops the per-session caches.
 */
function installTurnEndReporter(ctx, settings, deliver) {
  /** Last assistant text of each Session, keyed by Session id. */
  const lastText = new Map()
  /** When the open turn started, keyed by Session id. */
  const turnStarted = new Map()

  const forget = sessionId => {
    lastText.delete(sessionId)
    turnStarted.delete(sessionId)
  }

  const onDisposed = session => {
    if (session !== null && session !== undefined && typeof session.id === 'string') forget(session.id)
  }
  const offDisposed = ctx.on('session/disposed', onDisposed)

  const onEvent = (session, event) => {
    if (session === null || session === undefined || event === null || event === undefined) return
    const sessionId = session.id
    if (typeof sessionId !== 'string') return

    if (event.type === 'turn/start') {
      turnStarted.set(sessionId, Date.now())
      return
    }
    if (event.type === 'assistant/message') {
      const text = extractAssistantText(event.data)
      if (text !== '') lastText.set(sessionId, text)
      return
    }
    if (event.type !== 'turn/end') return

    const reason = event.data !== null && event.data !== undefined ? event.data.reason : undefined
    const kind = reason !== undefined && reason !== null ? reason.kind : undefined
    // Cancelled or blocked turns are user actions with nothing new to read.
    if (!TURN_REASONS.has(kind)) {
      forget(sessionId)
      return
    }

    const header = session.header
    if (header !== undefined && header !== null && header.origin === 'subagent') {
      forget(sessionId)
      return
    }

    const startedAt = turnStarted.get(sessionId)
    const finishedAt = Date.now()
    const text = lastText.get(sessionId) ?? ''
    forget(sessionId)

    let body = text
    if (kind === 'error') {
      const message = turnErrorMessage(reason)
      body = message === '' ? '本轮出错' : `本轮出错：${message}`
    } else if (body === '') {
      // A turn that only called tools has no answer text to excerpt; the toast
      // still tells the user the conversation moved on.
      body = kind === 'max-tokens' ? '本轮达到输出上限' : '本轮已完成'
    }

    deliver(
      buildTurnToast(settings, sessionTitleOf(ctx, session), body, elapsed(startedAt, finishedAt)),
      {
        kind: WEB_KINDS.turn,
        // One conversation, one slot: the newest turn replaces the previous
        // turn's notification instead of stacking a column of them.
        tag: `turn:${sessionId}`,
        sessionId,
      },
    )
  }
  const offEvent = ctx.on('session/event', onEvent)

  return () => {
    if (typeof offDisposed === 'function') offDisposed()
    if (typeof offEvent === 'function') offEvent()
    lastText.clear()
    turnStarted.clear()
  }
}

/**
 * Attention notifications: the agent is blocked waiting for the user, which is
 * more urgent than a finished turn.
 *
 * Questions arrive on the `user-questions/request` waterfall; this listener is
 * an observer only and always delegates with `next()`, so it can never answer
 * or veto the question. Approvals are recorded as `approval/asked` Session
 * events, which are read-only and therefore cannot affect the decision.
 *
 * @param ctx - the plugin context.
 * @param settings - the row's normalized config object.
 * @param deliver - hands one notification to every live channel.
 */
function installAttentionReporter(ctx, settings, deliver) {
  const disposers = []

  if (settings.notifyApprovals) {
    const off = ctx.on('session/event', (session, event) => {
      if (session === null || session === undefined || event === null || event === undefined) return
      if (event.type !== 'approval/asked') return
      try {
        const title = sessionTitleOf(ctx, session)
        const sessionId = typeof session.id === 'string' ? session.id : undefined
        deliver(approvalAttention(settings, title, event.data), {
          kind: WEB_KINDS.approval,
          // A pending approval is a decision the user must make: it stays until
          // handled, and a later approval for the same session replaces it.
          tag: `approval:${sessionId ?? title}`,
          sessionId,
          requireInteraction: true,
        })
      } catch (error) {
        ctx.logger.warn(`job-notify: approval notification failed: ${String(error)}`)
      }
    })
    disposers.push(off)
  }

  if (settings.notifyQuestions) {
    const off = ctx.on('user-questions/request', (request, next) => {
      try {
        const session = request !== null && request !== undefined ? request.agent?.session : undefined
        const title = session === undefined || session === null ? 'DeepSeek Harness' : sessionTitleOf(ctx, session)
        const sessionId =
          session !== undefined && session !== null && typeof session.id === 'string'
            ? session.id
            : undefined
        deliver(questionAttention(settings, title, request), {
          kind: WEB_KINDS.question,
          tag: `question:${sessionId ?? title}`,
          sessionId,
          requireInteraction: true,
        })
      } catch (error) {
        ctx.logger.warn(`job-notify: question notification failed: ${String(error)}`)
      }
      return next()
    })
    disposers.push(off)
  }

  return () => {
    for (const off of disposers) if (typeof off === 'function') off()
  }
}

/** The Session's folded title, falling back to its workspace folder name. */
function sessionTitleOf(ctx, session) {
  const titles = ctx.get('sessionTitle')
  if (titles !== undefined && typeof titles.get === 'function') {
    try {
      const snapshot = titles.get(session)
      if (snapshot !== undefined && snapshot !== null && typeof snapshot.title === 'string') {
        const title = snapshot.title.trim()
        if (title !== '') return title
      }
    } catch {
      // A missing or failing fold only costs the title.
    }
  }
  const cwd = session.header !== undefined && session.header !== null ? session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd !== '') {
    const parts = cwd.split(/[\\/]/).filter(part => part !== '')
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return 'DeepSeek Harness'
}