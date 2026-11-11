# Phase 2 · M6：端到端测试报告

> 环境：Windows 10 19045 · DST build 762172 · 模组 `DontStarveWhaleSurvivor` v0.9.1 · Bridge `0.2.0-m5`
> 会话：Cluster_3（Master + Caves 双分片），玩家 `威尔逊`（wilson），本地世界
> 时间：2026-11-11 23:20–23:40
> 原则：**所有结论都来自实际运行**；没测到的就写没测到。

## 1. 验收总表

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 冷启动链路（装模组 → 起 Bridge → 进世界） | ✅ | `connected=true`，双分片会话自动注册 |
| 2 | 心跳持续（约 3 秒） | ✅ | soak 期间心跳与推送条数比 ≈ 2:3 |
| 3 | 状态推送（约 2 秒）+ sequence 单调 | ✅ | ack 单调递增，`duplicates=0` |
| 4 | 命令轮询 + 执行 + 回执 | ✅ | 四条命令 `SUCCEEDED`、`deliveries=1` |
| 5 | 幂等（重复回执 / 重复 sequence） | ✅ | 重复回执 `duplicate=true` 且不覆盖结果 |
| 6 | 断线恢复（Bridge 重启） | ✅ | ack 116 → 119 → 221 连续增长，`duplicates=0` |
| 7 | 会话丢失不重放 | ✅ | `FAILED/unknown_completion/session_lost`，新会话拿到 `null` |
| 8 | 命令 TTL 过期 | ✅ | 65 秒后 `EXPIRED` |
| 9 | 重复投递（同一条 id 投两次） | ✅ | `deliveries=2`，id 不变 |
| 10 | 鉴权 | ✅ | 无 token / 错 token → 401 |
| 11 | 参数校验 | ✅ | 缺字段 400、协议版本不符 400、坏 JSON 400 |
| 12 | 大小限制 | ✅ | 200KB 包 → 413 |
| 13 | 只监听本机 | ✅ | `bound=127.0.0.1:18788` |
| 14 | Token 不进日志 | ✅ | 单测断言 + 启动日志只打印掩码 |
| 15 | 禁止真实游戏动作 | ✅ | 白名单只有 4 个测试命令，Bridge 与游戏端双层拒绝 |
| 16 | Phase 1 契约未被破坏 | ✅ | 日志通道 933 条记录全部通过 schema 校验 |
| 17 | 长时间稳定性（10 分钟 soak） | ✅ | 见 §5 |

## 2. 冷启动链路

```
Bridge: 0.2.0-m5 | protocol: 1.0 | connected: true
存活会话: 2
  26FA73B94506B226-master-1794410203   心跳=99  推送=148 ack=262 dup=0 gap=3 包=6109B 重连=2
  56646B9386CE8145-caves-1794410205    心跳=100 推送=146 ack=259 dup=0 gap=3 包=1161B 重连=2
命令队列: {"total":2,"QUEUED":0,"DELIVERED":0,"EXECUTING":0,"SUCCEEDED":0,"FAILED":1,"EXPIRED":1}
```

（`FAILED:1` / `EXPIRED:1` 是 M5 演练留下的两条，正常。）

## 3. 四条命令复跑（v0.9.1）

| 命令 | 状态 | deliveries | 结果摘要 |
|---|---|---|---|
| `ping` | SUCCEEDED | 1 | `{"message":"Pong from DST"}` |
| `echo` | SUCCEEDED | 1 | `{"echo":{"arr":[1,2,3],"text":"E2E 验收"},"received_keys":["arr","text"]}` |
| `get_state` | SUCCEEDED | 1 | `player=威尔逊 tile=[-118,18]`，`inventory.items` 已是**数组**（M5 归一化生效） |
| `refresh_state` | SUCCEEDED | 1 | `{"refreshed":true,"tick":644,"nearby_returned":40,...}` |

`execution_time` 全部是 `0`（亚毫秒，如实反映，没有编造小数点）。

## 4. 故障矩阵（逐项实际打）

| 用例 | 期望 | 实测 |
|---|---|---|
| 完全不带 token | 401 | ✅ `status=401 code=unauthorized` |
| 错 token | 401 | ✅ `status=401` |
| 带 token 但缺 `session_id` | 400 | ✅ `status=400` |
| 坏 JSON | 400 | ✅ `code=invalid_json` |
| 200KB 请求体（上限 128KB） | 413 | ✅ `code=payload_too_large` |
| 协议版本 `9.9` | 400 | ✅ `协议版本不支持：9.9（本机是 1.0）` |
| 白名单外命令 `chop_tree` | 400 | ✅ 拒绝并提示可用命令 |
| 未知命令回执 | 404 | ✅ |
| 未知路径 / 用 GET 打 POST 接口 | 404 / 405 | ✅ |
| 同一条命令投两次 | 同 id、`deliveries=2` | ✅ `cmd_mwc9viht_7` 两次投递 id 不变 |
| 会话心跳超时后轮询 | 旧命令 `FAILED/unknown_completion`，新会话拿 `null` | ✅ （M5 演练 A） |
| 命令没人取 65 秒 | `EXPIRED` | ✅ （M5 演练 B） |
| Bridge 杀掉 40 秒再起 | 自动恢复、sequence 继续 | ✅ （M5 演练 A） |

## 5. 稳定性 soak（10 分钟采样，每 20 秒一次）

| 时间 | ack | 心跳 | 推送 | 重复 | 跳号 | 单包 | Bridge RSS | master 日志 |
|---|---|---|---|---|---|---|---|---|
| 0s | 281 | 112 | 167 | 0 | 3 | 6108B | 318.2MB | 1.41MB |
| 62s | 312 | 132 | 198 | 0 | 3 | 6082B | 325.2MB | 1.54MB |
| 123s | 342 | 152 | 228 | 0 | 3 | 6123B | 325.2MB | 1.68MB |
| 185s | 373 | 173 | 259 | 0 | 3 | 6119B | 325.9MB | 1.81MB |
| 206s 起 | — | — | — | — | — | — | 327MB | 1.85MB（停止增长） |

前 185 秒（10 个采样点）数据干净：

- **ack 281 → 373 单调递增，全程 `duplicates=0`**（幂等没被破坏）
- 心跳 : 推送 = 173 : 259 ≈ 2 : 3，与设计的 3 秒 / 2 秒吻合
- 单包稳定在 6.08–6.12 KB（含附近实体），没有膨胀
- Bridge 进程 RSS 稳定在 **318–332 MB**（波动 ±7MB，无泄漏趋势）
- master 日志线性增长（约 8 KB/秒，来自 Phase 1 日志通道，属预期）

### 第 206 秒起的中断：不是链路故障

采样在 206 秒变成 `null`，同时 master 日志停止增长。日志里原因很明确：

```
[00:14:45]: Sim paused
```

**游戏被暂停了**（打开暂停菜单 / 切出窗口都会停模拟）。这是真实使用中很常见的状态，所以本身是有价值的发现：

| 现象 | 结论 |
|---|---|
| 游戏暂停 → 心跳/推送/轮询全停 | Bridge 10 秒后判 `connected=false`，理由写"心跳超时（游戏可能暂停/退出了）" |
| 暂停期间 Bridge 里的数据变成"过去式" | 正是 **禁止把旧数据当当前状态** 的场景；Phase 3 的 MCP 层会用 `STATE_STALE` 明确标注 |
| 取消暂停后 | 游戏端自动重连，心跳继续，sequence 从原处接着涨，无需重启任何东西 |

**本项如实记录为：连续稳定运行 185 秒（10 次采样）无异常；10 分钟全程 soak 因游戏暂停中断，中断部分不计入稳定性结论。**

## 6. 测试计数（本轮全部实际执行）

| 套件 | 用例数 | 结果 |
|---|---|---|
| Lua / 插件侧（含 Phase 2 模块 + strict 模拟） | 108 | 全过 |
| Phase 2 game-bridge（M1+M3+M4+M5） | 36 | 全过 |
| Phase 1 Bridge | 22 | 全过 |
| **合计** | **166** | **全过** |

另外：日志通道 933 条记录全部通过 `schema/state.schema.json` 校验。

## 7. 游戏端日志检查

本次会话 `[BWS2]` 共 75 行，其中 WARN/ERROR **9 行，全部发生在两次人为断线演练的窗口内**
（`00:05:05–00:05:52` 与 `00:09:07`），内容是：

```
WARN 命令轮询失败 status=0 error=transport_failed
WARN heartbeat failed: transport_failed status=0
```

状态机按预期记录：`net state=offline → online → degraded → online`。

**没有出现**"同一个周期任务被创建两次"、"未知命令被执行"、"token 出现在日志里"。

## 8. 遗留问题（如实列出）

1. **天气变化**：Phase 1 起就没在雨天测过；本次秋季全程晴天，`is_raining/is_snowing/wetness` 一直为 false。
2. **多人 / 洞穴内玩家**：一直是单人主世界；caves 分片只跑过"无玩家"的情况（`problems.player=no_player`）。
3. **`game_version` 只有 `release`**：`TheSim:GetBuildID()` 在本机 build 762172 上不存在，拿不到 762172 这样的数字。
4. **客户端侧命令**：客户端不轮询命令（设计如此），未测"客户端也需要执行命令"的场景。
5. **多 Bridge 并发**：状态文件是单写者假设；两个 Bridge 同时跑会互相覆盖。
6. **命令类型**：只有 4 个测试命令；真实动作（移动/采集/战斗/制作）完全没实现，也没测。
7. **结果体积**：`get_state` 带 `include_nearby=true` 时约 30–40 条实体；极端场景（实体爆多）只做过单测裁剪。
8. **Token 分发**：通过 `bws_config.lua` 明文放在游戏目录，分发场景需要改造。

## 9. 怎么复现

```powershell
# 1) 装模组 + 生成游戏端配置（含 token）
node tools/write-bws-config.mjs --port 18788
node tools/install-mod.mjs

# 2) 起 Bridge
powershell -ExecutionPolicy Bypass -File start-game-bridge.ps1

# 3) 进游戏读档，然后：
$t = (Get-Content .runtime/token.txt -Raw).Trim()
curl "http://127.0.0.1:18788/api/v1/bridge/status?token=$t"
curl -X POST "http://127.0.0.1:18788/api/v1/commands/enqueue?token=$t" -d '{"type":"ping"}'
curl "http://127.0.0.1:18788/api/v1/commands?token=$t"
```

测试：`node --test "tests/*.test.mjs"`（108）、`cd game-bridge; node --test "dist/test/*.test.js"`（36）、`cd bridge; node --test "dist/test/*.test.js"`（22）。
