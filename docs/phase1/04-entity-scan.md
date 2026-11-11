# 里程碑 5：附近实体扫描

> 仍然只读。扫描**不在每帧做**：由 `observer_manager` 按「扫描间隔」调用一次，结果缓存进 `state.nearby`。

## 1. 文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/entity_observer.lua` | 新增 | 一次 `FindEntities` + 一遍分类，带半径/数量/分类三类上限 |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 修改 | 加扫描缓存 `O.nearby`、按周期触发、state 里带 `nearby` |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | 追加 `modimport` |
| `DontStarveWhaleSurvivor/modinfo.lua` | 修改 | 新增 `OBSERVER_SCAN_RADIUS`（16 格）、`OBSERVER_SCAN_SECONDS`（4 秒）；版本 0.5.0 |
| `tests/phase1-entities.test.mjs` | 新增 | 4 个用例：分类/距离/过滤、上限与截断、半径换算、缓存周期 |

## 2. API 依据（762172）

| 用途 | API | 出处 |
|---|---|---|
| 找附近实体 | `TheSim:FindEntities(x, y, z, radius, musthavetags, canthavetags, musthaveoneoftags)` | `findclosest.lua:83`、`runaway.lua:128` |
| 有效实体 | `ent:IsValid()` | `entityscript.lua` |
| 坐标 | `ent.Transform:GetWorldPosition()` | `entityscript.lua` |
| 可加工物 | `ent.components.workable.action.id`（`CHOP`/`MINE`/`DIG`/`HAMMER`）与 `workleft` | `components/workable.lua:7,33` |
| 血量 | `ent.components.health:GetPercent()` | `health.lua:477` |
| 掉落物 | `ent.components.inventoryitem.owner == nil` | `inventoryitem.lua` |
| 中文名 | `STRINGS.NAMES[string.upper(prefab)]` | `strings.lua` |
| 分类标签 | `player` / `hostile` / `monster` / `animal` / `structure` / `pickable` / `barren` | 源码里用 `HasTag("…")` 统计过，都真实存在 |

**踩坑记录**：`Pickable` 组件**没有** `CanBePicked()`，能采不能采只能看实体标签（`pickable` 有、`barren` 无）。

## 3. 分类规则（优先级从上到下，一个实体只归一类）

| category | 判定 |
|---|---|
| `player` | `HasTag("player")`（观察目标自己会被排除） |
| `hostile` | `HasTag("hostile")` 且有 `components.health` |
| `creature` | 有 `components.combat` + `health`，或带 `monster` / `animal` 标签 |
| `tree` / `rock` / `diggable` / `damageable` | `components.workable.action.id` = `CHOP` / `MINE` / `DIG` / `HAMMER` |
| `harvestable` | 有 `pickable` 标签且没有 `barren`，或有 `components.harvestable` |
| `item` | `components.inventoryitem.owner == nil`（掉在地上的） |
| `structure` | `HasTag("structure")` |
| 其它 | 不输出（特效、装饰、不认识的东西） |

每条记录的字段：`prefab`、`name`（中文）、`category`、`tile_x`/`tile_z`、`distance`（格，1 位小数）；
`hostile`/`creature` 额外带 `hp`（百分比），`tree`/`rock`/`diggable`/`damageable` 额外带 `work_left`。

## 4. 上限与缓存（原则 8：不把耗时操作丢给主线程）

| 参数 | 默认 | 夹取范围 | 来源 |
|---|---|---|---|
| 半径 `radius_tiles` | 16 格 | 2 ~ 40 | modinfo `OBSERVER_SCAN_RADIUS` |
| 总条数 `max_entities` | 40 | 1 ~ 200 | 代码常量（后续可配） |
| 每类条数 `per_category` | 10 | 1 ~ 50 | 代码常量 |
| 扫描间隔 | 4 秒 | ≥ 状态间隔 | modinfo `OBSERVER_SCAN_SECONDS` |

- `FindEntities` 的半径参数是**世界单位**，所以传 `radius_tiles * 4`（有单测守着）。
- 扫描结果缓存在 `O.nearby`，每次 state 只带缓存，并用 `nearby.scanned_at_tick` 标明它是第几个周期扫的。
- 扫描间隔换算成"每 N 个 state 周期扫一次"，避免两套定时器打架。
- 超过上限时 `truncated: true`，`scanned`（FindEntities 返回总数）与 `returned`（实际写出条数）分开给。

## 5. 日志片段

```json
"nearby": {
  "radius_tiles": 16, "scanned": 132, "returned": 18, "truncated": true,
  "scanned_at_tick": 45,
  "counts": { "tree": 6, "rock": 3, "harvestable": 4, "hostile": 2, "item": 2, "structure": 1 },
  "entities": [
    { "prefab": "evergreen", "name": "常青树", "category": "tree", "tile_x": 14, "tile_z": 10, "distance": 4, "work_left": 7 },
    { "prefab": "spider", "name": "蜘蛛", "category": "hostile", "tile_x": 12, "tile_z": 12, "distance": 2.2, "hp": 75 },
    { "prefab": "log", "name": "木头", "category": "item", "tile_x": 10, "tile_z": 11, "distance": 1.4 }
  ]
}
```

## 6. 测试方法（要你进游戏）

模组已装成 **v0.5.0**：

1. 保存退出世界 → 完全退出游戏 → 重新启动 → 读档；
2. 站在有树/草/石头的地方，并**动一动**（走动、捡东西），让扫描有变化；
3. 告诉我，我抓最新 state 的 `nearby` 段核对。

本地（不用进游戏）：

```powershell
node --test tests/phase1-entities.test.mjs   # 4 个用例
node --test "tests/*.test.mjs"               # 全项目 67 个用例
```

## 7. 通过标准

- [ ] `state.nearby` 出现，`radius_tiles` = 16（或你配的值）
- [ ] `entities` 里的 `tile_x/tile_z` 与游戏里看到的相对位置一致（你往东走，实体的 tile_x 应该越来越小/大得合理）
- [ ] `counts` 分类合理：树多的地方 `tree` 多，蜘蛛巢附近有 `hostile`
- [ ] 地上的木头/草堆出现在 `item`
- [ ] `scanned_at_tick` 每 4 个周期才变一次（说明没每帧扫）
- [ ] `observer.errors` 仍为 0

## 8. 已知限制

- **没有视线判定**：墙后/树后的东西也会被列出来（只按距离），后面可以加遮挡过滤。
- 只取"每类最近的 N 个"，不是全量；极端密集场景（蜘蛛巢爆怪）会被截断（`truncated:true`）。
- 洞穴分片同样适用（`FindEntities` 在洞里也能用），但洞穴实体标签更杂，分类会以 `creature`/`structure` 为主。
- 半径上限 40 格，避免一次扫描把服务端拖慢。
