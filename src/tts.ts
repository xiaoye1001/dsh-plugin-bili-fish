import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The slice of the dsh-plugin-tts host service this plugin relies on. It is
 * read with ctx.get() (optional dependency), so a missing or differently
 * shaped service is reported instead of crashing apply().
 */
export interface TtsService {
  synthesize(request: {
    text: string
    voice: string
    provider?: string
    signal?: AbortSignal
  }): Promise<{
    audio: Uint8Array | ArrayBuffer
    mime?: string
  }>
}

export function resolveTts(ctx: Context, serviceName: string): TtsService | undefined {
  const service: unknown = ctx.get(serviceName)
  if (typeof service === 'object' && service !== null && typeof (service as TtsService).synthesize === 'function') {
    return service as TtsService
  }
  return undefined
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
}

export async function synthesizeToFile(
  tts: TtsService,
  options: { text: string; voice: string; outputDir: string; videoId: string; signal: AbortSignal },
): Promise<{ audioPath: string; mime: string }> {
  const { signal } = options
  signal.throwIfAborted()
  const out = await tts.synthesize({ text: options.text, voice: options.voice, provider: 'edge', signal })
  signal.throwIfAborted()
  const audio = out.audio instanceof Uint8Array ? out.audio : new Uint8Array(out.audio)
  if (audio.byteLength === 0) throw new Error('TTS service returned empty audio')
  const mime = out.mime ?? 'audio/mpeg'
  const dir = options.outputDir || join(tmpdir(), 'dsh-bili-fish')
  await mkdir(dir, { recursive: true })
  const safeId = options.videoId.replace(/[^0-9A-Za-z]/g, '')
  const audioPath = join(dir, `${safeId}-${randomUUID()}.${EXT_BY_MIME[mime] ?? 'mp3'}`)
  await writeFile(audioPath, audio, { signal })
  return { audioPath, mime }
}
