# M2.0 · 动作安全矩阵

> 「Node 是否验证」= `lib/dispatcher.js` / `lib/control.js`；「Lua 是否验证」= `scripts/whale/guard.lua`。
> 原则：**Node 只是第一道闸，Lua 是最终授权者**——Node 放行不代表一定能执行。
> 每行都对应测试用例（见 `docs/M2_test_report.md`）。

| # | 风险场景 | Node 是否验证 | Lua 是否验证 | 预期结果 | 对应原因码 | 测试 |
|---|---|---|---|---|---|---|
| 1 | 动作不在白名单 | ✅ | ✅ | 拒绝，**不写命令** | `action_not_allowed` | dispatcher-1 / guard-4 |
| 2 | 参数含未知字段 | ✅ | ✅ | 拒绝 | `unknown_arg:<k>` | dispatcher-2 / guard-19 |
| 3 | 参数类型错 / NaN / Infinity | ✅ | ✅ | 拒绝 | `bad_type` / `nan` / `infinite` | dispatcher-2 / guard-21,22,25 |
| 4 | 参数越界 / 非整数 / 缺必填 | ✅ | ✅ | 拒绝 | `out_of_range` / `not_integer` / `missing_arg` | dispatcher-2 / guard-20,23,24 |
| 5 | 没有控制权（别人持有） | ✅ | ✅（世代） | 拒绝，不发命令 | `control_denied` / `not_owner` | dispatcher-3,10 / lease-3 |
| 6 | 租约过期 | ✅ | ✅ | 拒绝 | `lease_expired` | lease-6 / （Lua 同字段） |
| 7 | generation 过期 | ✅ | ✅ | 拒绝 | `stale_generation` | lease-8 / guard-8b / dispatcher-8 |
| 8 | 环境变化（runtime/session/shard/actor） | ✅ | ✅ | 拒绝并换代 | `env_changed` / `runtime_mismatch` / `session_mismatch` / `shard_mismatch` / `actor_mismatch` | lease-7 / guard-10..13 |
| 9 | 游戏重启后旧命令 | ✅（runtime 变→换代） | ✅ | 拒绝 | `runtime_mismatch` | guard-12 |
| 10 | 命令过期 | —（由 dispatcher 生成 TTL） | ✅ | 拒绝 | `command_expired` | guard-5 |
| 11 | 重复 command_id | —（UUID 唯一） | ✅ | 不重复执行 | `duplicate_command` | guard-9 |
| 12 | 协议版本不符 | —（只发 v1） | ✅ | 拒绝 | `bad_protocol` | guard-2 |
| 13 | 缺 command_id / 缺世代 / 缺过期时间 | —（总会写） | ✅ | 拒绝 | `missing_command_id` / `missing_generation` / `missing_expiry` | guard-3,6,7 |
| 14 | 快照过期（stale） | ✅ | —（不依赖） | 拒绝 | `game_not_ready` | dispatcher-4 |
| 15 | Actor 无效 | ✅ | ✅ | 拒绝 | `actor_invalid` | dispatcher-4 / guard-14 类似 |
| 16 | Actor 死亡 | ✅ | ✅ | 拒绝 | `actor_dead` | dispatcher-4 / guard-15 |
| 17 | Actor 是 ghost（灵魂） | ✅ | ✅（先于"是不是玩家"判） | 拒绝 | `actor_is_ghost` | dispatcher-4 / guard-14 |
| 18 | 观察兜底到非玩家实体 | ❌（Node 只看 `actor_type`，以 Lua 为准） | ✅ | 拒绝 | `actor_not_player` | guard-16 |
| 19 | 非权威环境（客户端/非 ismastersim） | ❌ | ✅ | 拒绝 | `not_authoritative` | guard-17 |
| 20 | 缺动作所需组件 | ❌（Node 不知道组件） | ✅ | 拒绝 | `missing_component:<名>` | guard-18 |
| 21 | 目标 `#N` 来自旧快照 | —（本轮动作不用 ref） | ✅ | 拒绝 | `stale_snapshot` | guard-26 |
| 22 | 目标 ref 不存在 | — | ✅ | 拒绝 | `unknown_ref` | guard-26 |
| 23 | 目标实体消失 / 进 limbo | — | ✅ | 拒绝 | `entity_gone` / `in_limbo` | guard-27 |
| 24 | 目标分类不匹配 / 太远 | — | ✅ | 拒绝 | `wrong_category` / `out_of_range` | guard-26 |
| 25 | 游戏说成功但实际没发生 | ✅（核对） | — | `unverified`，**不报成功** | `position_unchanged` | dispatcher-6 |
| 26 | 等不到结果 | ✅ | — | `unknown`，**不自动重试** | `result_timeout` | dispatcher-9 |
| 27 | Lua 侧拒绝（旧世代） | ✅（映射成 rejected） | ✅ | 一次即止，不重试 | `stale_generation` | dispatcher-8 |
| 28 | F8 与 MCP 同时请求 | ✅ | ✅ | 后到者 `control_denied` | `control_denied` | dispatcher-10 |
| 29 | 人工接管 / 紧急停止 | ✅（`force` / `invalidate`） | ✅（换代后旧命令失效） | 换手成功、旧命令全废 | `taken_over` | lease-4,9 |

---

## 备注

1. **Node 侧不判的项（18/19/20/21-24）不是遗漏**：组件、权威性、分类这些只有游戏进程知道；
   Node 侧硬判反而会与游戏状态不一致。它们由 Lua 兜底，且 Node 会把 Lua 的拒绝原样映射成 `rejected`。
2. **没有任何一条路径能在被拒时仍写出命令**：dispatcher 的所有拒绝分支都发生在 `bridge.call` 之前（单测用"命令计数为 0"钉住）。
3. **`unknown` 不重试**：dispatcher 只在一次调用里发一条命令；超时直接返回 `unknown` 并提示 `get_state`。
