// End-to-end check of the settings page: the real lib/client.js bundle runs in
// Chromium with real React; its RPC calls are routed through Playwright to the
// real host handler of a plugin loaded on a real Cordis root.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'

// Playwright is provided by the environment (pre-installed Chromium), not a package dependency.
const { chromium } = createRequire(import.meta.url)('playwright')

function applyPatch(config, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (isVolatile(config[key])) updateVolatile(config[key], createVolatile(value))
    else applyPatch(config[key], value)
  }
}

async function bootHost() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRegistry)
  let connection
  await root.plugin({ name: 'connection-host', apply(ctx) { connection = new HostConnectionService(ctx, [], {}) } })
  const config = plugin.Config({})
  const updates = []
  const forms = {
    revision: 0,
    writable: true,
    describe: () => [{ ns: 'bili-fish', revision: forms.revision }],
    async update(_ns, patch) { updates.push(patch); applyPatch(config, patch); forms.revision++ },
    configure: () => () => {},
  }
  root.provide('settings', forms)
  await root.plugin({
    name: 'ui-host', inject: ['tools'],
    apply(ctx) {
      Object.defineProperty(ctx.fiber, 'entry', { value: { options: { id: 'bili-fish' } } })
      plugin.apply(ctx, config)
    },
  })
  const api = connection.createSharedFetchHandler('/api')
  return { fetch: (request) => api.fetch(request, { principal: { kind: 'owner' } }), updates }
}

test('settings page renders, edits, confirms and saves through the host', async (t) => {
  const shim = await build({
    entryPoints: [new URL('./ui/react-shim.js', import.meta.url).pathname],
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  })
  const host = await bootHost()
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  const apiCalls = []
  // The page's relative fetch('api/bili-fish/…') goes to the real Connection /api dispatcher.
  await page.route('http://dsh.test/api/**', async (route) => {
    const req = route.request()
    apiCalls.push(new URL(req.url()).pathname)
    const res = await host.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined }))
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
  })
  await page.route('http://dsh.test/', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="font-family: system-ui; padding: 24px"><div id="root"></div></body></html>',
  }))

  await page.goto('http://dsh.test/')
  await page.addScriptTag({ content: shim.outputFiles[0].text })
  await page.addScriptTag({
    content: `window.__ModuleLoader__ = { load(def) { window.__biliFish = def.factory(id => {
      const m = window.__platform[id]; if (!m) throw new Error('unexpected module ' + id); return m }) } }`,
  })
  await page.addScriptTag({ content: readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    const mod = window.__biliFish
    const ctx = {
      slots: {
        inject: (_name, cb) => cb(),
        register: (options, Component) => {
          const { createElement } = window.__platform.react
          window.__platform['react-dom/client'].createRoot(document.getElementById('root'))
            .render(createElement(Component, options.inject()))
          return () => {}
        },
      },
    }
    mod.apply(ctx)
  })

  await page.getByText('今日（').waitFor()
  await page.getByRole('heading', { name: '自动回复' }).waitFor()
  await page.getByRole('heading', { name: '自己逛' }).waitFor()
  await page.getByText('bilibili-mcp 未连接').waitFor()
  mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true })
  await page.screenshot({ path: new URL('../artifacts/settings-page.png', import.meta.url).pathname, fullPage: true })

  // Edit: turn on real sends and lower the daily comment cap.
  await page.getByRole('switch', { name: '允许真实发送' }).click()
  await page.getByLabel('每日评论上限').fill('3')
  await page.getByText('有未保存的修改').waitFor()

  // Declining the confirmation must not save.
  page.once('dialog', d => d.dismiss())
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(200)
  assert.equal(host.updates.length, 0)

  page.once('dialog', d => { assert.match(d.message(), /每天 3 条评论/); d.accept() })
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByText('已保存，下一次工具调用即生效。').waitFor()
  assert.deepEqual(host.updates, [{ sendEnabled: true, maxCommentsPerDay: 3 }])
  await page.getByText('真实发送已开启').waitFor()
  await page.getByText('0 / 3').waitFor()

  // Video list: typing with Enter between ids must work.
  const videos = page.getByLabel('要巡检的视频')
  await videos.click()
  await page.keyboard.type('BV1xx411c7mD')
  await page.keyboard.press('Enter')
  await page.keyboard.type('BV1yy411c7mE')
  assert.equal(await videos.inputValue(), 'BV1xx411c7mD\nBV1yy411c7mE')
  await page.getByRole('switch', { name: '开启自动回复' }).click()
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByText('已保存，下一次工具调用即生效。').waitFor()
  assert.deepEqual(host.updates.at(-1), { autoReply: { enabled: true, videos: ['BV1xx411c7mD', 'BV1yy411c7mE'] } })

  // Client-side validation blocks unsafe intervals before any request.
  await page.getByLabel('最小间隔（秒）').fill('5')
  await page.getByText('发送间隔不能低于 12 秒').waitFor()
  assert.equal(await page.getByRole('button', { name: '保存' }).isDisabled(), true)
  await page.getByRole('button', { name: '撤销' }).click()

  await page.screenshot({ path: new URL('../artifacts/settings-page-saved.png', import.meta.url).pathname, fullPage: true })
  await page.evaluate(() => { document.body.style.background = '#1f2023'; document.body.style.color = '#e8e8ea' })
  await page.screenshot({ path: new URL('../artifacts/settings-page-dark.png', import.meta.url).pathname, fullPage: true })
  assert.ok(apiCalls.includes('/api/bili-fish/state') && apiCalls.includes('/api/bili-fish/save'), JSON.stringify(apiCalls))
  assert.deepEqual(errors, [])
})
