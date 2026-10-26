// Opening the plugin's own DSH sessions (auto-reply patrol, exploration).
//
// A session is resolved through `ctx.sessionController` (created on first
// use), its tools are restricted to an explicit allow-list, and only then is
// it handed back. Restriction failures fail closed: the caller gets an error
// string and must not wake the session.

import type { Context } from '@deepseek-ai/cordis'
import type { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Wake-ups from dsh-plugin-bili-fish (auto-reply patrol, exploration). */
    'bili-fish': { kind: 'bili-fish' }
  }
}

/**
 * The slices of `ctx.sessionController` (@deepseek-ai/dsh-api-session-controller)
 * and of an Agent (@deepseek-ai/dsh-agent) used here, as declared in their
 * 0.2.1-rc.2 type definitions.
 */
export interface DoorAgent {
  readonly status: 'idle' | 'running'
  readonly ctx: Context
  followup(message: ReturnType<typeof createUserMessage>): void
}
export interface DoorSessionController {
  resolveAgent(sessionId: string): Promise<{ agent: DoorAgent } | { error: unknown }>
  create(request: { sessionId?: string }): Promise<{ sessionId: string }>
}

export class SessionDoor {
  private controller: DoorSessionController | undefined
  private readonly restricted = new WeakMap<DoorAgent, string>()

  constructor(private readonly ctx: Context) {}

  /** Track the optional session controller for the plugin's lifetime. Call once. */
  install(): void {
    this.ctx.inject(['sessionController'], (sub) => {
      sub.effect(() => {
        this.controller = (sub as unknown as { sessionController: DoorSessionController }).sessionController
        console.info('[bili-fish] 会话服务已就绪（自动回复 / 自己逛）')
        return () => { this.controller = undefined }
      }, 'bili-fish: session controller')
    })
  }

  get available(): boolean {
    return this.controller !== undefined
  }

  /**
   * Resolve (or create) a session and restrict it to `allow`.
   * @returns the agent, or a human-readable reason it cannot be woken.
   */
  async open(sessionId: string, allow: readonly string[]): Promise<DoorAgent | string> {
    const controller = this.controller
    if (!controller) return '会话服务不可用（sessionController 未加载）'
    let resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) {
      try {
        await controller.create({ sessionId })
      } catch (error) {
        return `无法创建会话 ${sessionId}：${error instanceof Error ? error.message : String(error)}`
      }
      resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) return `无法打开会话 ${sessionId}`
    }
    const agent = resolved.agent
    const key = [...allow].sort().join(',')
    if (this.restricted.get(agent) === key) return agent
    try {
      const dispose = agent.ctx.tools.restrict({ allow: [...allow] })
      this.restricted.set(agent, key)
      // Lift it with this plugin, so a reload re-applies a fresh one.
      this.ctx.effect(() => () => { dispose() }, `bili-fish: ${sessionId} tool restriction`)
    } catch (error) {
      return `无法限制会话 ${sessionId} 的工具，已停止唤醒：${error instanceof Error ? error.message : String(error)}`
    }
    return agent
  }
}
