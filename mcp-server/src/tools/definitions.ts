// 工具定义（单一事实来源）
//
// 这一份数组同时给 stdio、Streamable HTTP 和未来的内置 Agent 用 —— 绝不各写一套。
//
// M1 只有 get_bridge_status 真正实现（用来证明 MCP → Bridge 链路是通的）；
// 其余工具把名字/描述/参数范围先定下来，调用时明确返回 NOT_IMPLEMENTED，
// 而不是编造数据。M3 再把它们逐个接上 Bridge 的真实数据。

import { z } from 'zod'
import type { McpServerConfig } from '../config.js'
import type { BridgeClient } from '../bridge/client.js'
import { notImplemented, ToolError, type ToolErrorPayload } from '../schemas/errors.js'
import type { Logger } from '../utils/logger.js'

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  isError?: boolean
}

export interface ToolContext {
  client: BridgeClient
  config: McpServerConfig
  logger: Logger
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  /** 参数 schema（同时用于 JSON Schema 生成与运行时校验） */
  schema: z.ZodObject<z.ZodRawShape>
  /** 本阶段只允许只读工具 */
  readOnly: true
  /** 该工具在哪个里程碑实现（M1 里除 bridge status 外都是 NOT_IMPLEMENTED） */
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

function todoTool(
  name: string,
  title: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
  milestone: string,
): ToolDefinition {
  return {
    name,
    title,
    description,
    schema,
    readOnly: true,
    milestone,
    handler: async () => {
      throw notImplemented(title, milestone)
    },
  }
}

const radiusSchema = z.number().int().min(2).max(20).default(16)
const limitSchema = z.number().int().min(1).max(50).default(20)

export function createToolDefinitions(): ToolDefinition[] {
  return [
    // ─────────────── 游戏状态 ───────────────
    {
      // M2 起：走完整 Bridge Client（快照缓存 + 过期标注），但只做"总览"这一层
      name: 'get_game_status',
      title: '游戏总状态',
      description:
        '一次拿到当前游戏状态总览：会话/分片、玩家、世界、背包摘要，以及这份数据有多新。数据过期时会明确标记 stale。',
      schema: z.object({
        include_raw: z.boolean().default(false).describe('是否附带原始快照 JSON（体积较大）'),
        shard: z.string().min(1).max(32).optional().describe('指定分片（master/caves），不填则自动选有玩家的那个'),
      }),
      readOnly: true,
      milestone: 'M2',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { include_raw?: boolean; shard?: string }
        const read = await ctx.client.readSnapshot({ shard: args.shard ?? null })
        const snapshot = (read.game.snapshot ?? {}) as Record<string, unknown>
        const player = snapshot.player as Record<string, unknown> | undefined
        const world = snapshot.world as Record<string, unknown> | undefined
        const inventory = snapshot.inventory as Record<string, unknown> | undefined
        const items = Array.isArray(inventory?.items) ? (inventory?.items as unknown[]) : []

        const payload = {
          ok: true,
          source: 'bridge',
          fetched_at: new Date().toISOString(),
          // 新鲜度：绝不让调用方把旧数据当当前状态
          freshness: {
            stale: read.stale,
            stale_reason: read.staleReason,
            age_ms: read.ageMs,
            snapshot_at: read.game.snapshot_at,
            stale_after_ms: read.game.stale_after_ms,
            from_cache: read.fromCache,
          },
          session: read.game.session,
          player: player ?? null,
          world: world ?? null,
          inventory: inventory === undefined
            ? null
            : { slots: inventory.slots ?? null, used: inventory.used ?? items.length, items },
          ...(args.include_raw ? { raw_snapshot: snapshot } : {}),
        }

        const lines = [
          read.stale
            ? `⚠️ 数据已过期（${read.staleReason ?? 'unknown'}，约 ${Math.round(read.ageMs / 1000)} 秒前）—— 以下是最后一次已知状态，不代表当前`
            : `数据新鲜（约 ${Math.max(0, Math.round(read.ageMs / 1000))} 秒前采集${read.fromCache ? '，来自缓存' : ''}）`,
          `会话：${read.game.session.session_id} [${read.game.session.shard ?? '?'}] alive=${read.game.session.alive}`,
          player
            ? `玩家：${String(player.name ?? player.prefab ?? '?')} 血 ${JSON.stringify(player.health ?? null)} 饥饿 ${JSON.stringify(player.hunger ?? null)} 位置 (${JSON.stringify((player.position as { tile_x?: number } | undefined)?.tile_x ?? '?')}, ${JSON.stringify((player.position as { tile_z?: number } | undefined)?.tile_z ?? '?')})`
            : '玩家：无',
          world ? `世界：第 ${String(world.day ?? '?')} 天 ${String(world.phase ?? '?')} ${String(world.season ?? '?')} 温度 ${String(world.temperature ?? '?')}` : '世界：无',
          inventory === undefined ? '背包：无' : `背包：${String(inventory.slots ?? '?')} 格，已用 ${String(inventory.used ?? items.length)}`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: payload }
      },
    },
    {
      name: 'get_bridge_status',
      title: 'Bridge 通道状态',
      description:
        '查看 MCP Server 与 Game Bridge 的连接状态：Bridge 是否在跑、游戏是否连上、当前会话、心跳延迟、命令队列。不返回游戏内容本身。',
      schema: z.object({}),
      readOnly: true,
      milestone: 'M1',
      handler: async (_args, ctx) => {
        const health = await ctx.client.health()
        const status = await ctx.client.status()
        const bridge = status.data.bridge as Record<string, unknown> | undefined
        const sessions = Array.isArray(status.data.sessions) ? (status.data.sessions as Array<Record<string, unknown>>) : []
        const alive = sessions.filter((s) => s.alive === true)
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
          sessions: sessions.map((s) => ({
            session_id: s.session_id,
            shard: s.shard,
            alive: s.alive,
            heartbeats: s.heartbeats,
            telemetry_count: s.telemetry_count,
            acknowledged_sequence: s.acknowledged_sequence,
            duplicates: s.duplicates,
            gaps: s.gaps,
            last_payload_bytes: s.last_payload_bytes,
          })),
          session_count: sessions.length,
          alive_session_count: alive.length,
        }
        const text = [
          `Bridge 通道：${health.data.bound ?? ctx.client.url}`,
          `游戏连接：${payload.bridge.connected ? '已连接' : '未连接'}（${payload.bridge.connected_reason ?? '-'}）`,
          `最近心跳：${payload.bridge.last_heartbeat_ago_ms === null ? '无' : `${payload.bridge.last_heartbeat_ago_ms} ms 前`}`,
          `会话：${payload.session_count} 个（存活 ${payload.alive_session_count}）`,
          ...sessions.map(
            (s) => `  · ${s.session_id} [${s.shard ?? '?'}] alive=${s.alive} 心跳=${s.heartbeats} ack=${s.acknowledged_sequence}`,
          ),
          `命令队列：排队 ${payload.bridge.queued_commands ?? 0}，进行中 ${payload.bridge.active_commands ?? 0}`,
        ].join('\n')
        return { content: [{ type: 'text', text }], structuredContent: payload }
      },
    },
    todoTool('get_player_status', '玩家状态', '当前玩家的血/饥饿/理智/体温/坐标（M3 实现）', z.object({}), 'M3'),
    todoTool(
      'get_inventory',
      '背包',
      '背包格子、物品数量与耐久（M3 实现）',
      z.object({ include_empty: z.boolean().default(false) }),
      'M3',
    ),
    todoTool('get_world_status', '世界状态', '天数/季节/昼夜/天气/温度（M3 实现）', z.object({}), 'M3'),

    // ─────────────── 环境感知 ───────────────
    todoTool(
      'get_nearby_entities',
      '附近实体',
      '按类别列出附近实体（M3 实现）',
      z.object({ radius_tiles: radiusSchema, limit: limitSchema }),
      'M3',
    ),
    todoTool(
      'get_nearby_resources',
      '附近资源',
      '附近可采集/可砍伐/可开采的资源（M3 实现）',
      z.object({ radius_tiles: radiusSchema, limit: limitSchema }),
      'M3',
    ),
    todoTool(
      'get_nearby_threats',
      '附近威胁',
      '附近敌对生物与危险（M3 实现）',
      z.object({ radius_tiles: radiusSchema, limit: limitSchema }),
      'M3',
    ),
    todoTool(
      'get_base_status',
      '基地概况',
      '基地范围内的建筑、容器、光源等（需要先定义"基地"判定规则，M3 或更后）',
      z.object({ radius_tiles: radiusSchema, limit: limitSchema }),
      'M3',
    ),

    // ─────────────── 诊断与管理 ───────────────
    todoTool('refresh_game_state', '刷新状态', '让游戏立刻重新采集一次状态（M3 实现）', z.object({}), 'M3'),
    todoTool(
      'get_recent_events',
      '最近事件',
      '最近发生的事件（需要事件流缓存，M4 之后）',
      z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      'M4',
    ),
    todoTool(
      'get_command_result',
      '命令结果',
      '查询某条命令的执行结果（M3 实现）',
      z.object({ command_id: z.string().min(1).max(128) }),
      'M3',
    ),
  ]
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
