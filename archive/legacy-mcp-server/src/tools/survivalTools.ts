// Phase 5 M5 · MCP 生存工具（eat / craft / build structure / build campfire）
//
// 设计（任务书 §7.4 + §11 + §12）：
//   · 全部带 Zod Schema + 参数限制，配方/食物走固定白名单；
//   · 写动作先在程序层查控制权；
//   · **eat / craft / build 需人工确认**（任务书 §11「初期建议人工确认」），
//     必须显式传 confirmed=true，Lua 端也会再校验一次；
//   · 完成后 verify 带真实核验：进食看饥饿差、制作看背包成品、营火看 fire 标签。

import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolContext } from './definitions.js'
import { ToolError } from '../schemas/errors.js'

const CRAFT_ENUM = z.enum(['axe', 'pickaxe', 'torch', 'campfire'])
const EAT_ENUM = z.enum(['berries', 'carrot', 'corn', 'mushroom', 'meat', 'cookedmeat', 'seeds'])

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

async function enqueueAction(ctx: ToolContext, type: string, params: Record<string, unknown>): Promise<ToolResult> {
  const { controllerId, sessionId } = await requireControl(ctx)
  const response = await ctx.client.enqueueCommand(type, params, { shard: 'master', controllerId, sessionId })
  const command = (response.data as { command?: { id?: string; status?: string } } | null)?.command
  if (!command?.id) throw new ToolError('INTERNAL_ERROR', 'Bridge 没有返回 command_id', { detail: response.data })
  const payload = {
    ok: true,
    action_id: command.id,
    command_id: command.id,
    action_type: type,
    status: command.status ?? 'QUEUED',
    controller_id: controllerId,
    params,
    note: '已入队；用 get_command_result 查 EXECUTING / SUCCEEDED / FAILED。SUCCEEDED 时带 verify（饥饿差/成品/营火核验）',
  }
  return {
    content: [{ type: 'text', text: `动作 ${type} 已入队，action_id=${command.id}（${payload.status}）。用 get_command_result 查进度与 verify。` }],
    structuredContent: payload,
  }
}

function requireConfirmed(args: { confirmed?: boolean }, name: string): void {
  if (args.confirmed !== true) {
    throw new ToolError('INVALID_ARGUMENT', `${name} 需要人工确认：请让用户明确同意后再传 confirmed=true`, {
      hint: '任务书 §11：进食/制作/建造初期建议人工确认。程序层强制，不是提示词约束。',
    })
  }
}

export function createSurvivalTools(): ToolDefinition[] {
  return [
    {
      name: 'eat_item',
      title: '进食',
      description:
        '吃东西恢复饥饿。走游戏原生 ACTIONS.EAT，不直接改数值。不传 item 时让游戏自动挑背包里最合适的食物。' +
        '**需要人工确认**：必须显式传 confirmed=true。完成后 verify 带饥饿值前后差（hunger_delta），核验真的吃到了。',
      schema: z.object({
        item: EAT_ENUM.optional().describe('可选：指定吃什么（不传=自动挑最好的）'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M5',
      handler: async (args, ctx) => {
        requireConfirmed(args, 'eat_item')
        return enqueueAction(ctx, 'eat_item', {
          ...(args.item === undefined ? {} : { item: args.item }),
          confirmed: true,
        })
      },
    },
    {
      name: 'craft_item',
      title: '制作物品',
      description:
        '制作斧头/镐/火把/营火。走游戏原生 builder:MakeRecipe（服务端有效路径），' +
        '会先检查科技等级与材料是否够，不直接改物品数量。' +
        '**需要人工确认**：必须显式传 confirmed=true。完成后 verify 清点背包成品数量。',
      schema: z.object({
        recipe: CRAFT_ENUM.describe('要做的配方：axe / pickaxe / torch / campfire'),
        count: z.number().int().min(1).max(3).default(1).describe('做几个，1~3'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M5',
      handler: async (args, ctx) => {
        requireConfirmed(args, 'craft_item')
        return enqueueAction(ctx, 'craft_item', {
          recipe: args.recipe, count: args.count, confirmed: true,
        })
      },
    },
    {
      name: 'build_campfire',
      title: '建造营火',
      description:
        '放一个营火并生火。走游戏原生建造流程（MakeRecipeAtPoint），会自动找一块放得下的空地、走过去、摆放。' +
        '**需要人工确认**：必须显式传 confirmed=true。完成后 verify 检查附近是否真的出现 fire 实体。',
      schema: z.object({
        x: z.number().int().min(-10000).max(10000).optional().describe('可选：指定格子 x（不传=自动找空地）'),
        z: z.number().int().min(-10000).max(10000).optional().describe('可选：指定格子 z'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M5',
      handler: async (args, ctx) => {
        requireConfirmed(args, 'build_campfire')
        return enqueueAction(ctx, 'build_campfire', {
          recipe: 'campfire',
          ...(args.x === undefined ? {} : { x: args.x }),
          ...(args.z === undefined ? {} : { z: args.z }),
          confirmed: true,
        })
      },
    },
    {
      name: 'build_structure',
      title: '建造建筑',
      description:
        '建造要摆到地上的建筑。当前白名单只有 campfire（其他建筑等后续里程碑）。' +
        '**需要人工确认**：必须显式传 confirmed=true。',
      schema: z.object({
        recipe: z.enum(['campfire']).describe('要建造的东西（当前只支持 campfire）'),
        x: z.number().int().min(-10000).max(10000).optional().describe('可选：指定格子 x'),
        z: z.number().int().min(-10000).max(10000).optional().describe('可选：指定格子 z'),
        confirmed: z.boolean().default(false).describe('人工确认。必须为 true 才会执行'),
      }),
      readOnly: false,
      milestone: 'Phase5-M5',
      handler: async (args, ctx) => {
        requireConfirmed(args, 'build_structure')
        return enqueueAction(ctx, 'build_structure', {
          recipe: args.recipe,
          ...(args.x === undefined ? {} : { x: args.x }),
          ...(args.z === undefined ? {} : { z: args.z }),
          confirmed: true,
        })
      },
    },
  ]
}
