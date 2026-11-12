// Phase 5 M2 · MCP 控制权工具（只读）
//
// 注意：这里**只查询** Bridge 持久化的控制权状态，不提供 acquire/release/stop 等写接口
// —— 控制权变更必须通过 Survival Controller（唯一权威写者），避免多写者破坏一致性。

import { z } from 'zod'
import type { ToolDefinition, ToolResult } from './definitions.js'
import { ToolError } from '../schemas/errors.js'
import type { ToolContext } from './definitions.js'

export function createControlTools(): ToolDefinition[] {
  return [
    {
      name: 'get_control_status',
      title: '控制权状态',
      description:
        '查询当前游戏控制权：控制模式（MANUAL/SUPERVISED/AUTONOMOUS/PAUSED/EMERGENCY_STOP）、持有者、会话、lease 是否过期、是否紧急停止。只读，不修改任何状态。执行游戏动作前应先查这个。',
      schema: z.object({}),
      readOnly: true,
      milestone: 'Phase5-M2',
      handler: async (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        const response = await ctx.client.controlStatus()
        if (response.status !== 200 || response.data === null) {
          throw new ToolError('BRIDGE_UNAVAILABLE', '读不到 Bridge 的控制权状态（Bridge 可能没在跑或未升级到 M2）')
        }
        const raw = response.data.control as Record<string, unknown> | undefined
        if (raw === undefined || typeof raw !== 'object') {
          throw new ToolError('INTERNAL_ERROR', 'Bridge 返回的控制权状态格式不对')
        }
        const mode = String(raw.mode ?? 'UNKNOWN')
        const holder = raw.holder === null || raw.holder === undefined ? null : String(raw.holder)
        const sessionId = raw.session_id === null || raw.session_id === undefined ? null : String(raw.session_id)
        const expiresAt = typeof raw.lease_expires_at === 'number' ? raw.lease_expires_at : null
        const remaining = expiresAt === null ? null : Math.max(0, expiresAt - Date.now())
        const emergency = raw.emergency_stop === true || mode === 'EMERGENCY_STOP'
        const leaseValid = expiresAt !== null && !emergency && remaining !== null && remaining > 0

        const payload = {
          ok: true,
          source: 'bridge',
          fetched_at: new Date().toISOString(),
          mode,
          holder,
          session_id: sessionId,
          lease_valid: leaseValid,
          lease_expires_at: expiresAt,
          lease_remaining_ms: remaining,
          emergency_stop: emergency,
          /** 给 Agent 的一句人话结论 */
          can_execute_actions: !emergency && mode !== 'MANUAL' && mode !== 'PAUSED' && holder !== null && leaseValid,
          history_count: Array.isArray(raw.history) ? raw.history.length : 0,
        }
        const lines = [
          `控制模式：${mode}`,
          `持有者：${holder ?? '（无）'}   会话：${sessionId ?? '（无）'}`,
          `Lease：${leaseValid ? `有效，剩余 ${String(remaining)} ms` : '无效或已过期'}`,
          `紧急停止：${emergency ? '是（一切动作被拒）' : '否'}`,
          `可执行游戏动作：${payload.can_execute_actions ? '是' : '否'}`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: payload }
      },
    },
  ]
}
