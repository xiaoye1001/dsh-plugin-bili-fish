// Regression for "mcp__bilibili__bilibili_search 当前不可见" inside the
// exploration / auto-reply sessions. Those sessions are restricted with
// tools.restrict({ allow: [...] }), which also hides the bilibili-mcp tools
// the plugin's own tools call internally. Uses a real agent scope
// (dsh-scope createScope) and the real dsh-tools restriction.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { EXPLORE_TOOLS } from '../lib/explore/explorer.js'
import { PATROL_TOOLS } from '../lib/autoreply/watcher.js'

function mcpTool(root, name, text) {
  const calls = []
  root.tools.register({
    name: `mcp__bilibili__${name}`,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
      render: () => [{ type: 'text', text: '' }],
    },
    async execute(args) { calls.push(args); return { content: [{ type: 'text', text: typeof text === 'function' ? text(args) : text }] } },
  })
  return calls
}

async function boot(t, allow, raw = {}) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  t.after(() => root.fiber.dispose())
  const calls = {
    search: mcpTool(root, 'bilibili_search', '1. 橘猫的一天\n   UP主: 猫奴 (uid:11)\n   生活 · 3:00 · 今天\n   ▶1  💬1  👍1  ⭐1'),
    users: mcpTool(root, 'bilibili_user_videos', '📺 UP主 uid:11 的视频:\n1. [BV1aa411c7mD] 橘猫的一天 (10播放)'),
    info: mcpTool(root, 'bilibili_video_info', '标题: 橘猫的一天'),
    subtitle: mcpTool(root, 'bilibili_video_subtitle', '📝 字幕 (中文):\n[00:01] 喵'),
    danmaku: mcpTool(root, 'bilibili_video_danmaku', '弹幕：好胖'),
    comments: mcpTool(root, 'bilibili_video_comments', '📋 共 1 条评论：\n1. 网友: 胖橘 [rpid:777]'),
    reply: mcpTool(root, 'bilibili_reply', '评论已发布\nrpid: 9999999\n内容: x'),
  }
  await root.plugin(plugin, raw)
  // A real agent scope, restricted exactly like the plugin's sessions.
  const agent = {}
  await root.plugin({
    name: 'fake-agent-host',
    inject: ['tools'],
    apply(ctx) { createScope(ctx, agent).ctx.tools.restrict({ allow: [...allow] }) },
  })
  assert.equal(root.tools.get('mcp__bilibili__bilibili_search', agent), undefined, 'precondition: MCP tools hidden in the session')
  let n = 0
  const run = (name, args) => root.tools.execute({ callId: ToolCallId(`r${++n}`), name, arguments: args, agent, signal: new AbortController().signal })
  return { run, calls }
}

test('bili_discover and bili_watch_video work inside the restricted explore session', async (t) => {
  const { run, calls } = await boot(t, EXPLORE_TOOLS)
  const found = await run('bili_discover', { keyword: '猫' })
  assert.equal(found.isError, false, JSON.stringify(found.error ?? found.content))
  assert.deepEqual(found.value.videos.map(v => v.videoId), ['BV1aa411c7mD'])
  const watched = await run('bili_watch_video', { videoId: 'BV1aa411c7mD' })
  assert.equal(watched.isError, false, JSON.stringify(watched.error ?? watched.content))
  assert.match(watched.value.subtitle, /喵/)
  assert.equal(calls.search.length, 1)
})

test('bili_comment and bili_reply send from restricted sessions', async (t) => {
  const explore = await boot(t, EXPLORE_TOOLS, { sendEnabled: true })
  const c = await explore.run('bili_comment', { videoId: 'BV1aa411c7mD', text: '这只橘猫走路的样子太像我了，啊不对，比我勤快', dryRun: false })
  assert.equal(c.isError, false, JSON.stringify(c.error ?? c.content))
  assert.equal(c.value.rpid, '9999999')

  const patrol = await boot(t, PATROL_TOOLS, { sendEnabled: true })
  const r = await patrol.run('bili_reply', { videoId: 'BV1aa411c7mD', parentRpid: '777', text: '胖橘是夸我吗', dryRun: false })
  assert.equal(r.isError, false, JSON.stringify(r.error ?? r.content))
  assert.deepEqual(patrol.calls.reply[0], { videoId: 'BV1aa411c7mD', message: '胖橘是夸我吗', parentRpid: '777', rootRpid: '777' })
})

test('the model in a restricted session still cannot call the MCP tools directly', async (t) => {
  const { run, calls } = await boot(t, EXPLORE_TOOLS, { sendEnabled: true })
  const direct = await run('mcp__bilibili__bilibili_search', { keyword: '猫' })
  assert.equal(direct.isError, true)
  const write = await run('mcp__bilibili__bilibili_reply', { videoId: 'BV1aa411c7mD', message: 'x' })
  assert.equal(write.isError, true)
  assert.equal(calls.search.length + calls.reply.length, 0)
})
