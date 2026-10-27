// Client for the Feiyu voice service (肥鱼声音服务) HTTP API v1 —
// https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice (server/).
//
// An independent TypeScript implementation of that documented HTTP contract;
// no code from that project is included. The service, its voice models and
// their licences stay in that project and are deployed separately.
//
//   GET  /health                      { status, version }            (no auth)
//   GET  /v1/capabilities             { tts[], rvc[], singing, queue }
//   POST /v1/assets        multipart  { id, bytes, sha256, suffix }  (.wav .flac .mid .midi .abc .txt .json)
//   POST /v1/speech                   { text, style, voice }         -> 202 job
//   POST /v1/voice-conversion         { audio_id, voice }            -> 202 job
//   POST /v1/singing                  { score_id, lyrics?, voice }   -> 202 job
//   GET  /v1/jobs/{id}                { id, kind, status: queued|running|success|failed|interrupted, error? }
//   GET  /v1/jobs/{id}/audio          audio/wav
//   Auth: Authorization: Bearer <api key> on /v1/*. Errors: { detail }.

import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type JobKind = 'speech' | 'conversion' | 'singing'
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'interrupted'

export interface Job {
  id: string
  kind?: string
  status: JobStatus
  error?: string
}

export interface Capabilities {
  tts: { voice?: string; available: boolean; styles?: string[] }[]
  rvc: { voice?: string; available: boolean }[]
  singing: { available: boolean }
  queue?: { waiting: number; running: boolean }
}

const JOB_ID = /^[0-9a-f]{32}$/
const ROUTES: Record<JobKind, string> = { speech: 'speech', conversion: 'voice-conversion', singing: 'singing' }
const MAX_WAV = 128 * 1024 ** 2
const MAX_UPLOAD = 128 * 1024 ** 2

export class FeiyuError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'FeiyuError'
  }
}

export function assertJobId(id: string): void {
  if (!JOB_ID.test(id)) throw new FeiyuError('任务编号格式不对（应为 32 位十六进制）')
}

export class FeiyuClient {
  private readonly base: string

  constructor(baseUrl: string, private readonly apiKey: string, private readonly timeoutMs = 60_000) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private async request(method: string, path: string, init: { body?: BodyInit; json?: unknown; signal?: AbortSignal; auth?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (init.auth !== false) headers.authorization = `Bearer ${this.apiKey}`
    let body = init.body
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(init.signal ? [init.signal] : [])]
    let response: Response
    try {
      response = await fetch(this.base + path, { method, headers, body, redirect: 'manual', signal: AbortSignal.any(signals) })
    } catch (error) {
      init.signal?.throwIfAborted()
      throw new FeiyuError(`连不上肥鱼声音服务 ${this.base}：${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status >= 300) {
      let detail = ''
      try {
        const data = await response.json() as { detail?: unknown }
        detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? '')
      } catch {
        // not JSON
      }
      const hint = response.status === 401 ? '（API Key 不对或没填）' : response.status === 503 ? '（服务队列已满，稍后再试）' : ''
      throw new FeiyuError(`肥鱼声音服务 HTTP ${response.status}${hint}${detail ? '：' + detail : ''}`, response.status)
    }
    return response
  }

  async health(signal?: AbortSignal): Promise<{ status: string; version?: string }> {
    return await (await this.request('GET', '/health', { signal, auth: false })).json() as { status: string; version?: string }
  }

  async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    return await (await this.request('GET', '/v1/capabilities', { signal })).json() as Capabilities
  }

  /** Upload a local file; returns the service's asset id. */
  async upload(path: string, signal?: AbortSignal): Promise<string> {
    const info = await stat(path)
    if (info.size === 0) throw new FeiyuError('文件是空的')
    if (info.size > MAX_UPLOAD) throw new FeiyuError('文件超过 128 MB')
    const form = new FormData()
    form.append('file', new Blob([await readFile(path, { signal })]), basename(path))
    const data = await (await this.request('POST', '/v1/assets', { body: form, signal })).json() as { id?: unknown }
    if (typeof data.id !== 'string' || !JOB_ID.test(data.id)) throw new FeiyuError('服务返回的素材编号不对')
    return data.id
  }

  async submit(kind: JobKind, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Job> {
    const job = await (await this.request('POST', '/v1/' + ROUTES[kind], { json: payload, signal })).json() as Job
    assertJobId(job.id)
    return job
  }

  async status(jobId: string, signal?: AbortSignal): Promise<Job> {
    assertJobId(jobId)
    return await (await this.request('GET', '/v1/jobs/' + jobId, { signal })).json() as Job
  }

  /**
   * Poll until the job settles or `waitMs` passes. Returns the last status
   * (still `queued`/`running` on timeout); throws if the job failed.
   */
  async wait(jobId: string, waitMs: number, signal?: AbortSignal, pollMs = 2000): Promise<Job> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const job = await this.status(jobId, signal)
      if (job.status === 'success') return job
      if (job.status === 'failed' || job.status === 'interrupted') {
        throw new FeiyuError(`肥鱼任务 ${jobId} ${job.status === 'failed' ? '失败' : '被中断'}${job.error ? '：' + job.error : ''}`)
      }
      if (Date.now() + pollMs > deadline) return job
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, pollMs)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
      })
    }
  }

  /** Download a finished job's WAV into `dir/<jobId>.wav` (reused if already there). */
  async download(jobId: string, dir: string, signal?: AbortSignal): Promise<string> {
    assertJobId(jobId)
    const path = join(dir, `${jobId}.wav`)
    try {
      if ((await stat(path)).size > 0) return path
    } catch {
      // not downloaded yet
    }
    const bytes = await this.audio(jobId, signal)
    await mkdir(dir, { recursive: true })
    const handle = await open(path, 'wx', 0o644)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return path
  }

  /** A finished job's WAV bytes, checked to be a RIFF file of sane size. */
  async audio(jobId: string, signal?: AbortSignal): Promise<Uint8Array> {
    assertJobId(jobId)
    const response = await this.request('GET', `/v1/jobs/${jobId}/audio`, { signal })
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_WAV) throw new FeiyuError('服务返回的音频超过 128 MB')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_WAV || bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') {
      throw new FeiyuError('服务返回的不是有效的 WAV 音频')
    }
    return bytes
  }
}

