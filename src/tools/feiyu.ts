// 肥鱼声音 tools — a DSH port of the AstrBot plugin's commands and LLM tools
// (feiyu_speak / feiyu_convert / feiyu_sing, /肥鱼状态, /肥鱼任务), talking to
// the same Feiyu voice service over HTTP.
//
// Differences from the AstrBot version, because DSH has no chat attachments:
// conversion and singing read files from a dedicated inbox folder only, and
// finished audio is saved as a WAV file whose path is returned.

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Settings } from '../config.js'
import { FeiyuClient, type Job, type JobKind } from '../feiyu/client.js'
import { feiyuPaths, readApiKey, resolveInboxFile, type FeiyuPaths } from '../feiyu/local.js'
import type { ToolDeps } from './deps.js'

const STATUSES = ['queued', 'running', 'success', 'failed', 'interrupted'] as const

const JOB_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    status: { type: 'string', enum: STATUSES, required: true },
    audioPath: { type: 'string' },
    message: { type: 'string', required: true },
  },
} as const

type JobResult = { jobId: string; status: typeof STATUSES[number]; audioPath?: string; message: string }

const renderJob = (v: JobResult) => [{
  type: 'text' as const,
  text: v.audioPath ? `${v.message}\n音频：${v.audioPath}` : `${v.message}（任务 ${v.jobId}，状态 ${v.status}）`,
}]

/** Client + local paths, or a clear error when the service is not set up. */
export async function feiyuSetup(settings: Settings): Promise<{ client: FeiyuClient; paths: FeiyuPaths; cfg: Settings['feiyu'] }> {
  const cfg = settings.feiyu
  const paths = feiyuPaths(cfg)
  if (cfg.baseUrl.trim() === '') throw new Error('肥鱼声音服务还没配置：请在设置页「肥鱼声音」里填写服务地址和 API Key')
  const key = await readApiKey(paths.keyFile)
  if (key === '') throw new Error('肥鱼声音服务缺少 API Key：请在设置页「肥鱼声音」里填写')
  return { client: new FeiyuClient(cfg.baseUrl, key), paths, cfg }
}

async function finish(client: FeiyuClient, paths: FeiyuPaths, job: Job, waitSeconds: number, signal: AbortSignal, label: string): Promise<JobResult> {
  const settled = await client.wait(job.id, waitSeconds * 1000, signal)
  if (settled.status !== 'success') {
    return { jobId: job.id, status: settled.status, message: `${label}还在生成，稍后用 feiyu_job(jobId="${job.id}") 取回` }
  }
  const audioPath = await client.download(job.id, paths.outbox, signal)
  return { jobId: job.id, status: 'success', audioPath, message: `${label}已生成` }
}

async function run(settings: () => Settings, kind: JobKind, payload: Record<string, unknown>, signal: AbortSignal, label: string): Promise<JobResult> {
  const { client, paths, cfg } = await feiyuSetup(settings())
  const job = await client.submit(kind, { ...payload, voice: cfg.voice }, signal)
  return finish(client, paths, job, cfg.waitSeconds, signal, label)
}

export function createFeiyuTools({ settings }: ToolDeps): ToolDefinition[] {
  const status = defineTool({
    name: 'feiyu_status',
    description: '查看肥鱼声音服务是否可用：说话（TTS）、换声（RVC）、按谱唱歌，以及可用的说话风格。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configured: { type: 'boolean', required: true },
          reachable: { type: 'boolean', required: true },
          version: { type: 'string' },
          speech: { type: 'boolean', required: true },
          conversion: { type: 'boolean', required: true },
          singing: { type: 'boolean', required: true },
          styles: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: !v.configured || !v.reachable
          ? v.message
          : `肥鱼服务${v.version ? ' ' + v.version : ''}：说话 ${v.speech ? '可用' : '未安装'}；换声 ${v.conversion ? '可用' : '未安装'}；按谱唱歌 ${v.singing ? '可用' : '未安装'}${v.styles.length ? `；风格 ${v.styles.join('、')}` : ''}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const empty = { speech: false, conversion: false, singing: false, styles: [] as string[] }
      let setup
      try {
        setup = await feiyuSetup(settings())
      } catch (error) {
        return { configured: false, reachable: false, ...empty, message: error instanceof Error ? error.message : String(error) }
      }
      try {
        const [health, caps] = await Promise.all([setup.client.health(exec.signal), setup.client.capabilities(exec.signal)])
        const styles = [...new Set(caps.tts.filter(t => t.available).flatMap(t => t.styles ?? []))]
        return {
          configured: true,
          reachable: true,
          ...(health.version ? { version: health.version } : {}),
          speech: caps.tts.some(t => t.available),
          conversion: caps.rvc.some(t => t.available),
          singing: !!caps.singing?.available,
          styles,
          message: 'ok',
        }
      } catch (error) {
        exec.signal.throwIfAborted()
        return { configured: true, reachable: false, ...empty, message: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const speak = defineTool({
    name: 'feiyu_speak',
    description: '用肥鱼的声音把一段文字说出来，生成 WAV 音频并返回文件路径。需要演唱谱子用 feiyu_sing；已有人声换成肥鱼音色用 feiyu_convert。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的文字，最多 2000 字' },
      style: { type: 'string', description: '说话风格：cute（可爱，默认）或 gentle（温柔）' },
    },
    output: { schema: JOB_OUTPUT, render: (_a, v) => renderJob(v) },
    async execute(args, exec) {
      const text = args.text.trim()
      const n = [...text].length
      if (n === 0 || n > 2000) throw new Error(`文字长度 ${n}，需要 1～2000 字`)
      const style = args.style?.trim() || settings().feiyu.style
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(style)) throw new Error('风格只能是 cute、gentle 这类标识')
      return run(settings, 'speech', { text, style }, exec.signal, '肥鱼说话')
    },
  })

  const convert = defineTool({
    name: 'feiyu_convert',
    description:
      '把一段干净的人声或清唱（WAV / FLAC）换成肥鱼音色，保留内容和旋律。'
      + '只能使用肥鱼收件夹里的文件：先让用户把文件放进收件夹，再传文件名。不能把谱子交给它（谱子用 feiyu_sing）。',
    parameters: {
      file: { type: 'string', required: true, description: '收件夹里的 .wav 或 .flac 文件名' },
    },
    output: { schema: JOB_OUTPUT, render: (_a, v) => renderJob(v) },
    async execute(args, exec) {
      const { client, paths, cfg } = await feiyuSetup(settings())
      const local = await resolveInboxFile(paths.inbox, args.file, ['.wav', '.flac'])
      const audioId = await client.upload(local, exec.signal)
      const job = await client.submit('conversion', { audio_id: audioId, voice: cfg.voice }, exec.signal)
      return finish(client, paths, job, cfg.waitSeconds, exec.signal, '肥鱼换声')
    },
  })

  const sing = defineTool({
    name: 'feiyu_sing',
    description:
      '按 MIDI 或 ABC 主旋律和中文歌词，用肥鱼的声音唱出来（服务先按谱合成，再换成肥鱼音色）。'
      + '谱子文件必须在肥鱼收件夹里。歌词按音符顺序排列，一字多音用 _ 占位；内嵌完整歌词的 MIDI 可以不传歌词。',
    parameters: {
      file: { type: 'string', required: true, description: '收件夹里的 .mid / .midi / .abc 文件名' },
      lyrics: { type: 'string', description: '按音符顺序排列的歌词，最多 10000 字' },
    },
    output: { schema: JOB_OUTPUT, render: (_a, v) => renderJob(v) },
    async execute(args, exec) {
      const lyrics = args.lyrics?.trim()
      if (lyrics && [...lyrics].length > 10000) throw new Error('歌词超过 10000 字')
      const { client, paths, cfg } = await feiyuSetup(settings())
      const local = await resolveInboxFile(paths.inbox, args.file, ['.mid', '.midi', '.abc'])
      const scoreId = await client.upload(local, exec.signal)
      const job = await client.submit('singing', { score_id: scoreId, voice: cfg.voice, ...(lyrics ? { lyrics } : {}) }, exec.signal)
      return finish(client, paths, job, cfg.waitSeconds, exec.signal, '肥鱼唱歌')
    },
  })

  const job = defineTool({
    name: 'feiyu_job',
    description: '查询肥鱼声音任务的状态；已经生成好的会下载并返回音频文件路径。',
    parameters: {
      jobId: { type: 'string', required: true, description: '32 位任务编号' },
    },
    output: { schema: JOB_OUTPUT, render: (_a, v) => renderJob(v) },
    async execute(args, exec) {
      const { client, paths } = await feiyuSetup(settings())
      const current = await client.status(args.jobId.trim(), exec.signal)
      if (current.status === 'success') {
        const audioPath = await client.download(current.id, paths.outbox, exec.signal)
        return { jobId: current.id, status: 'success' as const, audioPath, message: '音频已生成' }
      }
      const message = current.status === 'failed' || current.status === 'interrupted'
        ? `任务${current.status === 'failed' ? '失败' : '被中断'}${current.error ? '：' + current.error : ''}`
        : '还在生成'
      return { jobId: current.id, status: current.status, message }
    },
  })

  return [status, speak, convert, sing, job]
}

