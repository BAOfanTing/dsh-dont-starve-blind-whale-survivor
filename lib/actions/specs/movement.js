// 移动与探索（3 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

export const movementSpecs = {
  move_to: {
    riskLevel: 'R1',
    category: 'movement',
    description: '走到某个格子（服务端权威移动，走不到会如实报告）',
    // 真机（0.15.0）：位置变化要等状态文件下一帧（约 1 秒），
    // 只读一次快照会把"其实走到了"误判成 position_unchanged（unverified）。
    verifyWaitMs: 2500,
    args: {
      x: { type: 'number', integer: true, min: -2000, max: 2000, required: true },
      z: { type: 'number', integer: true, min: -2000, max: 2000, required: true },
      timeout: { type: 'number', min: 2, max: 120 },
    },
    /** 核对：位置必须真的变了（或者已经贴着目标 1 格内） */
    verify(before, after, args) {
      const a = before?.actor
      const b = after?.actor
      if (!a || !b || b.tileX === null || b.tileZ === null) return { ok: false, reason: 'no_position_after' }
      const moved = a.tileX !== b.tileX || a.tileZ !== b.tileZ
      const dist = (typeof args?.x === 'number' && typeof args?.z === 'number')
        ? Math.hypot(b.tileX - args.x, b.tileZ - args.z)
        : null
      const nearTarget = dist !== null && dist <= 1.5
      // 把当前位置和剩余距离一起带回去，避免模型不知道确切位置而紧跟着再调 get_state。
      const pos = { x: b.tileX, z: b.tileZ }
      if (moved || nearTarget) return { ok: true, pos, dist, from: { x: a.tileX, z: a.tileZ } }
      return { ok: false, reason: 'position_unchanged', pos, dist }
    },
  },
  stop: {
    riskLevel: 'R1',
    category: 'movement',
    description: '立刻停下手里的动作（走路/砍树/打架都停）',
    args: {},
    verify() {
      return { ok: true } // 停止没有可核对的“效果”，只要游戏确认即可
    },
  },
  /**
   * 走出去找某种东西。
   * 只走路 + 观察，**不采不捡**；找到就报坐标，让模型或上层技能决定下一步。
   * 因为不改世界，核对只看"位置真的变了"。
   */
  seek: {
    riskLevel: 'R2',
    category: 'movement',
    description: '从脚下往外一圈圈找某种东西，找到就报它在哪（不会自动去采）',
    verifyWaitMs: 2500,
    args: {
      prefab: { type: 'string', pattern: '^[a-z0-9_]{1,32}$', maxLength: 32, required: true },
      step: { type: 'number', min: 4, max: 30 },
      max_tiles: { type: 'number', min: 4, max: 80 },
      look: { type: 'number', min: 8, max: 40 },
    },
    verify(before, after) {
      const a = before?.actor
      const b = after?.actor
      if (!a || !b || b.tileX === null || b.tileZ === null) return { ok: false, reason: 'no_position_after' }
      const moved = a.tileX !== b.tileX || a.tileZ !== b.tileZ
      const pos = { x: b.tileX, z: b.tileZ }
      if (moved) return { ok: true, pos, from: { x: a.tileX, z: a.tileZ } }
      // 没动也可能"找到就在脚边"，这种情况 Lua 会直接 done；这里不判死
      return { ok: true, pos, how: 'no_move_needed' }
    },
  },
}
