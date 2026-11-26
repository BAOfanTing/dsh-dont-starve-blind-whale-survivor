# TARGET-REFRESH 改动方案（Mod 0.38.4 → 0.39.0）

> 依据：`latestLogs/session.txt`（7452 行、94 次工具调用）+ 现有代码逐文件核对。
> 基线：735/735 单测通过（`npm test`）。

---

## 实现状态（2026-11-16）

| 项 | 状态 | 证据 |
|---|---|---|
| §1 实时目标选择（5 个动作 + 固定枚举） | ✅ 已实现 | `tests/target-nearest.test.mjs`（15 例） |
| §1 稳定句柄 target_handle | ✅ 已实现（含真机验证：8 棵树/2 株食物植物带句柄，NET/HAMMER 不发） | `tests/target-handle.test.mjs`（10 例） |
| §2 stale_snapshot 熔断 | ✅ 已实现 + **真机验证**（第 1 次提示、第 2 次熔断、替代方案） | `tests/stale-circuit.test.mjs`（8 例） |
| §3 食物救援链 | ✅ 已实现 + **真机验证**（eat 回执列出真实背包 cutgrass/petals/twigs） | `tests/food-rescue.test.mjs`（12 例） |
| §4 配方白名单一致性 + 建造证据 | ✅ 已实现 + **真机验证**（rope→recipe_locked、axe 缺料数字、torch 真做出来） | `tests/recipe-parity.test.mjs`（10 例） |
| §5 长期记忆绑定 World/Save | ✅ 已实现 | `tests/world-memory.test.mjs`（9 例） |
| §6 12 项测试（UNIT/INTEGRATION/RUNTIME） | ✅ UNIT+INTEGRATION 已跑（799/799）；**RUNTIME 部分完成**（见下节：stale=0、句柄生效、拒绝理由准确；缺一次 succeeded） | 见 TESTING.md |

**单测总数**：735（改动前）→ **799**（改动后，新增 64）。全部通过，`0 failed`。
**原安全测试**（Control Lease / Guard / ACK / Handover）一条未改，全绿。

---

## RUNTIME 验收清单（需要游戏读档进世界）

### 已经拿到的真机证据（2026-11-16，Mod 0.39.0/0.39.1，Cluster_1/Master，真实 DST 世界）

真实世界里跑过（世界 `01320F432105DCB5` → `r1794834701-5497`，角色 `player:KU_dsu8_vGS`，
**Nearby 快照每 2 秒换一次** —— 正是修复前必然 `stale_snapshot` 的场景）。

**A. 确定性场景：12/12 全过**（走产品自己的 MCP 服务器 `http://127.0.0.1:18090/mcp`，
也就是模型真实使用的那条链路：`tools/call → dispatcher → 文件桥 → Lua guard → BufferedAction`）

| 项 | 真机回执 |
|---|---|
| §2 第一次 `stale_snapshot` | ✅ 「附近快照变了（你给的 r-STALE-n1，当前 …-n55）」+「**不要**把 snapshot_id 加 1、不要预补偿」 |
| §2 第二次 → 熔断 | ✅ 「stale_snapshot 已连续 2 次（一直用 #911 配一个往上猜的 snapshot_id），**熔断**：不再重试这个旧引用」+ 给出 `pickup_nearest` / `target_handle` 两条替代路 |
| §3 `eat`（背包没安全食物） | ✅ 「no_food｜背包里现在没有白名单食物…；另外背包里有（都不在可吃白名单）：**cutgrass×4（不能自动吃）、petals×1、twigs×2**」—— 真实背包，不是模型记忆 |
| §4 `craft rope` | ✅ 「**recipe_locked**｜rope 是第一阶段科技配方：先 build sciencemachine，站到它旁边再做」（旧版是 `recipe_not_allowed`） |
| §4 `craft armorwood` | ✅ 先报科技锁（优先级正确，不会让模型以为"补够材料就能做"） |
| §4 `craft axe`（缺燧石） | ✅ 「ingredients_missing: **flint 0/1**」—— 数字读自原版配方表 |
| §4 `craft torch`（材料够） | ✅ **真的做出来了**：「做好了 火把，已自动拿在手里（torch）（cutgrass-2，twigs-2）」+ Node 侧核对通过 |

**B. 实时目标选择：0 次 stale_snapshot，拒绝理由全部准确**

| 动作（等 5~6 秒后下发，**不带** `#N`/`snapshot_id`） | 真机回执 |
|---|---|
| `pickup_nearest(flint)` | ✅ 诚实 `no_target`「附近没有可捡的 flint（扫到 341 个实体，341 个类型不符）」 |
| `harvest_nearest(ripe_food_plant)` | ✅ 诚实 `out_of_range`「最近的一处 ripe_food_plant（绿蘑菇）在 8.1 格外 (-16,-13)：先 move_to 过去再试」 |
| `pickup_food(safe_ground_food)` | ✅ 诚实 `out_of_range`「最近的一处 safe_ground_food（蛙腿）在 14.7 格外 (-9,8)」 |
| `mine_nearest(ordinary_rock)` | ✅ 诚实 `no_target`「附近没有可挖的 ordinary_rock（扫到 340 个实体）」 |
| `chop_nearest(tree)` | ✅ 找到树后诚实拒绝 `no_tool: 背包里没有能砍的工具，先 craft axe` |
| `gather` via `target_handle` | ✅ 句柄 `hdk` 被接受；目标在等待期间被拿走时诚实回 `entity_gone`（**没有**换成别的东西） |
| **`stale_snapshot` 次数** | ✅ **0 次**（修复前同一世界形态下 23 次） |
| 等完之后快照确实换了 | ✅ 回执里的「快照：…-n21 → …-n22（变了）」显示编号在变，动作仍然准确 |

**C. 句柄在真机按白名单发放**（实测某一帧）

- 12 个 `resources` 里 **8 棵树带句柄**（h5u/h6b/h61/h4z/h62/h6h/h4s/h4r）；`carrot_planted` h54、
  `berrybush_juicy` h8x、`grass` h77/h7b/h7c/h70/h73 也带。
- `butterfly` / `fireflies`（work=NET）、`fence_junk`（work=HAMMER）、`threats` / `creatures` **不发** ——
  白名单边界正确。
- `harvest_ready=false` 的条目照样发句柄（句柄只表示"目标还在"），但动作会被 `not_ready` 拒。

**还差一条**：一次 `pickup_nearest(flint)` / `chop_nearest(tree)` / `mine_nearest(ordinary_rock)`
的**成功**回执。当时世界里：地面 `pickupables=0`（没有燧石可捡）、背包没有斧头/镐（`no_tool`）、
附近没有石头（`no_target`），而且角色一度被蜘蛛打死停在幽灵状态。这些是**缺前置条件**，
不是缺能力 —— 回执已经把缺什么、去哪儿都说得清清楚楚。补齐材料/走到矿点后按下面命令复跑即可。

### 复跑命令（角色活着、非幽灵、附近有目标时）

前置：`node tools/install-mod.mjs` 重装模组 → 重新读档 → 确认
`http://127.0.0.1:18090/status` 说找到了状态文件。

```powershell
# 先体检（状态/模组版本/句柄/控制权 一次说清）
node tools/verify-live.mjs doctor
node tools/verify-live.mjs kinds

# ★ 核心验收：**等 5 秒**再下发（模拟模型思考），动作不带 #N / snapshot_id
node tools/verify-live.mjs nearest flint            # 拾取指定类别的燧石
node tools/verify-live.mjs nearest tree             # 砍一棵树（需要斧头）
node tools/verify-live.mjs nearest ordinary_rock    # 挖矿脉（需要镐）
node tools/verify-live.mjs nearest gold_vein        # 挖金矿
node tools/verify-live.mjs nearest safe_ground_food # 取安全食物（地上）
node tools/verify-live.mjs nearest ripe_food_plant  # 采成熟植株

# 附近有但够不着：先走过去再验收（--move-to 是真实 move_to，也走 dispatcher）
node tools/verify-live.mjs nearest ripe_food_plant --wait 5 --move-to -16,-13
```

> ⚠ 别在**另一个会话正在跑**时用 `verify-live nearest`：控制租约是排他的，两边会互相换手，
> 验收会以 `control_denied / authority_revoking` 结束（这是安全设计，不是 bug）。
> 要么让那个会话停下，要么直接用会话里的工具（`pickup_nearest` 等）来验收。
> `verify-live.mjs doctor` 会先告诉你"当前有没有别的控制者"。

通过判据（脚本会直接打印 PASS/FAIL）：

1. 回执**不是** `stale_snapshot` / `stale_snapshot_circuit_open`；
2. `status=succeeded`，且 `verified` 里能看到真实变化（背包 +N / 目标消失）；
3. 脚本会同时打印"等待前后的 Nearby 快照 id"，用来证明**快照确实变了而动作仍然成功**
   （这正是修复前做不到的那件事）。

其它真机项：

```powershell
node tools/verify-live.mjs lease     # 租约 / 换手 / ACK 通路
node tools/verify-live.mjs nearby    # 附近分类桶 + 快照 id
node tools/verify-live.mjs harvest   # 可收获候选 + 成熟度字段
```

手测（会话里直接下工具）：

- `pickup_nearest {"target_kind":"flint"}` 等 5 秒后仍然成功；
- 先 `get_state` 拿一个「句柄h…」，**隔 10 秒**再 `pickup {"target_handle":"h…"}` 仍然成功；
- 故意用 `pickup {"target_ref":"#1","snapshot_id":"<过期的一帧>"}` 连着试两次 →
  第二次必须是 `stale_snapshot_circuit_open`，且游戏里**没有任何动作发生**；
- 背包里没有食物时 `eat {"food":"carrot"}` → 回执列出"背包里现在真正能吃的"；
- `craft {"recipe":"rope"}` → 远离科学机器时 `recipe_locked`（提示先建科学机器），
  站在机器旁边时成功。

---

## 0. 日志实证：先纠正一个归因

| 现象 | 日志证据 | 真实原因 |
|---|---|---|
| `stale_snapshot` × 23（pickup）/ 3（chop）/ 2（harvest） | 行 962/1034/1373/3792…8449 | **编号每 4 秒必换**：`nearby.lua` 的内容指纹把**全量扫描列表**（含 180+ 实体）算进去，只要有任何实体位置变化（四舍五入到 4 单位）就换 `scan_seq`。模型一轮思考 30~60 秒 → 必然过期 |
| `eat not_in_inventory` × 2 | 行 4720（carrot）、5112（carrot） | **不是 bug**。行 3794→4038、5087→5024 显示：Reflex 在 07:57:51 / 08:01:26 把胡萝卜吃掉（饥饿 70→82、背包里 carrot 消失）。模型凭**上轮记忆**发 eat，真实背包已空 → 拒绝正确 |
| Reflex 咬住 carrot 不撒手 | 同上 | 拒绝回执只有 `not_in_inventory`，**没有告诉模型现在背包里到底有什么**，模型只能反复猜 prefab |
| `green_mushroom` / `blue_mushroom` 被 `food_not_allowed` | 行 8760（blue）、6788/8032（green） | **命名正确但语义错位**：`green_mushroom` 是**地上植株**（harvestrules），可食物品是 `green_cap`（eatrules）。两侧表本来就不同名，回执没提示 |
| `harvest target_not_harvestable` | 行 8469 | 快照 n431 匹配成功，但 `#1` 在新帧里**已经是别的实体** → 正确拒绝，但没有替代方案，模型只能继续猜编号 |
| `craft rope` → `recipe_not_allowed` | 行 1446 | Node/Lua **一致**（rope 不在任何白名单），但第一阶段科技需要它 |
| 笔记里的基地 `(21,-81)` 与实际 `(-21,-5)` | 行 5017 起、STATE 行 | `notes.md` 是全局单文件，不绑世界 |

**结论**：模型侧 Prompt 无问题；缺的是「一个不依赖编号的目标选择入口」+「失败时把真实世界事实回给模型」+「连败熔断」。

---

## 1. 第一优先级：实时目标选择（方案 A）

### 1.1 新模块 `scripts/whale/targetrules.lua`（唯一真来源）

放**固定枚举** + 候选判定 + 最近目标查找 + 稳定句柄。观察侧（nearby 渲染）与执行侧（guard）共用它，
沿用 `pickuprules` / `harvestrules` 的既有模式（禁止两边各写一套）。

```
T.KINDS = {
  -- pickup_nearest
  flint / twigs / cutgrass / log / rocks / goldnugget / charcoal / petals
  -- pickup_food（默认 safe_ground_food = eatrules.AUTO_SAFE 与 pickuprules 的交集）
  safe_ground_food / carrot / berries / berries_juicy / pumpkin / corn / eggplant /
  honey / meat / smallmeat / froglegs / fish
  -- chop_nearest
  tree
  -- mine_nearest
  ordinary_rock / gold_vein
  -- harvest_nearest（只认成熟植株；未成熟一律不作为目标）
  ripe_food_plant / berrybush / juicy_berrybush / carrot_plant / mushroom
}
```

每个 kind 声明：`action`（pickup/chop/mine/harvest）、`prefabs`（显式白名单表）、`filter`（额外条件）、
`require_ready`（是否要求成熟）。

**Prefab 白名单来源（已在本机 `.runtime/dst-scripts` 核实）**

- `tree`：`evergreens.lua`（`evergreen*` / `twiggytree*`）、`deciduoustrees.lua`（`deciduoustree*`）、
  `marsh_tree`、`mushtree*`、`livingtree`、`marbletree`、`winter_tree`、`moontree`。
  另外**强制** `workable.action.id == "CHOP"`（能力与白名单双重判定）。
- `ordinary_rock`：`rock1` / `rock_flintless` / `rock_flintless_med` / `rock_flintless_low`
  （`rocks.lua` 战利品表：无 `goldnugget`）。
- `gold_vein`：`rock2`（`rocks.lua:76-85` 战利品表含 `goldnugget 1.00`）。
  两者都**强制** `workable.action.id == "MINE"`。
- `pickup_*`：复用 `Whale.pickuprules.PREFABS`；`safe_ground_food` 额外要求 `edible` 组件
  且 `prefab ∈ eatrules.AUTO_SAFE`。
- `harvest_*`：复用 `Whale.harvestrules`；**额外要求 `IsReady(ent) == true`**（未成熟直接跳过，不报错）。

### 1.2 五个新动作（Node 规格 + Lua guard 双白名单）

| 工具 | 参数 | 是否要 `snapshot_id` | 说明 |
|---|---|---|---|
| `pickup_nearest` | `target_kind`（枚举）、`radius`(可选) | **否** | 就地捡最近的一类资源 |
| `chop_nearest` | `target_kind`、`radius` | 否 | 砍最近的树（自动装斧头，走原 chop 链） |
| `mine_nearest` | `target_kind`、`radius` | 否 | 挖最近的矿（自动装镐，走原 mine 链） |
| `pickup_food` | `target_kind`(默认 `safe_ground_food`)、`radius` | 否 | 实时搜地面白名单食物并捡起 |
| `harvest_nearest` | `target_kind`、`radius` | 否 | 采最近**已成熟**的食物植株 |

**执行链完全复用**：guard 在**授权那一刻**用当前世界状态重新 `FindNearest`，然后走
「候选 → 白名单 → 成熟度 → 距离 → 背包容量 → 工具 → `Whale.job == nil` → 原有 Guard 全通过」，
最后仍然 `BufferedAction → A.push()`（`JOBS.pickup` / `JOBS.chop` / `JOBS.mine` / `JOBS.harvest`）。
**不新建执行通道**，不碰 Control Lease / ACK / Dispatcher 的唯一出口地位。

`target_kind` 参数规则：`^[a-z_]{1,32}$` **且必须命中 `T.KINDS`**，否则 `target_kind_not_allowed`。
模型无法传 prefab / GUID / Lua 表达式。

### 1.3 方案 B：稳定 `target_handle`（不暴露 GUID）

在同一模块里实现句柄注册表：

- **生成**：`handle = "h" .. 会话盐 .. base36(自增序号)`。键 = `prefab|tile_x|tile_z`（量化到格子）。
  位置与 prefab 都没变 → 多次扫描**同一个句柄**（测试 1）。
- **失效**：实体 `IsValid()==false` / 进 limbo / 被玩家拿走 / 本帧扫描未出现 → 注销。句柄过期一律
  `target_gone`，**绝不自动替换成别的对象**（测试 4）。
- **绑定**：注册表带 `runtime_id` + `session_id` + `actor_id`；不匹配直接 `handle_session_mismatch`。
- **不可伪造**：只认注册表里存在的句柄，查不到 = `unknown_handle`（模型自己编不出来）。
- **执行前复检**：`ResolveHandle` 重新查真实实体 + 重新过候选/成熟度/距离（与 `#N` 同一条 `resolve_target` 出口）。

**接线方式（最小改动）**：`pickup / harvest / chop / mine / dig / hammer / gather / attack / kill`
新增**可选** `target_handle`。三者关系：

```
args.target_handle 存在 → 跳过 snapshot 校验，走 ResolveHandle
否则                     → 维持现状：target_ref + snapshot_id 必须都是当前帧
```

`#N` 依旧是「当前观察里的展示编号」，语义不变。dispatcher 里 `spec.requiresSnapshot` 的判定改成
「有 handle 就不查 snapshot，否则必须查」——**不放宽任何一条既有校验**。

### 1.4 安全边界说明（明确不动的部分）

| 边界 | 是否改动 | 说明 |
|---|---|---|
| Control Lease / 两阶段换手 / `job_cleared` ACK | **不动** | 新动作走同一个 `control.validate` |
| Lua Guard 白名单 / 参数 / 租约复核 | 只**新增动作条目** | 每条新动作走 `G.ACTIONS`，无旁路 |
| Dispatcher 唯一出口 | 不动 | 新动作仍是 `bridge.call` 一条命令 |
| 命令协议（`command_id`、防重放、8 秒过期） | 不动 | — |
| `#N` 引用不能跨快照 | 不动 | `target_ref` 路径原样 |
| 目标校验（存在/白名单/状态/距离/组件） | 强化 | 新路径**额外**加 `FindNearest` 复检 |
| 结果核对以真实状态为准 | 强化 | 见 1.5 |

### 1.5 新动作的核对（verify）方式

Node 侧不知道 Lua 最终选了哪个实体，所以**以「枚举对应的 prefab 集合在背包里的增量」为权威证据**：

- `pickup_nearest`：该 kind 的 prefab 集合任一 +N；否则 `inventory_unchanged`。
- `pickup_food`：`AUTO_SAFE` 集合任一 +N。
- `chop_nearest`：`log`/`charcoal` +N，**或** before 快照里最近那棵树在 after 里消失。
- `mine_nearest`：`rocks`/`flint`/`goldnugget`/`nitre` +N，**或**最近那块石头消失。
- `harvest_nearest`：该 kind 产物 +N，**或**同一株 `harvest_ready` true→false，**或**植株消失。

—— 全部是「世界真的变了」的证据，不看函数返回值。

---

## 2. `stale_snapshot` 熔断

位置：`lib/dispatcher.js`（不碰 Lua）。

```
breaker = { key(tool|target_ref|snapshot_id), count, openedAt, lastCurrent }
```

- 第 1 次 `stale_snapshot`：照旧返回，但 message 明确「不要加 1、不要预补偿」。
- 连续第 2 次**同一个旧引用**：开闸 → 后续同 `key` 的请求直接 `stale_snapshot_circuit_open`
  （**不发命令到游戏**），并给出替代方案：`pickup_nearest(target_kind=…)` / `pickup_food` / 重新
  `get_state` 后**原样照抄**新 id。
- 计数与原因写进会话日志（`session.txt` 的 `DONE` 行已带 `reason`），并在 `describe()` 里显示
  「已连续 N 次」。
- **清零**：① 任一动作 `succeeded`；② 请求的 `(target_ref|snapshot_id)` 与记录的不同（= 目标变了）；
  ③ `runtime_id` 变化（换世界/重载）。

明确**不做**：放宽校验、允许旧 `#N`、自动 `+1`、盲用同编号实体、缩短模型思考时间。

---

## 3. 第二优先级：食物救援链

### 3.1 `eat` 用真实背包（已是事实，补证据与提示）

- `guard.lua:744-776` 本来就读 `actor.components.inventory`，**不读模型记忆** → 这个不改。
- 改**失败回执**（`guard.lua` 的 `eat` 分支 + `B.Report` 的 text）：
  - `not_in_inventory` → 附「背包里现在真正可吃的：`red_cap×2, green_cap×6`」+ 正确 prefab 名对照
    （`green_cap` / `blue_cap` / `red_cap` 是**物品**；`green_mushroom` / `blue_mushroom` / `red_mushroom`
    是**地上植株**）。
  - `no_food` → 附真实背包清单 + 「没有 AUTO_SAFE 食物；生蘑菇要先 `cook` 或手动指定」。
  - `food_not_allowed` → 附「你说的 X 是植株名/不在白名单；物品名是 Y」（用 `harvestrules.PRODUCT` 反查）。
- **AUTO_SAFE 保持不变**（生蘑菇仍不进自动进食）。

### 3.2 成熟度与地面/植株区分

- `harvest_nearest` 只挑 `IsReady == true` 的植株；未成熟**不作为目标**（不报错、不占坑，直接找下一个）。
- `pickup_food` 只搜**地面掉落物**（`pickuprules.IsCandidate` + `inventoryitem.owner == nil` + `edible`）。
- `nearby` 渲染保持「已成熟 / 未成熟」标记（已有），并在文本里把未成熟项显式写成「未成熟（不能采）」。

### 3.3 食物搜索不只依赖 berrybush

- `harvest_nearest(kind=ripe_food_plant)` 覆盖 `berrybush / berrybush2 / berrybush_juicy / carrot_planted /
  red_mushroom / green_mushroom / blue_mushroom`。
- `gather_area` 不带 prefab 时**已经**同时搜 gatherrules + harvestrules（`gathering.lua:524-539`），
  保持；补一条：结果里说明「附近没有成熟目标，最近一株 X 还要等」而不是空手回一句失败。

### 3.4 Reflex 不再无效抢占

- `reflex.lua` 已有「抢占前先判能不能帮上忙」（1304-1314）。补：`report_need("food", …)` 加**冷却**
  （避免每 5 秒刷同一条需求），且**已确认无安全食物时不中断正在跑的任务**。
- 饥饿危险 → 产出结构化 `need: food`（已有 `R.Needs()`），由 `lib/plan.js` 规划路线：
  - `eat` 目标存在且附近有地面安全食物 → 建议 `pickup_food(target_kind=safe_ground_food)`；
  - 附近有成熟植株 → 建议 `harvest_nearest(target_kind=ripe_food_plant)`；
  - 都没有 → `seek`/`move_to` 走出去（保持现状）。

### 3.5 吃掉后的核对

`survival.js` 的 `eat.verify` 已有「饥饿上升 / 数量减少 / 回血」。补：
- 把**真正减少的 prefab** 一起回给模型（`verified.used_prefab`）；
- `eat` 回执里显式写「已核对：饥饿 +X」或「没核对上：饥饿没变且背包没少」。

---

## 4. 第三优先级：科技动作能力补齐

先审计（Node `lib/actions/specs/crafting.js` ↔ Lua `scripts/whale/craftrules.lua`）：

| recipe | Node 现状 | Lua 现状 | 一致性 | 本阶段 |
|---|---|---|---|---|
| `rope` | 不允许 | 不允许 | ✅ 一致（都拒） | **开放**（第一阶段科技需要） |
| `boards` | 不允许 | 不允许 | ✅ | **开放** |
| `backpack` | 不允许 | 不允许 | ✅ | **开放** |
| `spear` | 不允许 | 不允许 | ✅ | **开放** |
| `armorwood` | 不允许 | 不允许 | ✅ | **开放** |
| `axe`/`pickaxe`/`torch`/`flowerhat` | 允许 | 允许 | ✅ | 保持 |

- 材料需求：**只读原版 `GLOBAL.AllRecipes`**（`craftrules.Ingredients` 已是这条路径），兜底表同步补齐；
  两侧数字必须一致（测试 11 用 parity 断言）。
- 科技条件：从原版 `recipe.level` 判定，`TECH.NONE` 才允许（第一阶段不做科学机器解锁链）。
- 建造成功证据：**删掉** `crafting.js` `build.verify` 里 `materials_consumed` 这条弱证据
  （任务书明确禁止），只认「附近多了该建筑实体」；核对不上就是 `unverified / build_not_found`。
- 接线顺序：**等 1/2 稳定后再接**完整科技链（本任务只做白名单 + 材料 + 证据三件事）。

---

## 5. 长期记忆绑定 World/Save

- Lua：`observe.lua` 输出 `world_key` / `world_key_source`：
  `cluster:<cluster_id>/shard:<shard_id>`；`cluster_id` 取不到时退回 `session:<session_id>`
  （并**如实标注**来源，不编造）。
- Node `lib/index.js`：`notes` 从单文件 `notes.md` 变为 **按 world_key 分文件**
  （`notes/<sanitized-world-key>.md`，主键保留 `notes.md` 兼容旧数据）。
- `get_state` 顶部显示：当前世界键 + 「世界已切换（旧 key → 新 key），旧世界的基地坐标和未完成目标
  已归档、不再显示」。**旧世界的笔记不删**，但当前世界看不到、也不会被当成当前坐标。
- `lib/plan.js`：`derivePlan` 的「沿用上一份计划」增加 `world_key`/`runtime_id` 一致性判定，
  换世界不复用旧目标（`since` 重置）。

---

## 6. 测试（区分 UNIT / INTEGRATION / RUNTIME）

| # | 用例 | 类型 | 落点 |
|---|---|---|---|
| 1 | 快照连续刷新时稳定句柄解析同一目标 | INTEGRATION(fengari) | `tests/target-handle.test.mjs` |
| 2 | 快照编号改变后 `pickup_nearest(flint)` 仍能找到燧石 | INTEGRATION(fengari) | `tests/target-nearest.test.mjs` |
| 3 | 同一个 `#1` 在新快照指向其他实体时不能误操作 | INTEGRATION(fengari) | `tests/target-handle.test.mjs` |
| 4 | 目标消失 → `target_gone`（句柄与 `#N` 两条路） | INTEGRATION(fengari) | `tests/target-handle.test.mjs` |
| 5 | 不成熟浆果不能被采（`harvest_nearest` 跳过 + `harvest` 拒） | INTEGRATION(fengari) | `tests/food-rescue.test.mjs` |
| 6 | 自动寻找地面南瓜 / 多汁浆果 | INTEGRATION(fengari) | `tests/food-rescue.test.mjs` |
| 7 | Reflex 吃掉胡萝卜后模型不能再用旧背包状态 | INTEGRATION(fengari) + UNIT | `tests/food-rescue.test.mjs` |
| 8 | 背包只有生蘑菇时自动进食按安全规则返回结果 | UNIT(guard) | `tests/food-rescue.test.mjs` |
| 9 | 连续 `stale_snapshot` 正确熔断 | UNIT | `tests/stale-circuit.test.mjs` |
| 10 | 老世界基地坐标在新世界不继续使用 | UNIT | `tests/world-memory.test.mjs` |
| 11 | Node/Lua 新工具白名单与目标枚举一致 | UNIT | `tests/target-nearest.test.mjs` + `tests/recipe-parity.test.mjs` |
| 12 | 原 Control Lease / Guard / ACK 安全测试全通过 | UNIT+INTEGRATION | 既有 `control-*.test.mjs` / `guard.test.mjs`（回归，不改） |

RUNTIME（需游戏进世界，`node tools/verify-live.mjs`）：
`nearest-flint` / `nearest-tree` / `nearest-rock` / `food-rescue` —— **等待 5 秒后**再发动作，验「不 stale 且真执行」。

---

## 7. 明确不做（按任务书）

- 不放宽 `stale_snapshot`、不允许旧 `#N`、不自动 `+1`、不盲用同编号实体、不暴露 GUID。
- 不缩短模型思考时间作为根本方案；不加 Prompt 长度掩盖系统性错误。
- 不重构 `actions.lua` / `index.js` / `guard.lua`（只在其中**新增**小段）。
- 不开放无关科技阶段；不重新设计整个 Reflex；不删历史测试。

---

## 8. 预计改动清单

**Lua（模组）**
- 新增 `scripts/whale/targetrules.lua`（枚举 + 候选 + FindNearest + 稳定句柄）
- `modmain.lua`：加 1 行 `modimport`（顺序在 guard 之前）
- `guard.lua`：`G.ACTIONS` 加 5 条；新增 5 个小 `if action == …` 块；`resolve_target` 支持 handle
- `nearby.lua`：渲染 `target_handle`；`Resolve` 旁加 `ResolveHandle`
- `eatrules.lua`：加 `E.ListEdibleNames()` / `E.ProductNameOf()`
- `craftrules.lua`：白名单加 5 个配方 + `TECH.NONE` 校验
- `router`（`bridge.lua`，1 行式）：把 5 个新动作的 `target_kind`/`radius` 透传进 ctx
- `observe.lua`：`world_key` 输出 + 未成熟项文案
- `reflex.lua`：food need 冷却

**Node（插件）**
- `lib/actions/specs/gathering.js`：5 个新规格 + verify
- `lib/actions/specs/crafting.js`：5 个配方 + 删 `materials_consumed`
- `lib/dispatcher.js`：handle 路径、熔断器
- `lib/tools.js`：5 个工具定义 + `RULES` 能力清单自动派生 + eat/采集说明改写
- `lib/index.js`：notes 按 world_key 分文件（小段）
- `lib/plan.js`：食物建议 + 世界一致性

**文档/版本**
- `modinfo.lua` 0.38.4→0.39.0；`package.json` 0.9.3→0.10.0；`modmain.lua` 兜底版本
- `STATUS.md` / `ARCHITECTURE.md` / `README.md`（31 动作→36）/ `TESTING.md`
