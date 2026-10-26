import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  POST_OUTPUT_SCHEMA,
  assertLength,
  assertRpid,
  assertVideoId,
  decideSend,
  isSkipped,
  skipped,
} from '../shared.js'
import { missingTool, type ToolDeps } from './deps.js'

export function createReplyTool({ settings, guard, bili }: ToolDeps): ToolDefinition {
  const { min, max } = settings().replyLength
  return defineTool({
    name: 'bili_reply',
    description:
      `回复一条已有的 B 站评论（${min}～${max} 字）。`
      + '调用前先用 bili_build_prompt(kind="reply") 取得大肥鱼人格。想说的超过 40 字或情绪很强烈时，改用 bili_send_voice。'
      + '同一条评论短时间内只会回复一次。默认 dryRun=true 只生成草稿。',
    parameters: {
      videoId: { type: 'string', required: true, description: '评论所在视频的 BV 号或 av 号' },
      parentRpid: { type: 'string', required: true, description: '要回复的那条评论的 rpid（纯数字）' },
      text: { type: 'string', required: true, description: `回复正文，${min}～${max} 字，大肥鱼口吻，无 Markdown` },
      dryRun: { type: 'boolean', description: '默认 true：只返回草稿不发送。false 才真正发送。' },
    },
    output: {
      schema: POST_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: isSkipped(value)
          ? `未发送（${value.reason}）${value.message ? '：' + value.message : ''}`
          : `${value.message}${value.rpid && value.rpid !== 'dry-run' ? `（rpid ${value.rpid}）` : ''}`,
      }],
    },
    async execute(args, exec) {
      const config = settings()
      assertVideoId(args.videoId)
      assertRpid(args.parentRpid)
      const text = args.text.trim()
      assertLength('回复', text, config.replyLength)

      // Short-term memory: never reply to the same comment twice within the window.
      if (guard.wasRecentlyReplied(args.parentRpid)) {
        return { rpid: '', message: 'skipped: already replied' }
      }

      const decision = decideSend(config, args.dryRun)
      if (decision.mode === 'draft') return { rpid: 'dry-run', message: '草稿：' + text }
      if (decision.mode === 'skip') return decision.result

      if (!bili.has(bili.replyTool, exec)) return skipped('dependency_missing', missingTool(bili.replyTool))
      const slot = guard.reserve('reply')
      if (!slot.ok) return skipped('rate_limited', slot.message)

      // Mark before the await so a concurrent call for the same comment is deduped too.
      guard.markReplied(args.parentRpid)
      const posted = await bili.postText(
        { videoId: args.videoId, message: text, parentRpid: args.parentRpid },
        exec,
      )
      return { rpid: posted.rpid, message: posted.rpid ? '已回复' : '已回复（未能从返回中解析 rpid）' }
    },
  })
}
