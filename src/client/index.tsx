// Browser half: registers the “大肥鱼 · B 站” page in the DSH settings panel.
// Loaded through package.json `dsh.client`; talks to the host through
// POST /api/bili-fish/{state,save} (src/panel/host.ts).

import { BiliFishSection } from './Section.js'
import type { ClientCtx } from './rpc.js'

export const inject = ['slots']

export function apply(ctx: ClientCtx): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'bili-fish',
    order: 300,
    label: '大肥鱼 · B 站',
    inject: () => ({ ctx }),
  }, BiliFishSection))
}
