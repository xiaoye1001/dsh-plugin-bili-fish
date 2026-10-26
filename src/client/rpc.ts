import { endpointPath, type Endpoint, type RpcResult } from '../panel/protocol.js'

/** The slice of the browser ClientContext this page uses. */
export interface ClientCtx {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
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

/**
 * Call one host endpoint. Same transport as DSH's own page: a same-origin POST
 * under `/api`, resolved against the document base and authenticated by the
 * browser session cookie the Connection service already set.
 */
export async function callRpc<T>(_ctx: ClientCtx, endpoint: Endpoint, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpointPath(endpoint).slice(1), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? null),
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? '（未登录或会话过期，请用启动时打印的带 token 的地址重新打开）'
      : response.status === 404
        ? '（插件主进程未注册接口，请看 dsh web 启动输出里的 [bili-fish] 行）'
        : ''
    throw new BiliFishRpcError({ code: `http-${response.status}`, message: `请求 ${endpointPath(endpoint)} 失败：HTTP ${response.status}${hint}` })
  }
  const result = await response.json() as RpcResult<T>
  if (result.ok) return result.value
  throw new BiliFishRpcError(result.error)
}
