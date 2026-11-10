/**
 * Pure formatting and decision helpers for @local/dsh-job-notify.
 *
 * Everything here is free of Node APIs and of the plugin context, so the Host
 * half can stay a thin event-to-toast translator and these rules can be unit
 * tested without a running Harness.
 * @module @local/dsh-job-notify/format
 */

/** The AppUserModelID the Harness desktop shell registers. */
export const DEFAULT_APP_ID = 'com.deepseek.dsh'

/** Display budgets. A Windows toast renders two short lines, so stay modest. */
export const LIMITS = Object.freeze({
  label: 140,
  detail: 90,
  excerpt: 200,
  title: 80,
  appId: 128,
})

/** Compact job titles, keyed by {@link outcomeOf}. */
const JOB_TITLES = Object.freeze({
  completed: '后台任务已完成',
  failed: '后台任务失败',
  killed: '后台任务已停止',
  nonzero: '后台任务异常退出',
})

/** Turn-end reasons worth a notification. Cancelled and blocked turns are not. */
export const TURN_REASONS = new Set(['completed', 'error', 'max-tokens'])

/** Read a possibly-volatile Config field; ordinary values pass through. */
export function readConfigValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Accept an AppUserModelID-shaped string, or fall back to the Harness default. */
export function appIdOf(value, fallback = DEFAULT_APP_ID) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > LIMITS.appId) return fallback
  // An AUMID is a dot-separated, shell-safe identifier. Refusing anything else
  // keeps a bad config value from failing inside ToastNotificationManager.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : fallback
}

/** Read the row's Config, defaulting every switch to on. */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const bool = (key, fallback = true) => {
    const value = readConfigValue(raw[key])
    return value === undefined || value === null ? fallback : value !== false
  }
  const text = (key, fallback) => {
    const value = readConfigValue(raw[key])
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    enabled: bool('enabled'),
    onCompleted: bool('onCompleted'),
    onFailed: bool('onFailed'),
    onKilled: bool('onKilled'),
    // A foreground shell call is also a job, but its caller waits for it: only
    // an unawaited settlement is work nobody collected, i.e. a real background
    // task. Set `skipAwaited: false` to notify on every settlement.
    skipAwaited: bool('skipAwaited'),
    // On by default: the user asked for turn completion to be visible, and it
    // fires once per turn. Set `notifyTurnEnd: false` to keep only job toasts.
    notifyTurnEnd: bool('notifyTurnEnd'),
    showLabel: bool('showLabel'),
    showDuration: bool('showDuration'),
    showExitCode: bool('showExitCode'),
    appId: appIdOf(text('appId', DEFAULT_APP_ID)),
  }
}

/** Grapheme splitter when the runtime has one, so emoji are never cut in half. */
const segmenter =
  typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

/** Split into user-perceived characters, falling back to code points. */
function graphemes(text) {
  if (segmenter !== undefined) return Array.from(segmenter.segment(text), part => part.segment)
  return Array.from(text)
}

/** Collapse whitespace and clamp to `limit` graphemes, appending an ellipsis. */
export function compact(value, limit) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = graphemes(flat)
  if (parts.length <= limit) return flat
  return `${parts.slice(0, Math.max(1, limit - 1)).join('')}…`
}

/** Human-friendly elapsed time between two epoch milliseconds. */
export function elapsed(startedAt, finishedAt) {
  if (typeof startedAt !== 'number' || typeof finishedAt !== 'number') return ''
  const seconds = (finishedAt - startedAt) / 1000
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  // Sub-minute values keep one decimal; everything above rounds to whole
  // seconds first so a value like 119.9 s cannot render as "1 分 60 秒".
  if (seconds < 59.95) return `${seconds.toFixed(1)} 秒`
  const totalSeconds = Math.round(seconds)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const rest = totalSeconds % 60
  if (totalMinutes < 60) return rest === 0 ? `${totalMinutes} 分` : `${totalMinutes} 分 ${rest} 秒`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) return `${hours} 小时`
  return rest === 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时 ${minutes} 分 ${rest} 秒`
}

/**
 * The process exit code a job's detail reports, when it reports one.
 *
 * Shell producers write `exit code: N`; the bracket form `[exit code: N]` is a
 * tool-result marker that carries the same fact. Both are accepted, and a
 * negative code stays negative.
 */
export function exitCodeOf(detail) {
  const match = /(?:^|[^A-Za-z0-9_])exit code:\s*(-?\d+)/i.exec(String(detail ?? ''))
  return match === null ? undefined : Number(match[1])
}

/**
 * Which switch and title one settlement answers to. A shell tool reports a
 * nonzero exit as `completed` with `detail: "exit code: N"`, so the code — not
 * the status — decides whether the task actually succeeded.
 */
export function outcomeOf(job) {
  if (job === null || job === undefined) return undefined
  if (job.status === 'killed') return 'killed'
  if (job.status === 'failed') return 'failed'
  const code = exitCodeOf(job.detail)
  return code !== undefined && code !== 0 ? 'nonzero' : 'completed'
}

/** Compose one toast payload from a settled job view, or undefined when unknown. */
export function buildJobToast(config, job) {
  const outcome = outcomeOf(job)
  const title = outcome === undefined ? undefined : JOB_TITLES[outcome]
  if (title === undefined) return undefined
  const parts = []
  if (config.showLabel) {
    parts.push(compact(job.label, LIMITS.label) || compact(job.kind, LIMITS.label) || '后台任务')
  }
  if (config.showExitCode) {
    if (outcome === 'nonzero') {
      const code = exitCodeOf(job.detail)
      parts.push(code === undefined ? '退出码未知' : `退出码 ${code}`)
    } else if (outcome !== 'completed') {
      parts.push(compact(job.detail, LIMITS.detail))
    }
  }
  if (config.showDuration) parts.push(elapsed(job.startedAt, job.finishedAt))
  return { title, body: parts.filter(part => part !== '').join(' · '), appId: config.appId }
}

/** Compose one turn-completion toast. */
export function buildTurnToast(config, title, body, duration) {
  const parts = []
  const text = compact(body, LIMITS.excerpt)
  if (text !== '') parts.push(text)
  if (config.showDuration && duration !== '') parts.push(duration)
  return {
    title: compact(title, LIMITS.title) || 'DeepSeek Harness',
    body: parts.join(' · '),
    appId: config.appId,
  }
}

/**
 * Drop Markdown syntax: a toast renders plain text, so markers would show
 * literally. The rules are deliberately conservative — `snake_case` and a bare
 * `|` are ordinary prose, not emphasis or a table — because the excerpt is a
 * human-facing summary, not a Markdown renderer.
 */
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    // `__dunder__` is an identifier far more often than Markdown emphasis, so
    // only the unambiguous `**bold**` form is stripped.
    .replace(/(?<![\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])/g, '$1')
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?!_)(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
}

/** Concatenate the text blocks of one assistant message. */
export function extractAssistantText(data) {
  const message = data !== null && data !== undefined ? data.message : undefined
  const blocks =
    message !== null && message !== undefined && Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const raw = parts.join('\n')
  if (raw === '') return ''
  const stripped = compact(plainText(raw), LIMITS.excerpt)
  if (stripped !== '') return stripped
  // A message that is entirely a code block would strip to nothing; keep the
  // code itself, without the fences, rather than a blank notification.
  const code = raw.replace(/^\s*(?:```|~~~)[^\n]*$/gm, ' ').replace(/\s*(?:```|~~~)\s*/g, ' ')
  return compact(code, LIMITS.excerpt) || compact(raw, LIMITS.excerpt)
}

/** Extract the human-readable failure line from a `turn/end` error reason. */
export function turnErrorMessage(reason) {
  const candidates = [
    reason?.error?.message,
    typeof reason?.error === 'string' ? reason.error : undefined,
    reason?.message,
    reason?.reason?.message,
    typeof reason?.reason === 'string' ? reason.reason : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return compact(plainText(candidate), LIMITS.detail)
    }
  }
  return ''
}
