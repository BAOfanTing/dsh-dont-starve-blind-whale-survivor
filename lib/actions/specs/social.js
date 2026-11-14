// 社交（1 个动作）
//
// 每个动作声明：riskLevel / category / description / 参数白名单 / 核对方式（verify）。
// 参数白名单是安全边界的一部分：args 里出现的其它键一律被拒（防模型夹带）。

export const socialSpecs = {
  /**
   * SURVIVAL-04：在游戏里说话（人类玩家看得到）。不改世界，核对不判死。
   */
  say: {
    riskLevel: 'R1',
    category: 'social',
    description: '在游戏聊天里说一句话',
    args: {
      text: { type: 'string', maxLength: 120, required: true },
    },
    verify() {
      return { ok: true }
    },
  },
}
