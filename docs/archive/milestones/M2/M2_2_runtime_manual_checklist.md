# M2.2 · 真机验收清单

> 前提：0.16.0 已装盘；**改过 Lua，必须重进世界**（状态文件 `mod=0.16.0` 才算加载）。
> 用**独立测试世界**。本阶段只改观察层，动作白名单仍是 `move_to` / `stop` / `pickup`。
> 要我代跑就说"测吧"，我执行 `node tools/m2_2_verify_nearby.mjs`（加 `--pickup` 才会真的拾取一次）。

---

## 0. 准备

```powershell
# 版本核对（源码 + 已装都应是 0.16.0）
Select-String 'DontStarveWhaleSurvivor\modinfo.lua' -Pattern '^version'
Select-String "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\modinfo.lua" -Pattern '^version'

# 确认新模块在位
Test-Path "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\scripts\whale\pickuprules.lua"

# 世界是否已加载 0.16.0（状态文件 mod 字段）
node tools/m2_2_verify_nearby.mjs
```

MCP（可选，只影响 `--pickup` 回归那一项）：
```powershell
node tools/m2_0_2_start_mcp.mjs
Invoke-WebRequest http://127.0.0.1:18090/status -UseBasicParsing | Select-Object -Expand Content
```

---

## 测试 A：pickupables 桶出现且顺序正确（**核心**）

1. 进世界，`get_state`。
2. 预期文本里出现新的 `可拾取物：` 段；JSON 里 `buckets` 有八个键，顺序为
   `threats → pickupables → food → resources → containers → structures → creatures → other`。

**判定**：八桶齐全且顺序一致 = PASS。

## 测试 B：地面燧石/树枝/割草真的进了 pickupables

把一颗燧石（或树枝）丢在脚边（按 Q 丢弃），等一次附近刷新（约 4 秒）。

预期：
- 它在 `pickupables` 桶里，且有 `item_kind` 字段（`resources`）；
- **不在** `food`、**不在** `resources`；
- 有 `#N`，可直接用于 `pickup`。

## 测试 C：flint 不再进 food（本轮修复点）

同上场景，检查 `food` 桶。

- 修复前：`flint` 出现在 `food`（因为它带 `edible` + `ELEMENTAL`）；
- 修复后：`food` 里没有 flint；真实食物（浆果、胡萝卜等）仍在 `food`。

## 测试 D：可拾取物不再被植物挤掉（本轮核心目标）

站在一片草地/树苗中间（附近有很多草、树苗、岩石），脚下再丢一颗燧石。

预期：
- 即使 `resources` 桶已经满 12 个，燧石仍然出现在 `pickupables` 并拿到 `#N`；
- 文本里 `附近（16 格内，只显示 N/M 个）` 说明有截断；
- 某个桶满时，该桶行尾出现"（本桶已满，可能还有没列出的）"。

## 测试 E：远处目标也能被看见（候选 vs 执行的距离区分）

对 5~8 格外的燧石：

- 预期：它**仍在** `pickupables`（观察侧不限距离）；
- 直接 `pickup` 它 → 应回 `out_of_range`（执行侧仍限 2.5 格）；
- 先 `move_to` 靠近，再 `pickup` → 成功，背包数量 +1。

## 测试 F：Pickup 闭环回归（不能被 M2.2 破坏）

按 M2.1 的 A 流程再跑一遍：观察 → `#N` → `pickup` → 背包 +1 → 回执与实际一致。
也可以用 `node tools/m2_2_verify_nearby.mjs --pickup` 一次跑完。

## 测试 G：Delta 不误报

1. 记录一次观察的 `delta`；
2. 把物品丢下/捡起，或走开一段距离；
3. 预期：同一实体换桶只报 `changes.category`（`resources → pickupables`），**不报** added + removed；
4. 被截断的实体（`not_returned`）**不报** removed。

---

## 结果回报

```powershell
# 一键（只读）
node tools/m2_2_verify_nearby.mjs
# 含一次真实拾取
node tools/m2_2_verify_nearby.mjs --pickup
```

脚本会逐项打印 `PASS / FAIL / NOT_OBSERVED` 并给汇总。
**没有观察到的项一律记 NOT_OBSERVED，不冒充通过。**

> 如果出现"Observer 说可拾取、pickup 却回 `prefab_not_allowed`"，
> 立即停止并保留 `whale_state.json` + `whale_result.json` —— 那说明观察-执行一致性被破坏了。
