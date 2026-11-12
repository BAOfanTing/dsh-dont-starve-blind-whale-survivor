// 工具定义（单一事实来源）
//
// 这一份数组同时给 stdio、Streamable HTTP 和未来的内置 Agent 用 —— 绝不各写一套。
//
// 分层：
//   definitions.ts  基础设施（ToolDefinition / ToolResult / 错误包装）+ 组合各工具集
//   readTools.ts    10 个只读工具的真实实现（M3）
//   bridgeStatus    通道状态工具（M1）
//
// 本阶段**全部只读**：不移动、不攻击、不采集、不制作、不建造、不丢弃、不执行任意代码。

import { z } from 'zod'
import type { McpServerConfig } from '../config.js'
import type { BridgeClient } from '../bridge/client.js'
import { ToolError, type ToolErrorPayload } from '../schemas/errors.js'
import type { Logger } from '../utils/logger.js'
import { createReadTools } from './readTools.js'
import { createControlTools } from './controlTools.js'
import type { EventDetector } from './events.js'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  isError?: boolean
}

export interface ToolContext {
  client: BridgeClient
  config: McpServerConfig
  logger: Logger
  /** 事件流：每次读快照都会喂给它，工具据此产出"发生了什么" */
  events: EventDetector
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  /** 参数 schema（同时用于 JSON Schema 生成与运行时校验） */
  schema: z.ZodObject<z.ZodRawShape>
  /** 本阶段只允许只读工具 */
  readOnly: true
  /** 该工具在哪个里程碑实现 */
  milestone: string
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

/** 统一的失败结果：AI 读文本，程序读 structuredContent.error */
export function errorResult(payload: ToolErrorPayload): ToolResult {
  const hint = payload.hint ? `\n建议：${payload.hint}` : ''
  return {
    isError: true,
    content: [{ type: 'text', text: `[${payload.code}] ${payload.message}${hint}` }],
    structuredContent: { ok: false, error: payload },
  }
}

/** 通道状态（M1 实现，M2 补充了快照/会话细节） */
function createBridgeStatusTool(): ToolDefinition {
  return {
    name: 'get_bridge_status',
    title: 'Bridge 通道状态',
    description:
      '查看 MCP Server 与 Game Bridge 的连接状态：Bridge 是否在跑、游戏是否连上、当前会话、心跳延迟、命令队列、快照新鲜度。不返回游戏内容本身。',
    schema: z.object({}),
    readOnly: true,
    milestone: 'M1',
    handler: async (_args, ctx) => {
      const health = await ctx.client.health()
      const status = await ctx.client.status()
      const bridge = status.data.bridge as Record<string, unknown> | undefined
      const sessions = Array.isArray(status.data.sessions) ? (status.data.sessions as Array<Record<string, unknown>>) : []
      const alive = sessions.filter((session) => session.alive === true)

      // 顺带看一眼快照新鲜度（拿不到也不影响状态查询）
      let snapshotFreshness: Record<string, unknown> | null = null
      try {
        const read = await ctx.client.readSnapshot()
        snapshotFreshness = {
          stale: read.stale,
          stale_reason: read.staleReason,
          age_ms: read.ageMs,
          snapshot_at: read.game.snapshot_at,
          from_cache: read.fromCache,
        }
      } catch (error) {
        snapshotFreshness = { error: error instanceof ToolError ? error.payload.code : 'INTERNAL_ERROR' }
      }

      const payload = {
        ok: true,
        source: 'bridge',
        fetched_at: new Date().toISOString(),
        bridge_url: ctx.client.url,
        bridge: {
          health: health.data,
          connected: bridge?.connected ?? false,
          connected_reason: bridge?.connected_reason ?? null,
          session_id: bridge?.session_id ?? null,
          shard: bridge?.shard ?? null,
          last_heartbeat_ago_ms: bridge?.last_heartbeat_ago_ms ?? null,
          last_sequence: bridge?.last_sequence ?? null,
          queued_commands: bridge?.queued_commands ?? null,
          active_commands: bridge?.active_commands ?? null,
          command_stats: bridge?.command_stats ?? null,
        },
        sessions: sessions.map((session) => ({
          session_id: session.session_id,
          shard: session.shard,
          alive: session.alive,
          heartbeats: session.heartbeats,
          telemetry_count: session.telemetry_count,
          acknowledged_sequence: session.acknowledged_sequence,
          duplicates: session.duplicates,
          gaps: session.gaps,
          last_payload_bytes: session.last_payload_bytes,
        })),
        session_count: sessions.length,
        alive_session_count: alive.length,
        snapshot: snapshotFreshness,
      }
      const text = [
        `Bridge 通道：${String(health.data.bound ?? ctx.client.url)}`,
        `游戏连接：${payload.bridge.connected ? '已连接' : '未连接'}（${String(payload.bridge.connected_reason ?? '-')}）`,
        `最近心跳：${payload.bridge.last_heartbeat_ago_ms === null ? '无' : `${String(payload.bridge.last_heartbeat_ago_ms)} ms 前`}`,
        `会话：${payload.session_count} 个（存活 ${payload.alive_session_count}）`,
        ...sessions
          .filter((session) => session.alive === true)
          .map((session) => `  · ${String(session.session_id)} [${String(session.shard ?? '?')}] 心跳=${String(session.heartbeats)} ack=${String(session.acknowledged_sequence)}`),
        `命令队列：排队 ${String(payload.bridge.queued_commands ?? 0)}，进行中 ${String(payload.bridge.active_commands ?? 0)}`,
        snapshotFreshness === null
          ? '快照：未知'
          : snapshotFreshness.stale === true
            ? `快照：已过期（${String(snapshotFreshness.stale_reason ?? '?')}，约 ${Math.round(Number(snapshotFreshness.age_ms ?? 0) / 1000)} 秒前）`
            : '快照：新鲜',
      ].join('\n')
      return { content: [{ type: 'text', text }], structuredContent: payload }
    },
  }
}

/** 全部工具（顺序即 tools/list 的顺序） */
export function createToolDefinitions(): ToolDefinition[] {
  // Phase 5 M2 追加 1 个只读控制权工具；其余 12 个只读工具保持不变
  const tools = [createBridgeStatusTool(), ...createReadTools(), ...createControlTools()]
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`工具重名：${tool.name}`)
    seen.add(tool.name)
  }
  return tools
}

/** 供 registry 统一包一层：ToolError → 结构化失败；其它异常 → INTERNAL_ERROR */
export async function runTool(def: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await def.handler(args, ctx)
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.payload)
    const message = String((error as Error)?.message ?? error)
    ctx.logger.error(`工具 ${def.name} 内部错误：${message}`)
    return errorResult({ code: 'INTERNAL_ERROR', message })
  }
}
