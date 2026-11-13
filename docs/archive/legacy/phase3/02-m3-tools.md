# Phase 3 · M3：第一批只读工具全部实现

> 结论：**12 个工具里 11 个真实现**（只剩 `get_recent_events` 留到 M4），
> 全部走 M2 的 `readSnapshot()` + 统一新鲜度标注；数据过期时明确写"不代表当前"，不把旧数据当现状。
> 31 个 MCP 测试全过（真实 HTTP 假 Bridge），并已对着真实 Bridge 跑通 8 个工具。

## 1. 改动的文件

| 文件 | 内容 |
|---|---|
| `mcp-server/src/tools/snapshot.ts` | **新增**：快照取数的公共件（类型安全的字段抽取、Lua 空表 `{}` → `[]` 归一化、`Freshness` 信封、实体/物品解析） |
| `mcp-server/src/tools/readTools.ts` | **新增**：10 个只读工具的真实实现（约 600 行） |
| `mcp-server/src/tools/definitions.ts` | 重写为"基础设施 + 组合"：`ToolResult` / `ToolDefinition` / `errorResult` / `runTool` + `createBridgeStatusTool()` + 组合去重 |
| `mcp-server/test/m3.test.ts` | **新增** 15 个用例 |

## 2. 12 个工具的最终状态

| # | 工具 | 状态 | 数据来源 |
|---|---|---|---|
| 1 | `get_game_status` | ✅ | 快照总览（玩家+世界+背包+附近元信息） |
| 2 | `get_bridge_status` | ✅ | `/health` + `/bridge/status` + 快照新鲜度 |
| 3 | `get_player_status` | ✅ | 快照 `player` |
| 4 | `get_inventory` | ✅ | 快照 `inventory`（含装备栏） |
| 5 | `get_world_status` | ✅ | 快照 `world`（含洞穴相位） |
| 6 | `get_nearby_entities` | ✅ | 快照 `nearby.entities`（按距离排序 + 类别过滤） |
| 7 | `get_nearby_resources` | ✅ | 同上，过滤 harvestable/tree/rock/diggable/item |
| 8 | `get_nearby_threats` | ✅ | 同上，hostile 优先 + 带血量生物 |
| 9 | `get_base_status` | ✅ | 启发式：结构/容器/光源打分（**不是**游戏内基地概念） |
| 10 | `refresh_game_state` | ✅ | 下发 `refresh_state` 命令 + 等结果 + 强制读新快照 |
| 11 | `get_command_result` | ✅ | `/api/v1/commands` 按 id 查 |
| 12 | `get_recent_events` | ⛔ NOT_IMPLEMENTED | 需要事件流缓存，留 M4 |

## 3. 统一的输出契约

每个工具都返回：

```jsonc
{
  "content": [{ "type": "text", "text": "第一行永远是新鲜度提示\n后续是人类可读摘要" }],
  "structuredContent": {
    "ok": true,
    "freshness": {
      "stale": false, "stale_reason": null, "age_ms": 1200,
      "snapshot_at": 1794447000500, "stale_after_ms": 15000,
      "from_cache": true, "session_alive": true,
      "session_id": "26FA…-master-…", "shard": "master"
    },
    // …该工具自己的数据
  }
}
```

失败时：

```jsonc
{ "isError": true, "content": [{ "text": "[GAME_DISCONNECTED] …" }],
  "structuredContent": { "ok": false, "error": { "code": "GAME_DISCONNECTED", "message": "…", "hint": "…" } } }
```

## 4. 实际运行日志（对着真实 Bridge，游戏未运行）

```
───── get_game_status ─────
⚠️ 数据已过期（heartbeat_timeout，约 36864 秒前）—— 以下是最后一次已知状态，不代表当前
会话：26FA73B94506B226-master-1794410203 [master] alive=false
玩家：威尔逊 生命 33.3% 饥饿 66.7% 理智 50%
世界：第 3 天 day autumn 温度 30.6

───── get_player_status ─────
玩家：威尔逊（幽灵）
生命：50/150（33.3%）
饥饿：100/150（66.7%）

───── get_inventory ─────
背包：0/15 格
  （空）

───── get_world_status ─────
世界：第 3 天（cycles 2），day，autumn
季节进度：已过 2 天 / 还剩 18 天
温度：30.6

───── get_nearby_entities ─────
附近 16 格内扫到 134 个实体，返回 40 个（已裁剪）
类别统计：damageable=2 creature=9 item=6 harvestable=9 tree=10 diggable=2 rock=1 hostile=1
  · [damageable] 骷髅 @(-118,18) 距离 0 work_left=3

───── get_nearby_threats ─────
威胁等级：高（附近有敌对生物）
敌对 1 个，带血量的生物 9 个（半径 16 格）
  最近：南瓜灯 距离 1.3 hp=100

───── get_base_status ─────
基地判断（启发式，半径 16 格）：只有零星结构
结构物 0 个，其中容器 0 个；光源 3 个；可破坏物 2 个

───── get_recent_events ─────
[NOT_IMPLEMENTED] 事件流还没实现（计划在 M4）
建议：当前可以用 get_player_status / get_world_status 对比两次调用的差异来推断变化
```

工具执行日志：

```
INFO 工具执行 {"tool":"get_game_status","ok":true,"ms":28,"args":["include_raw"]}
INFO 工具执行 {"tool":"get_player_status","ok":true,"ms":0,"args":[]}
INFO 工具执行 {"tool":"get_inventory","ok":true,"ms":0,"args":["include_empty"]}
INFO 工具执行 {"tool":"get_world_status","ok":true,"ms":2,"args":[]}
INFO 工具执行 {"tool":"get_nearby_entities","ok":true,"ms":0,"args":["radius_tiles","limit"]}
INFO 工具执行 {"tool":"get_nearby_threats","ok":true,"ms":1,"args":["radius_tiles","limit"]}
INFO 工具执行 {"tool":"get_base_status","ok":true,"ms":2,"args":["radius_tiles","limit"]}
INFO 工具执行 {"tool":"get_recent_events","ok":false,"ms":0,"args":["limit"],"code":"NOT_IMPLEMENTED"}
```

## 5. 这份数据暴露的两个真实问题（都记下来）

### ① 旧快照里的「南瓜灯」被算成威胁

`get_nearby_threats` 报"最近：南瓜灯 距离 1.3 hp=100"。原因是这份快照是 **10 小时前的**，
而「带 `inventoryitem` 的实体不算生物」这个修正是 Phase 2 M5（模组 v0.9.1）才加的 ——
旧数据里南瓜灯还是 `creature` 类别。**需要开游戏用新模组验证修正是否生效。**

### ② `get_base_status` 说"结构物 0 个"但同时"光源 3 个"

因为南瓜灯归到 creature 了，所以 structures 里没有它，但光源判定按名字匹配抓到了它。
两个数字不矛盾，但读起来别扭。**M4 可以改进**：光源判定只在 structure/creature 都算完之后统一归类。

### ③ 玩家处于幽灵状态

`is_ghost: true` + 生命 50/150 —— 说明上次游戏结束时玩家死了变幽灵。
工具如实反映，这是正确行为（AI 看到这个应该建议复活/重开）。

## 6. 测试

```
✔ 工具清单：12 个工具，全部只读，无重复
✔ get_player_status：解析出生命/饥饿/理智/坐标
✔ get_inventory：物品数量/耐久/新鲜度/燃料 + 装备栏
✔ get_world_status：天数/季节/昼夜/天气/月相
✔ get_nearby_entities：按距离排序 + 类别过滤 + 类别统计
✔ get_nearby_resources：只返回可获取资源类别
✔ get_nearby_threats：敌对优先，威胁等级正确
✔ get_base_status：启发式基地判定
✔ 数据过期时：工具如实标注 stale，而不是假装新鲜
✔ 快照缺 nearby 时：环境类工具明确报错（不编数据）
✔ 没有玩家时：get_player_status 报 GAME_DISCONNECTED 并给分片提示
✔ get_recent_events：还没实现，老实返回 NOT_IMPLEMENTED
✔ get_command_result：格式校验 + 查不到时报错
✔ refresh_game_state：下发命令并等结果，成功后强制读新快照
✔ get_bridge_status：通道状态 + 快照新鲜度
# tests 15 / pass 15
```

其中一条测试专门防"工具越权"：**所有工具名按 `_` 分段后不允许出现 move/attack/chop/mine/eat/craft/build/drop/kill/teleport**。

## 7. 全量回归

| 套件 | 用例 | 结果 |
|---|---|---|
| MCP Server（M1+M2+M3） | 31 | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |

## 8. 未完成 / 风险

1. **`get_recent_events` 没实现**（M4）：需要事件流缓存（对比两次快照产生事件）。
2. **真实数据验证不足**：这次只验证了"过期数据"路径（游戏没开），**没有用新鲜数据跑过**。
   需要开一次游戏确认：南瓜灯分类是否已修正、实体统计是否合理、背包/装备解析是否正确。
3. **`get_base_status` 是启发式**：没有游戏内"基地"概念，靠结构/容器/光源打分，可能误判。
   已在工具描述里写明"启发式"，避免 AI 当成事实。
4. **附近实体上限**：游戏端每次扫描最多返回 40 个（日志长度限制），所以 `get_nearby_entities` 最多看到 40 个，
   `scanned` 字段会告诉 AI 实际扫到多少（如 134 个）。已如实透出 `truncated: true`。
5. **`refresh_game_state` 依赖游戏响应**：游戏暂停时命令不会执行，工具会 `TOOL_TIMEOUT`（如实报错）。

## 9. 下一步（M4）

- 实现 `get_recent_events`（事件流缓存：对比连续快照，产出"受伤/饥饿变化/昼夜切换/发现威胁"等事件）
- 实现 MCP Resources（6 个只读资源）
- 实现 MCP Prompts（4 个分析指导）
