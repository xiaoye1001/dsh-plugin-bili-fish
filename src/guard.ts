import type { Settings } from './config.js'

export type Bucket = 'comment' | 'reply'

/** BV ids are case-sensitive; av ids are not. */
function videoKey(videoId: string): string {
  return /^av\d+$/i.test(videoId) ? videoId.toLowerCase() : videoId
}

export type GuardDecision = { ok: true } | { ok: false; message: string }

export interface UsageSnapshot {
  /** Local calendar day the counters belong to (YYYY-MM-DD in config.timeZone). */
  day: string
  comments: number
  replies: number
  /** Epoch ms of the last real send, or null when nothing was sent since load. */
  lastSendAt: number | null
  /** Parent rpids still inside the dedupe window. */
  recentReplies: number
}

/**
 * Daily caps, minimum spacing, and short-term reply dedupe for real sends.
 *
 * Limits are read through `settings()` on every check, so a save from the
 * settings page applies to the next call. State lives in this plugin
 * instance's memory: a host restart or full reload resets it. Check-and-reserve
 * runs synchronously, so two concurrent calls cannot both pass the same slot.
 */
export class SendGuard {
  private day = ''
  private counts: Record<Bucket, number> = { comment: 0, reply: 0 }
  private lastSendAt = Number.NEGATIVE_INFINITY
  private readonly replied = new Map<string, number>()
  private readonly commented = new Map<string, number>()
  private readonly dayFormat: Intl.DateTimeFormat

  constructor(private readonly settings: () => Settings, private readonly now: () => number = Date.now) {
    this.dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: settings().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  /** Read-only check: would a send in this bucket pass right now? */
  check(bucket: Bucket): GuardDecision {
    const t = this.now()
    this.rollDay(t)
    const s = this.settings()
    const limit = bucket === 'comment' ? s.maxCommentsPerDay : s.maxRepliesPerDay
    if (this.counts[bucket] >= limit) {
      return { ok: false, message: `今日${bucket === 'comment' ? '评论' : '回复'}已达上限 ${limit} 条` }
    }
    const wait = this.lastSendAt + s.minIntervalMs - t
    if (wait > 0) {
      return { ok: false, message: `距上次发送不足 ${s.minIntervalMs} ms，还需等待约 ${Math.ceil(wait / 1000)} 秒` }
    }
    return { ok: true }
  }

  /**
   * Check and, on success, consume one slot. A consumed slot is NOT given back
   * if the send later fails: a failed network call may still have posted, so
   * the guard stays on the conservative side.
   */
  reserve(bucket: Bucket): GuardDecision {
    const decision = this.check(bucket)
    if (!decision.ok) return decision
    this.counts[bucket] += 1
    this.lastSendAt = this.now()
    return decision
  }

  wasRecentlyReplied(parentRpid: string): boolean {
    this.pruneReplied()
    return this.replied.has(parentRpid)
  }

  markReplied(parentRpid: string): void {
    this.pruneReplied()
    this.replied.set(parentRpid, this.now())
  }

  /** Whether this plugin commented on the video within commentOncePerVideoHours. */
  wasCommented(videoId: string): boolean {
    this.pruneCommented()
    return this.commented.has(videoKey(videoId))
  }

  markCommented(videoId: string): void {
    this.pruneCommented()
    this.commented.set(videoKey(videoId), this.now())
  }

  /** Videos commented on recently, newest first (for the exploration prompt). */
  recentlyCommented(limit = 20): string[] {
    this.pruneCommented()
    return [...this.commented.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([v]) => v)
  }

  private pruneCommented(): void {
    const cutoff = this.now() - this.settings().commentOncePerVideoHours * 3600_000
    for (const [v, at] of this.commented) {
      if (at <= cutoff) this.commented.delete(v)
    }
  }

  usage(): UsageSnapshot {
    this.rollDay(this.now())
    this.pruneReplied()
    return {
      day: this.day,
      comments: this.counts.comment,
      replies: this.counts.reply,
      lastSendAt: Number.isFinite(this.lastSendAt) ? this.lastSendAt : null,
      recentReplies: this.replied.size,
    }
  }

  private pruneReplied(): void {
    const cutoff = this.now() - this.settings().replyDedupeWindowMs
    for (const [rpid, at] of this.replied) {
      if (at <= cutoff) this.replied.delete(rpid)
    }
  }

  private rollDay(t: number): void {
    const day = this.dayFormat.format(t)
    if (day !== this.day) {
      this.day = day
      this.counts = { comment: 0, reply: 0 }
    }
  }
}
