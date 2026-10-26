// Wire contract between the host RPC channel and the browser settings page.
// Pure types and data: imported by both halves, so no Node APIs here.

/**
 * The page talks to the host through exact routes under DSH's own `/api`
 * channel (`ctx.connection.fetch.register`). That route is mounted and
 * authenticated by the Connection service itself, so the plugin never needs
 * the `webServer` service, which a profile plugin may not be able to see.
 */
export const API_BASE = '/api/bili-fish'

export type Endpoint = 'state' | 'save' | 'check' | 'explore' | 'login' | 'logout'

export const ENDPOINTS: readonly Endpoint[] = ['state', 'save', 'check', 'explore', 'login', 'logout']

/** Absolute route path for one endpoint, e.g. `/api/bili-fish/state`. */
export function endpointPath(endpoint: Endpoint): string {
  return `${API_BASE}/${endpoint}`
}

/** The fields the settings page may change. All of them are `.volatile()` in Config. */
export interface EditableSettings {
  sendEnabled: boolean
  dryRunByDefault: boolean
  maxCommentsPerDay: number
  maxRepliesPerDay: number
  minIntervalMs: number
  replyDedupeWindowMs: number
  voiceEnabled: boolean
  tts: { defaultVoice: string }
  voiceFallback: { enabled: boolean; uploadUrl: string; template: string }
  persona: { override: string; extra: string }
  commentOncePerVideoHours: number
  explore: {
    enabled: boolean
    interests: string[]
    intervalMin: number
    activeFrom: number
    activeTo: number
    watchPerRound: number
    commentsPerRound: number
    send: boolean
  }
  autoReply: {
    enabled: boolean
    videos: string[]
    intervalSec: number
    maxPerRound: number
    send: boolean
    skipNames: string[]
  }
}

/** Live state of exploration. */
export interface ExploreStatus {
  enabled: boolean
  active: boolean
  lastWakeAt: number | null
  lastKeyword: string | null
  nextKeyword: string | null
  lastError: string | null
  sessionId: string
}

/** Live state of the auto-reply patrol. */
export interface AutoReplyStatus {
  enabled: boolean
  watching: number
  pending: number
  lastRunAt: number | null
  lastWakeAt: number | null
  lastError: string | null
  sessionId: string
}

export interface PanelState {
  settings: EditableSettings
  /** Read-only values shown for context (change them in cordis.patch.yml). */
  fixed: {
    timeZone: string
    commentLength: { min: number; max: number }
    replyLength: { min: number; max: number }
    replyTool: string
    voiceTool: string
    ttsService: string
  }
  usage: {
    day: string
    comments: number
    replies: number
    lastSendAt: number | null
    recentReplies: number
  }
  dependencies: {
    replyTool: boolean
    voiceTool: boolean | null
    tts: boolean
  }
  /** Whether saving is possible, and the settings revision to fence the next write. */
  persistence: { writable: true; entryId: string; revision: number } | { writable: false; reason: string }
  /** Built-in persona text, so the page can show what “override” replaces. */
  defaultPersona: string
  autoReplyStatus: AutoReplyStatus
  exploreStatus: ExploreStatus
  /** Which login values are stored; secrets are reported as set/unset only. */
  login: {
    path: string
    sessdata: boolean
    biliJct: boolean
    dedeUserId: string | null
    updatedAt: number | null
    /** cordis.patch.yml entry pointing bilibili-mcp-server at the file. */
    mcpSnippet: string
  }
  recentlyCommented: string[]
}

export interface SaveRequest {
  patch: unknown
  /** Revision from the last `state`; a mismatch means someone else saved first. */
  revision?: number
}

export interface RpcFailure {
  code: string
  message: string
  details: object
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcFailure }

export const MIN_INTERVAL_FLOOR_MS = 12000
export const DEDUPE_FLOOR_MS = 60000
export const MAX_COMMENTS_CAP = 100
export const MAX_REPLIES_CAP = 200
