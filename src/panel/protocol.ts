// Wire contract between the host RPC channel and the browser settings page.
// Pure types and data: imported by both halves, so no Node APIs here.

export const RPC_CHANNEL = '/bili-fish'

export type Endpoint = 'state' | 'save'

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
