// Host half of the settings page: one Connection RPC channel (`/bili-fish`).
//
// Reads come from the live plugin state; writes go through the DSH settings
// service (`ctx.settings.update`), which persists them into the active
// profile's cordis.patch.yml and hot-applies the `.volatile()` fields without
// remounting the plugin. Every failure is returned as an RpcResult, never
// thrown, so the page always gets a stable error code.

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { configProblems, type Settings } from '../config.js'
import type { SendGuard } from '../guard.js'
import { FISH_PERSONA } from '../persona.js'
import type { ReplyPatrol } from '../autoreply/watcher.js'
import type { Explorer } from '../explore/explorer.js'
import { clearLogin, cookieFilePath, mcpEntrySnippet, readLoginStatus, saveLogin, validateLogin } from '../login.js'
import { FeiyuClient } from '../feiyu/client.js'
import { clearApiKey, feiyuPaths, readApiKey, saveApiKey, validApiKey } from '../feiyu/local.js'
import type { BiliClient } from '../bili-client.js'
import { resolveTts } from '../tts.js'
import {
  DEDUPE_FLOOR_MS,
  MAX_COMMENTS_CAP,
  MAX_REPLIES_CAP,
  MIN_INTERVAL_FLOOR_MS,
  ENDPOINTS,
  endpointPath,
  type EditableSettings,
  type FeiyuTestResult,
  type Endpoint,
  type PanelState,
  type RpcResult,
  type SaveRequest,
} from './protocol.js'

export interface PanelDeps {
  ctx: Context
  settings: () => Settings
  guard: SendGuard
  bili: BiliClient
  /** Local profile entry id of this plugin instance, if loaded from one. */
  entryId: string | undefined
  patrol: ReplyPatrol
  explorer: Explorer
}

const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value })
const fail = <T = never>(code: string, message: string, details: object = {}): RpcResult<T> =>
  ({ ok: false, error: { code, message, details } })

/** Last connection test per plugin instance (shown until the next test). */
const lastFeiyuTest = new WeakMap<Context, FeiyuTestResult>()

async function feiyuLocal(s: Settings): Promise<PanelState['feiyuLocal']> {
  const paths = feiyuPaths(s.feiyu)
  return { keySet: (await readApiKey(paths.keyFile)) !== '', keyPath: paths.keyFile, inbox: paths.inbox, outbox: paths.outbox }
}

async function testFeiyu(s: Settings): Promise<FeiyuTestResult> {
  const at = Date.now()
  if (s.feiyu.baseUrl.trim() === '') return { ok: false, at, message: '还没有填写服务地址' }
  const key = await readApiKey(feiyuPaths(s.feiyu).keyFile)
  const client = new FeiyuClient(s.feiyu.baseUrl, key, 10_000)
  try {
    const health = await client.health()
    if (key === '') return { ok: false, at, message: `服务在线（${health.version ?? '未知版本'}），但还没有填写 API Key`, ...(health.version ? { version: health.version } : {}) }
    const caps = await client.capabilities()
    return {
      ok: true,
      at,
      message: '连接成功',
      ...(health.version ? { version: health.version } : {}),
      speech: caps.tts.some(t => t.available),
      conversion: caps.rvc.some(t => t.available),
      singing: !!caps.singing?.available,
      styles: [...new Set(caps.tts.filter(t => t.available).flatMap(t => t.styles ?? []))],
    }
  } catch (error) {
    return { ok: false, at, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function buildState({ ctx, settings, guard, bili, entryId, patrol, explorer }: PanelDeps): Promise<PanelState> {
  const s = settings()
  const cookiePath = cookieFilePath(s.bilibili.cookieFile)
  const login = await readLoginStatus(cookiePath)
  return {
    settings: pickEditable(s),
    fixed: {
      timeZone: s.timeZone,
      commentLength: s.commentLength,
      replyLength: s.replyLength,
      replyTool: s.bilibili.replyTool,
      voiceTool: s.bilibili.voiceTool,
      ttsService: s.tts.service,
    },
    usage: guard.usage(),
    dependencies: {
      replyTool: bili.has(s.bilibili.replyTool),
      voiceTool: s.bilibili.voiceTool ? bili.has(s.bilibili.voiceTool) : null,
      tts: resolveTts(ctx, s.tts.service) !== undefined,
    },
    persistence: persistence(ctx, entryId),
    defaultPersona: FISH_PERSONA,
    autoReplyStatus: patrol.status(),
    exploreStatus: explorer.status(),
    login: { ...login, mcpSnippet: mcpEntrySnippet(cookiePath) },
    feiyuLocal: await feiyuLocal(s),
    feiyuTest: lastFeiyuTest.get(ctx) ?? null,
    recentlyCommented: guard.recentlyCommented(),
  }
}

function pickEditable(s: Settings): EditableSettings {
  return {
    sendEnabled: s.sendEnabled,
    dryRunByDefault: s.dryRunByDefault,
    maxCommentsPerDay: s.maxCommentsPerDay,
    maxRepliesPerDay: s.maxRepliesPerDay,
    minIntervalMs: s.minIntervalMs,
    replyDedupeWindowMs: s.replyDedupeWindowMs,
    voiceEnabled: s.voiceEnabled,
    tts: { defaultVoice: s.tts.defaultVoice },
    voiceFallback: {
      enabled: s.voiceFallback.enabled,
      uploadUrl: s.voiceFallback.uploadUrl,
      template: s.voiceFallback.template,
    },
    persona: { override: s.persona.override, extra: s.persona.extra },
    commentOncePerVideoHours: s.commentOncePerVideoHours,
    feiyu: {
      baseUrl: s.feiyu.baseUrl,
      voice: s.feiyu.voice,
      style: s.feiyu.style,
      useForBiliVoice: s.feiyu.useForBiliVoice,
      waitSeconds: s.feiyu.waitSeconds,
    },
    explore: {
      enabled: s.explore.enabled,
      interests: [...s.explore.interests],
      intervalMin: s.explore.intervalMin,
      activeFrom: s.explore.activeFrom,
      activeTo: s.explore.activeTo,
      watchPerRound: s.explore.watchPerRound,
      commentsPerRound: s.explore.commentsPerRound,
      send: s.explore.send,
    },
    autoReply: {
      enabled: s.autoReply.enabled,
      videos: [...s.autoReply.videos],
      intervalSec: s.autoReply.intervalSec,
      maxPerRound: s.autoReply.maxPerRound,
      send: s.autoReply.send,
      skipNames: [...s.autoReply.skipNames],
    },
  }
}

function persistence(ctx: Context, entryId: string | undefined): PanelState['persistence'] {
  const forms = ctx.get('settings') as Context['settings'] | undefined
  if (!forms) return { writable: false, reason: '未加载 @deepseek-ai/dsh-settings，设置只能在 cordis.patch.yml 中修改' }
  if (!entryId) return { writable: false, reason: '插件不是从 profile 条目加载的，无法保存' }
  if (!forms.writable) return { writable: false, reason: '当前 profile 不接受表单写入' }
  const form = forms.describe({ redactSecrets: true }).find(row => row.ns === entryId)
  if (!form) {
    return { writable: false, reason: `条目 "${entryId}" 当前不可编辑（可能被 home 层或 --patch 覆盖）` }
  }
  return { writable: true, entryId, revision: form.revision }
}

type Problem = string

function bool(path: string, v: unknown, problems: Problem[]): boolean | undefined {
  if (typeof v !== 'boolean') problems.push(`${path} 必须是布尔值`)
  return typeof v === 'boolean' ? v : undefined
}

function int(path: string, v: unknown, min: number, max: number, problems: Problem[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${path} 必须是 ${min}～${max} 之间的整数`)
    return undefined
  }
  return v
}

function str(path: string, v: unknown, maxLength: number, problems: Problem[], pattern?: RegExp): string | undefined {
  if (typeof v !== 'string' || v.length > maxLength || (pattern && v !== '' && !pattern.test(v))) {
    problems.push(`${path} 格式不正确（最长 ${maxLength} 字符）`)
    return undefined
  }
  return v
}

function strList(path: string, v: unknown, maxItems: number, problems: Problem[], pattern?: RegExp): string[] | undefined {
  if (!Array.isArray(v) || v.length > maxItems || v.some(x => typeof x !== 'string' || x.length > 64 || (pattern && !pattern.test(x)))) {
    problems.push(`${path} 必须是最多 ${maxItems} 项的列表${pattern ? '（每项为 BV 号）' : ''}`)
    return undefined
  }
  return [...new Set(v as string[])]
}

function obj(path: string, v: unknown, allowed: readonly string[], problems: Problem[]): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    problems.push(`${path} 必须是对象`)
    return undefined
  }
  for (const key of Object.keys(v)) if (!allowed.includes(key)) problems.push(`不允许修改 ${path}.${key}`)
  return v as Record<string, unknown>
}

/**
 * Strict whitelist: only the volatile fields the page owns, with types and
 * bounds checked here (the settings service re-validates against Config).
 * Returns the cleaned patch or the list of problems.
 */
export function validatePatch(input: unknown): { patch: Record<string, unknown> } | { problems: Problem[] } {
  const problems: Problem[] = []
  const root = obj('patch', input, [
    'sendEnabled', 'dryRunByDefault', 'maxCommentsPerDay', 'maxRepliesPerDay', 'minIntervalMs',
    'replyDedupeWindowMs', 'voiceEnabled', 'tts', 'voiceFallback', 'persona', 'autoReply',
    'commentOncePerVideoHours', 'explore', 'feiyu',
  ], problems)
  if (!root) return { problems }
  const patch: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => { if (value !== undefined) patch[key] = value }

  if ('sendEnabled' in root) set('sendEnabled', bool('sendEnabled', root.sendEnabled, problems))
  if ('dryRunByDefault' in root) set('dryRunByDefault', bool('dryRunByDefault', root.dryRunByDefault, problems))
  if ('voiceEnabled' in root) set('voiceEnabled', bool('voiceEnabled', root.voiceEnabled, problems))
  if ('maxCommentsPerDay' in root) set('maxCommentsPerDay', int('maxCommentsPerDay', root.maxCommentsPerDay, 0, MAX_COMMENTS_CAP, problems))
  if ('maxRepliesPerDay' in root) set('maxRepliesPerDay', int('maxRepliesPerDay', root.maxRepliesPerDay, 0, MAX_REPLIES_CAP, problems))
  if ('minIntervalMs' in root) set('minIntervalMs', int('minIntervalMs', root.minIntervalMs, MIN_INTERVAL_FLOOR_MS, 24 * 3600 * 1000, problems))
  if ('replyDedupeWindowMs' in root) set('replyDedupeWindowMs', int('replyDedupeWindowMs', root.replyDedupeWindowMs, DEDUPE_FLOOR_MS, 7 * 24 * 3600 * 1000, problems))

  if ('tts' in root) {
    const tts = obj('tts', root.tts, ['defaultVoice'], problems)
    if (tts && 'defaultVoice' in tts) {
      const voice = str('tts.defaultVoice', tts.defaultVoice, 64, problems, /^[A-Za-z]{2,3}(-[A-Za-z0-9]+){2,3}$/)
      if (voice === '') problems.push('tts.defaultVoice 不能为空')
      else if (voice !== undefined) patch.tts = { defaultVoice: voice }
    }
  }
  if ('voiceFallback' in root) {
    const vf = obj('voiceFallback', root.voiceFallback, ['enabled', 'uploadUrl', 'template'], problems)
    if (vf) {
      const out: Record<string, unknown> = {}
      if ('enabled' in vf) out.enabled = bool('voiceFallback.enabled', vf.enabled, problems)
      if ('uploadUrl' in vf) out.uploadUrl = str('voiceFallback.uploadUrl', vf.uploadUrl, 2000, problems, /^https?:\/\/\S+$/)
      if ('template' in vf) out.template = str('voiceFallback.template', vf.template, 200, problems)
      patch.voiceFallback = out
    }
  }
  if ('persona' in root) {
    const p = obj('persona', root.persona, ['override', 'extra'], problems)
    if (p) {
      const out: Record<string, unknown> = {}
      if ('override' in p) out.override = str('persona.override', p.override, 8000, problems)
      if ('extra' in p) out.extra = str('persona.extra', p.extra, 2000, problems)
      patch.persona = out
    }
  }
  if ('commentOncePerVideoHours' in root) {
    set('commentOncePerVideoHours', int('commentOncePerVideoHours', root.commentOncePerVideoHours, 1, 24 * 365, problems))
  }
  if ('feiyu' in root) {
    const f = obj('feiyu', root.feiyu, ['baseUrl', 'voice', 'style', 'useForBiliVoice', 'waitSeconds'], problems)
    if (f) {
      const out: Record<string, unknown> = {}
      if ('baseUrl' in f) out.baseUrl = str('feiyu.baseUrl', f.baseUrl, 500, problems, /^https?:\/\/\S+$/)
      if ('voice' in f) out.voice = str('feiyu.voice', f.voice, 80, problems, /^[A-Za-z0-9_.-]+$/)
      if ('style' in f) out.style = str('feiyu.style', f.style, 40, problems, /^[A-Za-z0-9_-]+$/)
      if ('useForBiliVoice' in f) out.useForBiliVoice = bool('feiyu.useForBiliVoice', f.useForBiliVoice, problems)
      if ('waitSeconds' in f) out.waitSeconds = int('feiyu.waitSeconds', f.waitSeconds, 10, 1800, problems)
      patch.feiyu = out
    }
  }
  if ('explore' in root) {
    const e = obj('explore', root.explore, ['enabled', 'interests', 'intervalMin', 'activeFrom', 'activeTo', 'watchPerRound', 'commentsPerRound', 'send'], problems)
    if (e) {
      const out: Record<string, unknown> = {}
      if ('enabled' in e) out.enabled = bool('explore.enabled', e.enabled, problems)
      if ('send' in e) out.send = bool('explore.send', e.send, problems)
      if ('interests' in e) out.interests = strList('explore.interests', e.interests, 30, problems)
      if ('intervalMin' in e) out.intervalMin = int('explore.intervalMin', e.intervalMin, 30, 24 * 60, problems)
      if ('activeFrom' in e) out.activeFrom = int('explore.activeFrom', e.activeFrom, 0, 23, problems)
      if ('activeTo' in e) out.activeTo = int('explore.activeTo', e.activeTo, 1, 24, problems)
      if ('watchPerRound' in e) out.watchPerRound = int('explore.watchPerRound', e.watchPerRound, 1, 5, problems)
      if ('commentsPerRound' in e) out.commentsPerRound = int('explore.commentsPerRound', e.commentsPerRound, 0, 3, problems)
      patch.explore = out
    }
  }
  if ('autoReply' in root) {
    const a = obj('autoReply', root.autoReply, ['enabled', 'videos', 'intervalSec', 'maxPerRound', 'send', 'skipNames'], problems)
    if (a) {
      const out: Record<string, unknown> = {}
      if ('enabled' in a) out.enabled = bool('autoReply.enabled', a.enabled, problems)
      if ('send' in a) out.send = bool('autoReply.send', a.send, problems)
      if ('intervalSec' in a) out.intervalSec = int('autoReply.intervalSec', a.intervalSec, 60, 86400, problems)
      if ('maxPerRound' in a) out.maxPerRound = int('autoReply.maxPerRound', a.maxPerRound, 1, 10, problems)
      if ('videos' in a) out.videos = strList('autoReply.videos', a.videos, 50, problems, /^BV[0-9A-Za-z]{10}$/)
      if ('skipNames' in a) out.skipNames = strList('autoReply.skipNames', a.skipNames, 20, problems)
      patch.autoReply = out
    }
  }
  return problems.length > 0 ? { problems } : { patch }
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k]
    // Arrays replace wholesale (like the settings service does); only plain objects merge.
    const mergeable = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)
    out[k] = mergeable(v) && mergeable(prev)
      ? merge(prev as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}

export async function dispatch(deps: PanelDeps, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
  try {
    switch (endpoint as Endpoint) {
      case 'state':
        return ok(await buildState(deps))
      case 'save':
        return await save(deps, payload)
      case 'check':
        // Run one patrol round now (it still respects every switch and limit).
        if (!deps.settings().autoReply.enabled) return fail('disabled', '自动回复未开启')
        await deps.patrol.runRound()
        return ok(await buildState(deps))
      case 'login': {
        // Secrets go straight to the cookie file; they are never echoed back.
        const checked = validateLogin(payload)
        if ('problems' in checked) return fail('invalid', checked.problems.join('；'), { problems: checked.problems })
        try {
          await saveLogin(cookieFilePath(deps.settings().bilibili.cookieFile), checked.value)
        } catch (error) {
          return fail('save-failed', `写入登录信息失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return ok(await buildState(deps))
      }
      case 'logout':
        try {
          await clearLogin(cookieFilePath(deps.settings().bilibili.cookieFile))
        } catch (error) {
          return fail('save-failed', `删除登录信息失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return ok(await buildState(deps))
      case 'feiyu-key': {
        // The API key goes to its own 0600 file and is never echoed back.
        const key = (payload as { apiKey?: unknown } | null)?.apiKey
        if (!validApiKey(key)) return fail('invalid', 'API Key 格式不对（8～512 个可见字符，不含空格）')
        try {
          await saveApiKey(feiyuPaths(deps.settings().feiyu).keyFile, key)
        } catch (error) {
          return fail('save-failed', `保存 API Key 失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return ok(await buildState(deps))
      }
      case 'feiyu-key-clear':
        try {
          await clearApiKey(feiyuPaths(deps.settings().feiyu).keyFile)
        } catch (error) {
          return fail('save-failed', `删除 API Key 失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return ok(await buildState(deps))
      case 'feiyu-test':
        lastFeiyuTest.set(deps.ctx, await testFeiyu(deps.settings()))
        return ok(await buildState(deps))
      case 'explore':
        // Wake the exploration session once now (still within every limit; ignores the interval, not the switch).
        if (!deps.settings().explore.enabled) return fail('disabled', '自己逛未开启')
        await deps.explorer.round()
        return ok(await buildState(deps))
      default:
        return fail('unknown-endpoint', `unknown endpoint "${endpoint}"`)
    }
  } catch (error) {
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}

async function save(deps: PanelDeps, payload: unknown): Promise<RpcResult<PanelState>> {
  const request = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<SaveRequest>
  const checked = validatePatch(request.patch)
  if ('problems' in checked) return fail('invalid', checked.problems.join('；'), { problems: checked.problems })

  const merged = merge(deps.settings() as unknown as Record<string, unknown>, checked.patch) as unknown as Settings
  const problems = configProblems(merged)
  if (problems.length > 0) return fail('invalid', problems.join('；'), { problems })

  const target = persistence(deps.ctx, deps.entryId)
  if (!target.writable) return fail('read-only', target.reason)
  if (request.revision !== undefined && request.revision !== target.revision) {
    return fail('conflict', '设置已在别处被修改，请刷新后再保存', { expected: request.revision, actual: target.revision })
  }

  const forms = deps.ctx.get('settings') as Context['settings']
  try {
    await forms.update(target.entryId, checked.patch, target.revision)
  } catch (error) {
    const code = (error as { code?: unknown })?.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'save-failed'
    return fail(code, error instanceof Error ? error.message : String(error))
  }
  return ok(await buildState(deps))
}

/** Serve one endpoint as a Fetch route: JSON body in, RpcResult JSON out (always HTTP 200 for handled calls). */
export async function handleFetch(deps: PanelDeps, endpoint: Endpoint, request: Request): Promise<Response> {
  let payload: unknown = null
  try {
    const text = await request.text()
    payload = text.trim() === '' ? null : JSON.parse(text)
  } catch {
    return Response.json(fail('bad-request', 'request body is not JSON'), { status: 400 })
  }
  return Response.json(await dispatch(deps, endpoint, payload))
}

/**
 * Register the page's routes while ctx.connection exists, and tell the
 * settings service this plugin ships its own page. Both are optional: without
 * them the tools still work and the page simply isn't available.
 *
 * Why not `connection.rpc.handle()`: it mounts a new top-level route through
 * the caller's `webServer`, and in a real DSH profile that service lives in a
 * part of the plugin tree a profile plugin cannot see ("cannot get property
 * webServer without inject"), so the route was never mounted and the page got
 * HTTP 405. Exact routes under `/api` only touch the Connection service.
 */
export function installPanelHost(deps: PanelDeps): void {
  const { ctx } = deps
  const pluginFiber = ctx.fiber

  ctx.inject(['connection'], (sub) => {
    for (const endpoint of ENDPOINTS) {
      const path = endpointPath(endpoint)
      sub.effect(() => {
        let dispose: () => Promise<void>
        try {
          dispose = sub.connection.fetch.register({
            path,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: request => handleFetch(deps, endpoint, request),
          })
        } catch (error) {
          console.error(`[bili-fish] 设置页接口 ${path} 注册失败：`, error)
          throw error
        }
        // Dispose explicitly from our own effect, so the route always leaves with this plugin.
        return () => { void dispose() }
      }, `bili-fish: ${path} route`)
    }
    console.info(`[bili-fish] 设置页接口已注册：POST ${ENDPOINTS.map(endpointPath).join('、')}`)
  })

  ctx.inject(['settings'], (sub) => {
    sub.effect(() => sub.settings.configure({ auto: false }, pluginFiber), 'bili-fish: settings page policy')
  })
}
