import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  DEDUPE_FLOOR_MS,
  MAX_COMMENTS_CAP,
  MAX_REPLIES_CAP,
  MIN_INTERVAL_FLOOR_MS,
  type EditableSettings,
  type PanelState,
} from '../panel/protocol.js'
import { BiliFishRpcError, callRpc, type ClientCtx } from './rpc.js'

const VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓（女，温暖）'],
  ['zh-CN-XiaoyiNeural', '晓伊（女，活泼）'],
  ['zh-CN-YunxiNeural', '云希（男，阳光）'],
  ['zh-CN-YunjianNeural', '云健（男，激情）'],
  ['zh-CN-YunyangNeural', '云扬（男，播音）'],
  ['zh-CN-liaoning-XiaobeiNeural', '晓北（东北话）'],
  ['zh-CN-shaanxi-XiaoniNeural', '晓妮（陕西话）'],
] as const

const POLL_MS = 15_000

// Theme-neutral styling: inherit text colour and use translucent greys so the
// page reads correctly under both the light and dark DSH themes.
const S = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 24px', maxWidth: 720, fontSize: 14, lineHeight: 1.5 } satisfies CSSProperties,
  h1: { fontSize: 18, fontWeight: 600, margin: 0 } satisfies CSSProperties,
  muted: { opacity: 0.65, fontSize: 13 } satisfies CSSProperties,
  card: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } satisfies CSSProperties,
  cardTitle: { fontSize: 15, fontWeight: 600, margin: 0 } satisfies CSSProperties,
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } satisfies CSSProperties,
  label: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 260px' } satisfies CSSProperties,
  block: { display: 'flex', flexDirection: 'column', gap: 4 } satisfies CSSProperties,
  suffix: { opacity: 0.65, fontSize: 13, minWidth: 28 } satisfies CSSProperties,
  input: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, padding: '6px 8px', minWidth: 0 } satisfies CSSProperties,
  textarea: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, padding: 8, width: '100%', boxSizing: 'border-box', resize: 'vertical' } satisfies CSSProperties,
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 } satisfies CSSProperties,
  stat: { background: 'rgba(127,127,127,.08)', borderRadius: 8, padding: '10px 12px' } satisfies CSSProperties,
  statValue: { fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } satisfies CSSProperties,
  badge: (good: boolean | null): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '2px 8px', borderRadius: 999,
    background: good === null ? 'rgba(127,127,127,.12)' : good ? 'rgba(34,160,90,.15)' : 'rgba(210,80,60,.15)',
  }),
  banner: (tone: 'warn' | 'error' | 'ok'): CSSProperties => ({
    borderRadius: 8, padding: '10px 12px', fontSize: 13,
    background: tone === 'ok' ? 'rgba(34,160,90,.12)' : tone === 'warn' ? 'rgba(220,160,30,.15)' : 'rgba(210,80,60,.15)',
  }),
  bar: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', paddingTop: 4 } satisfies CSSProperties,
  button: (primary: boolean, disabled: boolean): CSSProperties => ({
    font: 'inherit', borderRadius: 6, padding: '6px 14px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: primary ? '1px solid transparent' : '1px solid rgba(127,127,127,.35)',
    background: primary ? '#4d6bfe' : 'transparent', color: primary ? '#fff' : 'inherit',
  }),
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', padding: 2, flex: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: checked ? '#4d6bfe' : 'rgba(127,127,127,.4)', transition: 'background .15s',
      }}
    >
      <span style={{
        display: 'block', width: 18, height: 18, borderRadius: '50%', background: '#fff',
        transform: checked ? 'translateX(18px)' : 'translateX(0)', transition: 'transform .15s',
      }} />
    </button>
  )
}

function Field({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={S.row}>
      <div style={S.label}>
        <span>{title}</span>
        {hint && <span style={S.muted}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function NumberInput({ value, min, max, step = 1, onChange, disabled, suffix, label }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled?: boolean; suffix?: string; label: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={text}
        disabled={disabled}
        style={{ ...S.input, width: 96, textAlign: 'right' }}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(n)) onChange(n)
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span style={S.suffix}>{suffix}</span>}
    </span>
  )
}

/** Fields that differ between the server copy and the draft, as a nested patch. */
export function diffSettings(base: EditableSettings, draft: EditableSettings): Partial<EditableSettings> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(draft) as (keyof EditableSettings)[]) {
    const a = base[key] as unknown
    const b = draft[key] as unknown
    if (typeof b === 'object' && b !== null) {
      const sub: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(b)) {
        if ((a as Record<string, unknown>)[k] !== v) sub[k] = v
      }
      if (Object.keys(sub).length > 0) out[key] = sub
    } else if (a !== b) {
      out[key] = b
    }
  }
  return out as Partial<EditableSettings>
}

/** Client-side mirror of the host checks, so the user sees problems before saving. */
export function localProblems(d: EditableSettings): string[] {
  const p: string[] = []
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi
  if (!int(d.maxCommentsPerDay, 0, MAX_COMMENTS_CAP)) p.push(`每日评论上限需在 0～${MAX_COMMENTS_CAP} 之间`)
  if (!int(d.maxRepliesPerDay, 0, MAX_REPLIES_CAP)) p.push(`每日回复上限需在 0～${MAX_REPLIES_CAP} 之间`)
  if (!(d.minIntervalMs >= MIN_INTERVAL_FLOOR_MS)) p.push(`发送间隔不能低于 ${MIN_INTERVAL_FLOOR_MS / 1000} 秒`)
  if (!(d.replyDedupeWindowMs >= DEDUPE_FLOOR_MS)) p.push(`去重窗口不能低于 ${DEDUPE_FLOOR_MS / 60000} 分钟`)
  if (!d.tts.defaultVoice.trim()) p.push('默认音色不能为空')
  if (d.voiceFallback.enabled) {
    if (!/^https?:\/\/\S+$/.test(d.voiceFallback.uploadUrl)) p.push('开启降级时需要填写 http(s) 上传地址')
    if (!d.voiceFallback.template.includes('{url}')) p.push('降级模板必须包含 {url}')
  }
  return p
}

function formatTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function BiliFishSection({ ctx }: { ctx: ClientCtx }) {
  const [state, setState] = useState<PanelState | null>(null)
  const [draft, setDraft] = useState<EditableSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const dirtyRef = useRef(false)

  const dirty = useMemo(
    () => !!state && !!draft && Object.keys(diffSettings(state.settings, draft)).length > 0,
    [state, draft],
  )
  dirtyRef.current = dirty

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await callRpc<PanelState>(ctx, 'state', null, signal)
      setState(next)
      // Don't clobber unsaved edits when the background poll lands.
      if (!dirtyRef.current) setDraft(next.settings)
      setLoadError(null)
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [ctx])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    const timer = setInterval(() => { void load(ac.signal) }, POLL_MS)
    return () => { ac.abort(); clearInterval(timer) }
  }, [load])

  const problems = draft ? localProblems(draft) : []
  const writable = state?.persistence.writable === true
  const canSave = writable && dirty && problems.length === 0 && !saving

  const update = <K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) => {
    setNotice(null)
    setDraft(d => (d ? { ...d, [key]: value } : d))
  }

  const save = async () => {
    if (!state || !draft || !canSave) return
    const patch = diffSettings(state.settings, draft)
    if (patch.sendEnabled === true) {
      const confirmed = window.confirm(
        '开启后，模型在调用时显式传 dryRun: false 就会真的在 B 站发评论。\n'
        + `当前上限：每天 ${draft.maxCommentsPerDay} 条评论、${draft.maxRepliesPerDay} 条回复，间隔 ≥ ${draft.minIntervalMs / 1000} 秒。\n\n确定开启真实发送吗？`,
      )
      if (!confirmed) return
    }
    setSaving(true)
    try {
      const revision = state.persistence.writable ? state.persistence.revision : undefined
      const next = await callRpc<PanelState>(ctx, 'save', { patch, revision })
      setState(next)
      setDraft(next.settings)
      setNotice({ tone: 'ok', text: '已保存，下一次工具调用即生效。' })
      // Live config refs update right after the patch is written; re-read once to show the applied values.
      setTimeout(() => { void load() }, 400)
    } catch (error) {
      const text = error instanceof BiliFishRpcError && error.code === 'conflict'
        ? '设置已在别处被修改，已重新加载，请再确认一次。'
        : `保存失败：${error instanceof Error ? error.message : String(error)}`
      setNotice({ tone: 'error', text })
      if (error instanceof BiliFishRpcError && error.code === 'conflict') {
        dirtyRef.current = false
        await load()
      }
    } finally {
      setSaving(false)
    }
  }

  if (!state || !draft) {
    return (
      <div style={S.page}>
        <h1 style={S.h1}>大肥鱼 · B 站</h1>
        {loadError
          ? <div style={S.banner('error')}>无法读取插件状态：{loadError}</div>
          : <div style={S.muted}>加载中…</div>}
      </div>
    )
  }

  const { usage, fixed, dependencies: dep } = state
  const ro = !writable

  return (
    <div style={S.page}>
      <div>
        <h1 style={S.h1}>大肥鱼 · B 站</h1>
        <div style={S.muted}>评论、回复与语音的发送开关和频率纪律。默认只生成草稿；真实发送还需要模型调用时显式传 dryRun: false。</div>
      </div>

      {!writable && state.persistence.writable === false && (
        <div style={S.banner('warn')}>只读：{state.persistence.reason}</div>
      )}
      {loadError && <div style={S.banner('error')}>刷新失败：{loadError}</div>}

      <section style={S.card} aria-labelledby="bf-today">
        <h2 id="bf-today" style={S.cardTitle}>今日（{usage.day}，{fixed.timeZone}）</h2>
        <div style={S.stats}>
          <div style={S.stat}>
            <div style={S.muted}>评论</div>
            <div style={S.statValue}>{usage.comments} / {state.settings.maxCommentsPerDay}</div>
          </div>
          <div style={S.stat}>
            <div style={S.muted}>回复</div>
            <div style={S.statValue}>{usage.replies} / {state.settings.maxRepliesPerDay}</div>
          </div>
          <div style={S.stat}>
            <div style={S.muted}>上次真实发送</div>
            <div style={S.statValue}>{formatTime(usage.lastSendAt)}</div>
          </div>
          <div style={S.stat}>
            <div style={S.muted}>去重中的评论</div>
            <div style={S.statValue}>{usage.recentReplies}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={S.badge(dep.replyTool)} title={fixed.replyTool}>bilibili-mcp {dep.replyTool ? '已连接' : '未连接'}</span>
          <span style={S.badge(dep.tts)} title={`ctx.${fixed.ttsService}`}>TTS {dep.tts ? '可用' : '未找到'}</span>
          <span style={S.badge(dep.voiceTool)} title={fixed.voiceTool || '未配置'}>
            语音评论工具 {dep.voiceTool === null ? '未配置' : dep.voiceTool ? '可用' : '未连接'}
          </span>
        </div>
        <div style={S.muted}>计数保存在内存里，DSH 重启后清零。</div>
      </section>

      <section style={S.card} aria-labelledby="bf-send">
        <h2 id="bf-send" style={S.cardTitle}>发送</h2>
        <Field title="允许真实发送" hint="总开关。关闭时所有工具只返回草稿或 send_disabled。">
          <Toggle label="允许真实发送" checked={draft.sendEnabled} disabled={ro} onChange={v => update('sendEnabled', v)} />
        </Field>
        <Field title="未传 dryRun 时默认只出草稿" hint="建议保持开启。关闭后，未显式传 dryRun: false 的调用返回 dry_run_not_explicit。">
          <Toggle label="默认只出草稿" checked={draft.dryRunByDefault} disabled={ro} onChange={v => update('dryRunByDefault', v)} />
        </Field>
        {draft.sendEnabled && (
          <div style={S.banner('warn')}>真实发送已开启。模型显式传 dryRun: false 时会用你的账号在 B 站发言。</div>
        )}
      </section>

      <section style={S.card} aria-labelledby="bf-rate">
        <h2 id="bf-rate" style={S.cardTitle}>频率</h2>
        <Field title="每日评论上限" hint="语音评论也计入这里。">
          <NumberInput label="每日评论上限" value={draft.maxCommentsPerDay} min={0} max={MAX_COMMENTS_CAP} disabled={ro} suffix="条" onChange={v => update('maxCommentsPerDay', v)} />
        </Field>
        <Field title="每日回复上限">
          <NumberInput label="每日回复上限" value={draft.maxRepliesPerDay} min={0} max={MAX_REPLIES_CAP} disabled={ro} suffix="条" onChange={v => update('maxRepliesPerDay', v)} />
        </Field>
        <Field title="两次发送最小间隔" hint={`不低于 ${MIN_INTERVAL_FLOOR_MS / 1000} 秒。`}>
          <NumberInput label="最小间隔（秒）" value={draft.minIntervalMs / 1000} min={MIN_INTERVAL_FLOOR_MS / 1000} max={86400} disabled={ro} suffix="秒" onChange={v => update('minIntervalMs', Math.round(v * 1000))} />
        </Field>
        <Field title="同一条评论不重复回复" hint="在这段时间内，对同一个 parentRpid 只回复一次。">
          <NumberInput label="去重窗口（分钟）" value={draft.replyDedupeWindowMs / 60000} min={1} max={10080} disabled={ro} suffix="分钟" onChange={v => update('replyDedupeWindowMs', Math.round(v * 60000))} />
        </Field>
        <div style={S.muted}>字数限制：评论 {fixed.commentLength.min}～{fixed.commentLength.max} 字，回复 {fixed.replyLength.min}～{fixed.replyLength.max} 字（在 cordis.patch.yml 中修改）。</div>
      </section>

      <section style={S.card} aria-labelledby="bf-voice">
        <h2 id="bf-voice" style={S.cardTitle}>语音</h2>
        <Field title="启用语音评论">
          <Toggle label="启用语音评论" checked={draft.voiceEnabled} disabled={ro} onChange={v => update('voiceEnabled', v)} />
        </Field>
        <Field title="默认音色" hint="Edge TTS 音色标识，可选列表或直接输入。">
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            <select
              aria-label="常用音色"
              style={S.input}
              disabled={ro}
              value={VOICES.some(([id]) => id === draft.tts.defaultVoice) ? draft.tts.defaultVoice : ''}
              onChange={e => { if (e.target.value) update('tts', { defaultVoice: e.target.value }) }}
            >
              <option value="">自定义…</option>
              {VOICES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <input
              aria-label="音色标识"
              style={{ ...S.input, width: 220 }}
              disabled={ro}
              value={draft.tts.defaultVoice}
              onChange={e => update('tts', { defaultVoice: e.target.value.trim() })}
            />
          </span>
        </Field>
        <Field title="降级：上传音频并附链接" hint="bilibili-mcp 没有语音评论工具时，把音频传到你的文件服务，再把链接拼进文字评论。">
          <Toggle label="启用降级路径" checked={draft.voiceFallback.enabled} disabled={ro} onChange={v => update('voiceFallback', { ...draft.voiceFallback, enabled: v })} />
        </Field>
        {draft.voiceFallback.enabled && (
          <>
            <label style={S.block}>
              <span>上传地址</span>
              <input
                style={S.input}
                disabled={ro}
                placeholder="https://files.example.com/upload"
                value={draft.voiceFallback.uploadUrl}
                onChange={e => update('voiceFallback', { ...draft.voiceFallback, uploadUrl: e.target.value.trim() })}
              />
              <span style={S.muted}>以 multipart/form-data 上传；鉴权请求头只能在 cordis.patch.yml 里配置。</span>
            </label>
            <label style={S.block}>
              <span>评论模板</span>
              <input
                style={S.input}
                disabled={ro}
                value={draft.voiceFallback.template}
                onChange={e => update('voiceFallback', { ...draft.voiceFallback, template: e.target.value })}
              />
              <span style={S.muted}>可用 {'{text}'} 和 {'{url}'}。</span>
            </label>
          </>
        )}
      </section>

      <section style={S.card} aria-labelledby="bf-persona">
        <h2 id="bf-persona" style={S.cardTitle}>人格</h2>
        <label style={S.block}>
          <span>补充说明</span>
          <span style={S.muted}>追加在人格末尾，比如“最近在追《葬送的芙莉莲》”。</span>
          <textarea
            style={S.textarea}
            rows={3}
            disabled={ro}
            value={draft.persona.extra}
            onChange={e => update('persona', { ...draft.persona, extra: e.target.value })}
          />
        </label>
        <label style={S.block}>
          <span>整体替换人格</span>
          <span style={S.muted}>留空使用内置的大肥鱼人格。</span>
          <textarea
            style={S.textarea}
            rows={6}
            disabled={ro}
            placeholder={state.defaultPersona}
            value={draft.persona.override}
            onChange={e => update('persona', { ...draft.persona, override: e.target.value })}
          />
        </label>
        <details>
          <summary style={{ cursor: 'pointer' }}>查看内置人格</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', ...S.muted, margin: '8px 0 0' }}>{state.defaultPersona}</pre>
        </details>
      </section>

      {problems.length > 0 && dirty && (
        <div style={S.banner('error')}>{problems.join('；')}</div>
      )}
      {notice && <div role="status" style={S.banner(notice.tone)}>{notice.text}</div>}

      {!ro && (
        <div style={S.bar}>
          {dirty && <span style={S.muted}>有未保存的修改</span>}
          <button type="button" style={S.button(false, !dirty || saving)} disabled={!dirty || saving} onClick={() => { setDraft(state.settings); setNotice(null) }}>
            撤销
          </button>
          <button type="button" style={S.button(true, !canSave)} disabled={!canSave} onClick={() => { void save() }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}
    </div>
  )
}
