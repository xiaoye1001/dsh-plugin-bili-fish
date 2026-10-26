import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { RPC_CHANNEL, type Endpoint, type RpcResult } from '../panel/protocol.js'

/** The slice of the browser ClientContext this page uses. */
export interface ClientCtx {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  connection?: { rpc: ClientConnectionRpc }
}

export class BiliFishRpcError extends Error {
  readonly code: string
  readonly details: object
  constructor(error: { code: string; message: string; details?: object }) {
    super(error.message)
    this.name = 'BiliFishRpcError'
    this.code = error.code
    this.details = error.details ?? {}
  }
}

function rpcOf(ctx: ClientCtx): ClientConnectionRpc {
  const rpc = ctx.connection?.rpc
  if (!rpc) throw new BiliFishRpcError({ code: 'no-connection', message: '连接服务不可用（@deepseek-ai/dsh-client-connection 未加载）' })
  return rpc
}

export async function callRpc<T>(ctx: ClientCtx, endpoint: Endpoint, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const raw = await rpcOf(ctx).call(RPC_CHANNEL, endpoint, payload ?? null, signal)
  const result = raw as unknown as RpcResult<T>
  if (result.ok) return result.value
  throw new BiliFishRpcError(result.error)
}
