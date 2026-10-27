import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ToolCallId is a compile-time brand over string, so no runtime import of dsh-llm is needed.
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
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
  /** rpids of comments this plugin posted, so the auto-reply patrol never answers itself. */
  private readonly posted = new Set<string>()

  isOwnComment(rpid: string): boolean {
    return this.posted.has(rpid)
  }

  /** Tokens of this plugin's own executions that are currently calling a bilibili tool. */
  private readonly inFlight = new Set<ToolExecutionToken>()

  constructor(private readonly ctx: Context, private readonly config: Config['bilibili']) {}

  get replyTool(): string {
    return this.config.replyTool
  }

  get voiceTool(): string | undefined {
    return this.config.voiceTool || undefined
  }

  /**
   * Whether the plugin can reach a bilibili-mcp tool right now (MCP tools come
   * and go with reconnects). See {@link scopeFor}: a tool hidden from a
   * restricted session but registered globally still counts.
   */
  has(name: string | undefined, exec?: Pick<ToolRunContext, 'agent'>): boolean {
    return this.scopeFor(name, exec) !== null
  }

  /**
   * Where to run a nested bilibili-mcp call. The calling agent's view first,
   * so normal sessions behave exactly as before; otherwise the global view.
   *
   * The fallback exists for the plugin's own sessions (auto-reply, explore):
   * they are restricted to the plugin's tools with tools.restrict({ allow }),
   * which also hides the MCP tools those tools call internally. The model in
   * such a session still cannot call the MCP tools itself — only these nested
   * calls, made with this execution as parent, reach them.
   * @returns `{ agent }` / `{}` for the scope to execute in, or null when the tool is not registered at all.
   */
  private scopeFor(name: string | undefined, exec?: Pick<ToolRunContext, 'agent'>): { agent?: ToolRunContext['agent'] } | null {
    if (!name) return null
    const agent = exec?.agent
    if (agent !== undefined && this.ctx.tools.get(name, agent) !== undefined) return { agent }
    return this.ctx.tools.get(name) !== undefined ? {} : null
  }

  /** Execution-input scope for a nested call; throws a clear error when the tool is not registered. */
  private nestedScope(name: string, exec: ToolRunContext): { agent?: ToolRunContext['agent'] } {
    const scope = this.scopeFor(name, exec)
    if (!scope) throw new Error(`${name} 未注册：bilibili-mcp-server 没有接入或没有连接`)
    return scope.agent !== undefined ? { agent: scope.agent } : {}
  }

  /**
   * Post a top-level comment (no parentRpid) or a reply. Bilibili threads a
   * reply by `root` (the top-level comment) and `parent` (the comment being
   * answered); for a reply to a top-level comment both are the same rpid.
   */
  async postText(
    input: { videoId: string; message: string; parentRpid?: string; rootRpid?: string },
    exec: ToolRunContext,
  ): Promise<PostResult> {
    const args: Record<string, string> = { videoId: input.videoId, message: input.message }
    if (input.parentRpid !== undefined) {
      args.parentRpid = input.parentRpid
      args.rootRpid = input.rootRpid ?? input.parentRpid
    }
    return this.call(this.config.replyTool, args, exec)
  }

  /**
   * Monotonic tool guard: a bilibili write tool may only run as a nested call
   * made by this plugin, so the model cannot bypass the switches, daily caps
   * and spacing by calling the MCP tool directly. Returns a denial reason, or
   * undefined to allow.
   */
  guardDirectCall(execution: Readonly<ToolExecution>, blocked: ReadonlySet<string>): string | undefined {
    if (!blocked.has(execution.name)) return undefined
    if (execution.parent !== undefined && this.inFlight.has(execution.parent)) return undefined
    return `${execution.name} 只能经 bili_comment / bili_reply / bili_send_voice 调用（受发送开关与频率限制约束）`
  }

  async postVoice(
    input: { videoId: string; audioPath: string; message: string },
    exec: ToolRunContext,
  ): Promise<PostResult> {
    const tool = this.voiceTool
    if (!tool) throw new Error('bilibili.voiceTool is not configured')
    return this.call(tool, { ...input }, exec)
  }

  /**
   * Run a bilibili-mcp read tool as a nested call of `exec` and return its text.
   * Read tools are not write-guarded, but nesting keeps the call logged under
   * the plugin tool that made it and cancels with it.
   */
  async readText(name: string, args: Record<string, unknown>, exec: ToolRunContext): Promise<string> {
    const result = await this.ctx.tools.execute({
      callId: `${exec.callId}:bili-fish-read:${++this.seq}` as ToolCallId,
      rootCallId: exec.rootCallId,
      name,
      arguments: args,
      signal: exec.signal,
      parent: exec.token,
      ...this.nestedScope(name, exec),
    })
    if (result.isError) throw new Error(result.error.message)
    const content = (result.value as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) return ''
    return content
      .map(b => (b as { type?: unknown; text?: unknown })?.type === 'text' ? String((b as { text: unknown }).text) : '')
      .join('\n')
  }

  private async call(name: string, args: Record<string, string>, exec: ToolRunContext): Promise<PostResult> {
    this.inFlight.add(exec.token)
    try {
      return await this.dispatch(name, args, exec)
    } finally {
      this.inFlight.delete(exec.token)
    }
  }

  private async dispatch(name: string, args: Record<string, string>, exec: ToolRunContext): Promise<PostResult> {
    const result = await this.ctx.tools.execute({
      callId: `${exec.callId}:bili-fish:${++this.seq}` as ToolCallId,
      rootCallId: exec.rootCallId,
      name,
      arguments: args,
      signal: exec.signal,
      parent: exec.token,
      ...this.nestedScope(name, exec),
    })
    if (result.isError) {
      throw new Error(`${name} 调用失败：${result.error.message}`)
    }
    const rpid = extractRpid(result.value)
    if (rpid) {
      this.posted.add(rpid)
      if (this.posted.size > 5_000) this.posted.delete(this.posted.values().next().value as string)
    }
    return { rpid }
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
