/**
 * Windows native notifications for finished background jobs and conversation
 * turns.
 *
 * Subscribes to the jobs registry's `settled` events and to a Session's
 * `turn/end` events, then shows a Windows toast through Windows PowerShell
 * 5.1's WinRT ToastNotificationManager. The toast uses the Harness desktop
 * AppUserModelID, so it appears as "DeepSeek Harness" instead of a generic
 * PowerShell source.
 *
 * @module @local/dsh-job-notify
 */
import z from '@deepseek-ai/schemastery'
import {
  buildJobToast,
  buildTurnToast,
  elapsed,
  extractAssistantText,
  normalizeConfig,
  outcomeOf,
  TURN_REASONS,
  turnErrorMessage,
} from './lib/format.js'
import { createToastRunner, ToastQueue } from './lib/toast.js'

/** The jobs registry is the only source of job completion events. */
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
})

/**
 * Show one Windows notification per settled background job.
 * @param ctx - the plugin context.
 * @param config - the row's optional config object.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger.debug('job-notify: disabled by config')
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger.info('job-notify: native toasts need Windows; the plugin stays idle on this platform')
    return
  }

  const queue = new ToastQueue({ run: createToastRunner(), logger: ctx.logger })
  const enqueue = payload => {
    queue.enqueue(payload)
  }

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
    if (payload !== undefined) enqueue(payload)
  })

  const disposeTurns = settings.notifyTurnEnd
    ? installTurnEndReporter(ctx, settings, enqueue)
    : undefined

  ctx.effect(() => () => {
    unsubscribe()
    disposeTurns?.()
    queue.close()
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
 * @returns a disposer that drops the per-session caches.
 */
function installTurnEndReporter(ctx, settings, enqueue) {
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

    enqueue(
      buildTurnToast(settings, sessionTitleOf(ctx, session), body, elapsed(startedAt, finishedAt)),
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
