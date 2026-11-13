// Phase 5 M6 · MCP 任务链工具（start_task / stop_task / get_task_status）
//
// 设计（任务书 §8 多步骤任务）：
//   · 任务名走固定白名单枚举，不接受任意脚本/表达式；
//   · start_task 需要控制权（写动作）；
//   · stop_task 需要控制权（会清理动作与按键状态）；
//   · get_task_status 只读，不需要控制权；
//   · 任务在游戏内异步推进（observer Tick 驱动），这里只负责启动与查询。

import { z } from 'zod'
import type { ToolDefinition, ToolResult, ToolContext } from './definitions.js'
import { ToolError } from '../schemas/errors.js'

/** 固定任务模板（与 Lua task_runner.lua 的 TASKS 表保持一致） */
const TASK_ENUM = z.enum(['survive_night', 'stock_logs', 'toolkit', 'forage'])

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

async function enqueueAndWait(
  ctx: ToolContext,
  type: string,
  params: Record<string, unknown>,
  waitMs = 8000,
): Promise<Record<string, unknown>> {
  const { controllerId, sessionId } = await requireControl(ctx)
  const response = await ctx.client.enqueueCommand(type, params, { shard: 'master', controllerId, sessionId })
  const command = (response.data as { command?: { id?: string; status?: string } } | null)?.command
  if (!command?.id) throw new ToolError('INTERNAL_ERROR', 'Bridge 没有返回 command_id', { detail: response.data })

  // 短轮询拿回执（任务启动/停止是同步返回的，不需要长等）
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const got = await ctx.client.getCommand(command.id)
    if (got.status === 200) {
      const c = (got.data as { command?: { status?: string; result?: unknown; error?: string } }).command
      if (c && c.status && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(c.status)) {
        return { status: c.status, result: c.result, error: c.error, action_id: command.id }
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  // 游戏端没回执：统一按 TOOL_TIMEOUT 报（和其他工具错误码族一致，便于上层判断）
  throw new ToolError('TOOL_TIMEOUT', `${type} 已下发但游戏端未回执（可能暂停中或未连接）`, {
    detail: { action_id: command.id },
    hint: '确认游戏在跑、世界未暂停（窗口最小化会暂停）',
  })
}

export function createTaskTools(): ToolDefinition[] {
  return [
    {
      name: 'start_task',
      title: '启动任务链',
      description:
        '启动一个**固定模板**的多步骤任务（不是任意脚本）。任务在游戏内异步推进，' +
        '每步都有前置条件检查（材料/工具/附近目标），失败会重试或跳过，必需步骤失败则整个任务中止。' +
        '可用任务：survive_night（过夜准备）/ stock_logs（攒木头）/ toolkit（备齐工具）/ forage（采集）。' +
        '需要控制权。用 get_task_status 查进度。',
      schema: z.object({
        task: TASK_ENUM.describe('任务名（固定模板）'),
      }),
      readOnly: false,
      milestone: 'Phase5-M6',
      handler: async (args, ctx) => {
        const r = await enqueueAndWait(ctx, 'start_task', { task: args.task })
        const ok = r.status === 'SUCCEEDED'
        return {
          content: [{
            type: 'text',
            text: `任务 ${args.task} 已启动。用 get_task_status 查进度。`,
          }],
          structuredContent: { ok: true, task: args.task, ...r },
        }
      },
    },
    {
      name: 'stop_task',
      title: '停止任务链',
      description:
        '中止当前正在跑的任务链，并清理动作状态（松开"按住动作键"、停止移动、清空缓冲动作）。' +
        '需要控制权。',
      schema: z.object({}),
      readOnly: false,
      milestone: 'Phase5-M6',
      handler: async (_args, ctx) => {
        // 不 catch：让 ToolError 原样上抛，保持统一错误码族
        const r = await enqueueAndWait(ctx, 'stop_task', {})
        return {
          content: [{ type: 'text', text: '任务已中止。' }],
          structuredContent: { ok: true, ...r },
        }
      },
    },
    {
      name: 'get_task_status',
      title: '查询任务链进度',
      description:
        '只读查询当前任务链进度：是否在跑、第几步/共几步、当前步在做什么、已完成/跳过步数、' +
        '上次错误、已耗时秒数，以及可用任务名单。',
      schema: z.object({}),
      readOnly: true,
      milestone: 'Phase5-M6',
      handler: async (_args, ctx) => {
        const response = await ctx.client.enqueueCommand('get_task_status', {}, { shard: 'master' })
        if (response.status !== 200) {
          throw new ToolError('BRIDGE_UNAVAILABLE', '读不到任务状态（Bridge 可能没在跑或未升级）', {
            detail: response.data,
          })
        }
        const command = (response.data as { command?: { id?: string } } | null)?.command
        if (!command?.id) {
          throw new ToolError('BRIDGE_UNAVAILABLE', 'Bridge 没有返回 command_id', { detail: response.data })
        }

        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          const got = await ctx.client.getCommand(command.id)
          if (got.status === 200) {
            const c = (got.data as { command?: { status?: string; result?: unknown; error?: string } }).command
            if (c && c.status && !['QUEUED', 'DELIVERED', 'EXECUTING'].includes(c.status)) {
              const result = (c.result ?? {}) as Record<string, unknown>
              const running = result.running === true
              const text = running
                ? `任务 ${String(result.task)} 进行中：第 ${String(result.step_index)}/${String(result.step_total)} 步（${String(result.current_why ?? '-')}），已完成 ${String(result.steps_done)} 步、跳过 ${String(result.steps_skipped)} 步`
                : '当前没有任务在跑'
              return {
                content: [{ type: 'text', text }],
                structuredContent: { ok: true, ...result },
              }
            }
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        // 游戏端没回执（暂停/未连上）：按 TOOL_TIMEOUT 报，和其他工具的错误码族保持一致
        throw new ToolError('TOOL_TIMEOUT', '查询任务状态超时：游戏端未回执（可能暂停中或未连接）', {
          hint: '确认游戏在跑、世界未暂停（窗口最小化会暂停）',
        })
      },
    },
  ]
}
