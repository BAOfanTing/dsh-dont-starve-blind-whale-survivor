# M2.3 · 真机验收清单

> 前提：0.17.0 已装盘；**改过 Lua，必须重进世界**（状态文件 `mod=0.17.0` 才算加载）。
> 用**独立测试世界**，不要在重要存档里反复采资源。
> 要我代跑就说"测吧"：`node tools/m2_3_verify_harvest.mjs --bridgeDir <save> [--harvest]`

---

## 0. 准备

```powershell
# 版本核对（源码 + 已装都应 0.17.0）
Select-String 'DontStarveWhaleSurvivor\modinfo.lua' -Pattern '^version'
Select-String "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\modinfo.lua" -Pattern '^version'

# 新模块在位
Test-Path "E:\SteamLibrary\steamapps\common\Don't Starve Together\mods\DontStarveWhaleSurvivor\scripts\whale\harvestrules.lua"

# 世界是否加载 0.17.0
node tools/m2_3_verify_harvest.mjs --bridgeDir "C:\Users\BAOfanTing\OneDrive\文档\Klei\DoNotStarveTogether\893016408\Cluster_2\Master\save"
```

MCP（只有 `--harvest` 才用得到）：
```powershell
node tools/m2_0_2_start_mcp.mjs
Invoke-WebRequest http://127.0.0.1:18090/status -UseBasicParsing | Select-Object -Expand Content
```

---

## 测试 A：正常收获（**核心**）

1. 进世界，走到一株**已经成熟**的浆果丛旁边（看游戏里有没有浆果）。
2. `get_state` → 文本里应出现 `可收获：#N 浆果丛(...) 已成熟`。
3. 记下 `#N` 与那一帧的 `snapshot_id`。
4. MCP 调 `harvest`：`{"target_ref":"#N","snapshot_id":"<那一帧>"}`。
5. 预期：
   - 回执 `采下了 浆果丛（berries+1）`（背包没满时）；
   - 背包里浆果数量 +1；
   - 再 `get_state`：同一株的 `harvest_ready` 变成 **false**（倒数到下次再生）。

**判定**：回执与真实状态一致 = PASS。

## 测试 B：未成熟目标

找一株**刚被采过**的浆果丛（`harvest_ready: false`）：
- 预期 `not_ready`；
- **不产生任何原生收获动作**，世界状态不变。

## 测试 C：非白名单目标

对树 / 草 / 树苗 / 岩石 / 胡萝卜调用 `harvest`：
- 预期 `prefab_not_allowed`（或 `target_not_harvestable`）；
- 不产生副作用。

## 测试 D：过期引用

拿到 `#N` 后等一次附近刷新（约 4 秒，`snapshot_id` 会变），再用**旧** `snapshot_id`：
- 预期 `stale_snapshot`，命令不会写进游戏。

## 测试 E：超出原生距离

对 3 格以外的成熟浆果丛调 `harvest`：
- 预期 `out_of_range`（原生上限 ≈1.03 格）；
- **角色不会自己走过去**，世界不发生收获变化。

## 测试 F：move_to 后 harvest

1. 对远处目标先 `move_to` 靠近；
2. 重新 `get_state` 拿**新的** `#N` 与 `snapshot_id`（不能沿用旧的）；
3. 再 `harvest` → 成功，背包 +1。

## 测试 G：控制权换手

harvest 进行中由另一个控制主体请求租约：
- 确认 Lua 写出的 ACK 里 **`job_cleared` 是 true**（换手才可能完成）；
- 若旧动作还在跑（`job_cleared=false`），Node 必须**保持 revoking**、不放行；
- 换手完成后旧 owner 的命令被 generation/epoch 拒绝。

> 现在可以用 `node tools/m2_0_3_verify_lease.mjs` 复验这条链路（11 项）。

## 测试 H：与 Pickup 分离

如果收获的产物**掉在地上**（背包满时）：
- 下一次快照里它应出现在 `pickupables` 并拿到新的 `#N`；
- harvest **不会**自动接续 pickup；
- 由模型单独决定是否调用 `pickup`。

---

## 结果回报

```powershell
# 只读部分（结构/字段/负向用例）
node tools/m2_3_verify_harvest.mjs --bridgeDir "<save>"
# 含一次真实收获
node tools/m2_3_verify_harvest.mjs --bridgeDir "<save>" --harvest
```

脚本逐项打印 `PASS / FAIL / NOT_OBSERVED` 并汇总。
**没有观察到的项一律记 NOT_OBSERVED，不冒充通过。**

> 若出现"回执说成功但 `harvest_ready` 没变、背包也没变"，立即停止并保留
> `whale_state.json` + `whale_result.json` —— 那说明结果核对有漏洞。
