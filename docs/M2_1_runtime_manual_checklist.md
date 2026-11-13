# M2.1 · Pickup 真机验收清单

> 前提：0.15.0 已装盘；**改过 Lua，必须重进世界**（状态文件 `mod=0.15.0` 才算加载）。
> 用**独立测试世界**。本阶段只开放 `pickup`，不开放砍树/挖矿/制作/战斗。
> 需要我代跑的话，直接说"测吧"，我执行 `node tools/m2_1_verify_pickup.mjs`。

---

## 0. 准备

```powershell
# 版本核对（源码 + 已装都应 0.15.0）
Select-String 'DontStarveWhaleSurvivor\modinfo.lua' -Pattern '^version'
Select-String "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\modinfo.lua" -Pattern '^version'

# 世界是否已加载 0.15.0（看状态文件 mod 字段）
node tools/m14-watch.mjs --seconds 10
```

MCP 服务（我这边用产品 `apply()` 起的临时进程）：
```powershell
node tools/m2_0_2_start_mcp.mjs
Invoke-WebRequest http://127.0.0.1:18090/status -UseBasicParsing | Select-Object -Expand Content
```

---

## 测试 A：正常拾取（**核心**）

1. 进世界，走到有**树枝 / 割下的草 / 燧石**的地上（不要用背包里的）。
2. 调 `get_state`，在「附近 · 资源」里找到形如 `#1 树枝 距1.2` 的条目，**记下 `snapshot_id`**（JSON 里 `nearby.snapshot_id`）。
3. 调 `pickup`：`{"target_ref":"#1","snapshot_id":"<刚记的>"}`。
4. 预期：
   - 返回 `succeeded`，消息类似「捡起了 树枝（背包：twigs+1）」；
   - 再 `get_state`，背包里出现该物品、数量 +1；
   - 附近列表里那一条消失（或变了编号）。

## 测试 B：不该捡的东西（零副作用）

对**树 / 建筑 / 容器 / 生物**用 `pickup`：

| 目标 | 预期 |
|---|---|
| 常青树 / 多枝树 | `prefab_not_allowed` |
| 箱子 / 冰箱 | `prefab_not_allowed`（或 `target_not_pickable`） |
| 兔子 / 蜜蜂 / 猪人 | `prefab_not_allowed` |

**必须确认**：角色不动、物品不掉、世界状态没变。

## 测试 C：过期引用

1. 记下 `#N` 与 `snapshot_id`。
2. 等 5 秒以上（附近重新扫描，`snapshot_id` 会变）。
3. 用**旧** `snapshot_id` + 旧 `#N` 调 `pickup`。
4. 预期：`stale_snapshot`（Node 侧就会拒，命令不会写进游戏）。

## 测试 D：背包满

把背包塞满（或用一个装不下该物品的状态）再拾取。

预期：
- `inventory_full`（Lua 用原生 `CanAcceptCount` 预判），或原生拒绝；
- **地面物品不消失**；
- 绝不返回 `succeeded`。

## 测试 E：距离

对着 3 格以外的物品拾取。

预期：`out_of_range`（上限 2.5 格），**角色不会自己走过去**。

## 测试 F：换手（与 M2.0.3 同法）

1. MCP 持有租约，执行一次 `pickup` 或 `move_to`。
2. 另一控制主体请求换手（`force`）。
3. 确认：Lua 写 `job_cleared=true` 的确认、旧动作终止、新主体拿到 `active`、旧命令被拒。

---

## 结果回报格式

```powershell
# 最近一次结果
Get-Content "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_2\Master\save\whale_result.json"
# 当前状态（看背包与附近）
node tools/m14-watch.mjs --seconds 5
```

重点：**A 是否真进背包**、**B/D/E 是否零副作用**、**C 是否 stale_snapshot**。

> 如果任一项出现"报告成功了但背包没变"，立即停止并保留 `whale_result.json` —— 那说明结果核对有漏洞。
