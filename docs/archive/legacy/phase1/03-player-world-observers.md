# 里程碑 3 + 4：玩家 / 背包 / 世界观察器

> 仍然**只读**：不操作角色、不改状态、不寻路、不打怪、不调 AI。
> 数据全部来自**服务端权威对象**（`AllPlayers` 里的实体 + `TheWorld.state`）。

## 1. 文件

| 文件 | 动作 | 作用 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/player_observer.lua` | 新增 | 身份、坐标、生命/饥饿/精神、体温、潮湿、装备位判定 |
| `DontStarveWhaleSurvivor/scripts/main/inventory_observer.lua` | 新增 | 每格物品、数量、耐久、新鲜度、燃料、护甲、装备栏 |
| `DontStarveWhaleSurvivor/scripts/main/world_observer.lua` | 新增 | 天数、昼夜、季节、天气、月亮、洞穴分支字段 |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 修改 | 每周期把三个观察器拼成一条 `type:"state"` 日志 |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | 追加 `modimport` 三个观察器 |
| `DontStarveWhaleSurvivor/modinfo.lua` | 修改 | 版本 0.4.0 |
| `tests/phase1-observers.test.mjs` | 新增 | 7 个用例，覆盖三个观察器 + 组装后的 state |
| `tests/phase1-observer.test.mjs` | 修改 | 里程碑 2 的回归用例（payload 结构变了） |

## 2. 数据来源（逐字段）

### player（`player_observer.lua`）

| JSON 字段 | 取值 | 源码位置 |
|---|---|---|
| `valid` | 实体是否有效（`ent:IsValid()`） | entityscript.lua |
| `prefab` | `ent.prefab` | — |
| `name` | `STRINGS.CHARACTER_NAMES[大写 prefab]`，没有就退回 `STRINGS.NAMES` | strings.lua |
| `guid` | `ent.GUID` | — |
| `userid` | `ent.userid`（`Network:GetUserID()` 赋的） | player_common.lua:1010 |
| `is_ghost` | `ent:HasTag("playerghost")` | player_common |
| `position.x/y/z` | `ent.Transform:GetWorldPosition()` | entityscript.lua |
| `position.tile_x/tile_z` | 世界坐标 / 4 向下取整 | — |
| `health.current/max/percent/dead` | `components.health.currenthealth/maxhealth/GetPercent()/IsDead()` | health.lua:477,546 |
| `hunger.current/max/percent` | `components.hunger.current/max/GetPercent()` | hunger.lua:94 |
| `sanity.current/max/percent` | `components.sanity.current/max/GetPercent()` | sanity.lua:288 |
| `temperature.current` | `components.temperature:GetCurrent()` | temperature.lua:108 |
| `moisture.value/percent` | `components.moisture:GetMoisture()/GetMoisturePercent()` | moisture.lua:167,171 |

### inventory（`inventory_observer.lua`）

| JSON 字段 | 取值 | 源码位置 |
|---|---|---|
| `slots` | `inv:GetNumSlots()`（再兜底上限 40） | inventory.lua:588 |
| `used` | 实际有东西的格数 | — |
| `is_full` | `inv:IsFull()` | inventory.lua:791 |
| `items[].slot` | 槽位号 | — |
| `items[].prefab / name` | 物品 prefab / `STRINGS.NAMES` | strings.lua |
| `items[].count` | `item.components.stackable:StackSize()`（无则 1） | stackable.lua:59 |
| `items[].uses_left / uses_max` | `finiteuses:GetUses()` / `.total` | finiteuses.lua:75 |
| `items[].freshness` | `perishable:GetPercent() * 100` | perishable.lua:217 |
| `items[].fuel` | `fueled:GetPercent() * 100` | fueled.lua:251 |
| `items[].armor` | `armor:GetPercent() * 100` | armor.lua |
| `equipment.hands/head/body` | `inv:GetEquippedItem(EQUIPSLOTS.*)`，结构同上 | inventory.lua:773 |

### world（`world_observer.lua`）

字段名全部来自 `components/worldstate.lua` 的 `self.data.*` 实际字段，没有自己造名字。

| JSON 字段 | 取值 |
|---|---|
| `prefab` / `shard` | `TheWorld.prefab` / `TheWorld:HasTag("cave")` → `caves`/`master` |
| `cycles` / `day` | `state.cycles` / `cycles + 1`（游戏里第 1 天 cycles=0） |
| `phase` / `is_day` / `is_dusk` / `is_night` | `state.phase` / `state.isday` / `state.isdusk` / `state.isnight` |
| `season` / `is_autumn|is_winter|is_spring|is_summer` | `state.season` / 对应布尔 |
| `elapsed_days_in_season` / `remaining_days_in_season` / `season_progress` | 同名字段 |
| `temperature` | `state.temperature` |
| `time.of_day` / `time.in_phase` | `state.time` / `state.timeinphase`（0~1） |
| `weather.*` | `israining / precipitation / precipitationrate / wetness / iswet / issnowing / snowlevel / issnowcovered / isacidraining` |
| `moon.*` | `moonphase / isfullmoon / isnewmoon / iswaxingmoon` |
| `cave.*`（仅洞穴分片） | `cavephase / iscaveday / iscavedusk / iscavenight / cavemoonphase` |

## 3. 设计上的几个决定

1. **只观察服务端**：`player_observer.Observe(player, side)` 在 `side ~= "server"` 时直接返回 `not_server_side`。
   客户端的 `components` 是同名的 replica，字段不全，读出来的数字不可信。
2. **`day = cycles + 1`**：里程碑 2 的实测发现 `cycles` 是 0 基（第 1 天 = 0），对人不友好；
   现在两个都保留（`cycles` 原始值 + `day` 展示值）。
3. **布尔值一定输出**：`is_dusk:false` 这种也写出来（`false ≠ nil`），消费方不用猜"没有这个键是什么意思"。
4. **nil 一律省略**：地面分片不会有 `cave` 段，没戴帽子不会有 `equipment.head`。
5. **模块缺失要降级、不算错误**：`safe_observe(name, module, fn)` 里模块为 nil 时返回 `xxx_unavailable`，
   只进 `observer.problems`，不增加 `errors`（这条是被单元测试逼出来的改进）。
6. **数量与周期都有上限**：背包格子最多 40（正常 15）；采样默认 2 秒一次，不在 `OnUpdate` 里做任何遍历。

## 4. state 日志长这样

```json
[00:12:34]: [BWS] {
  "schema_version":"1","type":"state","phase":1,"observer_version":"0.2.0",
  "side":"server","shard":"master","t":1794401900,"rt":88.5,"sim_tick":4412,"session":"0DEB4615ECBD25D1",
  "player":{"valid":true,"prefab":"willow","name":"薇洛","guid":100234,"userid":"KU_...","is_ghost":false,
            "position":{"x":48.5,"y":0,"z":180.25,"tile_x":12,"tile_z":45},
            "health":{"current":120,"max":150,"percent":80,"dead":false},
            "hunger":{"current":100,"max":150,"percent":66.7},
            "sanity":{"current":180,"max":200,"percent":90},
            "temperature":{"current":21.3},"moisture":{"value":7.5,"percent":7.5}},
  "inventory":{"slots":15,"used":3,"is_full":false,
               "items":[{"slot":1,"prefab":"axe","name":"斧头","count":1,"uses_left":40,"uses_max":50}, ...],
               "equipment":{"hands":{"prefab":"torch","uses_left":30,"uses_max":60}}},
  "world":{"prefab":"forest","shard":"master","cycles":4,"day":5,"phase":"day",
           "is_day":true,"is_dusk":false,"is_night":false,"season":"autumn","is_autumn":true,
           "temperature":22.6,"time":{"of_day":0.25,"in_phase":0.5},
           "weather":{"is_raining":false,"wetness":0},"moon":{"phase":"quarter","is_full_moon":false}},
  "observer":{"interval":2,"tick":37,"errors":0,"players":{"count":1}}
}
```

（上面为了好读做了缩进，游戏日志里是**一行**。）

## 5. 运行 & 测试

模组已装成 **v0.4.0**（`node tools/install-mod.mjs` 可重装）。

**要做的**：保存退出世界 → 完全退出游戏 → 重新启动 → 读档进世界，等 10 秒。

我（或你自己）跑：

```powershell
$k = "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether"
Get-Content "$k\master_server_log.txt" -Encoding UTF8 |
  Where-Object { $_ -match '\[BWS\].*"type":"state"' } | Select-Object -Last 1
```

为了看清字段，可以把它格式化成多层：把行里 `[BWS] ` 之后的部分丢进 `ConvertFrom-Json`。

## 6. 通过标准

- [ ] 出现 `"type":"state"` 行，且包含 `player / inventory / world / observer` 四段
- [ ] `player.position.tile_x/tile_z` 和游戏里你站的位置一致（走两步数字会变）
- [ ] `player.health/hunger/sanity` 的 `current/max` 与游戏 HUD 一致
- [ ] `inventory.items` 的数量、物品名和你背包一致；`equipment.hands` 是手上拿的东西
- [ ] `world.day` 等于画面上的天数；`phase` 与昼夜一致；`season` 是秋季
- [ ] `observer.errors` 一直是 0，`observer.problems` 不出现
- [ ] 受伤 / 吃东西 / 捡东西 之后，下一条 state 里数字跟着变（这条要你实际动一动）

## 7. 本地验证（不进游戏）

```powershell
node --test tests/phase1-observers.test.mjs    # 7 个用例
node --test "tests/*.test.mjs"                 # 全项目 63 个用例
```

覆盖：三围/体温/潮湿换算、坐标→格子、无效实体与客户端侧拒绝观察、背包数量/耐久/新鲜度/装备、
`day=cycles+1`、布尔 false 不丢、洞穴字段只在洞穴出现、无玩家时 `problems.player=no_player`。

## 8. 已知限制（本里程碑）

- 多人时只取**第一个有效玩家**（`AllPlayers` 遍历顺序不保证）；观察多人放后面做。
- 客户端不产出 `player/inventory`（`problems.player = "client_side"`），因为 replica 数据不权威。
- 还没有 `nearby`（附近实体扫描是里程碑 5）和统一 schema 冻结（里程碑 6）。
