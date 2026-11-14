// 战斗（2 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

import { findSameEntity, itemOfRef } from '../state-query.js'

export const combatSpecs = {
  /**
   * SURVIVAL-03：攻击（attack = 打几下；kill = 打到死）。
   * 核对：目标消失 / 血量下降都算成功。
   */
  attack: {
    riskLevel: 'R2',
    category: 'combat',
    description: '打一个东西几下（需要武器或空手）',
    requiresSnapshot: true,
    verifyWaitMs: 3000,
    args: {
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
      times: { type: 'number', min: 1, max: 50, integer: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, how: 'target_gone' }
      const hpBefore = item.health
      const hpAfter = same.health
      if (typeof hpBefore === 'number' && typeof hpAfter === 'number' && hpAfter < hpBefore) {
        return { ok: true, hpFrom: hpBefore, hpTo: hpAfter }
      }
      return { ok: false, reason: 'target_hp_unchanged' }
    },
  },
  kill: {
    riskLevel: 'R2',
    category: 'combat',
    description: '一直打到目标死（血低于 25% 会自动放弃）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, how: 'target_gone' }
      const hpBefore = item.health
      const hpAfter = same.health
      if (typeof hpBefore === 'number' && typeof hpAfter === 'number' && hpAfter < hpBefore) {
        return { ok: true, hpFrom: hpBefore, hpTo: hpAfter }
      }
      return { ok: false, reason: 'target_hp_unchanged' }
    },
  },
}
