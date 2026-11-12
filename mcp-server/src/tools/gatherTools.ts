// Phase 5 M3 · MCP 采集动作工具
//
// 设计（任务书 §12）：
//   · 所有工具有 Zod Schema + 参数限制；
//   · 写动作工具**先在程序层查控制权**（不靠提示词），未授权直接拒绝；
//   · 长时间动作返回 command_id（action_id），由 get_command_result 查进度，不阻塞 MCP 请求；
//   · controller_id 取 Bridge 当前 holder —— 外部 MCP 客户端与内置 Agent 共享同一份控制权。
//
// 注意：MCP 工具本身不直接改游戏，只往 Bridge 命令队列投递；
// 真正执行在 Lua 端，且 Lua 端还会再做一次控制权二次校验。

import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolContext } from './definitions.js'
import { ToolError } from '../schemas/errors.js'

/** 资源白名单（与 Lua 侧 GATHER_TARGETS 保持一致，不重复定义事实） */
const RESOURCE_ENUM = z.enum(['twigs', 'grass', 'berries'])

/** 查控制权并给出 controller_id；未授权时抛明确错误 */
async function requireControl(ctx: ToolContext): Promise<string> {
  const response = await ctx.client.controlStatus()
  if (response.status !== 200) {
    throw new ToolError('BRIDGE_UNAVAILABLE', '读不到控制权状态（Bridge 可能没在跑或未升级到 M2）')
  }
  const control = (response.data.control ?? {}) as Record<string, unknown>
  const mode = String(control.mode ?? 'UNKNOWN')
  const holder = control.holder === null || control.holder === undefined ? null : String(control.holder)
  const emergency = control.emergency_stop === true || mode === 'EMERGENCY_STOP'
  const expiresAt = typeof control.lease_expires_at === 'number' ? control.lease_expires_at : null
  const leaseValid = expiresAt !== null && Date.now() < expiresAt

  if (emergency) throw new ToolError('SESSION_INVALID', '紧急停止中，所有动作被拒', { hint: '先清除紧急停止' })
  if (mode === 'MANUAL') throw new ToolError('SESSION_INVALID', '人工接管中，AI 不能执行动作')
  if (mode === 'PAUSED') throw new ToolError('SESSION_INVALID', 'AI 已暂停')
  if (holder === null) throw new ToolError('SESSION_INVALID', '没有控制器持有写权限', { hint: '先通过 Survival Controller 申请控制权' })
  if (!leaseValid) throw new ToolError('SESSION_INVALID', '控制权 lease 已过期', { hint: '重新申请或续约控制权' })
  return holder
}

/** 下发动作命令并返回 command_id（不等待完成） */
async function enqueueAction(
  ctx: ToolContext,
  type: string,
  params: Record<string, unknown>,
  controllerId: string,
): Promise<ToolResult> {
  // session_id 用 Bridge 控制权记录里的值，避免与 Lua 端二次校验不一致
  const control = (await ctx.client.controlStatus()).data.control as Record<string, unknown> | undefined
  const sessionId = typeof control?.session_id === 'string' ? control.session_id : ''
  const response = await ctx.client.enqueueCommand(type, params, {
    shard: 'master',
    controllerId,
    sessionId,
  })
  const command = (response.data as { command?: { id?: string; type?: string; status?: string } } | null)?.command
  if (!command?.id) {
    throw new ToolError('INTERNAL_ERROR', 'Bridge 没有返回 command_id', { detail: response.data })
  }
  const payload = {
    ok: true,
    action_id: command.id,
    command_id: command.id,
    action_type: type,
    status: command.status ?? 'QUEUED',
    controller_id: controllerId,
    params,
    note: '动作已入队；用 get_command_result 查询 EXECUTING / SUCCEEDED / FAILED',
  }
  return {
    content: [{ type: 'text', text: `动作 ${type} 已入队，action_id=${command.id}（${payload.status}）。用 get_command_result 查询进度。` }],
    structuredContent: payload,
  }
}

export function createGatherTools(): ToolDefinition[] {
  return [
    {
      name: 'gather_resource',
      title: '采集基础资源',
      description:
        '采集树枝/草/浆果。走游戏原生采摘动作（ACTIONS.PICK / HARVEST），不直接改物品数量。' +
        '需要控制权；长时间动作返回 action_id，用 get_command_result 查进度。初期只支持 twigs/grass/berries，' +
        'flint/logs/rocks 与需要工具的资源不在此阶段。',
      schema: z.object({
        resource: RESOURCE_ENUM.describe('要采集的资源：twigs(树枝) / grass(草) / berries(浆果)'),
        count: z.number().int().min(1).max(10).default(1).describe('采集次数，1~10'),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格），2~20'),
      }),
      readOnly: false,
      milestone: 'Phase5-M3',
      handler: async (args, ctx) => {
        const controllerId = await requireControl(ctx)
        return enqueueAction(ctx, 'gather_resource', {
          resource: args.resource,
          count: args.count,
          radius: args.radius,
        }, controllerId)
      },
    },
    {
      name: 'move_to_target',
      title: '移动到资源目标',
      description:
        '走向附近指定的可采资源（复用游戏原生 go_to 动作）。需要控制权；' +
        '目标只接受 twigs/grass/berries 白名单，不接受任意 prefab 名。返回 action_id。',
      schema: z.object({
        resource: RESOURCE_ENUM.describe('目标资源：twigs / grass / berries'),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
      }),
      readOnly: false,
      milestone: 'Phase5-M3',
      handler: async (args, ctx) => {
        const controllerId = await requireControl(ctx)
        return enqueueAction(ctx, 'move_to_target', { resource: args.resource, radius: args.radius }, controllerId)
      },
    },
    {
      name: 'probe_game_actions',
      title: '探测游戏原生动作',
      description:
        '只读：报告当前游戏构建里 ACTIONS 是否存在、已登记的 JOBS、M3 资源白名单，' +
        '以及 ACTIONS.PICKUP 是否可用（决定后续能否实现拾取地面物品）。不下发任何动作。',
      schema: z.object({}),
      readOnly: true,
      milestone: 'Phase5-M3',
      handler: async (_args, ctx) => {
        let response
        try {
          response = await ctx.client.enqueueCommand('probe_game_actions', {}, { shard: 'master' })
        } catch (error) {
          // Bridge 没跑 / token 失效 / 旧版 Bridge 不认识这个命令 → 明确降级，不假装成功
          const message = String((error as Error)?.message ?? error)
          throw new ToolError('BRIDGE_UNAVAILABLE', `游戏动作探测下发失败：${message}`, {
            hint: '确认 Game Bridge 已升级到 Phase 5 M3 且在 18788 运行',
          })
        }
        const command = (response.data as { command?: { id?: string } } | null)?.command
        if (!command?.id) {
          throw new ToolError('BRIDGE_UNAVAILABLE', 'Bridge 没有返回 command_id（可能是旧版 Bridge 不支持 probe_game_actions）', {
            hint: '重启 Game Bridge 到 M3 新版',
          })
        }
        // 等一小段时间取回执（探测是即时的，不需要长等待）
        let result: Record<string, unknown> | null = null
        for (let i = 0; i < 12; i += 1) {
          await new Promise((r) => setTimeout(r, 500))
          try {
            const rec = await ctx.client.getCommand(command.id)
            if (rec && rec.status !== 'QUEUED' && rec.status !== 'DELIVERED') {
              result = rec as Record<string, unknown>
              break
            }
          } catch { /* 还没回执 */ }
        }
        if (result === null) {
          return {
            content: [{ type: 'text', text: `探测命令 ${command.id} 已下发，但还没收到回执（游戏可能暂停）。` }],
            structuredContent: { ok: true, action_id: command.id, pending: true },
          }
        }
        const payload = {
          ok: true,
          action_id: command.id,
          status: result.status,
          probe: result.result ?? null,
          error: result.error ?? null,
        }
        return {
          content: [{ type: 'text', text: `游戏动作探测（${String(result.status)}）：\n${JSON.stringify(result.result ?? result.error, null, 2)}` }],
          structuredContent: payload,
        }
      },
    },
  ]
}
