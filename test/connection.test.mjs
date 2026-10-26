// Regression tests for the settings page's "HTTP 405".
// In a real DSH profile the plugin cannot see the `webServer` service
// ("cannot get property webServer without inject"), so it must not depend on
// it. These use the real HostConnectionService from dsh-client-connection and
// send requests through its real shared /api dispatcher, like the browser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

async function boot() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  let connection
  await root.plugin({ name: 'connection-host', apply(ctx) { connection = new HostConnectionService(ctx, [], {}) } })
  const fiber = await root.plugin(plugin, {})
  const api = connection.createSharedFetchHandler('/api')
  const post = (path) => api.fetch(
    new Request(`http://127.0.0.1:3080${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' }),
    { principal: { kind: 'owner' } },
  )
  return { root, fiber, post }
}

test('page routes work with no webServer visible to the plugin', async () => {
  const { post } = await boot()
  const res = await post('/api/bili-fish/state')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.value.settings.sendEnabled, false)
})

test('the old top-level channel is gone', async () => {
  const { post } = await boot()
  assert.equal((await post('/api/bili-fish/unknown')).status, 404)
})

test('unloading the plugin removes its routes, and reloading does not collide', async () => {
  const { root, fiber, post } = await boot()
  await fiber.dispose()
  assert.equal((await post('/api/bili-fish/state')).status, 404)
  await root.plugin(plugin, {})
  assert.equal((await post('/api/bili-fish/state')).status, 200)
})
