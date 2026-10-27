// 肥鱼声音 port: client and tools against a fake Feiyu voice service that
// follows the server's HTTP contract (server/feiyu_voice_service/app.py of
// astrbot_plugin_feiyu_voice): Bearer auth on /v1, 201 assets, 202 jobs,
// job polling, audio/wav download.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { FeiyuClient } from '../lib/feiyu/client.js'
import { resolveInboxFile, saveApiKey } from '../lib/feiyu/local.js'

const KEY = 'test-key-0123456789'
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)])

async function fakeService(t, { pendingPolls = 0, wav = WAV } = {}) {
  const requests = []
  const jobs = new Map()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://x')
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body })
      const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
      if (url.pathname === '/health') return json(200, { status: 'ok', version: '0.2.0' })
      if (!url.pathname.startsWith('/v1/')) return json(404, { detail: 'Not Found' })
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { detail: 'A valid Bearer API key is required' })
      if (url.pathname === '/v1/capabilities') {
        return json(200, { tts: [{ voice: 'feiyu', available: true, styles: ['cute', 'gentle'] }], rvc: [{ voice: 'feiyu', available: true }], singing: { available: false }, queue: { waiting: 0, running: false } })
      }
      if (url.pathname === '/v1/assets' && req.method === 'POST') {
        const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? ''
        return json(201, { id: randomBytes(16).toString('hex'), bytes: body.length, sha256: 'x', suffix: name.slice(name.lastIndexOf('.')) })
      }
      const kind = { '/v1/speech': 'speech', '/v1/voice-conversion': 'conversion', '/v1/singing': 'singing' }[url.pathname]
      if (kind && req.method === 'POST') {
        const id = randomBytes(16).toString('hex')
        jobs.set(id, { kind, polls: 0, payload: JSON.parse(body.toString()) })
        return json(202, { id, kind, status: 'queued' })
      }
      const m = /^\/v1\/jobs\/([0-9a-f]{32})(\/audio)?$/.exec(url.pathname)
      if (m) {
        const job = jobs.get(m[1])
        if (!job) return json(404, { detail: 'Job not found' })
        if (m[2]) {
          res.writeHead(200, { 'content-type': 'audio/wav' })
          return res.end(wav)
        }
        job.polls++
        return json(200, { id: m[1], kind: job.kind, status: job.polls > pendingPolls ? 'success' : 'running' })
      }
      json(404, { detail: 'Not Found' })
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, requests, jobs }
}

async function dirs() {
  const base = await mkdtemp(join(tmpdir(), 'feiyu-'))
  return { base, keyFile: join(base, 'feiyu.json'), inputDir: join(base, 'inbox'), outputDir: join(base, 'out') }
}

test('client: auth, submit, wait, download with WAV check', async (t) => {
  const svc = await fakeService(t, { pendingPolls: 1 })
  const c = new FeiyuClient(svc.url, KEY)
  assert.equal((await c.health()).version, '0.2.0')
  assert.equal(svc.requests[0].auth, undefined, 'health needs no key')
  await assert.rejects(new FeiyuClient(svc.url, 'wrong-key-123').capabilities(), /HTTP 401（API Key 不对或没填）/)
  const job = await c.submit('speech', { text: '你好', style: 'cute', voice: 'feiyu' })
  const pending = await c.wait(job.id, 0, undefined, 5)
  assert.equal(pending.status, 'running', 'returns the last status on timeout')
  const done = await c.wait(job.id, 2000, undefined, 5)
  assert.equal(done.status, 'success')
  const out = (await dirs()).outputDir
  const path = await c.download(job.id, out)
  assert.deepEqual(await readFile(path), WAV)
  assert.equal(await c.download(job.id, out), path, 'reuses an existing download')
  await assert.rejects(c.status('../../etc'), /任务编号格式不对/)

  const bad = await fakeService(t, { wav: Buffer.from('<html>nope</html>') })
  const bc = new FeiyuClient(bad.url, KEY)
  const j = await bc.submit('speech', { text: 'x', style: 'cute', voice: 'feiyu' })
  await assert.rejects(bc.audio(j.id), /不是有效的 WAV/)
})

test('inbox: only files inside the inbox, with allowed suffixes, no symlink escape', async () => {
  const d = await dirs()
  await mkdir(d.inputDir, { recursive: true })
  await writeFile(join(d.inputDir, 'vocal.wav'), WAV)
  await writeFile(join(d.base, 'secret.wav'), WAV)
  await symlink(join(d.base, 'secret.wav'), join(d.inputDir, 'link.wav'))
  assert.equal(await resolveInboxFile(d.inputDir, 'vocal.wav', ['.wav']), join(await (await import('node:fs/promises')).realpath(d.inputDir), 'vocal.wav'))
  await assert.rejects(resolveInboxFile(d.inputDir, '../secret.wav', ['.wav']), /只能使用收件夹/)
  await assert.rejects(resolveInboxFile(d.inputDir, join(d.base, 'secret.wav'), ['.wav']), /只能使用收件夹/)
  await assert.rejects(resolveInboxFile(d.inputDir, 'link.wav', ['.wav']), /只能使用收件夹/)
  await assert.rejects(resolveInboxFile(d.inputDir, 'vocal.wav', ['.mid']), /只支持/)
  await assert.rejects(resolveInboxFile(d.inputDir, 'missing.wav', ['.wav']), /找不到/)
})

async function bootPlugin(t, feiyu) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  let connection
  await root.plugin({ name: 'connection-host', apply(ctx) { connection = new HostConnectionService(ctx, [], {}) } })
  t.after(() => root.fiber.dispose())
  await root.plugin(plugin, { feiyu })
  let n = 0
  const run = (name, args) => root.tools.execute({ callId: ToolCallId(`f${++n}`), name, arguments: args, signal: new AbortController().signal })
  const api = connection.createSharedFetchHandler('/api')
  const post = async (endpoint, body) => {
    const res = await api.fetch(new Request(`http://127.0.0.1/api/bili-fish/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { principal: { kind: 'owner' } })
    return { status: res.status, text: await res.text() }
  }
  return { run, post }
}

test('tools: status, speak, convert, sing, job', async (t) => {
  const svc = await fakeService(t)
  const d = await dirs()
  const unconfigured = await bootPlugin(t, { keyFile: d.keyFile, inputDir: d.inputDir, outputDir: d.outputDir })
  const st0 = await unconfigured.run('feiyu_status', {})
  assert.equal(st0.value.configured, false)
  assert.match(st0.value.message, /还没配置/)

  await saveApiKey(d.keyFile, KEY)
  const { run } = await bootPlugin(t, { baseUrl: svc.url, keyFile: d.keyFile, inputDir: d.inputDir, outputDir: d.outputDir })
  const st = await run('feiyu_status', {})
  assert.deepEqual([st.value.reachable, st.value.speech, st.value.conversion, st.value.singing, st.value.styles], [true, true, true, false, ['cute', 'gentle']])

  const spoke = await run('feiyu_speak', { text: '你好呀，我是大肥鱼', style: 'gentle' })
  assert.equal(spoke.isError, false, JSON.stringify(spoke.error))
  assert.equal(spoke.value.status, 'success')
  assert.deepEqual(await readFile(spoke.value.audioPath), WAV)
  const speech = [...svc.jobs.values()].find(j => j.kind === 'speech')
  assert.deepEqual(speech.payload, { text: '你好呀，我是大肥鱼', style: 'gentle', voice: 'feiyu' })

  await mkdir(d.inputDir, { recursive: true })
  await writeFile(join(d.inputDir, 'vocal.flac'), Buffer.from('fLaC....'))
  await writeFile(join(d.inputDir, 'star.mid'), Buffer.from('MThd....'))
  const conv = await run('feiyu_convert', { file: 'vocal.flac' })
  assert.equal(conv.isError, false, JSON.stringify(conv.error))
  const upload = svc.requests.find(r => r.path === '/v1/assets')
  assert.match(upload.body.toString('latin1'), /filename="vocal.flac"/)
  assert.match([...svc.jobs.values()].find(j => j.kind === 'conversion').payload.audio_id, /^[0-9a-f]{32}$/)

  const escape = await run('feiyu_convert', { file: '../feiyu.json' })
  assert.equal(escape.isError, true, 'cannot reach outside the inbox')

  const sung = await run('feiyu_sing', { file: 'star.mid', lyrics: '一闪一闪亮晶晶' })
  assert.equal(sung.isError, false, JSON.stringify(sung.error))
  const singing = [...svc.jobs.values()].find(j => j.kind === 'singing').payload
  assert.equal(singing.lyrics, '一闪一闪亮晶晶')
  assert.equal(singing.voice, 'feiyu')

  const jobId = [...svc.jobs.keys()][0]
  const fetched = await run('feiyu_job', { jobId })
  assert.equal(fetched.value.status, 'success')
  assert.ok((await stat(fetched.value.audioPath)).size > 0)
})

test('slow jobs return a job id that feiyu_job can collect later', async (t) => {
  const svc = await fakeService(t, { pendingPolls: 1000 })
  const d = await dirs()
  await saveApiKey(d.keyFile, KEY)
  const { run } = await bootPlugin(t, { baseUrl: svc.url, keyFile: d.keyFile, inputDir: d.inputDir, outputDir: d.outputDir, waitSeconds: 10 })
  // waitSeconds is the floor (10s) — use the job tool directly instead of waiting in a speak call.
  const id = [...(await (async () => { await new FeiyuClient(svc.url, KEY).submit('speech', { text: 'x', style: 'cute', voice: 'feiyu' }); return svc.jobs.keys() })())][0]
  const r = await run('feiyu_job', { jobId: id })
  assert.equal(r.value.status, 'running')
  assert.match(r.value.message, /还在生成/)
})

test('bili_send_voice uses the Feiyu service when configured', async (t) => {
  const svc = await fakeService(t)
  const d = await dirs()
  await saveApiKey(d.keyFile, KEY)
  const { run } = await bootPlugin(t, { baseUrl: svc.url, keyFile: d.keyFile, inputDir: d.inputDir, outputDir: d.outputDir })
  const r = await run('bili_send_voice', { videoId: 'BV1xx411c7mD', text: '笑到翻肚皮了', voice: 'gentle' })
  assert.equal(r.isError, false, JSON.stringify(r.error))
  assert.match(r.value.audioPath, /\.wav$/)
  assert.deepEqual(await readFile(r.value.audioPath), WAV)
  assert.equal([...svc.jobs.values()][0].payload.style, 'gentle')
})

test('panel: key saved 0600 and never echoed; test connection; settings save', async (t) => {
  const svc = await fakeService(t)
  const d = await dirs()
  const { post } = await bootPlugin(t, { baseUrl: svc.url, keyFile: d.keyFile, inputDir: d.inputDir, outputDir: d.outputDir })
  const before = JSON.parse((await post('state', null)).text)
  assert.equal(before.value.feiyuLocal.keySet, false)
  assert.equal(before.value.settings.feiyu.baseUrl, svc.url)

  const t0 = JSON.parse((await post('feiyu-test', null)).text)
  assert.match(t0.value.feiyuTest.message, /还没有填写 API Key/)

  assert.equal(JSON.parse((await post('feiyu-key', { apiKey: 'a b' })).text).error.code, 'invalid')
  const saved = await post('feiyu-key', { apiKey: KEY })
  assert.ok(!saved.text.includes(KEY), 'key not echoed')
  assert.equal(JSON.parse(saved.text).value.feiyuLocal.keySet, true)
  assert.equal((await stat(d.keyFile)).mode & 0o777, 0o600)

  const tested = JSON.parse((await post('feiyu-test', null)).text)
  assert.equal(tested.value.feiyuTest.ok, true)
  assert.deepEqual(tested.value.feiyuTest.styles, ['cute', 'gentle'])
  assert.ok(!(await post('state', null)).text.includes(KEY))

  const bad = JSON.parse((await post('save', { patch: { feiyu: { baseUrl: 'ftp://x' } } })).text)
  assert.equal(bad.ok, false)
  const cleared = JSON.parse((await post('feiyu-key-clear', null)).text)
  assert.equal(cleared.value.feiyuLocal.keySet, false)
})
