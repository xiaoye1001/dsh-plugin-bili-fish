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
  return `依赖缺失：${name} 未注册。bilibili-mcp-server 没有接入或没有连接：检查 cordis.patch.yml 里的 mcp-bilibili 条目，以及 dsh web 启动输出里 mcp-client(bilibili) 的报错。`
}
