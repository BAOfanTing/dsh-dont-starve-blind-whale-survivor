# M2.0 · 测试报告

> 版本：0.13.4 → **0.14.0**（新增 Lua `guard.lua`、Node `control.js`/`dispatcher.js`）
> 命令：`node --test --test-force-exit "tests/*.test.mjs"`

---

## 1. 数量

| 阶段 | tests | pass | fail |
|---|---|---|---|
| 进入 M2.0 前（M1.4 收尾） | 291 | 291 | 0 |
| + Lua 安全校验（27） | 318 | 318 | 0 |
| + 租约与分发器（20） | **338** | **338** | **0** |

新增两个测试文件：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/m2-lua-guard.test.mjs` | 27 | 协议/白名单/过期/世代/环境/角色（ghost、死亡、非玩家、非权威、缺组件）/参数（未知、NaN、Infinity、范围、整数、类型）/`#N` 解析（旧快照、未知、失效、limbo、分类、距离） |
| `tests/m2-control-dispatcher.test.mjs` | 20 | 租约 9 例（acquire/续租/竞争/强制接管/续租与释放权限/过期/环境变化/旧世代/作废）+ 分发器 11 例（白名单/参数/无租约/快照与角色/信封字段/核对/失败/Lua 拒绝/超时 unknown/F8-MCP 冲突/规格） |

既有 291 例**全部保留且通过**（有 2 例按新语义改写了断言，见 §3）。

---

## 2. 覆盖对照（任务书要求 → 用例）

| 要求 | 用例 |
|---|---|
| Actor 缺失 / 无效 / 非玩家 / ghost / 死亡 / 缺组件 / 世界未就绪 / 错误 shard / 非权威 | guard-14/15/16/17/18；dispatcher-4 |
| 租约正常获取 / 重复获取 / 竞争 / 续租 / 释放 / 过期 / 换代 / 旧世代 / runtime·session·shard 变化 / 两个进程写同一命令文件 | lease-1…9（落盘用原子写；本机 F8 与 MCP 同进程，跨进程靠文件 + 过期） |
| Target Resolve（有效 / 不存在 / stale / 旧 runtime·session·shard / actor 变 / entity_gone / in_limbo / wrong_category / out_of_range / 新扫描旧 #N） | guard-26/27（runtime/session/shard/actor 由 `snapshot_id` 前缀 + `N.Resolve` 覆盖；见 M1.4 的 runtime-id 测试） |
| Command Protocol（合法/未知动作/未知参数/类型/NaN/Infinity/越界/过期/重复 id/缺租约/旧世代/旧 runtime） | dispatcher-1/2/3/8 + guard-2…13/19…25 |
| 执行结果（received→succeeded 等状态、command_id 对应、结果不重复写、超时不当成功、unknown 不自动重试） | dispatcher-5/6/7/8/9 |
| 回归 | 291 例全部通过 |

---

## 3. 有意改写的 2 个既有断言

| 文件 | 原来 | 改成 | 原因 |
|---|---|---|---|
| `tests/mcp.test.mjs` | 用 `chop` 验证"结果原样返回" | 用 `stop`（开放）+ 断言 `chop` 被拒且**不写命令** | M2.0 只开 R1；顺便把"未开放动作不进游戏"钉死 |
| `tests/tool-parity.test.mjs` | 断言 `chop` 会自动补 `until_gone=true` | 断言 `chop/mine/pick/attack/craft/gather` 全部被拒、`bridge.call` 一次都没调 | 同上：关闭的动作根本到不了传输层；`until_gone` 逻辑保留给重开时用 |
| `tests/lua-mod.test.mjs` | 11 个 modimport | 12 个（+`guard.lua`）+ 顺序断言 | 新增模块 |

---

## 4. 关键行为证据（摘录）

| 断言 | 结果 |
|---|---|
| 未开放动作：`commands.length === 0` | ✅（dispatcher-1、tool-parity 新断言、mcp 动作测试） |
| 无租约/错 owner：不发命令 | ✅（dispatcher-3/10） |
| 信封字段齐全（protocol/command_id/generation/runtime/session/shard/actor/snapshot/expires） | ✅（dispatcher-5） |
| 游戏说成功但位置没变 → `unverified` | ✅（dispatcher-6） |
| 超时 → `unknown` 且只发一次 | ✅（dispatcher-9） |
| 低世代 → `stale_generation`（Lua）/ `rejected`（Node 映射） | ✅（guard-8b、dispatcher-8） |
| 观察兜底到非玩家实体 → `actor_not_player` | ✅（guard-16） |
| 旧快照/未知 ref/失效/limbo/分类/距离 全部拒绝 | ✅（guard-26/27） |

---

## 5. 其它自检

| 项 | 结果 | 证据类型 |
|---|---|---|
| 全量单测 | **338 / 338** | UNIT |
| Lua → Node 管线自检（`tools/m12-roundtrip.mjs`） | 32 / 32（M1.4 起未变） | UNIT |

---

## 6. 真机状态

| 项 | 状态 | 说明 |
|---|---|---|
| 0.14.0 加载进世界 | **NOT_RUN** | 已装盘；**当前运行中的世界仍是旧内存镜像**，需重新进世界 |
| 用真实玩家跑一次 `move_to` | **NOT_RUN** | 需要你确认（会真的移动角色）——见 `docs/M2_runtime_manual_checklist.md` |
| `stop` 真机 | **NOT_RUN** | 同上 |
| F8 与 MCP 抢占（真机） | **NOT_RUN** | 需要游戏 + MCP 端口同时在 |
| 网络层 MCP 端到端 | **BLOCKED** | `127.0.0.1:18090` 本次未监听（插件未起 MCP 服务） |

> 本轮没有执行任何会改变世界状态的动作；也没有用 Mock 冒充真机结论。
