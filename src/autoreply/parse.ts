/** One top-level comment as read from bilibili-mcp-server's `bilibili_video_comments`. */
export interface WatchedComment {
  videoId: string
  rpid: string
  user: string
  text: string
}

/**
 * Parse the text result of bilibili-mcp-server 1.2.0 `bilibili_video_comments`:
 *
 *   📋 共 2 条评论：
 *   1. 某某: 评论内容 [rpid:123456] 👍3
 *   2. 别人: 第一行
 *   第二行 [rpid:654321]
 *
 * The server prints the first 100 characters of each message, which may span
 * lines, so entries are delimited by the `N. ` prefix and the `[rpid:N]` tag
 * rather than by newlines. Unparseable text yields no comments.
 */
export function parseVideoComments(videoId: string, text: string): WatchedComment[] {
  const out: WatchedComment[] = []
  const entry = /(?:^|\n)\d+\. ([^\n]*?): ([\s\S]*?) \[rpid:(\d+)\]/g
  for (const m of text.matchAll(entry)) {
    const [, user = '', body = '', rpid = ''] = m
    out.push({ videoId, rpid, user: user.trim(), text: body.trim() })
  }
  return out
}

/** Join the text blocks of an MCP tool's canonical value `{ content: [...] }`. */
export function mcpText(value: unknown): string {
  const content = (value as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b as { type?: unknown; text?: unknown })?.type === 'text' ? String((b as { text: unknown }).text) : '')
    .join('\n')
}
