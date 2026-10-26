import type { Context } from '@deepseek-ai/cordis'
import type { BiliClient } from '../bili-client.js'
import type { Settings } from '../config.js'
import type { SendGuard } from '../guard.js'

/** Everything a tool factory needs; built once in apply(). */
export interface ToolDeps {
  ctx: Context
  /** Current effective settings; call per execution so panel edits apply immediately. */
  settings: () => Settings
  guard: SendGuard
  bili: BiliClient
}

export function missingTool(name: string): string {
  return `依赖缺失：当前不可见工具 ${name}。请确认已用 @deepseek-ai/dsh-mcp-client 接入 bilibili-mcp 并已连接。`
}
