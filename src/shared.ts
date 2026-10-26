import type { LengthRange, Settings } from './config.js'

/** Why a call did not write to bilibili. Every one of these is a normal return value, never a throw. */
export const SKIP_REASONS = [
  'rate_limited',
  'send_disabled',
  'dry_run_not_explicit',
  'dependency_missing',
  'voice_disabled',
  'already_commented',
  'voice_unsupported',
] as const
export type SkipReason = typeof SKIP_REASONS[number]

/** `{ skipped: true, reason, message? }` — the canonical "nothing was sent" value. */
export const SKIPPED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    skipped: { type: 'boolean', const: true, required: true },
    reason: { type: 'string', enum: SKIP_REASONS, required: true },
    message: { type: 'string' },
  },
} as const

/** `{ rpid, message }` or skipped. Shared by bili_comment and bili_reply. */
export const POST_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        rpid: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    SKIPPED_SCHEMA,
  ],
} as const

export interface Skipped {
  skipped: true
  reason: SkipReason
  message?: string
}

export function skipped(reason: SkipReason, message?: string): Skipped {
  return message === undefined ? { skipped: true, reason } : { skipped: true, reason, message }
}

export function isSkipped(value: unknown): value is Skipped {
  return typeof value === 'object' && value !== null && (value as { skipped?: unknown }).skipped === true
}

export type SendDecision =
  | { mode: 'draft' }
  | { mode: 'send' }
  | { mode: 'skip'; result: Skipped }

/**
 * Decide whether this call may write to bilibili. A real write needs BOTH the
 * global `sendEnabled` switch AND an explicit `dryRun: false` on the call;
 * a `false` that only came from `dryRunByDefault` is not enough.
 */
export function decideSend(config: Settings, dryRunArg: boolean | undefined): SendDecision {
  const dryRun = dryRunArg ?? config.dryRunByDefault
  if (dryRun) return { mode: 'draft' }
  if (dryRunArg !== false) {
    return { mode: 'skip', result: skipped('dry_run_not_explicit', '真实发送需要在调用时显式传 dryRun: false') }
  }
  if (!config.sendEnabled) {
    return { mode: 'skip', result: skipped('send_disabled', '总发送开关 sendEnabled 未开启，未发送') }
  }
  return { mode: 'send' }
}

/** Length in user-perceived characters (code points), which is how bilibili counts. */
export function charLength(text: string): number {
  return [...text].length
}

export function assertLength(field: string, text: string, range: LengthRange): void {
  const n = charLength(text.trim())
  if (n < range.min || n > range.max) {
    throw new Error(`${field} 长度为 ${n} 字，需要在 ${range.min}～${range.max} 字之间，请按大肥鱼人格重写`)
  }
}

const BV = /^BV[0-9A-Za-z]{10}$/
const AV = /^av\d+$/i

export function assertVideoId(videoId: string): void {
  if (!BV.test(videoId) && !AV.test(videoId)) {
    throw new Error(`videoId "${videoId}" 不是合法的 BV 号（BV + 10 位）或 av 号（av + 数字）`)
  }
}

export function assertRpid(rpid: string): void {
  if (!/^\d+$/.test(rpid)) throw new Error(`parentRpid "${rpid}" 应为纯数字的评论 id`)
}
