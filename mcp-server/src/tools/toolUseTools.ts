// Phase 5 M4 · MCP 工具使用工具（equip / chop / mine / pick up）
//
// 设计（任务书 §7.3 + §11 + §12）：
//   · 全部带 Zod Schema + 参数限制；
//   · 写动作先在程序层查控制权（不靠提示词）；
//   · **chop_tree / mine_rock 需人工确认**：必须显式传 confirmed=true，
//     否则直接拒绝（任务书 §11「初期建议人工确认」）。Lua 端也会再校验一次。
//   · 长时间动作返回 action_id，由 get_command_result 查进度，不阻塞 MCP 请求。

import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolContext } from './definitions.js'
import { ToolError } from '../schemas/errors.js'

const EQUIP_ENUM = z.enum(['axe', 'pickaxe', 'torch'])
const CHOP_TARGET_ENUM = z.enum(['evergreen', 'twiggytree', 'mushtree', 'tree'])
const MINE_TARGET_ENUM = z.enum(['rock', 'rock1', 'rock2', 'rock_flintless'])
const PICKUP_ENUM = z.enum(['flint', 'rocks', 'log', 'twigs', 'cutgrass', 'berries'])

/** 查控制权并给出 controller_id；未授权抛明确错误（与 M3 同一套判据） */
async function requireControl(ctx: ToolContext): Promise<{ controllerId: string; sessionId: string }> {
  const response = await ctx.client.controlStatus()
  if (response.status !== 200) {
    throw new ToolError('BRIDGE_UNAVAILABLE', '读不到控制权状态（Bridge 可能没在跑或未升级）')
  }
  const control = (response.data.control ?? {}) as Record<string, unknown>
  const mode = String(control.mode ?? 'UNKNOWN')
  const holder = control.holder === null || control.holder === undefined ? null : String(control.holder)
  const sessionId = typeof control.session_id === 'string' ? control.session_id : ''
  const emergency = control.emergency_stop === true || mode === 'EMERGENCY_STOP'
  const expiresAt = typeof control.lease_expires_at === 'number' ? control.lease_expires_at : null
  const leaseValid = expiresAt !== null && Date.now() < expiresAt

  if (emergency) throw new ToolError('SESSION_INVALID', '紧急停止中，所有动作被拒', { hint: '先清除紧急停止' })
  if (mode === 'MANUAL') throw new ToolError('SESSION_INVALID', '人工接管中，AI 不能执行动作')
  if (mode === 'PAUSED') throw new ToolError('SESSION_INVALID', 'AI 已暂停')
  if (holder === null) throw new ToolError('SESSION_INVALID', '没有控制器持有写权限', { hint: '先通过 Survival Controller 申请控制权' })
  if (!leaseValid) throw new ToolError('SESSION_INVALID', '控制权 lease 已过期', { hint: '重新申请或续约控制权' })
  return { controllerId: holder, sessionId }
}

async function enqueueAction(
  ctx: ToolContext,
  type: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const { controllerId, sessionId } = await requireControl(ctx)
  const response = await ctx.client.enqueueCommand(type, params, {
    shard: 'master',
    controllerId,
    sessionId,
  })
  const command = (response.data as { command?: { id?: string; status?: string } } | null)?.command
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
    note: '动作已入队；用 get_command_result 查询 EXECUTING / SUCCEEDED / FAILED。SUCCEEDED 时会带 verify（实际获得数量/装备核验）',
  }
  return {
    content: [{ type: 'text', text: `动作 ${type} 已入队，action_id=${command.id}（${payload.status}）。用 get_command_result 查询进度与 verify 结果。` }],
    structuredContent: payload,
  }
}

export function createToolUseTools(): ToolDefinition[] {
  return [
    {
      name: 'equip_item',
      title: '装备物品',
      description:
        '把背包里的工具拿到手上（斧头/镐/火把）。走游戏原生 inventory:Equip，不直接改装备槽。' +
        '需要控制权；完成后会核验手上实际装备的 prefab 是否与请求一致（verify.equipped）。',
      schema: z.object({
        item: EQUIP_ENUM.describe('要装备的物品：axe(斧头) / pickaxe(镐) / torch(火把)'),
      }),
      readOnly: false,
      milestone: 'Phase5-M4',
      handler: async (args, ctx) => enqueueAction(ctx, 'equip_item', { item: args.item }),
    },
    {
      name: 'chop_tree',
      title: '砍树',
      description:
        '砍附近的树。走游戏原生 ACTIONS.CHOP + BufferedAction，会自动装备背包里最好的斧头，' +
        '不直接改物品数量。**需要人工确认**：必须显式传 confirmed=true。' +
        '完成后会清点背包，把实际获得的 log/twigs 数量放进 verify.gained。',
      schema: z.object({
        count: z.number().int().min(1).max(5).default(1).describe('砍几棵，1~5'),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
        target: CHOP_TARGET_ENUM.optional().describe('可选：只砍指定种类（默认砍最近的可砍目标）'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M4',
      handler: async (args, ctx) => {
        if (args.confirmed !== true) {
          throw new ToolError('INVALID_ARGUMENT', 'chop_tree 需要人工确认：请让用户明确同意后再传 confirmed=true', {
            hint: '任务书 §11：砍伐初期建议人工确认。程序层强制，不是提示词约束。',
          })
        }
        return enqueueAction(ctx, 'chop_tree', {
          count: args.count, radius: args.radius,
          ...(args.target === undefined ? {} : { target: args.target }),
          confirmed: true,
        })
      },
    },
    {
      name: 'mine_rock',
      title: '采矿',
      description:
        '挖附近的矿石。走游戏原生 ACTIONS.MINE + BufferedAction，会自动装备背包里最好的镐，' +
        '不直接改物品数量。**需要人工确认**：必须显式传 confirmed=true。' +
        '完成后会清点背包，把实际获得的 rocks/flint/nitre/goldnugget 数量放进 verify.gained。',
      schema: z.object({
        count: z.number().int().min(1).max(5).default(1).describe('挖几处，1~5'),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
        target: MINE_TARGET_ENUM.optional().describe('可选：只挖指定种类（默认挖最近的可挖目标）'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M4',
      handler: async (args, ctx) => {
        if (args.confirmed !== true) {
          throw new ToolError('INVALID_ARGUMENT', 'mine_rock 需要人工确认：请让用户明确同意后再传 confirmed=true', {
            hint: '任务书 §11：采矿初期建议人工确认。程序层强制，不是提示词约束。',
          })
        }
        return enqueueAction(ctx, 'mine_rock', {
          count: args.count, radius: args.radius,
          ...(args.target === undefined ? {} : { target: args.target }),
          confirmed: true,
        })
      },
    },
    {
      name: 'pick_up_item',
      title: '拾取地面物品',
      description:
        '把地上的东西捡进背包（树枝/草/木头/燧石/石头/浆果）。走游戏原生 ACTIONS.PICKUP，' +
        '不直接改物品数量。需要控制权；完成后会清点背包，实际获得数量放进 verify.gained。',
      schema: z.object({
        item: PICKUP_ENUM.describe('要捡的东西：flint/rocks/log/twigs/cutgrass/berries'),
        count: z.number().int().min(1).max(10).default(1).describe('捡几个，1~10'),
        radius: z.number().int().min(2).max(20).default(12).describe('搜索半径（格）'),
      }),
      readOnly: false,
      milestone: 'Phase5-M4',
      handler: async (args, ctx) => enqueueAction(ctx, 'pick_up_item', {
        item: args.item, count: args.count, radius: args.radius,
      }),
    },
  ]
}
