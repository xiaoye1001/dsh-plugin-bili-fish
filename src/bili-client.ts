import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config, Settings } from './config.js'

export interface PostResult {
  /** bilibili 返回的评论 id；解析不到时为空串。 */
  rpid: string
}

/**
 * Thin wrapper over the bilibili-mcp tools bridged by @deepseek-ai/dsh-mcp-client.
 *
 * This plugin never talks to bilibili over HTTP itself: login, cookies and
 * risk-control stay inside bilibili-mcp. Every write goes back through
 * ctx.tools.execute(), so the nested call runs the full policy pipeline
 * (pre-execute, guards, approval) and is logged with this call as its parent.
 */
export class BiliClient {
  private seq = 0

  constructor(private readonly ctx: Context, private readonly config: Config['bilibili']) {}

  get replyTool(): string {
    return this.config.replyTool
  }

  get voiceTool(): string | undefined {
    return this.config.voiceTool || undefined
  }

  /** Whether a tool is visible to the calling agent right now (MCP tools come and go with reconnects). */
  has(name: string | undefined, exec?: Pick<ToolRunContext, 'agent'>): boolean {
    if (!name) return false
    return this.ctx.tools.get(name, exec?.agent) !== undefined
  }

  /** Post a top-level comment (no parentRpid) or a reply. */
  async postText(
    input: { videoId: string; message: string; parentRpid?: string },
    exec: ToolRunContext,
  ): Promise<PostResult> {
    const args: Record<string, string> = { videoId: input.videoId, message: input.message }
    if (input.parentRpid !== undefined) args.parentRpid = input.parentRpid
    return this.call(this.config.replyTool, args, exec)
  }

  async postVoice(
    input: { videoId: string; audioPath: string; message: string },
    exec: ToolRunContext,
  ): Promise<PostResult> {
    const tool = this.voiceTool
    if (!tool) throw new Error('bilibili.voiceTool is not configured')
    return this.call(tool, { ...input }, exec)
  }

  private async call(name: string, args: Record<string, string>, exec: ToolRunContext): Promise<PostResult> {
    const result = await this.ctx.tools.execute({
      callId: ToolCallId(`${exec.callId}:bili-fish:${++this.seq}`),
      rootCallId: exec.rootCallId,
      name,
      arguments: args,
      signal: exec.signal,
      parent: exec.token,
      ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    })
    if (result.isError) {
      throw new Error(`${name} 调用失败：${result.error.message}`)
    }
    return { rpid: extractRpid(result.value) }
  }
}

/**
 * bilibili-mcp servers differ in how they report the new comment id. Look in
 * structuredContent first, then in JSON text blocks, then fall back to a
 * loose "rpid: 123" match. Returns '' when nothing is found.
 */
export function extractRpid(value: unknown): string {
  const fromObject = (obj: unknown, depth = 0): string | undefined => {
    if (typeof obj !== 'object' || obj === null || depth > 4) return undefined
    const record = obj as Record<string, unknown>
    for (const key of ['rpid', 'rpid_str']) {
      const v = record[key]
      if (typeof v === 'string' && /^\d+$/.test(v)) return v
      if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v)
    }
    for (const key of ['structuredContent', 'data', 'reply', 'result']) {
      const found = fromObject(record[key], depth + 1)
      if (found) return found
    }
    return undefined
  }

  const direct = fromObject(value)
  if (direct) return direct

  const content = (value as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { type?: unknown; text?: unknown })?.type === 'text'
        ? (block as { text: unknown }).text
        : undefined
      if (typeof text !== 'string') continue
      try {
        const found = fromObject(JSON.parse(text))
        if (found) return found
      } catch {
        // not JSON; try the loose match below
      }
      const m = /rpid(?:_str)?["'\s:=]*(\d{5,})/i.exec(text)
      if (m?.[1]) return m[1]
    }
  }
  return ''
}

/**
 * Fallback for voice comments when bilibili-mcp has no voice tool: upload the
 * audio file to a user-supplied file service and return its public URL.
 * Off unless voiceFallback.enabled is set. The caller's signal is passed to
 * fetch so cancelling the tool call aborts the upload.
 */
export async function uploadAudio(
  audioPath: string,
  mime: string,
  config: Settings['voiceFallback'],
  signal: AbortSignal,
): Promise<string> {
  const bytes = await readFile(audioPath, { signal })
  const form = new FormData()
  form.append(config.fileField, new Blob([bytes], { type: mime }), basename(audioPath))
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const response = await fetch(config.uploadUrl, {
    method: 'POST',
    headers: config.headers,
    body: form,
    signal: AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) {
    throw new Error(`音频上传失败：HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  let cursor: unknown = body
  for (const key of config.urlField.split('.')) {
    cursor = typeof cursor === 'object' && cursor !== null ? (cursor as Record<string, unknown>)[key] : undefined
  }
  if (typeof cursor !== 'string' || !/^https?:\/\//.test(cursor)) {
    throw new Error(`音频上传响应里没有找到 ${config.urlField} 链接`)
  }
  return cursor
}
