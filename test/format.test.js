import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appIdOf,
  approvalAttention,
  buildAttentionToast,
  buildJobToast,
  buildTurnToast,
  compact,
  elapsed,
  exitCodeOf,
  extractAssistantText,
  normalizeConfig,
  outcomeOf,
  plainText,
  questionAttention,
  turnErrorMessage,
} from '../lib/format.js'

/** A settled job view shaped like the jobs registry's projection. */
function job(overrides = {}) {
  return {
    id: 'bash-1',
    kind: 'bash',
    label: 'npm run build',
    status: 'completed',
    detail: 'exit code: 0',
    startedAt: 1_000,
    finishedAt: 43_700,
    ...overrides,
  }
}

test('compact collapses whitespace and clamps by grapheme', () => {
  assert.equal(compact('  a\n\tb  ', 20), 'a b')
  assert.equal(compact('abcdef', 4), 'abc…')
  // One emoji stays whole instead of being cut into a surrogate half.
  assert.equal(compact('😀😀😀', 2), '😀…')
  assert.equal(compact('你好世界', 3), '你好…')
  assert.equal(compact(undefined, 5), '')
})

test('elapsed formats seconds, minutes, and hours', () => {
  assert.equal(elapsed(0, 1_500), '1.5 秒')
  assert.equal(elapsed(0, 59_000), '59.0 秒')
  assert.equal(elapsed(0, 90_000), '1 分 30 秒')
  assert.equal(elapsed(0, 119_900), '2 分')
  assert.equal(elapsed(0, 120_000), '2 分')
  assert.equal(elapsed(0, 3_599_900), '1 小时')
  assert.equal(elapsed(0, 3_900_000), '1 小时 5 分')
  assert.equal(elapsed(undefined, 5), '')
  assert.equal(elapsed(5, 1), '')
})

test('exitCodeOf reads producer details and tool markers', () => {
  assert.equal(exitCodeOf('exit code: 1'), 1)
  assert.equal(exitCodeOf('exit code: 0; sandbox: read-only'), 0)
  assert.equal(exitCodeOf('[exit code: 127]'), 127)
  assert.equal(exitCodeOf('exit code: -1'), -1)
  assert.equal(exitCodeOf('signal: SIGKILL'), undefined)
  assert.equal(exitCodeOf(''), undefined)
})

test('outcomeOf prefers status, then the exit code', () => {
  assert.equal(outcomeOf(job({ status: 'killed' })), 'killed')
  assert.equal(outcomeOf(job({ status: 'failed' })), 'failed')
  assert.equal(outcomeOf(job({ status: 'completed', detail: 'exit code: 2' })), 'nonzero')
  assert.equal(outcomeOf(job({ status: 'completed', detail: 'exit code: 0' })), 'completed')
  assert.equal(outcomeOf(undefined), undefined)
})

test('buildJobToast joins the enabled parts', () => {
  const settings = normalizeConfig({})
  const toast = buildJobToast(settings, job({ detail: 'exit code: 1' }))
  assert.deepEqual(toast, {
    title: '后台任务异常退出',
    body: 'npm run build · 退出码 1 · 42.7 秒',
    appId: 'com.deepseek.dsh',
  })
  assert.equal(buildJobToast(settings, job()).title, '后台任务已完成')
})

test('buildJobToast respects the display switches', () => {
  const settings = normalizeConfig({ showLabel: false, showDuration: false, showExitCode: false })
  assert.deepEqual(buildJobToast(settings, job()), {
    title: '后台任务已完成',
    body: '',
    appId: 'com.deepseek.dsh',
  })
  const failed = normalizeConfig({ showLabel: false, showDuration: false })
  assert.equal(buildJobToast(failed, job({ status: 'failed', detail: 'spawn ENOENT' })).body, 'spawn ENOENT')
})

test('normalizeConfig unwraps volatile references and validates the app id', () => {
  const ref = { get: () => false }
  const settings = normalizeConfig({ enabled: ref, appId: '  bad app id  ' })
  assert.equal(settings.enabled, false)
  assert.equal(settings.appId, 'com.deepseek.dsh')
  assert.equal(normalizeConfig({ appId: 'com.example.app' }).appId, 'com.example.app')
  assert.equal(appIdOf('com.example.app'), 'com.example.app')
  assert.equal(appIdOf('x'.repeat(129)), 'com.deepseek.dsh')
})

test('plainText strips Markdown but keeps ordinary prose', () => {
  assert.equal(plainText('**粗体** 和 `code`'), '粗体 和 code')
  assert.equal(plainText('snake_case_name stays'), 'snake_case_name stays')
  assert.equal(plainText('__init__ and _private stay'), '__init__ and _private stay')
  assert.equal(plainText('## 标题\n- 项目'), '标题\n项目')
  assert.equal(plainText('[链接](https://example.com)'), '链接')
  assert.equal(plainText('```js\ncode\n```'), ' ')
  assert.equal(plainText('| a | b |\n|---|---|\n| 1 | 2 |').trim(), '')
})

test('extractAssistantText concatenates text blocks and skips tool blocks', () => {
  const data = {
    message: {
      content: [
        { type: 'text', text: '第一段 **重点**' },
        { type: 'tool_use', name: 'read' },
        { type: 'text', text: '第二段' },
      ],
    },
  }
  assert.equal(extractAssistantText(data), '第一段 重点 第二段')
  assert.equal(extractAssistantText({ message: { content: [] } }), '')
  assert.equal(extractAssistantText(undefined), '')
  // A message that is only a code block keeps its text rather than vanishing.
  assert.equal(extractAssistantText({ message: { content: [{ type: 'text', text: '```\nx\n```' }] } }), 'x')
})

test('turnErrorMessage picks the first usable failure line', () => {
  assert.equal(turnErrorMessage({ kind: 'error', error: { message: 'rate limited' } }), 'rate limited')
  assert.equal(turnErrorMessage({ kind: 'error', error: 'socket closed' }), 'socket closed')
  assert.equal(turnErrorMessage({ kind: 'error', message: 'boom' }), 'boom')
  assert.equal(turnErrorMessage({ kind: 'error' }), '')
})

test('buildTurnToast omits an empty body and appends the duration', () => {
  const settings = normalizeConfig({})
  assert.deepEqual(buildTurnToast(settings, '会话标题', '回答节选', '12.0 秒'), {
    title: '会话标题',
    body: '回答节选 · 12.0 秒',
    appId: 'com.deepseek.dsh',
  })
  assert.deepEqual(buildTurnToast(settings, '', '', ''), {
    title: 'DeepSeek Harness',
    body: '',
    appId: 'com.deepseek.dsh',
  })
})

test('questionAttention describes the first question and counts the rest', () => {
  const settings = normalizeConfig({})
  assert.deepEqual(questionAttention(settings, '会话标题', { questions: [{ question: '选哪个方案？' }] }), {
    title: '需要你选择',
    body: '会话标题 · 选哪个方案？',
    appId: 'com.deepseek.dsh',
  })
  const multi = questionAttention(settings, '会话', {
    questions: [{ question: 'A？' }, { question: 'B？' }],
  })
  assert.match(multi.body, /共 2 个问题/)
  assert.equal(questionAttention(settings, '会话', {}).body, '会话 · 打开 Harness 回答问题')
})

test('approvalAttention includes the tool and reason', () => {
  const settings = normalizeConfig({})
  assert.deepEqual(approvalAttention(settings, '会话', { toolName: 'pwsh', reason: '删除文件' }), {
    title: '需要你批准',
    body: '会话 · 工具：pwsh · 删除文件',
    appId: 'com.deepseek.dsh',
  })
  assert.equal(approvalAttention(settings, '会话', {}).body, '会话 · 工具：工具操作')
})

test('buildAttentionToast clamps its body', () => {
  const settings = normalizeConfig({})
  const toast = buildAttentionToast(settings, '需要你选择', ['会话', 'x'.repeat(400)])
  assert.ok(toast.body.length <= 200)
  assert.ok(toast.body.endsWith('…'))
})
