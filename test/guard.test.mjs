import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, resolveSettings } from '../lib/config.js'
import { SendGuard } from '../lib/guard.js'
import { extractRpid } from '../lib/bili-client.js'

const live = (input) => { const c = Config(input); return () => resolveSettings(c) }

function clock(start) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('min interval and daily cap', () => {
  const c = clock(Date.UTC(2026, 9, 26, 4, 0, 0))
  const g = new SendGuard(live({ maxCommentsPerDay: 2 }), c.now)
  assert.equal(g.reserve('comment').ok, true)
  assert.equal(g.reserve('comment').ok, false, 'within 12s')
  c.advance(12_000)
  assert.equal(g.reserve('comment').ok, true)
  c.advance(60_000)
  const third = g.reserve('comment')
  assert.equal(third.ok, false)
  assert.match(third.message, /上限 2/)
  assert.equal(g.reserve('reply').ok, true, 'replies have their own bucket')
})

test('daily counter resets at local midnight (Asia/Shanghai)', () => {
  // 15:59:00 UTC = 23:59 in Shanghai
  const c = clock(Date.UTC(2026, 9, 26, 15, 59, 0))
  const g = new SendGuard(live({ maxRepliesPerDay: 1 }), c.now)
  assert.equal(g.reserve('reply').ok, true)
  c.advance(30_000)
  assert.equal(g.reserve('reply').ok, false)
  c.advance(60_000) // 00:00:30 next day in Shanghai
  assert.equal(g.reserve('reply').ok, true)
})

test('reply dedupe expires after the window', () => {
  const c = clock(0)
  const g = new SendGuard(live({}), c.now)
  g.markReplied('42')
  assert.equal(g.wasRecentlyReplied('42'), true)
  c.advance(10 * 60 * 1000 - 1)
  assert.equal(g.wasRecentlyReplied('42'), true)
  c.advance(1)
  assert.equal(g.wasRecentlyReplied('42'), false)
})

test('extractRpid handles common bilibili-mcp result shapes', () => {
  assert.equal(extractRpid({ content: [], structuredContent: { rpid: 123456 } }), '123456')
  assert.equal(extractRpid({ content: [{ type: 'text', text: '{"data":{"rpid_str":"777888999"}}' }] }), '777888999')
  assert.equal(extractRpid({ content: [{ type: 'text', text: '评论成功 rpid: 246813579' }] }), '246813579')
  assert.equal(extractRpid({ content: [{ type: 'text', text: '评论已发布\nrpid: 271828182845\n内容: 啊不对' }] }), '271828182845')
  assert.equal(extractRpid({ content: [{ type: 'text', text: 'ok' }] }), '')
})
