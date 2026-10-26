// dsh-plugin-bili-fish —— “大肥鱼” B 站评论 / 回复 / 语音工具插件。
//
// 函数插件形态：name / inject / Config / apply。所有注册都通过 ctx，
// 插件卸载时自动注销。默认只出草稿，真实发送需要 sendEnabled=true
// 且调用时显式 dryRun:false，并受每日上限与最小间隔约束。
//
// 浏览器半（设置页）在 src/client/，经 package.json 的 dsh.client 声明加载，
// 通过 Connection RPC 通道 /bili-fish 与这里通信（src/panel/host.ts）。

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { BiliClient } from './bili-client.js'
import { Config, assertConfig, resolveSettings } from './config.js'
import { SendGuard } from './guard.js'
import { installPanelHost } from './panel/host.js'
import { ReplyPatrol } from './autoreply/watcher.js'
import { Explorer } from './explore/explorer.js'
import { SessionDoor } from './session.js'
import { createDiscoverTool } from './tools/discover.js'
import { createWatchTool } from './tools/watch.js'
import { createBuildPromptTool } from './tools/build-prompt.js'
import { createCommentTool } from './tools/comment.js'
import { createReplyTool } from './tools/reply.js'
import { createSendVoiceTool } from './tools/send-voice.js'
import type { ToolDeps } from './tools/deps.js'
import { resolveTts } from './tts.js'

export { Config }
export { FISH_PERSONA } from './persona.js'
export type { TtsService } from './tts.js'

export const name = 'dsh-plugin-bili-fish'
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const settings = () => resolveSettings(config)
  const initial = settings()
  assertConfig(initial)
  const logger = ctx.logger('bili-fish')
  // Plain console too: `dsh web` shows plugin console output, the Cordis logger may go elsewhere.
  console.info(`[bili-fish] 已加载 · 发送${initial.sendEnabled ? '已开启' : '关闭（只出草稿）'} · 条目 ${(ctx.fiber as { entry?: { options?: { id?: string } } }).entry?.options?.id ?? '(无)'}`)

  const deps: ToolDeps = {
    ctx,
    settings,
    guard: new SendGuard(settings),
    bili: new BiliClient(ctx, initial.bilibili),
  }

  ctx.tools.register(createBuildPromptTool(deps))
  ctx.tools.register(createCommentTool(deps))
  ctx.tools.register(createReplyTool(deps))
  ctx.tools.register(createSendVoiceTool(deps))
  ctx.tools.register(createDiscoverTool(deps))
  ctx.tools.register(createWatchTool(deps))

  // Keep the model from calling bilibili write tools directly and skipping the guard above.
  ctx.tools.guard((execution) => {
    const s = settings()
    const blocked = new Set([s.bilibili.replyTool, ...s.bilibili.blockDirect])
    if (s.bilibili.voiceTool) blocked.add(s.bilibili.voiceTool)
    return deps.bili.guardDirectCall(execution, blocked)
  })

  const door = new SessionDoor(ctx)
  door.install()
  const patrol = new ReplyPatrol({ ctx, settings, door, isOwnComment: rpid => deps.bili.isOwnComment(rpid) })
  patrol.install()
  const explorer = new Explorer({ ctx, settings, door, recentlyCommented: () => deps.guard.recentlyCommented() })
  explorer.install()

  installPanelHost({
    ...deps,
    patrol,
    explorer,
    entryId: (ctx.fiber as { entry?: { options?: { id?: string } } }).entry?.options?.id,
  })

  // Capability probe. MCP tools appear only after dsh-mcp-client connects,
  // which may be after this apply(), so a miss here is a warning; every
  // real send re-checks and returns `dependency_missing` instead of crashing.
  if (!deps.bili.has(initial.bilibili.replyTool)) {
    logger.warn(
      `${initial.bilibili.replyTool} is not visible yet; real sends will return dependency_missing `
      + 'until dsh-mcp-client (serverName: bilibili) is connected. Drafts still work.',
    )
  }
  if (initial.bilibili.voiceTool && !deps.bili.has(initial.bilibili.voiceTool)) {
    logger.warn(`${initial.bilibili.voiceTool} is not visible yet; voice sends will fall back or be skipped.`)
  }
  if (initial.voiceEnabled && !resolveTts(ctx, initial.tts.service)) {
    logger.warn(
      `TTS service ctx.${initial.tts.service} not found; bili_send_voice will fail with a dependency error `
      + 'until dsh-plugin-tts is loaded.',
    )
  }
  if (initial.sendEnabled) {
    logger.info(
      `real sends enabled: ≤${initial.maxCommentsPerDay} comments/day, ≤${initial.maxRepliesPerDay} replies/day, `
      + `≥${initial.minIntervalMs} ms apart`,
    )
  }
}
