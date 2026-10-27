// Settings-page tests: the host RPC channel on a real Cordis root + dsh-tools
// registry, the real Connection service (requests go through its /api
// dispatcher exactly as the browser's do) and a fake `settings` service. The fake settings
// service writes into the plugin's real volatile refs via cosmokit's
// updateVolatile — the same mechanism the DSH Loader uses after a save.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'

const ENTRY = 'bili-fish'
const VIDEO = 'BV1xx411c7mD'
const COMMENT = '这条鱼看完了，啊不对，是看了两遍，后半段那个转场好顺'

/** Emulate the Loader: write a nested patch into the live config refs. */
function applyPatch(config, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const target = config[key]
    if (isVolatile(target)) updateVolatile(target, createVolatile(value))
    else if (typeof value === 'object' && value !== null) applyPatch(target, value)
    else throw new Error(`not volatile: ${key}`)
  }
}

async function boot({ raw = {}, settings = true, entryId = ENTRY, revision = 3 } = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  const mcpCalls = []
  root.tools.register({
    name: 'mcp__bilibili__bilibili_reply',
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args) {
      mcpCalls.push(args)
      return { content: [{ type: 'text', text: '{"rpid": 123456789}' }] }
    },
  })

  // Real Connection service (no web server at all — like a profile plugin that cannot see it).
  let connection
  await root.plugin({ name: 'connection-host', apply(ctx) { connection = new HostConnectionService(ctx, [], {}) } })

  const config = plugin.Config(raw)
  const updates = []
  const policies = []
  const forms = {
    revision,
    writable: true,
    describe: () => [{ ns: ENTRY, revision: forms.revision }],
    async update(ns, patch, expected) {
      if (expected !== forms.revision) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
      updates.push({ ns, patch, expected })
      applyPatch(config, patch)
      forms.revision += 1
    },
    configure(presentation, fiber) {
      policies.push({ presentation, fiber })
      return () => {}
    },
  }
  if (settings) root.provide('settings', forms)

  // Load the real plugin, giving its fiber a profile entry like the Loader does.
  await root.plugin({
    name: 'bili-fish-under-test',
    inject: ['tools'],
    apply(ctx) {
      if (entryId) Object.defineProperty(ctx.fiber, 'entry', { value: { options: { id: entryId } }, configurable: true })
      plugin.apply(ctx, config)
    },
  })

  let n = 0
  // Same path the browser takes: POST /api/bili-fish/<endpoint> through the shared /api handler.
  const api = connection.createSharedFetchHandler('/api')
  const post = (endpoint, body, principal = 'owner') => api.fetch(
    new Request(`http://127.0.0.1:3080/api/bili-fish/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { principal: { kind: principal } },
  )
  const rpc = async (endpoint, payload) => {
    const res = await post(endpoint, payload ?? null)
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
  const tool = (name, args) => root.tools.execute({ callId: ToolCallId(`p${++n}`), name, arguments: args, signal: new AbortController().signal })
  return { root, rpc, post, tool, updates, policies, forms, mcpCalls }
}

test('state reports settings, usage, dependencies and a writable revision', async () => {
  const { rpc, policies } = await boot()
  const r = await rpc('state', null)
  assert.equal(r.ok, true)
  const s = r.value
  assert.equal(s.settings.sendEnabled, false)
  assert.equal(s.settings.maxCommentsPerDay, 5)
  assert.equal(s.settings.tts.defaultVoice, 'zh-CN-XiaoxiaoNeural')
  assert.deepEqual(s.persistence, { writable: true, entryId: ENTRY, revision: 3 })
  assert.deepEqual(s.dependencies, { replyTool: true, voiceTool: null, tts: false })
  assert.equal(s.usage.comments, 0)
  assert.match(s.defaultPersona, /大肥鱼/)
  assert.equal(policies.length, 1)
  assert.deepEqual(policies[0].presentation, { auto: false })
})

test('a save hot-applies: the next tool call sees the new switch', async () => {
  const { rpc, tool, updates, mcpCalls } = await boot()
  const before = await tool('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.equal(before.value.reason, 'send_disabled')

  const saved = await rpc('save', { patch: { sendEnabled: true, persona: { extra: '今天很困' } }, revision: 3 })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(updates, [{ ns: ENTRY, patch: { sendEnabled: true, persona: { extra: '今天很困' } }, expected: 3 }])
  assert.equal(saved.value.settings.sendEnabled, true)
  assert.equal(saved.value.persistence.revision, 4)

  const after = await tool('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  assert.deepEqual(after.value, { rpid: '123456789', message: '已发送' })
  assert.equal(mcpCalls.length, 1)

  const prompt = await tool('bili_build_prompt', { kind: 'comment' })
  assert.match(prompt.value.persona, /今天很困/)
})

test('saving keeps today’s counters (no plugin remount)', async () => {
  const { rpc, tool } = await boot({ raw: { sendEnabled: true } })
  await tool('bili_comment', { videoId: VIDEO, text: COMMENT, dryRun: false })
  const saved = await rpc('save', { patch: { maxCommentsPerDay: 1 }, revision: 3 })
  assert.equal(saved.value.usage.comments, 1)
  const blocked = await tool('bili_comment', { videoId: 'BV1zz411c7mD', text: COMMENT, dryRun: false })
  assert.equal(blocked.value.reason, 'rate_limited')
})

test('save rejects unknown keys, bad types and unsafe values', async () => {
  const { rpc, updates } = await boot()
  const cases = [
    [{ timeZone: 'UTC' }, /不允许修改/],
    [{ sendEnabled: 'yes' }, /布尔/],
    [{ minIntervalMs: 1000 }, /12000/],
    [{ maxCommentsPerDay: 5000 }, /0～100/],
    [{ replyDedupeWindowMs: 10 }, /60000/],
    [{ bilibili: { replyTool: 'x' } }, /不允许修改/],
    [{ voiceFallback: { enabled: true } }, /uploadUrl/],
    [{ voiceFallback: { uploadUrl: 'javascript:alert(1)' } }, /格式不正确/],
    [{ tts: { defaultVoice: '' } }, /不能为空/],
    ['not an object', /对象/],
  ]
  for (const [patch, pattern] of cases) {
    const r = await rpc('save', { patch, revision: 3 })
    assert.equal(r.ok, false, JSON.stringify(patch))
    assert.equal(r.error.code, 'invalid')
    assert.match(r.error.message, pattern, JSON.stringify(patch))
    assert.equal(typeof r.error.details, 'object')
  }
  assert.equal(updates.length, 0)
})

test('voice fallback can be enabled together with a valid upload URL', async () => {
  const { rpc } = await boot()
  const r = await rpc('save', {
    patch: { voiceFallback: { enabled: true, uploadUrl: 'https://files.example/up', template: '{text} {url}' } },
    revision: 3,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.settings.voiceFallback, { enabled: true, uploadUrl: 'https://files.example/up', template: '{text} {url}' })
})

test('stale revision is a conflict', async () => {
  const { rpc, updates } = await boot()
  const r = await rpc('save', { patch: { sendEnabled: true }, revision: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'conflict')
  assert.equal(updates.length, 0)
})

test('without the settings service the page is read-only', async () => {
  const { rpc } = await boot({ settings: false })
  const state = await rpc('state', null)
  assert.equal(state.value.persistence.writable, false)
  assert.match(state.value.persistence.reason, /dsh-settings/)
  const r = await rpc('save', { patch: { sendEnabled: true } })
  assert.equal(r.error.code, 'read-only')
})

test('an entry the settings service does not expose is read-only', async () => {
  const { rpc } = await boot({ entryId: 'other-id' })
  const state = await rpc('state', null)
  assert.equal(state.value.persistence.writable, false)
  assert.match(state.value.persistence.reason, /other-id/)
})

test('only the two routes exist, only for the owner, only as JSON POST', async () => {
  const { post } = await boot()
  assert.equal((await post('reset-counters', {})).status, 404)
  assert.equal((await post('state', null, 'guest')).status, 403)
  const bad = await post('state', '{not json')
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.code, 'bad-request')
})

test('plugin dispose removes the RPC channel', async () => {
  const { root, rpc } = await boot()
  await root.fiber.dispose()
  await assert.rejects(() => rpc('state', null), /HTTP 404/)
})

test('client bundle registers the settings section through the module loader', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')

  let loaded
  const requested = []
  const window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
  new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window)
  assert.equal(loaded.id, pkg.name)
  const mod = loaded.factory((id) => {
    requested.push(id)
    return { jsx: () => null, jsxs: () => null, Fragment: 'f', useState: () => [], useEffect() {}, useMemo() {}, useRef: () => ({}), useCallback: f => f }
  })
  assert.deepEqual([...new Set(requested)].sort(), ['react', 'react/jsx-runtime'])
  assert.deepEqual(mod.inject, ['slots'])

  const registered = []
  const fakeCtx = {
    slots: {
      inject: (name, cb) => { assert.equal(name, 'settings.section'); cb() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  }
  mod.apply(fakeCtx)
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'bili-fish')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.label, '大肥鱼 · B 站')
  assert.equal(options.inject().ctx, fakeCtx)
  assert.equal(typeof component, 'function')
})

test('auto-reply settings: defaults, save, validation, and check gating', async () => {
  const { rpc } = await boot()
  const state = await rpc('state', null)
  assert.deepEqual(state.value.settings.autoReply, { enabled: false, videos: [], intervalSec: 300, maxPerRound: 3, send: false, skipNames: [] })
  assert.equal(state.value.autoReplyStatus.sessionId, 'bili-fish-autoreply')

  const disabled = await rpc('check', null)
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.code, 'disabled')

  for (const [patch, pattern] of [
    [{ autoReply: { videos: ['not-a-bv'] } }, /BV/],
    [{ autoReply: { intervalSec: 10 } }, /60/],
    [{ autoReply: { maxPerRound: 99 } }, /1～10/],
    [{ autoReply: { sessionId: 'x' } }, /不允许修改/],
  ]) {
    const r = await rpc('save', { patch, revision: 3 })
    assert.equal(r.ok, false, JSON.stringify(patch))
    assert.match(r.error.message, pattern)
  }

  const saved = await rpc('save', {
    patch: { autoReply: { enabled: true, videos: ['BV1xx411c7mD', 'BV1xx411c7mD'], intervalSec: 600, skipNames: ['我'] } },
    revision: 3,
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(saved.value.settings.autoReply.videos, ['BV1xx411c7mD'], 'duplicates removed')
  assert.equal(saved.value.settings.autoReply.enabled, true)

  // Enabled now: a manual check runs a round (and reports the missing comments tool here).
  const checked = await rpc('check', null)
  assert.equal(checked.ok, true)
  assert.match(checked.value.autoReplyStatus.lastError, /依赖缺失/)
})

test('exploration settings: save, validation, and explore gating', async () => {
  const { rpc } = await boot()
  const state = await rpc('state', null)
  assert.equal(state.value.settings.explore.enabled, false)
  assert.equal(state.value.settings.commentOncePerVideoHours, 168)
  assert.equal(state.value.exploreStatus.sessionId, 'bili-fish-explore')

  const off = await rpc('explore', null)
  assert.equal(off.error.code, 'disabled')

  for (const [patch, pattern] of [
    [{ explore: { intervalMin: 5 } }, /30/],
    [{ explore: { activeFrom: 20, activeTo: 8 } }, /activeFrom/],
    [{ explore: { watchPerRound: 1, commentsPerRound: 3 } }, /commentsPerRound/],
    [{ explore: { sessionId: 'x' } }, /不允许修改/],
    [{ commentOncePerVideoHours: 0 }, /1～/],
  ]) {
    const r = await rpc('save', { patch, revision: 3 })
    assert.equal(r.ok, false, JSON.stringify(patch))
    assert.match(r.error.message, pattern, JSON.stringify(patch))
  }
  const saved = await rpc('save', { patch: { explore: { enabled: true, interests: ['猫', '猫', '做饭'], commentsPerRound: 0 } }, revision: 3 })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(saved.value.settings.explore.interests, ['猫', '做饭'])
  assert.equal(saved.value.exploreStatus.nextKeyword, '猫')
  // Enabled: a manual round runs; this harness has no bilibili-mcp, so it is skipped before waking the model.
  const ran = await rpc('explore', null)
  assert.equal(ran.ok, true)
  assert.match(ran.value.exploreStatus.lastError, /未接入或未连接/)
})
