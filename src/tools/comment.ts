import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  POST_OUTPUT_SCHEMA,
  assertLength,
  assertVideoId,
  decideSend,
  isSkipped,
  skipped,
} from '../shared.js'
import { missingTool, type ToolDeps } from './deps.js'

export function createCommentTool({ settings, guard, bili }: ToolDeps): ToolDefinition {
  const { min, max } = settings().commentLength
  return defineTool({
    name: 'bili_comment',
    description:
      `在指定 B 站视频下发表一条评论（${min}～${max} 字）。`
      + '调用前先用 bili_build_prompt(kind="comment") 取得大肥鱼人格，按人格写好正文再调用本工具。'
      + '默认 dryRun=true 只生成草稿；只有在用户明确要求真实发送时才传 dryRun=false。',
    parameters: {
      videoId: { type: 'string', required: true, description: 'B 站 BV 号（如 BV1xx411c7mD）或 av 号（如 av170001）' },
      text: { type: 'string', required: true, description: `评论正文，${min}～${max} 字，大肥鱼口吻，无 Markdown` },
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
      const text = args.text.trim()
      assertLength('评论', text, config.commentLength)

      // One comment per video within commentOncePerVideoHours, drafts included, so the model knows early.
      if (guard.wasCommented(args.videoId)) {
        return skipped('already_commented', `最近 ${config.commentOncePerVideoHours} 小时内已经评论过这个视频`)
      }

      const decision = decideSend(config, args.dryRun)
      if (decision.mode === 'draft') return { rpid: 'dry-run', message: '草稿：' + text }
      if (decision.mode === 'skip') return decision.result

      if (!bili.has(bili.replyTool, exec)) return skipped('dependency_missing', missingTool(bili.replyTool))
      const slot = guard.reserve('comment')
      if (!slot.ok) return skipped('rate_limited', slot.message)

      // Mark before the await so a concurrent call on the same video is refused too.
      guard.markCommented(args.videoId)
      // parentRpid omitted on purpose: a top-level comment.
      const posted = await bili.postText({ videoId: args.videoId, message: text }, exec)
      return { rpid: posted.rpid, message: posted.rpid ? '已发送' : '已发送（未能从返回中解析 rpid）' }
    },
  })
}
