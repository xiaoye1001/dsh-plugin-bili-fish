// Login values: validation, the cookie file bilibili-mcp-server reads, and the
// panel endpoints (through the real Connection /api dispatcher). Secrets must
// never come back to the browser.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { clearLogin, cookieFilePath, readLoginStatus, saveLogin, validateLogin } from '../lib/login.js'

const SESSDATA = 'a1b2c3d4%2C1798000000%2Cabcde%2A11xyzSECRET'
const JCT = '0123456789abcdef0123456789abcdef'

test('validates the three values; empty means unchanged', () => {
  assert.deepEqual(validateLogin({ sessdata: SESSDATA, biliJct: JCT, dedeUserId: '12345' }),
    { value: { sessdata: SESSDATA, biliJct: JCT, dedeUserId: '12345' } })
  assert.deepEqual(validateLogin({ sessdata: '', biliJct: JCT, dedeUserId: '' }), { value: { biliJct: JCT } })
  assert.match(validateLogin({ biliJct: 'short' }).problems.join(), /bili_jct/)
  assert.match(validateLogin({ dedeUserId: 'abc' }).problems.join(), /DedeUserID/)
  assert.match(validateLogin({ sessdata: 'has space and is long enough' }).problems.join(), /SESSDATA/)
  assert.match(validateLogin({ sessdata: SESSDATA, evil: 1 }).problems.join(), /不认识的字段/)
  assert.match(validateLogin({}).problems.join(), /都是空的/)
})

test('default path is under DSH_HOME or ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/srv/dsh'
  try {
    assert.equal(cookieFilePath(''), '/srv/dsh/bili-fish/cookie.json')
    assert.equal(cookieFilePath('/x/c.json'), '/x/c.json')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('writes the server\'s file format, 0600, merging with what the server stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-login-'))
  const path = join(dir, 'nested', 'cookie.json')
  await saveLogin(path, { sessdata: SESSDATA, biliJct: JCT, dedeUserId: '12345' })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sessdata: SESSDATA, bili_jct: JCT, dede_user_id: '12345' })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700)

  // The server rewrites the file on auto-refresh with extra fields; a partial update keeps them.
  await writeFile(path, JSON.stringify({ sessdata: 'old%2Cvalue%2Cxxxxxxxxxxxxxx', bili_jct: JCT, dede_user_id: '12345', lastRefresh: 1700000000000 }))
  await saveLogin(path, { sessdata: SESSDATA })
  const merged = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(merged.sessdata, SESSDATA)
  assert.equal(merged.lastRefresh, 1700000000000)
  assert.equal((await stat(path)).mode & 0o777, 0o600)

  const status = await readLoginStatus(path)
  assert.deepEqual({ ...status, updatedAt: typeof status.updatedAt }, { path, sessdata: true, biliJct: true, dedeUserId: '12345', updatedAt: 'number' })
  await clearLogin(path)
  await clearLogin(path) // idempotent
  assert.deepEqual((await readLoginStatus(path)).sessdata, false)
})

test('panel login/logout endpoints never echo secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-login-'))
  const cookieFile = join(dir, 'cookie.json')
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  let connection
  await root.plugin({ name: 'connection-host', apply(ctx) { connection = new HostConnectionService(ctx, [], {}) } })
  await root.plugin(plugin, { bilibili: { cookieFile } })
  const api = connection.createSharedFetchHandler('/api')
  const post = async (endpoint, body) => {
    const res = await api.fetch(new Request(`http://127.0.0.1:3080/api/bili-fish/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { principal: { kind: 'owner' } })
    return { status: res.status, text: await res.text() }
  }

  const before = JSON.parse((await post('state', null)).text)
  assert.deepEqual(before.value.login.sessdata, false)
  assert.match(before.value.login.mcpSnippet, new RegExp(`BILIBILI_COOKIE_FILE: '${cookieFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))

  const bad = JSON.parse((await post('login', { biliJct: 'nope' })).text)
  assert.equal(bad.error.code, 'invalid')

  const saved = await post('login', { sessdata: SESSDATA, biliJct: JCT, dedeUserId: '12345' })
  assert.equal(saved.status, 200)
  assert.ok(!saved.text.includes(SESSDATA) && !saved.text.includes(JCT), 'secrets are not echoed')
  const body = JSON.parse(saved.text)
  assert.deepEqual([body.value.login.sessdata, body.value.login.biliJct, body.value.login.dedeUserId], [true, true, '12345'])
  assert.equal(JSON.parse(await readFile(cookieFile, 'utf8')).sessdata, SESSDATA)

  const state = await post('state', null)
  assert.ok(!state.text.includes(SESSDATA) && !state.text.includes(JCT))

  const out = JSON.parse((await post('logout', null)).text)
  assert.equal(out.value.login.sessdata, false)
  await root.fiber.dispose()
})
