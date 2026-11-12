# M2.0 · 动作执行架构与安全控制

> 版本：0.13.4 → **0.14.0**
> 目标：把 F8 / MCP / 人工测试统一到**一条**安全执行链路；宁可拒绝，也不对错误的角色/实体执行。

---

## 1. 一条链路（全部落地）

```
DeepSeek（Function Calling）
   └─ lib/tools.js executeTool()                     ← 唯一工具层（既有）
        └─ lib/dispatcher.js ActionDispatcher        ← ★新增：唯一动作分发（校验→租约→下发→等结果→核对）
             ├─ validateArgs(spec, args)             ← 严格参数 Schema（未知字段/NaN/Infinity/范围/整数）
             ├─ readSnapshot()                       ← 同一份快照（M1.1）；过期就拒绝
             ├─ lib/control.js LeaseManager.validate ← ★新增：控制权 + generation
             ├─ bridge.call(action, args, {envelope})← 唯一写命令文件的地方（既有，加了信封）
             └─ spec.verify(before, after)           ← 执行后核对（移动是否真的动了）
                  └─ scripts/whale/bridge.lua handle_command()
                       └─ Whale.guard.validate(cmd)  ← ★新增：Lua 侧最终授权（协议/过期/白名单/世代/角色/参数/组件）
                            └─ Whale.actions.Start() ← 既有 28 个原子动作（一行没改）
                                 └─ BufferedAction / locomotor / 原生组件
```

**约束（都已做到）**

| 要求 | 实现 |
|---|---|
| 所有动作只有一个 Node 入口 | `tools.js` 的动作类工具全部改走 `dispatcher.dispatch()`；`bridge.call` 只被 dispatcher 调用 |
| F8 与 MCP 共用 | 二者都走 `executeTool → dispatcher`；**没有第二条路径** |
| 禁止任意 Lua / 函数名 / Prefab 执行 | `ACTION_SPECS` 白名单只有 `move_to` / `stop`；其余工具直接返回"还没开放"，**一条命令都不写** |
| 模型不能构造 BufferedAction | 模型只给参数；BufferedAction 由 Lua 动作实现内部构造 |

---

## 2. Control Lease（`lib/control.js`）

| 字段 | 含义 |
|---|---|
| `owner` | `f8_agent` / `mcp_client` / `manual_test` / `system` |
| `generation` | 控制权世代。**换手就 +1**；旧世代命令一律拒绝（Node 与 Lua 双侧） |
| `env` | 环境指纹 `{runtimeId, sessionId, shardId, actorId}` |
| `acquiredAt` / `expiresAt` | 墙钟毫秒；默认 TTL 30s（F8 每步续租、MCP 调用期持有） |

规则：

- **换手**（不同 owner）→ `generation + 1`；
- **同一 owner 再 acquire** → 视为续租，**不涨世代**（否则会作废自己飞行中的命令）；
- **环境变了**（重启/换世界/换分片/换角色）→ 旧租约直接作废并换代；
- `force: true` 用于**人工接管**（F7/紧急），同样换代；
- `invalidate()` 用于紧急停止；
- 租约落盘（原子写 `.runtime/m2-control.json`），进程异常退出后靠"过期"自然恢复，不靠内存锁。

**为什么不是布尔标志**：布尔无法表达"这条命令属于哪一代"。generation 让"换手前发出、换手后才到"的命令一律失效——这正是 F8/MCP 互斥的核心。

---

## 3. Command Protocol（命令信封）

由 dispatcher 生成，随命令一起写进 `whale_cmd.json`（同时保留旧字段 `v/id/action/args/ts` 兼容）：

```jsonc
{
  "v": 1, "id": "<command_id>", "action": "move_to", "args": {"x":3,"z":4}, "ts": 1700000000000,
  "protocol_version": 1,
  "command_id": "9b2f…",          // 唯一；用于幂等/结果关联
  "requested_by": "f8_agent",
  "lease_generation": 12,
  "lease_expires_at": 1700000030000,
  "runtime_id": "r1794500464-9807",
  "session_id": "5F056B29…",
  "shard_id": "1",
  "actor_id": "player:KU_dsu8_vGS",
  "snapshot_id": "r1794500464-9807-n193",
  "created_at": 1700000000000,
  "expires_at": 1700000008000     // 默认 8 秒
}
```

Lua 侧校验（`Whale.guard.validate`，按顺序）：

1. `protocol_version == 1`；2. `command_id` 非空且**不在最近 32 条已处理里**；
3. 动作在 `Whale.guard.ACTIONS` 白名单；4. `expires_at > 墙钟`（过期即拒）；
5. `runtime_id` 与当前运行实例一致（**游戏重启后旧命令必拒**）；
6. `session_id` / `shard_id` 与当前一致；7. 角色可控制（见 §4）且 `actor_id` 一致；
8. `lease_generation >= 已见过的最高世代`（fencing）；9. 租约未过期；
10. 参数逐字段校验（未知字段/类型/NaN/Infinity/范围/整数）；11. 动作所需组件齐全。

通过后 `Whale.guard.accept(cmd)`：抬世代 + 记 command_id（环形 32 条），再交给 `Whale.actions.Start`。

---

## 4. Lua 侧角色可控制性（`Whale.guard.actor_status`）

**观察对象 ≠ 控制对象**。Actor Provider 为了"至少能看见"会兜底返回任意有效实体；
执行时**绝不允许**用兜底实体。判定顺序：

| 检查 | 失败原因码 |
|---|---|
| 有 actor 且 `IsValid` | `no_actor_*` / `actor_invalid` |
| 不是 ghost | `actor_is_ghost` |
| `actor_type == "player"` | `actor_not_player` |
| 活着 | `actor_dead` |
| `TheWorld` 存在且 `ismastersim == true` | `world_not_ready` / `not_authoritative` |
| 动作所需组件（`move_to` 要 `locomotor`+`health`，`stop` 要 `locomotor`） | `missing_component:<名字>` |

**禁止**：找不到目标时偷偷换一只同 prefab 的实体；角色不可控时"再找一个玩家"。

---

## 5. Target Resolver（`#N`）

接口：`Whale.guard.resolve_target(snapshot_id, ref, {category, max_distance})`，内部复用 M1.4 的 `Whale.nearby.Resolve` + `DescribeRef`（**没有第二套实体映射**）。

| 检查 | 原因码 |
|---|---|
| snapshot 前缀属于当前运行实例、且是当前扫描 | `stale_snapshot` |
| ref 在该快照里存在 | `unknown_ref` |
| 实体仍有效 / 不在 limbo | `entity_gone` / `in_limbo` |
| 分类匹配（例如只接受 resources） | `wrong_category` / `target_not_compatible` |
| 距离上限 | `out_of_range` |

**M2.0 现状**：`move_to`/`stop` 不需要 `#N`；解析器已实现并被 6 条单测覆盖，供 M2.1 的采集/交互动作直接使用。**不会**把 `previous_ref` 当当前引用，也**不会**对 `not_returned` 实体执行动作（它们没有 ref）。

---

## 6. 执行队列与状态

- 同一时刻**只有一个动作**：Lua 的 `Whale.job` 单槽（既有）+ dispatcher 串行 await；
- 重复 `command_id` → Lua 拒（`duplicate_command`），不会重复执行；
- 状态机（dispatcher 输出）：`rejected / succeeded / unverified / failed / unknown / cancelled`；
- **accepted ≠ succeeded**：写入命令文件只是"已下发"；Lua 的"动作开始"也只是"已受理"；只有游戏回执 + 快照核对过了才是 `succeeded`；
- `unknown`（超时/回执丢失）：**绝不自动重试**，提示模型先 `get_state`。

---

## 7. 结果核对（Result Reconciliation）

| 动作 | 核对方式 | 不通过时 |
|---|---|---|
| `move_to` | 前后快照的 `actor.tileX/tileZ` 是否变化，或已贴近目标 ≤1.5 格 | `unverified / position_unchanged` |
| `stop` | 无副作用可核对，游戏回执即成功 | — |

核对失败**不报成功**，而是 `unverified` —— 模型会看到"游戏说做完了，但没核对上"。

---

## 8. 本轮开放范围（严格最小）

| 风险 | 动作 | 状态 |
|---|---|---|
| R0 | `get_state` / `get_guide` / `update_notes` / `list_actions` / `list_recipes` | 保持可用（只读） |
| **R1** | **`move_to`、`stop`** | **本轮开放**（完整链路 + 双侧校验 + 核对） |
| R2 | 采集/拾取/制作/容器/吃/装备/睡 | 代码保留，**工具调用被拒**（`action_not_allowed`） |
| R3 | 攻击 / `act` / 战斗宏 | 同上 |
| 宏 | 4 个 | 同上 |

> 被拒时模型看到的是：`失败：M2.0 还没开放这个动作（只开放：move_to、stop）（action_not_allowed）`，
> 而且**一条命令都不会写进游戏**（有单测）。
