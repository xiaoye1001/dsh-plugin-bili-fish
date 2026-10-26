// Integration tests: real Cordis root + real @deepseek-ai/dsh-tools registry,
// a fake bilibili-mcp tool registered the same way dsh-mcp-client does, and a
// fake TTS service. Runs against the built lib/ output.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const MCP_OUTPUT = {
  schema: {
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content'],
    additionalProperties: false,
  },
  render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.content) }],
}

/** Boot a fresh harness. Each test gets its own registry, so tool names never collide. */
async function boot({ config = {}, mcp = true, tts = true, voiceTool = false, mcpBehavior } = {}) {
  const calls = []
  const voiceCalls = []
  const ttsCalls = []
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  if (mcp) {
    root.tools.register({
      name: 'mcp__bilibili__bili_reply',
      description: 'fake bilibili-mcp reply',
      parameters: { type: 'object', properties: {} },
      output: MCP_OUTPUT,
      async execute(args, exec) {
        calls.push({ args, signal: exec.signal })
        if (mcpBehavior) return mcpBehavior(args, exec)
        return { content: [{ type: 'text', text: JSON.stringify({ code: 0, data: { rpid: 987654321 } }) }] }
      },
    })
  }
  if (voiceTool) {
    root.tools.register({
      name: 'mcp__bilibili__bili_voice',
      description: 'fake voice comment',
      parameters: { type: 'object', properties: {} },
      output: MCP_OUTPUT,
      async execute(args) {
        voiceCalls.push(args)
        return { content: [{ type: 'text', text: 'ok' }], structuredContent: { rpid: '555666777' } }
      },
    })
  }
  if (tts) {
    root.provide('tts', {
      async synthesize(req) {
        ttsCalls.push(req)
        return { audio: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), mime: 'audio/mpeg' }
      },
    })
  }
  await root.plugin(plugin, config)
  let n = 0
  const run = (name, args, signal = new AbortController().signal) =>
    root.tools.execute({ callId: ToolCallId(`t${++n}`), name, arguments: args, signal })
  return { root, run, calls, voiceCalls, ttsCalls }
}

const VIDEO = 'BV1xx411c7mD'
const COMMENT = '这条鱼看完了，啊不对，是看了两遍，后半段那个转场好顺'
const REPLY = '诶你说得对，我刚没注意到'

test('registers four tools with object output schemas', async () => {
  const { root } = await boot()
  for (const name of ['bili_build_prompt', 'bili_comment', 'bili_reply', 'bili_send_voice']) {
    assert.ok(root.tools.get(name), `${name} registered`)
  }
  await root.fiber.dispose()
  assert.equal(root.tools?.get?.('bili_comment'), undefined)
})

test('bili_build_prompt exposes the persona and configured lengths', async () => {
  const { run } = await boot({ config: { persona: { extra: '今天心情好' } } })
  const r = await run('bili_build_prompt', { kind: 'reply', context: '这视频好水' })
  assert.equal(r.isError, false)
  assert.match(r.value.persona, /大肥鱼/)
  assert.match(r.value.persona, /今天心情好/)
  assert.equal(r.value.minLength, 5)
  assert.equal(r.value.maxLength, 30)
  assert.match(r.content[0].text, /这视频好水/)
})

test('bili_comment defaults to a draft and never calls bilibili', async () => {
  const { run, calls } = await boot({ config: { sendEnabled: true } })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT })
  assert.deepEqual(r.value, { rpid: 'dry-run', message: '草稿：' + COMMENT })
  assert.equal(calls.length, 0)
})

test('bili_comment rejects text outside 15–60 chars and bad video ids', async () => {
  const { run } = await boot()
  const short = await run('bili_comment', { videoId: VIDEO, text: '太短了' })
  assert.equal(short.isError, true)
  assert.match(short.error.message, /15～60/)
  const badId = await run('bili_comment', { videoId: 'hello', text: COMMENT })
  assert.equal(badId.isError, true)
})

test('real send is blocked when sendEnabled is off', async () => {
  const { run, calls } = await boot()
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.deepEqual(r.value, { skipped: true, reason: 'send_disabled', message: r.value.message })
  assert.equal(calls.length, 0)
})

test('dryRunByDefault=false still needs an explicit dryRun:false', async () => {
  const { run, calls } = await boot({ config: { sendEnabled: true, dryRunByDefault: false } })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT })
  assert.equal(r.value.reason, 'dry_run_not_explicit')
  assert.equal(calls.length, 0)
})

test('bili_comment sends via bilibili-mcp without parentRpid, then rate-limits', async () => {
  const { run, calls } = await boot({ config: { sendEnabled: true } })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(r.isError, false)
  assert.deepEqual(r.value, { rpid: '987654321', message: '已发送' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, { videoId: VIDEO, message: COMMENT })

  const again = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(again.isError, false)
  assert.equal(again.value.skipped, true)
  assert.equal(again.value.reason, 'rate_limited')
  assert.equal(calls.length, 1)
})

test('daily cap of 0 blocks every real comment', async () => {
  const { run, calls } = await boot({ config: { sendEnabled: true, maxCommentsPerDay: 0 } })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(r.value.reason, 'rate_limited')
  assert.equal(calls.length, 0)
})

test('bili_reply passes parentRpid and dedupes the same comment', async () => {
  const { run, calls } = await boot({ config: { sendEnabled: true } })
  const r = await run('bili_reply', { videoId: VIDEO, parentRpid: '111222333', text: REPLY, dryRun: false })
  assert.deepEqual(r.value, { rpid: '987654321', message: '已回复' })
  assert.deepEqual(calls[0].args, { videoId: VIDEO, message: REPLY, parentRpid: '111222333' })

  const dup = await run('bili_reply', { videoId: VIDEO, parentRpid: '111222333', text: REPLY, dryRun: false })
  assert.equal(dup.isError, false)
  assert.deepEqual(dup.value, { rpid: '', message: 'skipped: already replied' })
  assert.equal(calls.length, 1)
})

test('bili_reply rejects text outside 5–30 chars', async () => {
  const { run } = await boot()
  const r = await run('bili_reply', { videoId: VIDEO, parentRpid: '1', text: '嗯' })
  assert.equal(r.isError, true)
  assert.match(r.error.message, /5～30/)
})

test('missing bilibili-mcp yields dependency_missing, not a crash', async () => {
  const { run } = await boot({ mcp: false, config: { sendEnabled: true } })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(r.isError, false)
  assert.equal(r.value.reason, 'dependency_missing')
  assert.match(r.value.message, /mcp__bilibili__bili_reply/)
  const draft = await run('bili_comment', { videoId: VIDEO, text: COMMENT })
  assert.equal(draft.value.rpid, 'dry-run')
})

test('bilibili-mcp failure surfaces as a tool error', async () => {
  const { run } = await boot({
    config: { sendEnabled: true },
    mcpBehavior: () => { throw new Error('风控拦截') },
  })
  const r = await run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(r.isError, true)
  assert.match(r.error.message, /风控拦截/)
})

test('cancelling the outer call aborts the in-flight bilibili request', async () => {
  let innerSignal
  const { run } = await boot({
    config: { sendEnabled: true },
    mcpBehavior: (_args, exec) => new Promise((_resolve, reject) => {
      innerSignal = exec.signal
      exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const ac = new AbortController()
  const pending = run('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false }, ac.signal)
  await new Promise(r => setTimeout(r, 20))
  assert.ok(innerSignal, 'mcp tool started')
  ac.abort()
  const r = await pending
  assert.equal(innerSignal.aborted, true)
  assert.equal(r.isError, true)
})

test('bili_send_voice dry run writes a local audio draft only', async () => {
  const { run, calls, ttsCalls } = await boot({ config: { sendEnabled: true } })
  const r = await run('bili_send_voice', { videoId: VIDEO, text: '我真的笑到翻肚皮了' })
  assert.equal(r.isError, false)
  assert.equal(r.value.message, '语音草稿已生成')
  assert.ok(existsSync(r.value.audioPath))
  assert.equal(ttsCalls[0].voice, 'zh-CN-XiaoxiaoNeural')
  assert.equal(calls.length, 0)
})

test('bili_send_voice throws a clear error when the TTS service is missing', async () => {
  const { run } = await boot({ tts: false })
  const r = await run('bili_send_voice', { videoId: VIDEO, text: '你好呀' })
  assert.equal(r.isError, true)
  assert.match(r.error.message, /依赖缺失.*ctx\.tts/)
})

test('bili_send_voice without a voice tool and fallback off is voice_unsupported', async () => {
  const { run, ttsCalls } = await boot({ config: { sendEnabled: true } })
  const r = await run('bili_send_voice', { videoId: VIDEO, text: '你好呀', dryRun: false })
  assert.equal(r.value.reason, 'voice_unsupported')
  assert.equal(ttsCalls.length, 0, 'no audio synthesized for an impossible send')
})

test('bili_send_voice uses the bilibili voice tool when configured', async () => {
  const { run, voiceCalls } = await boot({
    voiceTool: true,
    config: { sendEnabled: true, bilibili: { voiceTool: 'mcp__bilibili__bili_voice' } },
  })
  const r = await run('bili_send_voice', { videoId: VIDEO, text: '你好呀', voice: 'zh-CN-YunxiNeural', dryRun: false })
  assert.equal(r.isError, false)
  assert.equal(r.value.rpid, '555666777')
  assert.equal(voiceCalls[0].videoId, VIDEO)
  assert.equal(voiceCalls[0].audioPath, r.value.audioPath)
})

test('bili_send_voice fallback uploads audio and posts the link as a comment', async () => {
  let received = ''
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      received = Buffer.concat(chunks).toString('latin1')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { url: 'https://files.example/a.mp3' } }))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address()
    const { run, calls } = await boot({
      config: {
        sendEnabled: true,
        voiceFallback: { enabled: true, uploadUrl: `http://127.0.0.1:${port}/up`, urlField: 'data.url' },
      },
    })
    const r = await run('bili_send_voice', { videoId: VIDEO, text: '听我说', dryRun: false })
    assert.equal(r.isError, false, JSON.stringify(r))
    assert.match(received, /name="file"/)
    assert.equal(calls[0].args.message, '听我说 语音版：https://files.example/a.mp3')
    assert.equal(r.value.rpid, '987654321')
  } finally {
    server.close()
  }
})

test('invalid config fails loudly at load', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  assert.throws(() => plugin.Config({ minIntervalMs: 1000 }))
  let error
  try {
    await root.plugin(plugin, { commentLength: { min: 50, max: 10 } })
  } catch (e) {
    error = e
  }
  assert.ok(error, 'apply rejected')
  assert.match(String(error), /commentLength/)
  assert.equal(root.tools.get('bili_comment'), undefined)
})

test('bundle patch references the package by name', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  const patch = readFileSync(new URL('../bundle.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes(`name: '${pkg.name}'`))
})
