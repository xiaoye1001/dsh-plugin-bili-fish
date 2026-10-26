import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FISH_PERSONA, taskLine } from '../persona.js'
import type { ToolDeps } from './deps.js'

export function createBuildPromptTool({ settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'bili_build_prompt',
    description:
      '取得“大肥鱼”人格和写作约束。在调用 bili_comment / bili_reply / bili_send_voice 之前先调用它，'
      + '然后严格按返回的人格写正文。只读，不访问网络。',
    parameters: {
      kind: { type: 'string', enum: ['comment', 'reply', 'voice'], required: true, description: '要写评论、回复还是语音' },
      context: { type: 'string', description: '视频标题/简介，或要回复的那条评论原文' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['comment', 'reply', 'voice'], required: true },
          persona: { type: 'string', required: true },
          task: { type: 'string', required: true },
          minLength: { type: 'integer', required: true },
          maxLength: { type: 'integer', required: true },
          context: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.persona,
          value.context ? `【参考内容】\n${value.context}` : '',
          `【任务】\n${value.task}`,
        ].filter(Boolean).join('\n\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = settings()
      const range = args.kind === 'comment'
        ? config.commentLength
        : args.kind === 'reply'
          ? config.replyLength
          : { min: 1, max: config.voiceMaxLength }
      const base = config.persona.override.trim() || FISH_PERSONA
      const persona = config.persona.extra.trim() ? `${base}\n\n${config.persona.extra.trim()}` : base
      const context = args.context?.trim()
      return {
        kind: args.kind,
        persona,
        task: taskLine(args.kind, range.min, range.max),
        minLength: range.min,
        maxLength: range.max,
        ...(context ? { context } : {}),
      }
    },
  })
}
