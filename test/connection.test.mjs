// Regression test for "transport failure for /bili-fish/state: HTTP 405".
// Uses the real HostConnectionService from @deepseek-ai/dsh-client-connection:
// in DSH it is published before the web server exists, and its rpc.handle()
// registers the channel through the *caller's* ctx.webServer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    service: {
      protocol: 'http:',
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

async function bootHarness() {
  const root = new Context()
  const errors = []
  root.on('internal/error', (e) => errors.push(e))
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  // Real Connection service, constructed the way its plugin does (minus browser auth).
  await root.plugin({ name: 'connection-host', apply(ctx) { new HostConnectionService(ctx, [], {}) } })
  return { root, errors }
}

test('rpc channel is registered when the web server starts after the plugin', async () => {
  const { root } = await bootHarness()
  await root.plugin(plugin, {})
  const web = fakeWebServer()
  assert.equal(web.routes.has('/bili-fish'), false)

  // DSH brings the web server up after Connection and after ordinary plugins.
  const fiber = root.provide('webServer', web.service)
  await new Promise(r => setTimeout(r, 20))
  assert.ok(web.routes.has('/bili-fish'), 'POST /bili-fish/* must reach the plugin, not the page fallback')
  assert.equal(web.routes.get('/bili-fish').kind, 'prefix')
  void fiber
})

test('rpc channel is registered when the web server already exists', async () => {
  const { root } = await bootHarness()
  const web = fakeWebServer()
  root.provide('webServer', web.service)
  await root.plugin(plugin, {})
  await new Promise(r => setTimeout(r, 20))
  assert.ok(web.routes.has('/bili-fish'))
})
