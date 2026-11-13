# API 验证报告（Phase 1）

> 原则：**不虚构 API**。每条 API 都要有「来源（762172 源码位置）」+「实机验证结果」两栏。
> 验证时间：2026-11-11 21:00–22:00（同一台机器，DST build 762172）。
> 实机值取自 `master_server_log.txt` 里的 `[BWS]` 记录（Master 分片）。

## 1. 结论

| 结果 | 数量 |
|---|---|
| 确认可用（源码 + 实机都有值） | 26 |
| 源码里**不存在**、已改掉 | 1（`TheSim:GetTime()`） |
| 存在但语义与假设不符、已纠正 | 3（`state.cycles` 0 基、`Pickable` 无 `CanBePicked`、`MakeRecipeFromMenu` 服务端空转） |

## 2. 逐条验证

### 2.1 玩家

| 数据 | API | 源码位置 | 实机验证（本次抓到的值） | 判定 |
|---|---|---|---|---|
| 有效实体 | `ent:IsValid()` | `entityscript.lua` | `valid: true` | ✅ |
| prefab | `ent.prefab` | — | `"willow"` | ✅ |
| 中文名 | `STRINGS.CHARACTER_NAMES[upper(prefab)]` | `strings.lua` | `"薇洛"` | ✅ |
| 实体 ID | `ent.GUID` | `entityscript.lua` | `116828` | ✅ |
| 玩家 userid | `ent.userid` | `player_common.lua:1010` | `"KU_dsu8_vGS"` | ✅ |
| 是否幽灵 | `ent:HasTag("playerghost")` | `player_common.lua` | `false` | ✅ |
| 世界坐标 | `ent.Transform:GetWorldPosition()` | `entityscript.lua` | `(13.81, 0, -56.46)` | ✅ |
| 生命 | `health.currenthealth / maxhealth / GetPercent() / IsDead()` | `health.lua:477,546` | `150/150, 100%, false`；受伤时 `49.9` | ✅ |
| 饥饿 | `hunger.current / max / GetPercent()` | `hunger.lua:94` | `150/…`、`55.3→64.5`（吃浆果） | ✅ |
| 精神 | `sanity.current / max / GetPercent()` | `sanity.lua:288` | `108.4/120` | ✅ |
| 体温 | `temperature:GetCurrent()` | `temperature.lua:108` | `30.5` | ✅ |
| 潮湿 | `moisture:GetMoisture() / GetMoisturePercent()` | `moisture.lua:167,171` | `0 / 0%` | ✅ |

### 2.2 背包 / 装备

| 数据 | API | 源码位置 | 实机验证 | 判定 |
|---|---|---|---|---|
| 格子数 | `inv:GetNumSlots()` | `inventory.lua:588` | `15` | ✅ |
| 每格物品 | `inv:GetItemInSlot(slot)` | `inventory.lua:777` | 逐格取到 | ✅ |
| 装备栏 | `inv:GetEquippedItem(EQUIPSLOTS.HANDS/HEAD/BODY)` | `inventory.lua:773` | 手持 `lighter`（薇洛的打火机），燃料 87.1 | ✅ |
| 数量 | `item.components.stackable:StackSize()` | `stackable.lua:59` | `花瓣x2`、`采下的草x8` | ✅ |
| 耐久 | `finiteuses:GetUses()` + `.total` | `finiteuses.lua:75` | 打火机/工具都有值 | ✅ |
| 新鲜度 | `perishable:GetPercent()` | `perishable.lua:217` | `花瓣 90.9%`、`浆果 95.3%` | ✅ |
| 燃料 | `fueled:GetPercent()` | `fueled.lua:251` | 打火机 `87.1` | ✅ |
| 是否满 | `inv:IsFull()` | `inventory.lua:791` | `false` | ✅ |

### 2.3 世界

| 数据 | API | 源码位置 | 实机验证 | 判定 |
|---|---|---|---|---|
| 天数 | `TheWorld.state.cycles` | `components/worldstate.lua` | `cycles 1 → day 2`、`cycles 2 → day 3` | ✅（**0 基**，已按 `day = cycles + 1` 输出） |
| 昼夜阶段 | `state.phase` / `isday` / `isdusk` / `isnight` | 同上 | `dusk → night → day` 都抓到过 | ✅ |
| 季节 | `state.season` / `isautumn` … | 同上 | `"autumn"` | ✅ |
| 季节进度 | `elapseddaysinseason` / `remainingdaysinseason` / `seasonprogress` | 同上 | `1 / 19 / 0.525` | ✅ |
| 世界温度 | `state.temperature` | 同上 | `22.8 ~ 30.9` | ✅ |
| 一天进度 | `state.time` / `timeinphase` | 同上 | `0.14 / 0.28` | ✅ |
| 天气 | `israining` / `precipitation` / `wetness` / `issnowing` / `snowlevel` / `issnowcovered` / `isacidraining` | 同上 | 全程 `false / 0`（秋季晴天，未发生降雨） | ✅ 字段可读（**未覆盖变化**） |
| 月亮 | `moonphase` / `isfullmoon` / `isnewmoon` / `iswaxingmoon` | 同上 | `quarter / false / false / true` | ✅ |
| 分片 | `TheWorld:HasTag("cave")` | — | master：`false`；洞穴进程：`true` | ✅ |

### 2.4 扫描与计时

| 数据 | API | 源码位置 | 实机验证 | 判定 |
|---|---|---|---|---|
| 附近实体 | `TheSim:FindEntities(x,y,z,r,must,cant,oneof)` | `findclosest.lua:83` 等 | 半径 16 格 → `scanned 150`，返回 28 条 | ✅ |
| 可加工物 | `components.workable.action.id` + `workleft` | `workable.lua:7,33` | 树 `work_left 10/15`、蘑菇 `1` | ✅ |
| 敌对/生物血量 | `health:GetPercent()` | `health.lua:477` | 红雀 `hp 100`、蜘蛛 `hp 75` | ✅ |
| 掉落物 | `components.inventoryitem.owner == nil` | `inventoryitem.lua` | 燧石/种子/木头都在 `item` | ✅ |
| 分类标签 | `HasTag("player"/"hostile"/"monster"/"animal"/"structure"/"pickable"/"barren")` | 源码内统计 | `tree/harvestable/hostile/creature/item/structure` 全部出现 | ✅ |
| 周期任务 | `ent:DoPeriodicTask(period, fn)` | `entityscript.lua` | 2 秒一条 state、4 秒一次扫描 | ✅ |
| 真实时间 | `TheSim:GetRealTime()`（毫秒） | `mainfunctions.lua:582` | `rt` 从 54 → 178（秒） | ✅ |
| 模拟 tick | `TheSim:GetTick()` | `mainfunctions.lua:573` | `sim_tick` 从 60 → 3780 | ✅ |
| 会话标识 | `TheNet:GetSessionIdentifier()` | `quagmire_recipebook.lua:18` 等 | master `0DEB…`、caves `0790…`（**每个分片不同**） | ✅ |

### 2.5 沙箱 / 生命周期

| 项 | 结论 | 证据 |
|---|---|---|
| mod 环境函数白名单 | 只有 `pairs/ipairs/print/math/table/type/string/tostring/require/Class` + `GLOBAL`/`modname`/`modimport` 等 | `mods.lua:296 CreateEnvironment` |
| `pcall` / `tonumber` / `error` / `os` / `io` 不可直接用 | 必须从 `GLOBAL` 取 | 早期版本用 `pcall` 直接崩（日志 `attempt to call global 'pcall' (a nil value)`） |
| `GetModConfigData` | 在 **mod 环境** 上，不在 `GLOBAL` | `modutil.lua:329`；实机取到 `interval=2` |
| `modsettings.lua` 只能用 `ForceEnableMod` | `ModManager` 在该阶段不存在 | `modindex.lua:1083`；写错会让游戏启动崩溃（已实测） |
| 日志行长度上限 | 约 3.9K 字符截断 | 63 条 3913~3921 字符的记录全部断在半截 JSON |

## 3. 被纠正的三个「想当然」

| 问题 | 我原来的假设 | 实际情况 | 处理 |
|---|---|---|---|
| `TheSim:GetTime()` | 存在，返回游戏内秒 | **不存在**（`pcall` 一直吞错误，`gt` 字段永远缺失） | 改用 `GetRealTime()/1000`（`rt`）+ `GetTick()`（`sim_tick`） |
| `TheWorld.state.cycles` | 就是「第几天」 | 0 基（第 1 天 = 0） | 输出 `cycles` 原始值 + `day = cycles + 1` |
| `Pickable:CanBePicked()` | 组件方法 | `Pickable` 组件没有方法，状态靠标签 `pickable`/`barren` | 改标签判断；草/浆果丛优先归 `harvestable` |
| `Builder:MakeRecipeFromMenu` | 服务端可用 | 服务端因「背包没被打开」直接 return | Phase 1 不做操作；记录在文档里，Phase 2 用 `MakeRecipe` |

## 4. 复现方式

```powershell
# 1) 游戏里进世界，让模组打日志
# 2) 用 Bridge 读出来（会按 schema 校验每条记录）
powershell -ExecutionPolicy Bypass -File start-bridge.ps1
curl http://127.0.0.1:18081/api/game/status
curl http://127.0.0.1:18081/api/game/state
```

本次验证期间：**380 条记录全部通过 schema 校验，0 条 invalid、0 条 parseFails**。
