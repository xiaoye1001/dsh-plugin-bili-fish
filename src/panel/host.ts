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
}

const ok = <T>(value: T): RpcResult<T> => ({ ok: true, value })
const fail = <T = never>(code: string, message: string, details: object = {}): RpcResult<T> =>
  ({ ok: false, error: { code, message, details } })

export function buildState({ ctx, settings, guard, bili, entryId, patrol }: PanelDeps): PanelState {
  const s = settings()
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
        return ok(buildState(deps))
      case 'save':
        return await save(deps, payload)
      case 'check':
        // Run one patrol round now (it still respects every switch and limit).
        if (!deps.settings().autoReply.enabled) return fail('disabled', '自动回复未开启')
        await deps.patrol.runRound()
        return ok(buildState(deps))
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
  return ok(buildState(deps))
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
