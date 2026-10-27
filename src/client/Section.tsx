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

/** Multi-line list input that keeps the raw text while typing (so Enter works) and reports the parsed list. */
function ListInput({ value, onChange, parse, disabled, rows, placeholder, label }: {
  value: string[]; onChange: (v: string[]) => void; parse: (text: string) => string[]
  disabled?: boolean; rows: number; placeholder?: string; label: string
}) {
  const [text, setText] = useState(value.join('\n'))
  // Follow outside changes (load, undo, conflict reload) without fighting the user's typing.
  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(value)) setText(value.join('\n'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <textarea
      aria-label={label}
      style={S.textarea}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      value={text}
      onChange={e => { setText(e.target.value); onChange(parse(e.target.value)) }}
    />
  )
}

/** Login values: kept only in this component, sent once, never read back. */
function LoginCard({ ctx, state, onState, onNotice, readOnly }: {
  ctx: ClientCtx
  state: PanelState
  onState: (s: PanelState) => void
  onNotice: (n: { tone: 'ok' | 'error' | 'warn'; text: string }) => void
  readOnly: boolean
}) {
  const login = state.login
  const [sessdata, setSessdata] = useState('')
  const [biliJct, setBiliJct] = useState('')
  const [uid, setUid] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const typed = sessdata.trim() !== '' || biliJct.trim() !== '' || uid.trim() !== ''

  const save = async () => {
    setBusy(true)
    try {
      const next = await callRpc<PanelState>(ctx, 'login', { sessdata: sessdata.trim(), biliJct: biliJct.trim(), dedeUserId: uid.trim() })
      onState(next)
      setSessdata('')
      setBiliJct('')
      setUid('')
      onNotice({ tone: 'warn', text: '登录信息已保存。需要重启 DSH，bilibili-mcp-server 才会用上新的登录信息。' })
    } catch (error) {
      onNotice({ tone: 'error', text: `保存登录信息失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!window.confirm('删除已保存的 B 站登录信息？删除后重启 DSH，bilibili-mcp-server 将处于未登录状态。')) return
    setBusy(true)
    try {
      onState(await callRpc<PanelState>(ctx, 'logout', null))
      onNotice({ tone: 'warn', text: '登录信息已删除，重启 DSH 后生效。' })
    } catch (error) {
      onNotice({ tone: 'error', text: `删除失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }

  const set = (ok: boolean) => <span style={S.badge(ok)}>{ok ? '已设置' : '未设置'}</span>
  const secretType = show ? 'text' : 'password'

  return (
    <section style={S.card} aria-labelledby="bf-login">
      <h2 id="bf-login" style={S.cardTitle}>B 站登录</h2>
      <div style={S.muted}>
        在浏览器登录 bilibili.com，按 F12 → Application（应用）→ Cookies → https://www.bilibili.com，复制下面三项的值。
        它们只保存在本机的 {login.path}（仅当前用户可读），不会显示在这里，也不会写进配置文件。
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span>SESSDATA {set(login.sessdata)}</span>
        <span>bili_jct {set(login.biliJct)}</span>
        <span>DedeUserID {login.dedeUserId ? <span style={S.badge(true)}>{login.dedeUserId}</span> : set(false)}</span>
      </div>
      <label style={S.block}>
        <span>SESSDATA</span>
        <input style={S.input} type={secretType} autoComplete="off" spellCheck={false} disabled={readOnly || busy}
          placeholder={login.sessdata ? '已设置，留空表示不修改' : '粘贴 SESSDATA'} value={sessdata} onChange={e => setSessdata(e.target.value)} />
      </label>
      <label style={S.block}>
        <span>bili_jct</span>
        <input style={S.input} type={secretType} autoComplete="off" spellCheck={false} disabled={readOnly || busy}
          placeholder={login.biliJct ? '已设置，留空表示不修改' : '32 位字母数字'} value={biliJct} onChange={e => setBiliJct(e.target.value)} />
      </label>
      <label style={S.block}>
        <span>DedeUserID</span>
        <input style={S.input} inputMode="numeric" autoComplete="off" disabled={readOnly || busy}
          placeholder={login.dedeUserId ?? '你的 uid（纯数字）'} value={uid} onChange={e => setUid(e.target.value)} />
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} />
        <span style={S.muted}>显示输入内容</span>
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={S.button(true, readOnly || busy || !typed)} disabled={readOnly || busy || !typed} onClick={() => { void save() }}>
          {busy ? '保存中…' : '保存登录信息'}
        </button>
        {(login.sessdata || login.biliJct || login.dedeUserId) && (
          <button type="button" style={S.button(false, readOnly || busy)} disabled={readOnly || busy} onClick={() => { void clear() }}>清除</button>
        )}
      </div>
      <div style={S.banner('warn')}>保存或清除后需要重启 DSH 才生效：bilibili-mcp-server 只在启动时读取一次登录信息。</div>
      <details>
        <summary style={{ cursor: 'pointer' }}>第一次使用：让 bilibili-mcp-server 读取这个文件</summary>
        <div style={{ ...S.muted, margin: '8px 0' }}>
          把 profile 的 cordis.patch.yml 里 mcp-bilibili 那一项换成下面这样（env 里不要再写 BILIBILI_SESSDATA 等三项，环境变量会覆盖文件）：
        </div>
        <pre style={{ ...S.textarea, whiteSpace: 'pre', overflowX: 'auto', margin: 0 }}>{login.mcpSnippet}</pre>
        <button type="button" style={{ ...S.button(false, false), marginTop: 8 }} onClick={() => {
          void navigator.clipboard?.writeText(login.mcpSnippet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
        }}>{copied ? '已复制' : '复制'}</button>
      </details>
    </section>
  )
}

/** API key + connection test for the Feiyu voice service; the key is sent once and never read back. */
function FeiyuKeyBox({ ctx, state, onState, onNotice }: {
  ctx: ClientCtx
  state: PanelState
  onState: (s: PanelState) => void
  onNotice: (n: { tone: 'ok' | 'error' | 'warn'; text: string }) => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const local = state.feiyuLocal
  const test = state.feiyuTest
  const call = async (endpoint: 'feiyu-key' | 'feiyu-key-clear' | 'feiyu-test', payload: unknown, done: string) => {
    setBusy(true)
    try {
      const next = await callRpc<PanelState>(ctx, endpoint, payload)
      onState(next)
      if (endpoint === 'feiyu-key') setKey('')
      if (endpoint === 'feiyu-test') {
        onNotice({ tone: next.feiyuTest?.ok ? 'ok' : 'warn', text: next.feiyuTest?.message ?? done })
      } else {
        onNotice({ tone: 'ok', text: done })
      }
    } catch (error) {
      onNotice({ tone: 'error', text: `失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <label style={S.block}>
        <span>API Key <span style={S.badge(local.keySet)}>{local.keySet ? '已设置' : '未设置'}</span></span>
        <span style={S.muted}>保存在 {local.keyPath}（仅当前用户可读），不会显示在这里。</span>
        <input style={S.input} type="password" autoComplete="off" spellCheck={false} disabled={busy}
          placeholder={local.keySet ? '已设置，输入新的会覆盖' : '声音服务的 API Key'} value={key} onChange={e => setKey(e.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={S.button(true, busy || key.trim() === '')} disabled={busy || key.trim() === ''}
          onClick={() => { void call('feiyu-key', { apiKey: key.trim() }, 'API Key 已保存。') }}>保存 API Key</button>
        {local.keySet && (
          <button type="button" style={S.button(false, busy)} disabled={busy}
            onClick={() => { if (window.confirm('删除已保存的肥鱼声音 API Key？')) void call('feiyu-key-clear', null, 'API Key 已删除。') }}>清除</button>
        )}
        <button type="button" style={S.button(false, busy)} disabled={busy}
          onClick={() => { void call('feiyu-test', null, '') }}>{busy ? '…' : '测试连接'}</button>
      </div>
      {test && (
        <div style={S.banner(test.ok ? 'ok' : 'warn')}>
          {test.ok
            ? `连接成功${test.version ? `（${test.version}）` : ''}：说话 ${test.speech ? '可用' : '未安装'}，换声 ${test.conversion ? '可用' : '未安装'}，按谱唱歌 ${test.singing ? '可用' : '未安装'}${test.styles?.length ? `；风格 ${test.styles.join('、')}` : ''}`
            : test.message}
        </div>
      )}
      <div style={S.muted}>换声 / 唱歌只能读取收件夹 {local.inbox} 里的文件；生成的音频保存在 {local.outbox}。</div>
    </>
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
        if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify(v)) sub[k] = v
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
  if (d.feiyu.baseUrl !== '' && !/^https?:\/\/\S+$/.test(d.feiyu.baseUrl)) p.push('肥鱼声音服务地址要以 http:// 或 https:// 开头')
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(d.feiyu.voice)) p.push('声音 ID 只能包含字母、数字、点、下划线和横线')
  if (!(Number.isInteger(d.feiyu.waitSeconds) && d.feiyu.waitSeconds >= 10 && d.feiyu.waitSeconds <= 1800)) p.push('最多等待需在 10～1800 秒之间')
  const ex = d.explore
  if (!(Number.isInteger(ex.intervalMin) && ex.intervalMin >= 30)) p.push('自己逛的间隔不能低于 30 分钟')
  if (!(ex.activeFrom >= 0 && ex.activeTo <= 24 && ex.activeFrom < ex.activeTo)) p.push('活跃时段需要“开始”早于“结束”（0～24 点）')
  if (ex.commentsPerRound > ex.watchPerRound) p.push('每轮评论数不能多于每轮观看数')
  if (ex.interests.some(k => k.length > 30) || ex.interests.length > 30) p.push('兴趣关键词最多 30 个，每个不超过 30 字')
  if (!(Number.isInteger(d.commentOncePerVideoHours) && d.commentOncePerVideoHours >= 1)) p.push('“每个视频只评论一次”的时长至少 1 小时')
  const ar = d.autoReply
  const badVideos = ar.videos.filter(v => !/^BV[0-9A-Za-z]{10}$/.test(v))
  if (badVideos.length > 0) p.push(`不是有效的 BV 号：${badVideos.join('、')}`)
  if (ar.videos.length > 50) p.push('最多巡检 50 个视频')
  if (!(Number.isInteger(ar.intervalSec) && ar.intervalSec >= 60)) p.push('巡检间隔不能低于 1 分钟')
  if (!(Number.isInteger(ar.maxPerRound) && ar.maxPerRound >= 1 && ar.maxPerRound <= 10)) p.push('每轮处理条数需在 1～10 之间')
  if (ar.enabled && ar.videos.length === 0) p.push('开启自动回复前请先填写要巡检的视频')
  return p
}

function lines(text: string): string[] {
  return text.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean)
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
  const [checking, setChecking] = useState(false)
  const [exploring, setExploring] = useState(false)
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

  const checkNow = async () => {
    setChecking(true)
    try {
      const next = await callRpc<PanelState>(ctx, 'check', null)
      setState(next)
      setNotice({ tone: next.autoReplyStatus.lastError ? 'warn' : 'ok', text: next.autoReplyStatus.lastError ?? '检查完成。' })
    } catch (error) {
      setNotice({ tone: 'error', text: `检查失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setChecking(false)
    }
  }

  const exploreNow = async () => {
    setExploring(true)
    try {
      const next = await callRpc<PanelState>(ctx, 'explore', null)
      setState(next)
      setNotice({ tone: next.exploreStatus.lastError ? 'warn' : 'ok', text: next.exploreStatus.lastError ?? `已唤醒会话“${next.exploreStatus.sessionId}”，大肥鱼开始逛了。` })
    } catch (error) {
      setNotice({ tone: 'error', text: `失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setExploring(false)
    }
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
    const exploreSend = (draft.explore.enabled && draft.explore.send && draft.sendEnabled && draft.explore.commentsPerRound > 0)
      && (patch.explore?.enabled === true || patch.explore?.send === true || patch.sendEnabled === true)
    if (exploreSend) {
      const confirmed = window.confirm(
        `“自己逛”将无人值守地用你的账号在陌生人的视频下发评论：每 ${Math.round(draft.explore.intervalMin / 60 * 10) / 10} 小时一轮、`
        + `每轮最多 ${draft.explore.commentsPerRound} 条，每天最多 ${draft.maxCommentsPerDay} 条。\n`
        + '频繁的自动评论可能被 B 站判定为刷屏，导致限流或封号。\n\n确定开启吗？',
      )
      if (!confirmed) return
    }
    const autoSend = (draft.autoReply.enabled && draft.autoReply.send && draft.sendEnabled)
      && (patch.autoReply?.enabled === true || patch.autoReply?.send === true || patch.sendEnabled === true)
    if (autoSend) {
      const confirmed = window.confirm(
        `自动回复将无人值守地用你的账号回复 ${draft.autoReply.videos.length} 个视频下的新评论，`
        + `每 ${Math.round(draft.autoReply.intervalSec / 60)} 分钟检查一次，每天最多 ${draft.maxRepliesPerDay} 条。\n\n确定开启吗？`,
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

      <LoginCard ctx={ctx} state={state} readOnly={false} onState={setState} onNotice={setNotice} />

      <section style={S.card} aria-labelledby="bf-feiyu">
        <h2 id="bf-feiyu" style={S.cardTitle}>肥鱼声音</h2>
        <div style={S.muted}>
          接入肥鱼声音服务（说话、换声、按谱唱歌）：先按
          {' '}<a href="https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice" target="_blank" rel="noreferrer">astrbot_plugin_feiyu_voice</a>{' '}
          的说明在本机或局域网部署声音服务，再把地址和 API Key 填在这里。声库素材来自 B 站 UP 主星落落_oi，已获授权用于该项目。
        </div>
        <label style={S.block}>
          <span>服务地址</span>
          <input style={S.input} disabled={ro} placeholder="http://127.0.0.1:9880" value={draft.feiyu.baseUrl}
            onChange={e => update('feiyu', { ...draft.feiyu, baseUrl: e.target.value.trim() })} />
          <span style={S.muted}>改了地址记得先点下面的“保存”，再测试连接。留空表示不使用。</span>
        </label>
        <FeiyuKeyBox ctx={ctx} state={state} onState={setState} onNotice={setNotice} />
        <Field title="默认说话风格">
          <select aria-label="默认说话风格" style={S.input} disabled={ro} value={draft.feiyu.style}
            onChange={e => update('feiyu', { ...draft.feiyu, style: e.target.value })}>
            {[...new Set(['cute', 'gentle', ...(state.feiyuTest?.styles ?? []), draft.feiyu.style])].map(v => (
              <option key={v} value={v}>{v === 'cute' ? '可爱（cute）' : v === 'gentle' ? '温柔（gentle）' : v}</option>
            ))}
          </select>
        </Field>
        <Field title="声音 ID" hint="声音服务里配置的声音，一般是 feiyu。">
          <input aria-label="声音 ID" style={{ ...S.input, width: 160 }} disabled={ro} value={draft.feiyu.voice}
            onChange={e => update('feiyu', { ...draft.feiyu, voice: e.target.value.trim() })} />
        </Field>
        <Field title="B 站语音评论也用肥鱼声音" hint="打开后 bili_send_voice 用这个服务合成语音。">
          <Toggle label="B 站语音用肥鱼声音" checked={draft.feiyu.useForBiliVoice} disabled={ro} onChange={v => update('feiyu', { ...draft.feiyu, useForBiliVoice: v })} />
        </Field>
        <Field title="最多等待" hint="超过这个时间先返回任务编号，之后用 feiyu_job 取回。">
          <NumberInput label="最多等待（秒）" value={draft.feiyu.waitSeconds} min={10} max={1800} disabled={ro} suffix="秒" onChange={v => update('feiyu', { ...draft.feiyu, waitSeconds: v })} />
        </Field>
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
        <Field title="同一个视频只评论一次" hint="在这段时间内不会对同一个视频再发评论（草稿也会提示）。">
          <NumberInput label="每视频评论间隔（天）" value={draft.commentOncePerVideoHours / 24} min={1} max={365} disabled={ro} suffix="天" onChange={v => update('commentOncePerVideoHours', Math.max(1, Math.round(v * 24)))} />
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

      <section style={S.card} aria-labelledby="bf-explore">
        <h2 id="bf-explore" style={S.cardTitle}>自己逛</h2>
        <div style={S.muted}>
          定时唤醒专用会话“{state.exploreStatus.sessionId}”：按兴趣找视频、“看”视频、遇到真想说的才评论。
          “看”是读标题简介、字幕、弹幕和热门评论——模型看不到画面，没有字幕的视频只能理解个大概。
          每一轮都会调用模型。该会话只能使用 bili_discover、bili_watch_video、bili_build_prompt、bili_comment。
        </div>
        <Field title="开启自己逛">
          <Toggle label="开启自己逛" checked={draft.explore.enabled} disabled={ro} onChange={v => update('explore', { ...draft.explore, enabled: v })} />
        </Field>
        <label style={S.block}>
          <span>感兴趣的关键词</span>
          <span style={S.muted}>每行一个，每轮轮流挑一个去搜；留空就逛热门。</span>
          <ListInput
            label="感兴趣的关键词"
            rows={3}
            disabled={ro}
            placeholder={'猫\n独立游戏\n做饭'}
            value={draft.explore.interests}
            parse={t => t.split('\n').map(x => x.trim()).filter(Boolean)}
            onChange={interests => update('explore', { ...draft.explore, interests })}
          />
        </label>
        <Field title="多久逛一次" hint="不低于 30 分钟。">
          <NumberInput label="逛的间隔（分钟）" value={draft.explore.intervalMin} min={30} max={1440} disabled={ro} suffix="分钟" onChange={v => update('explore', { ...draft.explore, intervalMin: v })} />
        </Field>
        <Field title="活跃时段" hint={`只在这段时间里逛（${state.fixed.timeZone}）。`}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <NumberInput label="开始（点）" value={draft.explore.activeFrom} min={0} max={23} disabled={ro} onChange={v => update('explore', { ...draft.explore, activeFrom: v })} />
            <span style={S.muted}>点到</span>
            <NumberInput label="结束（点）" value={draft.explore.activeTo} min={1} max={24} disabled={ro} suffix="点" onChange={v => update('explore', { ...draft.explore, activeTo: v })} />
          </span>
        </Field>
        <Field title="每轮最多看">
          <NumberInput label="每轮最多看" value={draft.explore.watchPerRound} min={1} max={5} disabled={ro} suffix="个" onChange={v => update('explore', { ...draft.explore, watchPerRound: v })} />
        </Field>
        <Field title="每轮最多评论" hint="填 0 就只看不评论。">
          <NumberInput label="每轮最多评论" value={draft.explore.commentsPerRound} min={0} max={3} disabled={ro} suffix="条" onChange={v => update('explore', { ...draft.explore, commentsPerRound: v })} />
        </Field>
        <Field title="真实评论" hint="关闭时只出草稿，可以在该会话里查看。开启后仍需上面的“允许真实发送”，受每日上限、间隔和“每个视频只评论一次”限制。">
          <Toggle label="自己逛真实评论" checked={draft.explore.send} disabled={ro} onChange={v => update('explore', { ...draft.explore, send: v })} />
        </Field>
        <div style={S.stats}>
          <div style={S.stat}><div style={S.muted}>上次出门</div><div style={S.statValue}>{formatTime(state.exploreStatus.lastWakeAt)}</div></div>
          <div style={S.stat}><div style={S.muted}>上次关键词</div><div style={S.statValue}>{state.exploreStatus.lastKeyword ?? '—'}</div></div>
          <div style={S.stat}><div style={S.muted}>下次关键词</div><div style={S.statValue}>{state.exploreStatus.nextKeyword ?? '热门'}</div></div>
          <div style={S.stat}><div style={S.muted}>现在</div><div style={S.statValue}>{state.exploreStatus.active ? '活跃时段' : '休息中'}</div></div>
        </div>
        {state.recentlyCommented.length > 0 && <div style={S.muted}>最近评论过：{state.recentlyCommented.join('、')}</div>}
        {state.exploreStatus.lastError && <div style={S.banner('warn')}>{state.exploreStatus.lastError}</div>}
        {!ro && (
          <div>
            <button
              type="button"
              style={S.button(false, !state.settings.explore.enabled || exploring)}
              disabled={!state.settings.explore.enabled || exploring}
              onClick={() => { void exploreNow() }}
            >
              {exploring ? '唤醒中…' : '现在去逛一次'}
            </button>
          </div>
        )}
      </section>

      <section style={S.card} aria-labelledby="bf-auto">
        <h2 id="bf-auto" style={S.cardTitle}>自动回复</h2>
        <div style={S.muted}>
          定时读取下面这些视频的评论（不消耗模型额度）。第一次只记下已有评论，之后出现的新评论才会交给专用会话
          “{state.autoReplyStatus.sessionId}”，由大肥鱼决定回不回。该会话只能使用 bili_build_prompt 和 bili_reply。
        </div>
        <Field title="开启自动回复">
          <Toggle label="开启自动回复" checked={draft.autoReply.enabled} disabled={ro} onChange={v => update('autoReply', { ...draft.autoReply, enabled: v })} />
        </Field>
        <label style={S.block}>
          <span>要巡检的视频</span>
          <span style={S.muted}>每行一个 BV 号，最多 50 个。</span>
          <ListInput
            label="要巡检的视频"
            rows={3}
            disabled={ro}
            placeholder={'BV1xx411c7mD\nBV1yy411c7mE'}
            value={draft.autoReply.videos}
            parse={lines}
            onChange={videos => update('autoReply', { ...draft.autoReply, videos })}
          />
        </label>
        <Field title="巡检间隔" hint="不低于 1 分钟。">
          <NumberInput label="巡检间隔（分钟）" value={draft.autoReply.intervalSec / 60} min={1} max={1440} disabled={ro} suffix="分钟" onChange={v => update('autoReply', { ...draft.autoReply, intervalSec: Math.round(v * 60) })} />
        </Field>
        <Field title="每轮最多处理" hint="多出来的留到下一轮。">
          <NumberInput label="每轮最多处理" value={draft.autoReply.maxPerRound} min={1} max={10} disabled={ro} suffix="条" onChange={v => update('autoReply', { ...draft.autoReply, maxPerRound: v })} />
        </Field>
        <Field title="真实回复" hint="关闭时只生成草稿，可以在该会话里查看。开启后仍需上面的“允许真实发送”，并受每日上限和间隔限制。">
          <Toggle label="自动回复真实发送" checked={draft.autoReply.send} disabled={ro} onChange={v => update('autoReply', { ...draft.autoReply, send: v })} />
        </Field>
        <label style={S.block}>
          <span>跳过这些昵称</span>
          <span style={S.muted}>比如你自己的昵称，每行一个。</span>
          <ListInput
            label="跳过这些昵称"
            rows={2}
            disabled={ro}
            value={draft.autoReply.skipNames}
            parse={t => t.split('\n').map(x => x.trim()).filter(Boolean)}
            onChange={skipNames => update('autoReply', { ...draft.autoReply, skipNames })}
          />
        </label>
        <div style={S.stats}>
          <div style={S.stat}><div style={S.muted}>上次巡检</div><div style={S.statValue}>{formatTime(state.autoReplyStatus.lastRunAt)}</div></div>
          <div style={S.stat}><div style={S.muted}>上次唤醒会话</div><div style={S.statValue}>{formatTime(state.autoReplyStatus.lastWakeAt)}</div></div>
          <div style={S.stat}><div style={S.muted}>待处理新评论</div><div style={S.statValue}>{state.autoReplyStatus.pending}</div></div>
        </div>
        {state.autoReplyStatus.lastError && <div style={S.banner('warn')}>{state.autoReplyStatus.lastError}</div>}
        {!ro && (
          <div>
            <button
              type="button"
              style={S.button(false, !state.settings.autoReply.enabled || checking)}
              disabled={!state.settings.autoReply.enabled || checking}
              onClick={() => { void checkNow() }}
            >
              {checking ? '检查中…' : '立即检查一次'}
            </button>
          </div>
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
