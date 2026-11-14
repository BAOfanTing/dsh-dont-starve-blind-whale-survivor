// 查询（只读）（4 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

export const infoSpecs = {
  /**
   * SURVIVAL-06：查配方（只读）。核对不判死。
   */
  recipes: {
    riskLevel: 'R1',
    category: 'info',
    description: '查配方：能做哪些、还差什么材料',
    args: {
      filter: { type: 'string', pattern: '^[a-z_]{0,32}$', maxLength: 32 },
      limit: { type: 'number', min: 1, max: 60, integer: true },
    },
    verify() {
      return { ok: true }
    },
  },
  /**
   * SURVIVAL-06：查游戏数据（只读）。核对不判死。
   */
  lookup: {
    riskLevel: 'R1',
    category: 'info',
    description: '查某个东西是什么、怎么做、能干什么',
    args: {
      q: { type: 'string', maxLength: 64, required: true },
    },
    verify() {
      return { ok: true }
    },
  },
  /**
   * SURVIVAL-06：探测附近某个 prefab（只读）。核对不判死。
   */
  probe: {
    riskLevel: 'R1',
    category: 'info',
    description: '看附近有没有某种东西（不靠 get_state）',
    args: {
      prefab: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32, required: true },
      radius: { type: 'number', min: 4, max: 40 },
    },
    verify() {
      return { ok: true }
    },
  },
  /**
   * SURVIVAL-04：查看目标详情（只读）。
   */
  inspect: {
    riskLevel: 'R1',
    category: 'info',
    description: '查看一个目标的详细信息（血量/能不能采/燃料等）',
    requiresSnapshot: true,
    verifyWaitMs: 0,
    args: {
      target_ref: { type: 'string', pattern: '^#[1-9][0-9]{0,3}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    verify() {
      return { ok: true }
    },
  },
}
