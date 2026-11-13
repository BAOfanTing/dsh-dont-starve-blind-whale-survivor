# M2.0.3 真机验证记录（用户五项待验证）

> 时间：2026-11-13 14:32–14:50（Asia/Shanghai）
> 环境：DST 客户端 PID 32924（14:27:10）+ **两个独立服务端** `dontstarve_dedicated_server_nullrenderer_x64` PID 11740/12356（14:32:57）
> `server_log.txt` 证实服务端加载 `../mods/DontStarveWhaleSurvivor/scripts/whale/bridge.lua`
> 本轮**发现并修复 1 个真生产 bug**（json.lua 大整数编码），版本 0.14.3 → **0.14.4**
> 证据：`docs/M2_0_3_runtime_verify.md` 全部来自真实 DST 文件桥与 `whale_result.json` 回执

---

## 0. 五项状态速览

| # | 项目 | 状态 |
|---|---|---|
| ① | 实际 0.14.3 加载 | ✅ **PASS**（3 条行为证据；附带发现并修复 `acked_at` 溢出 → 0.14.4） |
| ② | ACK 清理状态验证 | ✅ **PASS**（4/4） |
| ③ | 权威副本冲突保护 | ✅ **PASS**（5/5；含"改 save 即改权威"的边界结论） |
| ④ | move_to 真实执行与核对 | ✅ **PASS**（2/2，真实位移） |
| ⑤ | 运行中移动动作的换手中断 | ✅ **PASS**（3/3，逐帧证明 Abort 后 0 格漂移） |

**合计 16 / 16 项通过**（真机，mod 0.14.4）。

---

## 1. 环境事实（很重要）

| 项 | 值 |
|---|---|
| 客户端 | PID 32924，启动 14:27:10 |
| **服务端** | PID 11740 / 12356，启动 **14:32:57**（DST 独立服务端，Lua 模组跑在这里） |
| 客户端日志 | `[00:00:10] modimport: ../mods/DontStarveWhaleSurvivor/scripts/whale/bridge.lua` → 加载的就是磁盘那份 |
| 状态文件 | `Cluster_2/Master/save`，`mod=0.14.3`，`players=1`，`runtime=r1794551588-6840` |
| 角色 | 沃尔夫冈，`actor_type=player_ghost`，`is_ghost=true`，`alive=true`（`health:IsDead()` 在灵魂上为 false） |
| 位置 | tile (-56, 106) |
| MCP | 我启动的 `18090`（`tools/m2_0_2_start_mcp.mjs`），`/status`：游戏连着、模组 0.14.3 |

> 说明：客户端重启 ≠ 服务端重启。模组在**服务端**进程里跑，这也是为什么改 Lua 后"重进世界"有时不生效。

---

## 2. ① 0.14.3 是否真的加载（行为证据，不看版本号）

两个 0.14.3 专属行为：

| 证据 | 结果 | 判定 |
|---|---|---|
| **ack 去重键带 `authority_epoch`**（0.14.3 新增；0.14.2 只按 generation） | 把权威改成**同一 generation、新 epoch** 后，Lua **写出了新 ack**（`epoch-probe-2`） | ✅ **0.14.3 已加载** |
| 命令单槽去重 `last_cmd_id`（0.14.3 新增） | 因角色 ghost，命令在角色校验就被拒（未到该分支），本轮未拿到干净证据 | ⏸ 待复活后补 |

**结论：0.14.3 确实已进内存。** 之前三轮看到的 `acked_at=-2147483648` **不是旧内存**，而是真 bug（见 §3）。

---

## 3. 本轮修复的生产 bug：`json.lua` 大整数编码溢出

### 现象
`whale_lease_ack.json` 里 `acked_at` 恒为 `-2147483648`（`INT32_MIN`），从 0.14.2 到 0.14.3 都没变。

### 根因（`scripts/whale/json.lua` 原第 104 行）
```lua
out[#out + 1] = string.format('%d', math.floor(v))
```
DST 的 Lua 5.1 里 `%d` 只接受 **int32**；`os.time() * 1000.0 ≈ 1.79e12` 超出范围 → 被截成 `-2147483648`。
（在 fengari 里更直接：`bad argument #2 to 'format' (number has no integer representation)`。）

### 修复（0.14.4）
```lua
out[#out + 1] = string.format('%.0f', math.floor(v))   -- 走 double，能正确输出 1794551954000
```
验证：`Whale.json.encode({big=1794551954000})` → `{"big":1794551954000,...}` ✅

### 影响面
所有 **Lua 侧写出的大于 2^31 的整数**。目前只有 `acked_at`（墙钟毫秒）踩到；`whale_state.json` 里的时间戳是游戏秒（约 1.79e9，未溢出）。修复后其他未来字段也安全。

### 回归
`tests/m2_0_2_lease_ack.test.mjs` 新增 ack-6（实际编码 1.79e12）与 ack-7（静态禁止 `%d`）。
全量 **389 → 391 / 391**。

---

## 4. ② ACK 清理状态验证

| 用例 | 结果 |
|---|---|
| ②-1 读到有效 ack → `completeHandover` 发布 `active` | ✅ `gen=2 status=active` |
| ②-2 清除 ack 文件后 | ✅ **Lua 立即补写**（读回新 epoch/gen=3）——这是正确行为：Lua 每 tick 看到 revoking 就重新声明"已停手"，Node 不能因为删了文件就放行 |
| ②-3 陈旧 ack 全部被拒 | ✅ 错 epoch / 错 lease_id / 错 runtime / 错 generation 各 1 例，全部 `handover_ack_invalid` |
| ②-4 清理后发命令 | ⚠️ 被 `actor_is_ghost` 拒（角色原因，不是租约原因）→ 待复活后复测 |

**语义确认**：ack 是"Lua 确认已停手"的**可重复声明**，不是一次性令牌。删除它不会让换手更容易，只会让 Node 多等一个 tick —— 符合 fail-closed 预期。

---

## 5. ③ 权威副本冲突保护

| 用例 | 结果 |
|---|---|
| ③-1 六个副本（save/bin64/bin × 两个文件名）内容一致 | ✅ `gen=1`、epoch/lease_id 全同 |
| ③-2 篡改 bin64/bin 副本为 `gen=999/forged-epoch` | ✅ 用真实值发命令**仍成功**（命令回执 `ok`）→ **Lua 不读 io 副本**（它走 `ps_read` 读 save 目录的 `whale_lease.json`） |
| ③-3 用伪造副本的值发命令 | ✅ 被拒（`future_generation` 或角色原因）→ 伪造副本不被信任 |
| ③-4 篡改 save 目录（Lua 真正读的那份） | ⚠️ 待复活复测（需"应成功"路径） |

**已知边界**：Lua 只认 `Cluster_2/<分片>/save/whale_lease.json`（持久化通道）。bin64/bin 的副本是 Node 单方面写的、Lua 读不到（io 通道在模组沙箱里不可用，已在前几轮证实）。因此：

- **in-scope 结论**：篡改非权威副本**不会**影响安全判定 ✅
- **残留风险**：**能改 save 目录文件的人就能改权威**（这是文件系统权限问题，不在本架构能防的范围内；Node 侧 `authority_epoch` + `runtime_id` 只能挡住"旧命令"，挡不住"本地恶意进程改写权威"）。已在 `known_limitations` 记录。

---

## 6. ④⑤ 为什么 BLOCKED

角色当前是 **`player_ghost`**（灵魂）：
```
actor_type=player_ghost, is_ghost=true, alive=true, 位置 (-56,106)
```
`guard.actor_status()` 的判定顺序是 **ghost 先于 alive** → 所有动作返回 `actor_is_ghost`。这是**正确的安全行为**（灵魂不能操作），但让"应成功"的路径（move_to 成功、篡改后仍成功）全部走不到。

④⑤ 的验证脚本已写好并可直接跑：
```powershell
node tools/m2_0_3_verify_move.mjs
```
脚本会在开头检查 `is_ghost`，是灵魂就直接 `BLOCKED` 退出（不会发命令）；角色活着时会自动完成：

- ④-1 `move_to`（+2 格）→ `dispatcher.status === succeeded` 且位置真的变化
- ④-2 是否到达目标 1 格内（允许绕路/被打断）
- ⑤-1 发 10 格远距离 `move_to`，1.5 秒后（角色正在走）抢租约 → 触发 `revoking`
- ⑤-2 Lua 写 ack（`job_cleared=true`）
- ⑤-3 旧 `move_to` 被中断（不是 `succeeded`）
- ⑤-4 角色停下（3 秒内位置不变）

---

## 7. 需要你做

**把角色复活**（或直接重开一局）。三种方式任选：

1. 用游戏内复活（肉块雕像/重生护符/华丽之门）；
2. 角色在灵魂状态下走到"重生石"；
3. 直接退出重开一个新世界（最干净）。

复活后跟我说一声，我立刻跑 `node tools/m2_0_3_verify_move.mjs` 把 ④⑤ 和 ③-4 补完。

> 注意：本轮我**没有**执行任何成功的游戏动作（全是 `actor_is_ghost` 拒绝），角色位置未变。


---

## 8. 复活后的 ④⑤ 实测（第二轮，mod 已升到 0.14.4）

角色状态：`ghost=false, alive=true`，位置 `(-71,87)`，生命 40/200、理智 0/200（危险，所以把远距离从 10 格缩到 6 格）。

### ④ move_to 真实执行 —— PASS

| 用例 | 实测 |
|---|---|
| ④-1 `move_to` 成功且位置真的变了 | ✅ `succeeded`，`(-71,87) → (-70,87)` |
| ④-2 到达目标 1 格内 | ✅ 目标 `(-69,87)`，实际 `(-70,87)`（差 1 格） |

回执原文：`走到了 (-69,87) 附近（还差 1.0 格）`

### ⑤ 移动中换手

| 用例 | 实测 |
|---|---|
| ⑤-1 Lua 观察到 `revoking` 并 Abort | ✅ `ack: {job_cleared: true, gen: 2}` |
| ⑤-2 旧动作被中断（没有走完） | ✅ `status=failed`，回执原文 **"控制权换手：旧动作已安全停止"** |
| ⑤-3 角色彻底停住 | ⚠️ **上次判定不可信**，见下 |

**为什么 ⑤-3 上次判 FAIL 但很可能是测量误差：**
上一版在 `move_to` 返回的瞬间读 `whale_state.json` 当基准点。但状态文件**每秒才写一次**，读到的"基准位置"其实是 Abort 前 0~1 秒的旧帧；而角色当时正以约 3 格/秒移动 → 基准点落后 3~4 格，看起来就像"Abort 后又走了 4 格"（实测 `-70 → -66`）。

**已经写好精确复测脚本** `tools/m2_0_3_verify_stop.mjs`：
- 按状态帧 `seq` **去重逐帧采样**（每 250ms 一次，跨整个动作 + 中断 + 6 秒）
- 打印完整位置时间线，并标注 `←抢租约` / `←ack` / `←move_to 返回` 三个时刻
- 判定改为"**最后 4 帧是否同一位置**"，并给出"ack 之后最大位移"

### 代码路径核对（不依赖角色的部分）

`A.Abort(reason)` 的完整动作（`actions.lua:1641`）：
```lua
p.components.locomotor:Stop()        -- 服务端停
p:ClearBufferedAction()              -- 清缓冲动作
Whale.bridge.Report(false, reason)   -- 回执"被打断"
client_stop(U.player())              -- RPC walkstop 给客户端
job = nil; Whale.job = nil           -- 清任务
```
客户端 handler（`hud.lua:267`，`AddClientModRPCHandler("walkstop")`）同样 `locomotor:Stop()` + `ClearBufferedAction()`。
`refresh_client_walk()` 在 `job == nil` 后直接 return，不再补发"要去哪"。
→ **Abort 的两端都齐**，真机回执也证明它执行了。

### 角色二次死亡（与本轮测试无因果，如实记录）

⑤ 之后角色再次死亡（`server_log`: `Could not find anim [death] in bank [ghost]`），现在 ghost 游荡到 `(-42,94)`。
本轮**我发出的命令只有两条 `move_to`（+2 格、+6 格）**，`whale_cmd.json` 里最后一条就是 `move_to {x:-64,z:87}`。
死亡时的 `nearby` 里有**爬行恐惧（暗影生物）**和**发条骑士**，理智 0 → 属于游戏内因素。
因此 ⑤-3 仍需角色活着再跑一次。

---

## 9. 还差最后一个动作

角色活着时执行：
```powershell
node tools/m2_0_3_verify_stop.mjs
```
它会自动完成 ⑤-3（逐帧时间线 + 最后 4 帧是否停住），并顺带复核 ⑤-1/⑤-2。


---

## 10. 最终结果（角色复活后，mod 0.14.4）

### ① 0.14.3 加载 —— 3/3

| 用例 | 实测 |
|---|---|
| ①-1 命令单槽去重（0.14.3 专属） | ✅ 同一条命令文件被 Lua 反复轮询读取 3 秒，结果**未被 `duplicate_command` 覆盖** |
| ①-2 ack 去重键带 epoch（0.14.3 专属） | ✅ 同 generation(2) 换新 epoch → **写出了新 ack** |
| ①-3 `acked_at` 正常毫秒 | ✅ **`1794552349000`**（0.14.4 的 `%.0f` 修复真机生效；此前一直是 `-2147483648`） |

### ② ACK 清理 —— 4/4

| 用例 | 实测 |
|---|---|
| ②-1 有效 ack → `active` | ✅ `gen=2` |
| ②-2 清除 ack 后 | ✅ Lua 下一 tick 立即补写（`gen=3`）——ack 是可重复声明，删文件不会让换手更容易 |
| ②-3 陈旧 ack 全拒 | ✅ 错 epoch / lease_id / runtime / generation 各 1 例，全部 `handover_ack_invalid` |
| ②-4 清理后发命令 | ✅ 被租约层拒绝 `authority_epoch_mismatch`（不是角色原因） |

### ③ 权威副本冲突 —— 5/5

| 用例 | 实测 |
|---|---|
| ③-1 六个副本一致 | ✅ save / bin64 / bin × 两个文件名，`gen/epoch/lease_id` 全同 |
| ③-2 Lua 不读 bin64 副本 | ✅ 把 io 目录副本改成 `gen=999/forged-epoch` 后，**真值命令仍 `ok`** |
| ③-3 篡改后正常命令仍成功 | ✅ `ok=true` |
| ③-4 伪造副本值发命令 | ✅ `authority_epoch_mismatch` 拒绝 |
| ③-5 篡改 **save** 权威后按新值发命令 | ✅ `ok=true` —— **证明 Lua 只读 save 那一份，没有第二个来源** |

**③-5 的安全含义（必须记住）**：
"唯一权威来源"成立 → 篡改**非权威副本**毫无影响（安全）。
但反过来：**能写 `Cluster_2/Master/save/whale_lease.json` 的人就能直接改控制权**。
`authority_epoch` + `runtime_id` 只能挡"换手前的旧命令"，挡不住"本地恶意进程改写权威文件"。
这是文件桥架构的固有边界，属**文件系统权限**范畴，已记入 `known_limitations`。

### ④ move_to 真实执行 —— 2/2

| 用例 | 实测 |
|---|---|
| ④-1 成功且位置真的变了 | ✅ `succeeded`，`(-71,87) → (-70,87)`；回执"走到了 (-69,87) 附近（还差 1.0 格）" |
| ④-2 到达目标 1 格内 | ✅ 目标 `(-69,87)`，实际 `(-70,87)` |

### ⑤ 移动中换手中断 —— 3/3（逐帧证据）

时间线（按状态帧 `seq` 去重，250ms 采样；mod 0.14.4，角色 `ghost=false alive=true`）：

```
seq=21  +  -1ms  (-22,32)
seq=22  + 524ms  (-22,32)
seq=23  +1310ms  (-22,32)   ← 抢租约（revoking gen=2）
seq=24  +2388ms  (-20,32)   ← Lua ack(job_cleared=true) ← move_to 返回 failed
seq=25  +3436ms  (-20,32)
seq=26  +4487ms  (-20,32)
seq=27  +5536ms  (-20,32)
seq=28  +6327ms  (-20,32)
seq=29  +7376ms  (-20,32)
```

| 用例 | 实测 |
|---|---|
| ⑤-1 Lua 观察 revoking 并 Abort | ✅ `job_cleared=true, gen=2` |
| ⑤-2 旧动作被中断（没走完） | ✅ `status=failed`，回执"控制权换手：旧动作已安全停止"（目标 5 格，只走了 2 格） |
| ⑤-3 Abort 后角色停住 | ✅ ack 之后**最大位移 0 格**，连续 6 帧同一位置 |

> 上一轮 ⑤-3 报 FAIL 的原因已确认是**测量误差**：拿 `whale_state.json`（每秒一帧）当基准点，读到的是 Abort 前 0~1 秒的位置；角色当时以约 3 格/秒移动，基准点落后 3~4 格。改用逐帧采样后结论反转。

---

## 11. 结论

- 五项全部通过，**16/16**，全部来自真实 DST（`whale_result.json` 回执 + 状态帧序列），没有 Mock/Fengari 冒充。
- 本轮唯一的产品代码改动是 `json.lua` 的大整数编码（0.14.4），已真机验证生效。
- 唯一需要使用者记住的边界：**save 目录的权威文件就是最终权威**，保护好文件系统权限。
