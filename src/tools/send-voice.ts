import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { uploadAudio } from '../bili-client.js'
import { SKIP_REASONS, assertVideoId, charLength, decideSend, skipped } from '../shared.js'
import { resolveTts, synthesizeToFile, type TtsService } from '../tts.js'
import { feiyuTts } from '../feiyu/tts.js'
import { feiyuSetup } from './feiyu.js'
import { missingTool, type ToolDeps } from './deps.js'

const VOICE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        audioPath: { type: 'string', required: true },
        rpid: { type: 'string' },
        message: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        skipped: { type: 'boolean', const: true, required: true },
        reason: { type: 'string', enum: SKIP_REASONS, required: true },
        message: { type: 'string' },
        audioPath: { type: 'string' },
      },
    },
  ],
} as const

export function createSendVoiceTool({ ctx, settings, guard, bili }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'bili_send_voice',
    description:
      '把一段文字用 Edge TTS 转成语音，作为 B 站评论的语音附件发送。'
      + '大肥鱼想说的超过 40 字、情绪强烈、或对方明确要语音时使用。'
      + '默认 dryRun=true：只在本地生成音频草稿，不发送。',
    parameters: {
      videoId: { type: 'string', required: true, description: 'B 站 BV 号或 av 号' },
      text: { type: 'string', required: true, description: '要念出来的文字，口语、短句' },
      voice: { type: 'string', description: '用肥鱼声音时填风格 cute（可爱）或 gentle（温柔）；用 Edge TTS 时填音色如 zh-CN-XiaoxiaoNeural。不传用默认' },
      dryRun: { type: 'boolean', description: '默认 true：只生成本地音频草稿。false 才真正发送。' },
    },
    output: {
      schema: VOICE_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: 'skipped' in value
          ? `未发送（${value.reason}）${value.message ? '：' + value.message : ''}${value.audioPath ? `；音频：${value.audioPath}` : ''}`
          : `${value.message}；音频：${value.audioPath}${value.rpid ? `（rpid ${value.rpid}）` : ''}`,
      }],
    },
    async execute(args, exec) {
      const config = settings()
      assertVideoId(args.videoId)
      const text = args.text.trim()
      const n = charLength(text)
      if (n === 0 || n > config.voiceMaxLength) {
        throw new Error(`语音文本长度为 ${n} 字，需要在 1～${config.voiceMaxLength} 字之间`)
      }
      if (!config.voiceEnabled) return skipped('voice_disabled', 'voiceEnabled 已关闭')

      const decision = decideSend(config, args.dryRun)
      if (decision.mode === 'skip') return decision.result

      // TTS is a hard requirement for this tool: no third-party fallback is bundled.
      // 肥鱼声音服务 when configured (feiyu.useForBiliVoice), otherwise the ctx TTS service.
      const useFeiyu = config.feiyu.useForBiliVoice && config.feiyu.baseUrl.trim() !== ''
      let tts: TtsService | undefined
      if (useFeiyu) {
        const setup = await feiyuSetup(config)
        tts = feiyuTts(setup.client, setup.cfg)
      } else {
        tts = resolveTts(ctx, config.tts.service)
      }
      if (!tts) {
        throw new Error(
          `依赖缺失：未找到 TTS 服务 ctx.${config.tts.service}（需要加载 dsh-plugin-tts 并提供 synthesize()）`,
        )
      }

      if (decision.mode === 'send') {
        // Cheap checks first so we don't synthesize audio we can't send.
        const route = pickRoute()
        if (route.kind === 'missing') return skipped('dependency_missing', route.message)
        if (route.kind === 'unsupported') {
          return skipped('voice_unsupported', 'bilibili-mcp 未提供语音评论工具，且降级路径 voiceFallback 未开启')
        }
        const precheck = guard.check('comment')
        if (!precheck.ok) return skipped('rate_limited', precheck.message)
      }

      const { audioPath, mime } = await synthesizeToFile(tts, {
        text,
        voice: args.voice?.trim() || (useFeiyu ? config.feiyu.style : config.tts.defaultVoice),
        outputDir: config.tts.outputDir,
        videoId: args.videoId,
        signal: exec.signal,
      })
      if (decision.mode === 'draft') return { audioPath, message: '语音草稿已生成' }

      // Re-check under reservation: another send may have landed while TTS ran.
      const slot = guard.reserve('comment')
      if (!slot.ok) return { ...skipped('rate_limited', slot.message), audioPath }

      const route = pickRoute()
      if (route.kind === 'voice-tool') {
        const posted = await bili.postVoice({ videoId: args.videoId, audioPath, message: text }, exec)
        return { audioPath, rpid: posted.rpid, message: '语音评论已发送' }
      }
      if (route.kind === 'fallback') {
        // Degraded path (off by default, needs voiceFallback.enabled):
        // bilibili-mcp has no voice-comment tool, so upload the audio to the
        // user's own file service and post a normal text comment with the link.
        const url = await uploadAudio(audioPath, mime, config.voiceFallback, exec.signal)
        const message = config.voiceFallback.template.replaceAll('{text}', text).replaceAll('{url}', url)
        const posted = await bili.postText({ videoId: args.videoId, message }, exec)
        return { audioPath, rpid: posted.rpid, message: '已降级发送：文字评论 + 音频链接' }
      }
      // The tool set changed while we were synthesizing.
      return { ...skipped(route.kind === 'missing' ? 'dependency_missing' : 'voice_unsupported', '发送通道在生成语音期间不可用'), audioPath }

      function pickRoute():
        | { kind: 'voice-tool' }
        | { kind: 'fallback' }
        | { kind: 'missing'; message: string }
        | { kind: 'unsupported' } {
        if (bili.has(bili.voiceTool, exec)) return { kind: 'voice-tool' }
        if (!config.voiceFallback.enabled) return { kind: 'unsupported' }
        if (!bili.has(bili.replyTool, exec)) return { kind: 'missing', message: missingTool(bili.replyTool) }
        return { kind: 'fallback' }
      }
    },
  })
}
