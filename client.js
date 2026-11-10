/**
 * Browser half: the bundle's configuration section in the Plugins panel.
 *
 * Registers into `plugins.bundle.config`, which the bundle's detail page renders
 * between its description and its rows, so the settings are visible without
 * hunting for a row-level Configure control. The page does not hand a `form` to
 * a bundle-wide section, so this half resolves the Host-owned form itself from
 * the shared `configForms` service and writes through its `mutate`, exactly as
 * the shipped settings pages do.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-job-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BUNDLE = '@local/dsh-job-notify'
    // The Host keys a settings namespace by the Loader entry's declared id. The
    // row id is `job-notify`; the other spellings only matter for a composition
    // that names the row differently.
    const NAMESPACES = ['job-notify', BUNDLE, 'include:job-notify']
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
          onChange: event => onChange(event.target.checked),
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
        callback => (form === undefined ? () => {} : form.subscribe(callback)),
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
          .catch(error => {
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
          onChange: next => write('enabled', next),
        }),
        h('div', { style: S.divider }),
        h('div', { style: S.heading }, '通知内容'),
        h('p', { style: S.hint }, '关掉某项后，通知正文不再包含对应部分。'),
        h(Toggle, {
          text: '显示任务标签',
          hint: '通知正文带上命令或任务名。',
          checked: value.showLabel !== false,
          disabled: !writable,
          onChange: next => write('showLabel', next),
        }),
        h(Toggle, {
          text: '显示耗时',
          hint: '后台任务与对话轮次都显示耗时。',
          checked: value.showDuration !== false,
          disabled: !writable,
          onChange: next => write('showDuration', next),
        }),
        h(Toggle, {
          text: '显示退出码 / 失败原因',
          checked: value.showExitCode !== false,
          disabled: !writable,
          onChange: next => write('showExitCode', next),
        }),
        h('div', { style: S.divider }),
        h('div', { style: S.heading }, '提醒时机'),
        h(Toggle, {
          text: '后台任务完成',
          checked: value.onCompleted !== false,
          disabled: !writable,
          onChange: next => write('onCompleted', next),
        }),
        h(Toggle, {
          text: '后台任务失败或异常退出',
          checked: value.onFailed !== false,
          disabled: !writable,
          onChange: next => write('onFailed', next),
        }),
        h(Toggle, {
          text: '后台任务被停止',
          checked: value.onKilled !== false,
          disabled: !writable,
          onChange: next => write('onKilled', next),
        }),
        h(Toggle, {
          text: '每轮对话结束',
          hint: '只提醒你自己这条会话，子代理与工作流轮次不提醒。',
          checked: value.notifyTurnEnd !== false,
          disabled: !writable,
          onChange: next => write('notifyTurnEnd', next),
        }),
        h(Toggle, {
          text: '只提醒后台任务',
          hint: '前台命令、以及 agent 正在等待的任务保持安静；不影响对话轮次提醒。',
          checked: value.skipAwaited !== false,
          disabled: !writable,
          onChange: next => write('skipAwaited', next),
        }),
        h('div', { style: S.divider }),
        h('label', { style: S.fieldLabel }, 'Toast AppUserModelID'),
        h('input', {
          type: 'text',
          value: appIdDraft === null ? appId : appIdDraft,
          disabled: !writable,
          spellCheck: false,
          onChange: event => setAppIdDraft(event.target.value),
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
