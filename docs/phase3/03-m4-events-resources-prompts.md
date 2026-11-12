# Phase 3 · M4：事件流 + Resources + Prompts

> 结论：`get_recent_events` 实现（MCP 层对比连续快照产出事件）、6 个只读 Resources、4 个分析 Prompts 全部就位，
> 46 个 MCP 测试全过。**过程中修掉一个会让整个通信停摆的真 bug**（见 §5）。

## 1. 改动的文件

| 文件 | 内容 |
|---|---|
| `mcp-server/src/tools/events.ts` | **新增**：`EventDetector` —— 18 类事件、环形缓冲、阈值去噪、stale 感知 |
| `mcp-server/src/tools/readTools.ts` | `get_recent_events` 真实现；`readState()` 顺带喂事件流 |
| `mcp-server/src/resources/gameResources.ts` | **新增**：6 个 Resources |
| `mcp-server/src/prompts/gamePrompts.ts` | **新增**：4 个 Prompts |
| `mcp-server/src/server/createServer.ts` | 注册 resources + prompts，版本 0.3.0-m4 |
| `game-bridge/src/routes.ts` | `/api/v1/state` 会话选择修正（见 §5.2） |
| `DontStarveWhaleSurvivor/scripts/main/net.lua` | 周期任务失效后重建（见 §5.1），模组 0.9.2 |
| `mcp-server/test/m4.test.ts` | **新增** 15 个用例 |

## 2. 事件流（18 类事件）

| 类别 | 事件 | 触发条件 |
|---|---|---|
| 生命 | `health_dropped` / `health_restored` | 变化 ≥ 1%；掉 ≥20 个百分点算 `critical` |
| 饥饿 | `hunger_dropped` / `hunger_restored` | 变化 ≥ 0.5%；饥饿 ≤15% 算 `critical` |
| 理智 | `sanity_dropped` / `sanity_restored` | 变化 ≥ 1% |
| 生死 | `player_died` / `player_revived` / `became_ghost` | 状态翻转 |
| 世界 | `day_changed` / `phase_changed` / `season_changed` / `weather_changed` | 值变化 |
| 威胁 | `threats_appeared` / `threats_cleared` | hostile 数量变化 |
| 背包 | `inventory_changed` | 物品签名变化 |
| 连接 | `state_stale` / `state_recovered` | 新鲜度翻转 |

设计要点：

- **过期数据不参与差分**（避免拿旧值当变化），只报 `state_stale`；
- 阈值故意设小（饥饿 0.5%）：饥荒里饥饿约每秒掉 0.1~0.2%，阈值设 3% 永远不触发（这是实测踩到的坑）；
- 环形缓冲默认 200 条；支持按类型/严重程度/序号增量过滤。

## 3. Resources（6 个）

| URI | 内容 |
|---|---|
| `dst://game/status` | 总览（玩家+世界+背包+附近元信息+新鲜度） |
| `dst://game/player` | 玩家状态 |
| `dst://game/inventory` | 背包（items 已归一化为数组） |
| `dst://game/world` | 世界状态 |
| `dst://game/nearby` | 附近实体（按距离排序 + 类别统计） |
| `dst://game/bridge` | 通道状态（不依赖游戏是否在跑） |

全部返回 `application/json` 文本，带 `freshness` 块。

## 4. Prompts（4 个）

| 名称 | 用途 | 参数 |
|---|---|---|
| `survival_report` | 生存报告：三项数值、风险排序、数据可靠性、建议 | `focus`（可选） |
| `resource_assessment` | 资源评估：食物/木材/石头/草/燃料够不够 | `goal`（可选） |
| `night_preparation` | 夜晚准备：距离天黑、有无光源、风险 | 无 |
| `season_preparation` | 季节准备：剩余天数、装备缺口、准备清单 | `next_season`（可选） |

每个 Prompt 都包含：**取数步骤**（调哪个工具）+ **分析要点** + **必须遵守的规则**（检查 freshness、不编造字段、禁止写操作）。

## 5. 过程中修掉的两个真 bug

### 5.1 【严重】世界重载后 HTTP 通道永久停摆

**现象**：换存档后 Bridge 只收到 11 次 telemetry、**0 次 heartbeat**，`connected=false`，但游戏日志里
`[BWS]` 日志通道还在正常推（tick 33→35）。游戏端只有一条 `offline → online` 就再没动静。

**根因**：`net.start()` 用 `started` 布尔守卫。换存档 / 世界重载会清掉旧的 `DoPeriodicTask`，
但 `started` 仍是 `true` → 守卫认为"已经启动了" → **周期任务永久消失**。

**修复**：改成检查**任务对象是否还有效**（`tickTask:IsValid()`），失效就重建。
拿不到 `IsValid` 时保守认为还活着，避免重复建任务。

```lua
if started and tickTask ~= nil then
    local ok_alive, alive = pcall(function() return tickTask:IsValid() end)
    if not ok_alive or alive ~= false then return false end
    print('[BWS2] WARN net 周期任务已失效（世界重载过？），重新创建')
    tickTask = nil
    started = false
end
```

模组升到 **0.9.2**。这个 bug 只在"换存档/重载世界"时出现，之前几轮测试都没覆盖到。

### 5.2 【中】多分片下 `/api/v1/state` 选错分片

**现象**：`resources/read dst://game/player` 能读到薇洛，但 `get_player_status` 报"这个分片里没有玩家"；
`get_nearby_threats` 报"敌对 0"而 master 实际有 4 个。

**根因**：Bridge 选会话时只按"活着 + 有快照"，主世界和洞穴都在推数据，可能选到空洞穴。

**修复**：两级优先 —— ① 有玩家的分片优先；② 同优先级里按最近心跳排序（这样换存档后新会话能顶掉旧会话）。

同时在 `get_player_status` 里加了**自动换分片重试**：没指定 shard 且没玩家时，自动试 master/caves。

## 6. 实际运行验证

### Resources / Prompts（真实 MCP 协议）

```
resources/list: 6 个 -> dst://game/status, dst://game/player, dst://game/inventory,
                       dst://game/world, dst://game/nearby, dst://game/bridge
prompts/list:   4 个 -> survival_report, resource_assessment, night_preparation, season_preparation

resources/read dst://game/player:
  stale=false age=1281ms 玩家=薇洛 生命=33.3%
```

### 数据（真实游戏）

```
shard=master stale=False age=1505ms
nearby: scanned=156 returned=40
类别: item=10 harvestable=10 tree=10 structure=2 damageable=4 rock=3 diggable=1
  [item] 南瓜灯 d=1.2        ← M3 的「带 inventoryitem 不算生物」修正已生效 ✅
  [item] 种子 d=1.4
  [item] 红雀 d=1.5
```

**南瓜灯现在正确归为 `item`** —— 这是 M3 遗留的验证点，已确认修复生效。

### 事件流

连续读 3 次玩家状态（间隔 5 秒），饥饿 66.7% 保持不变 —— 因为游戏被暂停（`Sim paused`），
所以没有事件产生，工具如实返回"还没有事件"而不是编造。这是正确行为。

## 7. 测试

```
✔ 事件流：首次没有基线 → 不产生事件
✔ 事件流：生命下降 / 饥饿下降 / 理智下降
✔ 事件流：低于阈值不产生噪声事件
✔ 事件流：昼夜 / 季节 / 天气 / 天数变化
✔ 事件流：敌对生物出现 / 消失
✔ 事件流：背包变化 + 死亡/幽灵
✔ 事件流：数据过期时不比较数值，只报 stale / recovered
✔ 事件流：环形缓冲上限 + 过滤 + 增量拉取
✔ Resources：6 个，URI 全部符合 dst:// 约定
✔ Prompts：4 个，都只给分析指导且都要求检查新鲜度
✔ 协议：resources/list 返回 6 个资源
✔ 协议：resources/read 读取 dst://game/bridge（不依赖游戏是否在跑）
✔ 协议：prompts/list 返回 4 个提示词，且带参数说明
✔ 协议：prompts/get 生成的文本包含取数步骤与新鲜度要求
✔ 协议：四个 Prompt 都能取到，且都禁止写操作
# tests 15 / pass 15
```

## 8. 全量回归

| 套件 | 用例 | 结果 |
|---|---|---|
| MCP Server（M1+M2+M3+M4） | 46 | 全过 |
| Phase 2 game-bridge | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| Lua / 插件侧 | 108 | 全过 |

## 9. 未完成 / 风险

1. **事件流只在 MCP 进程内**：进程重启后从零开始；多客户端（stdio + HTTP）各有一份，不共享。
2. **事件阈值是经验值**：饥饿 0.5% 在正常游玩下能触发，但游戏暂停时不会产生任何事件（正确，但 AI 可能误以为"没事发生"）。
3. **换存档后旧会话仍留在 Bridge 列表里**：`/api/v1/state` 已经能选对（按心跳排序），但 `get_bridge_status` 里会看到一堆历史会话。M5/M6 可以加 TTL 清理。
4. **`get_base_status` 的启发式仍有误判可能**：没有游戏内基地概念，靠结构/容器/光源打分。
5. **模组 0.9.2 需要重启游戏才生效**：本次验证用的是 0.9.1（周期任务 bug 还在），
   所以**换存档后心跳停摆的修复还没在真实环境验证过**。

## 10. 下一步（M5）

Streamable HTTP 传输（端口 8790）：`NodeStreamableHTTPServerTransport` + Host/Origin 校验 +
请求体大小限制 + 会话管理 + 与 stdio 共用同一套 Tool Registry。
