import type { TtsService } from '../tts.js'
import type { FeiyuClient } from './client.js'

const STYLE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * Present the Feiyu voice service as the TtsService bili_send_voice expects.
 * `voice` is read as a Feiyu style (cute / gentle); Edge-style voice ids
 * (…Neural) and anything else fall back to the configured default style.
 */
export function feiyuTts(client: FeiyuClient, cfg: { voice: string; style: string; waitSeconds: number }): TtsService {
  return {
    async synthesize({ text, voice, signal }) {
      const style = STYLE.test(voice) && !/neural$/i.test(voice) ? voice : cfg.style
      const job = await client.submit('speech', { text, style, voice: cfg.voice }, signal)
      const settled = await client.wait(job.id, cfg.waitSeconds * 1000, signal)
      if (settled.status !== 'success') {
        throw new Error(`肥鱼语音还在生成（任务 ${job.id}），稍后用 feiyu_job 取回后再发送`)
      }
      return { audio: await client.audio(job.id, signal), mime: 'audio/wav' }
    },
  }
}
