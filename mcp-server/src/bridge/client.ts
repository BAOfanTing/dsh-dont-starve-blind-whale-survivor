// Bridge Client（M2 完整版）
//
// 这一层是 MCP Server 里**唯一**碰网络的地方，职责：
//   1. 请求：超时、错误分类（BRIDGE_UNAVAILABLE / SESSION_INVALID / TOOL_TIMEOUT / GAME_DISCONNECTED）
//   2. 快照：带 TTL 的缓存 + 明确的 staleness 判定（数据旧了必须让上层知道，不能当"当前状态"）
//   3. 命令：下发 + 轮询结果（M3 的工具会用到）
//   4. 并发：相同请求合并（避免 AI 一次问十个工具就打十次 Bridge）
//
// 错误语义（任务书要求）：
//   BRIDGE_UNAVAILABLE  Bridge 进程连不上
//   GAME_DISCONNECTED   Bridge 活着但没有可用游戏数据
//   STATE_STALE         有数据但过期（**不抛错**，随数据一起返回，由工具决定怎么描述）
//   SESSION_INVALID     token 被拒
//   TOOL_TIMEOUT        超时
//   INVALID_ARGUMENT    参数问题
//   NOT_IMPLEMENTED     功能未实现
//   INTERNAL_ERROR      其它

import type { McpServerConfig } from '../config.js'
import { ToolError } from '../schemas/errors.js'
import type { Logger } from '../utils/logger.js'

export interface BridgeResponse<T> {
  status: number
  data: T
  elapsedMs: number
}

/** Bridge /api/v1/state 的真实返回结构（与 game-bridge/src/routes.ts 对应） */
export interface GameSnapshot {
  session: {
    session_id: string
    shard: string | null
    game_version: string | null
    alive: boolean
    reconnects: number
    heartbeats: number
    acknowledged_sequence: number
    duplicates: number
    gaps: number
    player_status: Record<string, unknown> | null
  }
  snapshot: Record<string, unknown> | null
  snapshot_at: number | null
  snapshot_age_ms: number | null
  stale: boolean
  stale_reason: 'heartbeat_timeout' | 'no_snapshot' | 'snapshot_too_old' | null
  stale_after_ms: number
  other_sessions: number
  server_time: number
}

/** 带新鲜度信息的一次读取结果 */
export interface SnapshotRead {
  game: GameSnapshot
  /** 这次数据是从缓存来的还是刚拉的 */
  fromCache: boolean
  /** 本地视角下数据已经多久了（毫秒） */
  ageMs: number
  stale: boolean
  staleReason: string | null
}

export interface BridgeClientOptions {
  /** 快照缓存有效期；默认 1500ms（比游戏端 2 秒推送略短，保证"读到的不会太旧"） */
  cacheTtlMs?: number
  /** 命令结果轮询：单次请求超时 */
  commandTimeoutMs?: number
  now?: () => number
}

const DEFAULT_CACHE_TTL = 1500

export class BridgeClient {
  private cache: { at: number; value: SnapshotRead } | null = null
  private inFlight: Promise<SnapshotRead> | null = null
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly commandTimeoutMs: number

  constructor(
    private readonly config: McpServerConfig,
    private readonly logger: Logger,
    options: BridgeClientOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL
    this.commandTimeoutMs = options.commandTimeoutMs ?? config.toolTimeoutMs
  }

  get url(): string {
    return this.config.bridgeUrl
  }

  hasToken(): boolean {
    return this.config.token.length > 0
  }

  /** 清缓存（refresh 类工具用） */
  invalidate(): void {
    this.cache = null
  }

  // ───────────────────────── 底层请求 ─────────────────────────

  async getJson<T>(path: string, options: { timeoutMs?: number; auth?: boolean } = {}): Promise<BridgeResponse<T>> {
    return this.request<T>('GET', path, undefined, options)
  }

  async postJson<T>(path: string, body: unknown, options: { timeoutMs?: number } = {}): Promise<BridgeResponse<T>> {
    return this.request<T>('POST', path, body, options)
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: { timeoutMs?: number; auth?: boolean },
  ): Promise<BridgeResponse<T>> {
    const auth = options.auth ?? true
    const timeoutMs = options.timeoutMs ?? this.config.toolTimeoutMs
    const url = new URL(this.config.bridgeUrl + path)
    if (auth) {
      if (!this.hasToken()) {
        throw new ToolError('BRIDGE_UNAVAILABLE', '没有可用的 Bridge token', {
          hint: '用 BWS_TOKEN 指定，或先跑 node tools/write-bws-config.mjs 生成 .runtime/token.txt',
        })
      }
      url.searchParams.set('token', this.config.token)
    }

    const startedAt = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const elapsedMs = this.now() - startedAt
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
        const reason = (data as { error?: { message?: string } } | null)?.error?.message
        throw new ToolError('GAME_DISCONNECTED', reason ?? 'Bridge 没有可用的游戏数据', {
          hint: '游戏没开 / 没进世界 / 模组未启用 / 游戏被暂停',
          detail: data,
        })
      }
      if (response.status === 429) {
        throw new ToolError('BRIDGE_UNAVAILABLE', 'Bridge 队列已满', { detail: data })
      }
      if (!response.ok) {
        throw new ToolError('INTERNAL_ERROR', `Bridge 返回 HTTP ${response.status}`, { detail: data })
      }
      return { status: response.status, data: data as T, elapsedMs }
    } catch (error) {
      if (error instanceof ToolError) throw error
      const elapsedMs = this.now() - startedAt
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

  // ───────────────────────── 健康 / 状态 ─────────────────────────

  async health(): Promise<BridgeResponse<Record<string, unknown>>> {
    return this.getJson<Record<string, unknown>>('/health', {
      auth: false,
      timeoutMs: Math.min(2000, this.config.toolTimeoutMs),
    })
  }

  async status(): Promise<BridgeResponse<Record<string, unknown>>> {
    return this.getJson<Record<string, unknown>>('/api/v1/bridge/status')
  }

  /** Phase 5 M2：读 Bridge 持久化的控制权状态（只读） */
  async controlStatus(): Promise<BridgeResponse<Record<string, unknown>>> {
    try {
      return await this.getJson<Record<string, unknown>>('/api/v1/control/status')
    } catch (error) {
      // 旧版 Bridge（M1 时代）没有这个接口会返回 404 → request() 报 INTERNAL_ERROR。
      // 这里转成明确的 BRIDGE_UNAVAILABLE，让调用方知道该升级 Bridge，而不是"内部错误"。
      if (error instanceof ToolError && error.payload.code === 'INTERNAL_ERROR') {
        throw new ToolError('BRIDGE_UNAVAILABLE', 'Bridge 不支持控制权接口（需升级到 Phase 5 M2）', {
          hint: '重启 Game Bridge，或确认 /api/v1/control/status 可访问',
          detail: error.payload.detail,
        })
      }
      throw error
    }
  }

  // ───────────────────────── 快照（带缓存 + 并发合并）─────────────────────────

  /**
   * 读一份游戏状态快照。
   * - 缓存有效期内直接返回缓存（fromCache: true）
   * - 同时有多个调用时只打一次 Bridge（inFlight 合并）
   * - **过期不抛错**：把 stale/staleReason 一起返回，让工具层如实描述
   */
  async readSnapshot(options: { force?: boolean; shard?: string | null } = {}): Promise<SnapshotRead> {
    const at = this.now()
    if (!options.force && options.shard == null && this.cache !== null && at - this.cache.at <= this.cacheTtlMs) {
      const cached = this.cache.value
      const ageMs = this.now() - (cached.game.snapshot_at ?? cached.game.server_time)
      return { ...cached, fromCache: true, ageMs, stale: cached.stale || ageMs > cached.game.stale_after_ms }
    }
    if (this.inFlight !== null && options.shard == null) {
      const shared = await this.inFlight
      const ageMs = this.now() - (shared.game.snapshot_at ?? shared.game.server_time)
      return { ...shared, fromCache: true, ageMs, stale: shared.stale || ageMs > shared.game.stale_after_ms }
    }

    const path = options.shard ? `/api/v1/state?shard=${encodeURIComponent(options.shard)}` : '/api/v1/state'
    const promise = (async (): Promise<SnapshotRead> => {
      const response = await this.getJson<GameSnapshot>(path)
      const game = response.data
      const ageMs = game.snapshot_at === null ? Number.POSITIVE_INFINITY : this.now() - game.snapshot_at
      const stale = game.stale === true || ageMs > game.stale_after_ms
      const read: SnapshotRead = {
        game,
        fromCache: false,
        ageMs: Number.isFinite(ageMs) ? ageMs : -1,
        stale,
        staleReason: stale ? (game.stale_reason ?? 'snapshot_too_old') : null,
      }
      if (options.shard == null) {
        this.cache = { at: this.now(), value: read }
      }
      return read
    })()

    if (options.shard == null) {
      this.inFlight = promise
      // 注意：这里不能用 `void promise.finally(...)` —— finally 会派生一个新 promise，
      // 原始 promise 拒绝时那个派生 promise 没人接，会变成 unhandled rejection。
      // 用 then(ok, err) 两条路径都清掉 inFlight，既不吞错也不产生游离拒绝。
      promise.then(
        () => {
          this.inFlight = null
        },
        () => {
          this.inFlight = null
        },
      )
    }
    return promise
  }

  /** 严格读：数据过期就抛 STATE_STALE（给"必须是当前状态"的工具用） */
  async readFreshSnapshot(options: { shard?: string | null } = {}): Promise<SnapshotRead> {
    const read = await this.readSnapshot({ force: true, shard: options.shard })
    if (read.stale) {
      throw new ToolError('STATE_STALE', `游戏状态已过期（${read.staleReason ?? 'unknown'}）`, {
        hint: '游戏可能被暂停或未连接；可以先调用 refresh_game_state 再试',
        detail: {
          snapshot_age_ms: read.ageMs,
          stale_after_ms: read.game.stale_after_ms,
          session_alive: read.game.session.alive,
        },
      })
    }
    return read
  }

  // ───────────────────────── 命令（M4 才开放工具，这里先封装）─────────────────────────

  async enqueueCommand(type: string, params: Record<string, unknown> = {}, shard: string | null = null) {
    return this.postJson<{ command: { id: string; type: string; status: string } }>(
      '/api/v1/commands/enqueue',
      { type, params, ...(shard === null ? {} : { shard }) },
    )
  }

  async getCommand(commandId: string) {
    const response = await this.getJson<{ commands: Array<Record<string, unknown>> }>('/api/v1/commands')
    const found = response.data.commands.find((command) => command.id === commandId)
    if (!found) {
      throw new ToolError('INVALID_ARGUMENT', `没有这条命令：${commandId}`, { hint: '用 /api/v1/commands 查看最近命令' })
    }
    return found
  }

  /**
   * 下发并等结果（给 M3 的 refresh_game_state 之类用）。
   * 注意：本阶段只允许四个测试命令，真实动作类命令不存在。
   */
  async runCommand(
    type: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs
    const pollMs = options.pollMs ?? 250
    const enqueued = await this.enqueueCommand(type, params)
    const commandId = enqueued.data.command.id
    const deadline = this.now() + timeoutMs
    while (this.now() < deadline) {
      const command = await this.getCommand(commandId)
      const status = String(command.status)
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELLED') {
        return command
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new ToolError('TOOL_TIMEOUT', `命令 ${type} 在 ${timeoutMs}ms 内没有执行完`, {
      hint: '游戏可能被暂停；可以先用 get_bridge_status 看连接状态',
      detail: { command_id: commandId },
    })
  }
}
