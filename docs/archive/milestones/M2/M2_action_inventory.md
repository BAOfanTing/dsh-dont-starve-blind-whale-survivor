# M2.0 · 现有 GameActions 盘点（0.13.4 → 0.14.0）

> 目的：在动手前把"现在到底有哪些动作、它们怎么被执行、风险多大、缺什么保护"写清楚。
> 证据：`scripts/whale/actions.lua`、`macros.lua`、`bridge.lua`、`lib/tools.js`、`lib/bridge.js`、`lib/agent.js`、`lib/mcp-server.js`（全部读过本轮代码）

---

## 1. 真实数量

| 类别 | 数量 | 明细 |
|---|---|---|
| Lua 原子动作（`JOBS.*`） | **28** | `move_to, go_to, chop, mine, hammer, dig, pick, pickup, attack, eat, cook, craft, build, make_fire, equip, drop, sleep, say, wait, add_fuel, heal, act, list_actions, list_recipes, store, take, harvest, stop` |
| Lua 宏（`A.register`） | **4** | `gather, chop_until, cook_meal, night_watch` |
| Node 工具总数 | **35** | 3 个本地工具（`get_state/get_guide/update_notes`）+ 25 个原子动作 + 7 个宏（`store/take/harvest` 在 Node 侧算宏，在 Lua 里是原子） |
| 本轮开放（M2.0 白名单） | **2** | `move_to`、`stop`（都是 R1） |

> 宏与原子动作共用同一张 `JOBS` 表（宏通过 `A.register` 注册进去），所以 `A.Known()` 会同时列出两者。

---

## 2. 执行入口（改前）

```
F8（lib/agent.js callTool）
  └─ lib/tools.js executeTool()
       └─ ctx.bridge.call(name, args)      ← 直接写 whale_cmd.json
MCP（lib/mcp-server.js tools/call）
  └─ lib/tools.js executeTool()            ← 同一条（好）
       └─ ctx.bridge.call(name, args)
Lua（scripts/whale/bridge.lua）
  └─ 0.3s 轮询 whale_cmd.json → handle_command()
       └─ Whale.actions.Start(action, args, id)   ← 唯一真正碰游戏 API 的地方
```

**已经好的部分**：两个入口本来就走同一个 `executeTool`（M1.1 的成果），动作实现只有一套。

**改前的缺口**：

| 缺口 | 影响 |
|---|---|
| 没有控制权租约 | F8 与 MCP 可以同时下发，互相覆盖 |
| 没有 generation | 换手后旧命令照样执行 |
| 命令只有单槽去重（`last_cmd_id`） | 交错后旧 id 重放会再执行一次 |
| 没有过期时间 | 游戏卡住 5 分钟后恢复，会执行一条几分钟前的移动/攻击 |
| 没有协议版本/白名单 | 任何字符串都会被当动作名试一遍 |
| Lua 侧不校验角色 | 观察用的兜底实体（例如唯一剩下的怪）也能被当执行对象 |
| 角色检查只有 `Abort`（死亡时） | 残血/ghost/非玩家/非权威环境不拦 |
| 参数不校验 | NaN/Infinity/越界/未知字段都会传给游戏 |
| 结果只有 `ok/text` | 没有状态机、没有 command_id 关联、超时会被当成失败 |

---

## 3. 动作清单（风险分级）

> `target`：是否需要目标；`ref`：是否依赖 `#N` 引用；`组件`：执行前必须存在；`验证`：怎么确认真的成了。

| action | 工具 | Lua 执行器 | target | ref | 组件 | 主要游戏 API | 副作用 | 风险 | 验证方式 | 入口 |
|---|---|---|---|---|---|---|---|---|---|---|
| `move_to` / `go_to` | 同名 | `JOBS.move_to/go_to` | 坐标 | 否 | `locomotor` | `locomotor:GoToPoint` + 客户端走路 RPC | 移动 | **R1** | 位置变化 / 贴着目标 | F8+MCP |
| `stop` | `stop` | `JOBS.stop` | — | 否 | `locomotor` | `locomotor:Stop` + `ClearBufferedAction` | 打断 | **R1** | 无需核对（立刻生效） | F8+MCP |
| `chop/mine/hammer/dig` | 同名 | `JOBS.*`（共用 `job_work`） | 资源 | 现在是 prefab 名 | `locomotor`,`inventory` | `BufferedAction(ACTIONS.CHOP/MINE/…)` | 消耗工具耐久、掉落物品 | **R2** | 目标 workable 变化 + 背包增量 | F8+MCP |
| `pick`/`pickup`/`harvest` | 同名 | `JOBS.pick/pickup/harvest` | 资源/掉落物 | 同上 | `locomotor`,`inventory` | `ACTIONS.PICK/PICKUP/HARVEST` | 拾取 | **R2** | 背包增量 | F8+MCP |
| `store`/`take` | 同名 | `JOBS.store/take`（直接调 `container:GiveItem/RemoveItem`） | 容器 | 同上 | `inventory` | 容器组件 | 转移物品 | **R2** | 容器/背包变化 | F8+MCP |
| `craft`/`build` | 同名 | `JOBS.craft/build`（`builder:MakeRecipe`） | 配方 | 否 | `builder`,`inventory` | `builder:MakeRecipe` | 消耗材料、产生物品/建筑 | **R2** | 背包增量 / 世界新增 | F8+MCP |
| `make_fire`/`add_fuel` | 同名 | `JOBS.*` | 位置/火堆 | 否 | `inventory` | `MakeRecipe(campfire)` / `ACTIONS.ADDFUEL` | 生成火、消耗燃料 | **R2** | 火堆出现 / 燃料百分比 | F8+MCP |
| `eat`/`heal` | 同名 | `JOBS.eat/heal` | 物品 | 否 | `inventory`,`eater` | `ACTIONS.EAT/HEAL` | 消耗食物/药 | **R2** | 饥饿/血量变化 | F8+MCP |
| `equip`/`drop`/`sleep` | 同名 | `JOBS.*` | 物品/床 | 否 | `inventory` | `inventory:Equip/DropItem`、`ACTIONS.SLEEPIN` | 换装/丢东西/过夜 | **R2** | 装备槽/背包变化 | F8+MCP |
| `attack` | `attack` | `JOBS.attack` | 生物 | 同上 | `combat` | `ACTIONS.ATTACK` | 进入战斗 | **R3** | 目标血量变化 | F8+MCP |
| `act` | `act` | `JOBS.act` | 任意 | 否 | 视动作 | **任意 ACTIONS 表动作** | 不可枚举 | **R3**（最高） | 无法统一核对 | F8+MCP |
| `say`/`wait` | 同名 | `JOBS.say/wait` | — | 否 | 无 | `talker:Say` / 计时 | 聊天/耗时 | **R1** | 无需核对 | F8+MCP |
| `list_actions`/`list_recipes` | 同名 | `JOBS.*` | — | 否 | 无 | 读规划器/配方表 | 无 | **R0** | — | F8+MCP |
| 4 个宏 | 同名 | `macros.lua` → 循环调原子 | 资源/锅 | 否 | 视内部 | 组合 | 大量 | **R2~R3** | 内部靠背包增量 | F8+MCP |

---

## 4. 已有保护措施（改前）

| 保护 | 位置 | 说明 |
|---|---|---|
| 单动作执行（`Whale.job` 单槽） | `actions.lua` | 新动作打断旧动作并交代上一个结果 |
| 命令 id 去重 | `bridge.lua:203` | 只记**最后一个** id（不够） |
| 动作超时 | `bridge.lua`/`actions.lua` | 各动作自带 t 0 超时（宏观兜底） |
| 死亡中止 | `modmain.lua` death 事件 | 只处理"死亡"这一种 |
| 背包净变化校验 | `actions.Tick` | 结束时附 `（背包：log+2）` |
| 服务端权威 | `TheWorld.ismastersim` 分支 | 动作只在服务端跑 |

## 5. 缺的保护措施（本轮补齐）

1. 控制权租约 + generation fencing（Node + Lua 双侧）
2. 命令协议（版本/白名单/过期/唯一 id/环境指纹）
3. Lua 侧角色可控制性严格判定（非玩家/ghost/死亡/非权威/缺组件一律拒）
4. 参数严格校验（未知字段/类型/NaN/Infinity/范围/整数）
5. `#N` 目标的严格解析（当前 runtime/session/shard/actor + 分类 + 距离）
6. 结果状态机（accepted≠succeeded，unknown 不自动重试）
7. 执行后核对（移动是否真的动了）

## 6. 已知 DST API 兼容性问题（历史已验证）

| 问题 | 结论 |
|---|---|
| `TheSim:GetTime()` 在本构建不存在 | 已在 `util.lua` 处理（退回 GetRealTime / os.time） |
| `TheSim:GetRealTime()` 单位是毫秒 | `mainfunctions.lua:608/612` 证实；M1.4 计时用它 |
| `Pickable` 组件没有 `CanBePicked()` | 只能看 `pickable/barren` 标签 |
| `FindEntities` 半径是世界单位（1 格=4） | 已乘 4 |
| 服务端权威：`TheWorld.ismastersim` | 模组只在服务端执行动作（客户端仅补动画） |
