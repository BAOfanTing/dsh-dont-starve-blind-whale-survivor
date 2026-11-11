// Bridge Client（M1 精简版）
//
// 只做一件事：把 Game Bridge 的 HTTP 接口包成带超时、带错误分类的异步调用。
// M2 会在这里补上会话管理、命令下发、缓存与过期标记（STATE_STALE）；M1 先把链路跑通。
//
// 职责边界：**只有这一层能碰网络**，工具层不允许自己 fetch。

import type { McpServerConfig } from '../config.js'
import { ToolError } from '../schemas/errors.js'
import type { Logger } from '../utils/logger.js'

export interface BridgeResponse<T> {
  status: number
  data: T
  /** 这次请求花了多久（给工具输出用） */
  elapsedMs: number
}

export class BridgeClient {
  constructor(
    private readonly config: McpServerConfig,
    private readonly logger: Logger,
  ) {}

  get url(): string {
    return this.config.bridgeUrl
  }

  hasToken(): boolean {
    return this.config.token.length > 0
  }

  /** GET 一个 Bridge 接口，成功返回 JSON；失败按错误码分类抛 ToolError */
  async getJson<T>(path: string, options: { timeoutMs?: number; auth?: boolean } = {}): Promise<BridgeResponse<T>> {
    const auth = options.auth ?? true
    const timeoutMs = options.timeoutMs ?? this.config.toolTimeoutMs
    const url = new URL(this.config.bridgeUrl + path)
    if (auth) {
      if (!this.hasToken()) {
        throw new ToolError('BRIDGE_UNAVAILABLE', '没有可用的 Bridge token', {
          hint: '用 BWS_TOKEN 环境变量指定，或先跑 node tools/write-bws-config.mjs 生成 .runtime/token.txt',
        })
      }
      url.searchParams.set('token', this.config.token)
    }

    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      const elapsedMs = Date.now() - startedAt
      const text = await response.text()
      let data: unknown = null
      try {
        data = text.length > 0 ? JSON.parse(text) : null
      } catch {
        throw new ToolError('INTERNAL_ERROR', 'Bridge 返回的不是 JSON', { detail: text.slice(0, 200) })
      }
      if (response.status === 401 || response.status === 403) {
        throw new ToolError('SESSION_INVALID', 'Bridge 拒绝了 token', {
          hint: 'token 可能已轮换：重新生成并同步到游戏端 bws_config.lua',
          detail: { status: response.status },
        })
      }
      if (response.status === 503) {
        // Bridge 自己在说"我还没有游戏数据"
        throw new ToolError('GAME_DISCONNECTED', 'Bridge 没有可用的游戏数据', {
          hint: '游戏没开 / 没进世界 / 模组未启用',
          detail: data,
        })
      }
      if (!response.ok) {
        throw new ToolError('INTERNAL_ERROR', `Bridge 返回 HTTP ${response.status}`, { detail: data })
      }
      return { status: response.status, data: data as T, elapsedMs }
    } catch (error) {
      if (error instanceof ToolError) throw error
      const elapsedMs = Date.now() - startedAt
      if ((error as Error)?.name === 'AbortError') {
        throw new ToolError('TOOL_TIMEOUT', `请求 Bridge 超时（>${timeoutMs}ms）`, { detail: { path, elapsedMs } })
      }
      const code = (error as NodeJS.ErrnoException)?.code
      this.logger.warn('连不上 Bridge', { path, code: code ?? String(error) })
      throw new ToolError('BRIDGE_UNAVAILABLE', '连不上 Game Bridge', {
        hint: `确认 Bridge 在跑：${this.config.bridgeUrl}/health`,
        detail: { path, code: code ?? String((error as Error)?.message ?? error) },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Bridge 健康检查（不需要 token） */
  async health(): Promise<BridgeResponse<Record<string, unknown>>> {
    return this.getJson<Record<string, unknown>>('/health', { auth: false, timeoutMs: Math.min(2000, this.config.toolTimeoutMs) })
  }

  /** Bridge 运行状态（含会话、命令队列） */
  async status(): Promise<BridgeResponse<Record<string, unknown>>> {
    return this.getJson<Record<string, unknown>>('/api/v1/bridge/status')
  }
}
