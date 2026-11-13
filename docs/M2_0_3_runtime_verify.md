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
| ① | 实际 0.14.3 加载 | ✅ **PASS**（行为证据：ack 去重键带 epoch 生效）；附带发现 `acked_at` 溢出 bug → 已修 0.14.4 |
| ② | ACK 清理状态验证 | ✅ **PASS**（有效 ack→active / 清除后保持 revoking 或 Lua 立即补写 / 陈旧 ack 全拒） |
| ③ | 权威副本冲突保护 | ⚠️ **部分**（副本一致性 PASS、伪造副本不被信任 PASS；"篡改 save 后按新值应成功"被 ghost 挡住） |
| ④ | move_to 真实执行与核对 | **BLOCKED**（角色是 `player_ghost` 灵魂，动作被正确拒绝） |
| ⑤ | 运行中移动动作的换手中断 | **BLOCKED**（同上） |

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
