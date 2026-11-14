# M2.2.1 · 全项目瘦身与文档整合（最终报告）

> 执行日期：2026-11-13｜基线提交 `5cc59ce`｜交付物：本文件 + `README.md` + `ARCHITECTURE.md` + `STATUS.md` +
> `TESTING.md` + `archive/milestones/INDEX.md`
>
> 分两阶段：**第一阶段只审计不改文件**（报告经批准）→ **第二阶段按批准执行**。

---

## 1. M0–M6 文档完整盘点

第一阶段逐份盘点的结果如下（状态取值：有效 / 过时 / 已完成 / 废弃 / NEEDS_REVIEW）。
逐份清单与每阶段的"目标 / 实施 / 结果 / 验证级别 / 关键决策 / 现在是否有效 / 原始位置"见
[`archive/milestones/INDEX.md`](archive/milestones/INDEX.md)。

### 1.1 先澄清两件事实

1. **仓库里没有 M3–M6 阶段**，也没有它们的规划文档。真实存在的是 B 栈 `M0 → M1.0/1.1/1.2/1.4 →
   M2.0/2.0.1/2.0.2/2.0.3/2.1/2.2/2.3`，外加一套**更早**的 `phase1..phase6`（A 栈）。
   两套编号体系不同（`legacy/phase5` 里的 "m2" 不是 B 栈的 M2）。**没有虚构任何 M3–M6 条目。**
2. 任务书里"不开发 Harvest / 不进入 M2.3"已过时：M2.3（harvest）此前已完成并真机 14/14 通过。
   按"以实际代码和真实运行状态为准"的要求，本报告按现状记录。

### 1.2 B 栈阶段文档（57 份 → 归档）

| 阶段 | 份数 | 类型 | 状态 | 仍被引用 | 建议/处理 |
|---|---|---|---|---|---|
| M0 | 4（3 归档 + 1→api/） | 架构审计、API 实测、迁移计划、目录定案 | 已完成 | 否 | 归档 `milestones/M0/`；API 实测进 `api/` |
| M1.0 | 2 | 迁移报告、测试报告 | 已完成 | 1 处（`tests/lua-mod.test.mjs`） | 归档 `milestones/M1/` |
| M1.1 | 3 | Actor Provider 报告、**get_state 契约**、测试报告 | 已完成 / **契约仍有效** | 1 处（`lib/tools.js`） | 归档 |
| M1.2 | 3 | 阻塞、冒烟计划、**真机报告** | 已完成 | 1 处（测试注释） | 归档 |
| M1.4 | 9 | 实现/验收/审计/Delta 修复/**nearby 契约**/真机 | 已完成 / **契约仍有效** | 1 处 | 归档 |
| M2.0 | 5 → 4 归档 + 1→security | 动作架构、动作清单、测试、真机清单、安全矩阵 | 有效 | 否 | 归档 `milestones/M2/` + `security/` |
| M2.0.1 | 1 → security | 租约安全审计（P0 来源） | 已完成 | 否 | 归档 `security/` |
| M2.0.2 | 7 → 6 security + 1 归档 | 修复报告、安全测试、真机探测 3 轮、清单、限制 | 已完成 | 1 处（测试注释） | 归档 |
| M2.0.3 | 1 → security | 真机换手 16/16 | 已完成 | 否 | 归档 `security/` |
| M2.1 | 6 → 4 归档 + 1 api + 1 security | pickup 设计/测试/清单/限制、API 审计、安全 | 有效 | 1 处（`pickuprules.lua`） | 归档 |
| M2.2 | 6 → 5 归档 + 1 api | nearby 审查/设计/实现/测试/清单/限制 | 有效 | 否 | 归档 |
| M2.3 | 6 → 4 归档 + 1 api + 1 security | harvest 设计/测试/清单/限制、API 审计、安全 | 有效 | 1 处（`harvestrules.lua`） | 归档 |
| 其他 | 4 | `dsh-plugin.md`、`tool_migration_matrix.md`、`audit-…100days.md`、README | 有效 / 过时 | `dsh-plugin.md` 被 `package.json` 与 `build-client.mjs` 引用 | `dsh-plugin.md` **原位保留**；其余归档 `legacy/` |

### 1.3 早期阶段文档（**48** 份 → `legacy/`）

| 目录 | 份数 | 当初是什么 | 状态 | 处理 |
|---|---|---|---|---|
| `phase1` | 9 | 环境、最小模组、观察器、实体扫描、状态 Schema、Bridge、API 验证 | 废弃（思路被 M1 吸收） | 归档 `legacy/phase1/` |
| `phase2` | 6 | TS `game-bridge` + HTTP 18788 | 废弃 | 归档（代码在 `archive/legacy-game-bridge/`） |
| `phase3` | 6 | TS MCP 服务器 | 废弃 | 归档（代码在 `archive/legacy-mcp-server/`） |
| `phase4` | 8 | TS Agent（LLM provider / loop / 上下文） | 废弃 | 归档（代码在 `archive/legacy-agent/`） |
| `phase5` | 10 | 动作控制、移动、两次真机验证、采集、工具化 | 废弃（含原始真机证据） | 归档 `legacy/phase5/` |
| `phase6` | 9 | 威胁/逃跑/战斗/季节/Boss/决策 | 废弃 | 归档（Boss/敌人档案曾提取成 `tests/fixtures/legacy-ts-profiles.json`，**该 fixture 已于 SURVIVAL-07 删除**——它只被 `phase6-lua` 用来核对归档 Lua 白名单） |

> **统计口径修正**：第一阶段的审计报告写的是 47 篇，实际是 **48 篇**
> （9+6+6+8+10+9）。本次按 48 归档，`docs/` 总数 104 → 104，一篇没少。

---

## 2. 文档数量对比

| 指标 | 整理前 | 整理后 |
|---|---|---|
| `docs/` 下 Markdown | **104** | **104**（另新增 5 份现行文档：ARCHITECTURE / STATUS / TESTING / REFACTOR_AUDIT / milestones/INDEX） |
| `docs/` 顶层散落文档 | 57 | **1**（只剩 `dsh-plugin.md`，因为 `package.json` 打包它） |
| `docs/archive/` | 0 | 103（M0 3 + M1 17 + M2 18 + security 11 + api 4 + legacy 50） |
| 归档后"日常必读"文档 | — | **4**（README + ARCHITECTURE + STATUS + TESTING） |

---

## 3. 目录结构（前 → 后）

### 3.1 整理前

```
lib/ (10)  DontStarveWhaleSurvivor/ (16+4)  tools/ (21)  tests/ (86)  schema/ (1)
mcp-server/ (44)   agent/ (32)   game-bridge/ (22)        ← A 栈，仍留在顶层
archive/ (59)                                             ← 只有 A 栈代码
docs/ 104 篇全部平铺在顶层 + phase1..6/（48 篇）
根目录 4 个 A 栈 PS1：install-bridge / start-bridge / install-game-bridge / start-game-bridge
```

### 3.2 整理后

```
README.md                 ← 重写：用途/能力/环境/安装/启动/连接/FAQ/文档入口
docs/
├── ARCHITECTURE.md       ← 新建：只讲现行架构（一张主图 + 安全边界）
├── STATUS.md             ← 新建：版本/能力/验证等级/已知问题/待办
├── TESTING.md            ← 新建：只写真跑得通的命令
├── REFACTOR_AUDIT.md     ← 本文件
├── dsh-plugin.md         ← 原位不动
└── archive/
    ├── milestones/INDEX.md + M0/(3) M1/(17) M2/(18)
    ├── security/(11)  api/(4)  legacy/(50)
lib/ (10)  DontStarveWhaleSurvivor/ (16+4)  tools/ (19)  tests/ (87)  schema/ (1)
archive/ 163  ← legacy-mcp-server / legacy-agent / legacy-game-bridge / phase-a / unused-survival
根目录只剩现行脚本：build / common / install / test .ps1
```

---

## 4. 被归档 / 移动的文件清单

**全部用 `git mv`，历史可追溯；没有复制、没有改名后重写内容。**

### 4.1 代码（98 个文件 → `archive/`）

> **SURVIVAL-07 更新（2026-11）**：`archive/` 已**整体删除**，连同 138 个只测归档代码的
> `tests/phase*.test.mjs`（以及 `tests/fixtures/legacy-ts-profiles.json`）。
> 理由：那 138 个用例（占当时 613 个的 22%）跑的是 A 栈的 `archive/phase-a/scripts/main/*.lua`，
> 而现行模组 18 个 `modimport` 全是 `scripts/whale/*`、`scripts/main` 目录根本不存在 ——
> 它们保护的是死代码，却让人误以为有 613 个测试在保护现行实现。
>
> 下面的表记录的是 **M2.2.1 当时搬到了哪**，不是现在还在哪。要找回任何一段：
>
> ```powershell
> git log --oneline -- archive/            # 找到删除前那次提交
> git checkout <commit> -- archive/phase-a # 只取回需要的部分
> ```
>
> 恢复时注意：A 栈的观察器会自己遍历 `AllPlayers`、用 HTTP 18788 桥，
> 和现在的 Actor Provider + 文件桥是两套东西，不能混着跑。

| 原路径 | 新路径 | 为什么 |
|---|---|---|
| `mcp-server/`（44） | `archive/legacy-mcp-server/` | A 栈 TS MCP 服务器；现行是 `lib/mcp-server.js`。唯一依赖（`tests/phase6-lua`）已在本阶段解掉 |
| `agent/`（32） | `archive/legacy-agent/` | A 栈 TS Agent；现行是 `lib/agent.js`（F8） |
| `game-bridge/`（22） | `archive/legacy-game-bridge/` | A 栈 HTTP 18788 桥；现行用文件桥 |
| `tools/bench-phase6.mjs` | `archive/legacy-mcp-server/` | 依赖 A 栈 `dist` 的性能基准 |
| `tools/write-bws-config.mjs` | `archive/legacy-game-bridge/` | 生成 `bws_config.lua`（`http://127.0.0.1:18788`）；**Lua 侧没有任何代码读 `BWS_CONFIG`** |
| `install-bridge.ps1`、`start-bridge.ps1` | `archive/legacy-agent/` | A 栈脚本 |
| `install-game-bridge.ps1`、`start-game-bridge.ps1` | `archive/legacy-game-bridge/` | A 栈脚本 |

### 4.2 文档（103 份 → `docs/archive/`）

见 §1.2 / §1.3 的分组；逐份路径见各目录（文件名未改）。

### 4.3 新增（不是移动）

| 文件 | 作用 |
|---|---|
| `docs/ARCHITECTURE.md` / `STATUS.md` / `TESTING.md` / `REFACTOR_AUDIT.md` | 四份核心文档 |
| `docs/archive/milestones/INDEX.md` | 里程碑导航（含两套命名体系说明、M3–M6 不存在的事实） |
| `tests/fixtures/legacy-ts-profiles.json` | 替代 `mcp-server/dist` 的最小静态 fixture（7 + 12 项名单） |

---

## 5. 被删除的文件清单

**没有删除任何文件。**（`git log --diff-filter=D` 在本次提交区间内为空）

唯一的"消失"是 `.gitignore` 里 4 类**失效规则**被删除（`bridge/node_modules`、`bridge/dist`、
`game-bridge/*`、`mcp-server/*`、`agent/*`、`survival/*`）——它们指向的目录要么已归档，
要么根本不存在；归档目录统一由 `archive/**/node_modules/`、`archive/**/dist/` 覆盖。

**本地（不在 git 里）清理**见 §11.3。

---

## 6. 代码精简统计

| 指标 | 前 | 后 | 变化 |
|---|---|---|---|
| 模型可见工具 | 37（其中 **35 唯一**） | **7**（全部唯一） | −30 |
| 未开放但暴露给模型的工具 | 28 | **0** | −28 |
| `lib/tools.js` 行数 | 625 | **247** | −378（−60%） |
| 顶层跟踪目录里的 A 栈代码 | 98 文件 | 0（全部 `archive/`） | −98 |
| `tools/` 脚本（现行） | 21 | 19 | −2 |
| 跟踪文件总数 | 414 | 420（+6 = 5 份文档 + 1 fixture） | — |
| 测试用例 | 477 | **479** | **+2（没有减少）** |

### 6.1 每一项冗余的处理（对应第一阶段的 R1–R10）

| 编号 | 问题 | 处理 | 状态 |
|---|---|---|---|
| R1 | `pickup`/`harvest` 各重复注册一次 | 删掉旧定义，工具表唯一 | ✅ 已修 |
| R2 | 28 个工具永远被 dispatcher 拒 | 方案 A：只暴露 4 个白名单动作；宏不再暴露 | ✅ 已修 |
| R3 | `agent/` 无任何引用 | 归档 | ✅ |
| R4 | `game-bridge/` 无任何引用 | 归档 | ✅ |
| R5 | `tests/phase6-lua` 依赖被 gitignore 的 `dist` | 改读最小 fixture | ✅ 已修（干净检出验证过） |
| R6 | 4 个 A 栈 PS1 + `write-bws-config` | 归档；本地 `bws_config.lua` 删除 | ✅ |
| R7 | `bench-phase6.mjs` 依赖 A 栈 `dist` | 归档 | ✅ |
| R8 | 版本号 0.9.2 vs 0.17.1 | **按批准保留双版本**，在 STATUS/README 写清含义 | ✅ 记录 |
| R9 | `actions.lua` 里 24 个非白名单 JOBS | **不动**（动作储备；reflex/macros 用其中 4 个），记录在案 | ✅ 记录 |
| R10 | `archive/` 本地 51.8MB 依赖 + `.runtime/` 2.6MB | 本地清理（§11.3） | ✅ |

### 6.2 安全边界检查（一条都没削弱）

| 安全机制 | 状态 |
|---|---|
| Actor Provider | 未改 |
| Nearby / Snapshot Resolve（`#N` + `snapshot_id`） | 未改 |
| PickupRules / HarvestRules（观察侧与执行侧共用） | 未改（只改了一行注释里的文档路径） |
| Action Dispatcher（唯一动作出口） | **白名单未改**（`move_to/stop/pickup/harvest`） |
| Control Lease / 两阶段换手 / ACK 五条硬条件 | 未改 |
| Lua Guard（白名单 + 参数 + 目标 + 租约复核） | 未改 |
| Command Protocol（`command_id`、防重放、8 秒过期） | 未改 |
| 目标校验（存在/白名单/状态/距离/组件权限） | 未改 |
| 动作执行与结果确认 | 未改 |
| 测试（不放宽校验） | 新增"工具名唯一 / 可见动作 == 白名单 / 未开放动作抛错且不写命令"三组断言 |

---

## 7. 测试结果

| 项 | 结果 |
|---|---|
| 完整单测 | **479 / 479 PASS**（前 477，+2 新增断言，**没有减少用例**） |
| 干净检出模拟（把 `mcp-server/dist` 移走） | **479 / 479 PASS** ✓ |
| `test.ps1` 入口 | **479 / 479，退出码 0** ✓ |
| `get_state` / `nearby` / `move_to` / `stop` / `pickup` / `harvest` | 单测全部覆盖并通过 |
| F8 与 MCP 共用链路 | `tool-parity` 断言两边共用同一份 `TOOLS`；`agent.test` + `mcp.test` 均通过 |
| Control Lease + Lua Guard + ACK/Handover | `m2_0_1_lease_security` / `m2_0_2_*` / `m2-lua-guard` 全通过 |
| 工具列表无重名 | 新增断言 + `mcp.test` 断言 `new Set(names).size === names.length` |
| 文档引用 | 12 处全量核对（见 §8.2），全部指向存在的文件 |
| **真实游戏（RUNTIME）** | **NOT_RUN** —— 本次没有启动游戏 |
| **端到端（真实模型）** | **NOT_RUN** |

---

## 8. 是否改变运行行为

### 8.1 会影响行为的改动（3 处，都是"让可见表面与真实能力一致"）

1. **工具表 37 → 7**：模型不再看到 `chop`/`mine`/`attack`/`craft`/`gather` 等 28 个"点了必然失败"的工具。
   调用这些名字现在**直接报"没有这个工具"**，而不是走 dispatcher 后回"还没开放"。
   → 安全闸没变，只是不再对外宣称做不到的事。
2. **模型提示词 `RULES` 重写**：原文教模型用 `go_to` / `pick` / `add_fuel` / `heal` / `say`
   （这些已不开放），现在只讲 4 个开放动作的正确用法（`#N` + `snapshot_id`、不会自动走路、快照会失效）。
3. **`dst` 入口工具描述**里的示例 `{"action":"chop"}` 改成 `{"action":"stop"}`。

### 8.2 明确**没有**改变的

- 动作执行链、dispatcher 白名单、Control Lease、Lua Guard、ACK 条件、结果核对方式：**一行没动**。
- Lua 的 `actions.lua`（28 个 JOBS）、`macros.lua`、`reflex.lua`、`nearby.lua`、`guard.lua`：**没动**。
- Lua 侧唯一改动是 `harvestrules.lua` / `pickuprules.lua` 各**一行注释里的文档路径**（模组版本因此 0.17.1 → 0.17.2，行为无差异）。
- 用户存档、游戏目录、API Key、模型配置：**没碰**。

---

## 9. 未完成工作及其原始阶段归属

| 项 | 原始归属 | 现在在哪 |
|---|---|---|
| M3–M6 | **不存在**（没有规划文档） | `INDEX.md` §0 明确说明，不虚构 |
| 续火 / 回血 / 死亡复活 | 100 天差距审计 P0 | `STATUS.md` §6.2 |
| 容器存取 / 锅完整流程 / interact / 配方查询 / 导航 / 威胁预警 / 季节倒计时 | 同上 P1 | 同上 |
| 会话预算 / 自动续玩 / 行动历史 / 长期记忆 / 成本 / 复盘 | 同上 P2 | 同上 |
| 结果文件单槽、reflex 占用 Actor、原生距离紧、harvest 单试点、成熟布尔、桶上限 | M2.0–M2.3 各阶段限制 | `STATUS.md` §5 |
| `WORK_TOOLS`/`until_gone` 空转分支 | M2.2.1 产生 | `STATUS.md` §6.3（保留是为了不动执行器） |
| 攻略正文仍写历史动作 | M2.2.1 发现 | `STATUS.md` §5 #9，标 **NEEDS_REVIEW**（未擅自改内容） |

---

## 10. Git 提交记录

| 提交 | 内容 |
|---|---|
| `a6e65ca` | `refactor(M2.2.1/R1+R2)` 工具表 37 → 7；删重复注册；重写 `RULES`；新增唯一性/白名单/只读路由三组断言（477 → 479） |
| `c9a47ac` | `fix(M2.2.1/Q3)` `phase6-lua` 改读 `tests/fixtures/legacy-ts-profiles.json`；**干净检出（无 dist）479/479 验证通过** |
| `a180bd3` | `chore(M2.2.1/R3+R4+R6+R7)` A 栈 98 个文件 + 4 个 PS1 + 2 个脚本 → `archive/`；`.gitignore` 清理 |
| `d4f72ca` | `docs(M2.2.1)` 103 份文档归档（104 → 104）+ 9 处引用修复 + 模组 0.17.2（去 BOM） |
| 本次最后一条 | 四份核心文档 + 本报告 + 索引（见 `git log -1`） |

每次提交后都跑了相关测试（其中 `a6e65ca` 与 `d4f72ca` 后跑了全量）。

---

## 11. 最终工作区状态

### 11.1 Git

- `git status --short` 为空（干净）。
- 无删除记录：`git log 5cc59ce..HEAD --diff-filter=D` 为空。

### 11.2 文档链接检查（12 处）

| 引用方 | 指向 | 结果 |
|---|---|---|
| `lib/tools.js` | `docs/archive/milestones/M1/M1_1_get_state_schema.md` | ✅ 存在 |
| `tools/build-client.mjs` | `docs/dsh-plugin.md` | ✅ 原位 |
| `package.json` | `docs/dsh-plugin.md` | ✅ 原位 |
| `tests/lua-mod.test.mjs` | `docs/archive/milestones/M1/M1_0_migration_report.md` | ✅ |
| `tests/m1_4-delta-truncation.test.mjs` | `docs/archive/milestones/M1/M1_4_runtime_test_report.md` | ✅ |
| `tests/m1_4-nearby.test.mjs` | `docs/archive/milestones/M1/M1_2_runtime_test_report.md` | ✅ |
| `tests/m2-lua-guard.test.mjs` | `docs/archive/security/M2_0_2_runtime_manual_checklist.md` | ✅ |
| `tests/m2_0_1_lease_security.test.mjs` | `docs/archive/security/M2_0_2_security_test_report.md` | ✅ |
| `harvestrules.lua` | `docs/archive/api/M2_3_harvest_api_audit.md` | ✅ |
| `pickuprules.lua` | `docs/archive/api/M2_1_pickup_api_audit.md` | ✅ |
| `README.md` | `docs/ARCHITECTURE.md` / `STATUS.md` / `TESTING.md` / `REFACTOR_AUDIT.md` / `dsh-plugin.md` / `archive/milestones/INDEX.md` | ✅ 全部存在 |

### 11.3 本地清理（不在 git 里，按批准执行）

- 删除 `archive/**/node_modules`、`archive/**/dist`（生成物，可重装）。
- 删除 `DontStarveWhaleSurvivor/bws_config.lua`（A 栈 HTTP 时代的生成文件，**内容含明文本机 token**，
  已被 `.gitignore` 忽略；Lua 侧无任何读取）。
- `.runtime/` **没有清空**：先检查过，保留了 `m12-backup-2026-11-12` 等**独有的历史验证资料**，
  只删本次任务自己的临时脚本。
- 根目录 `node_modules/`、用户世界存档、有效配置：**没动**。

### 11.4 结论

- 日常入口收敛为 **4 份**：`README.md`、`docs/ARCHITECTURE.md`、`docs/STATUS.md`、`docs/TESTING.md`。
- 历史资料 **104 篇一篇没删**，全部可按 `docs/archive/milestones/INDEX.md` 检索。
- 工具表面从 37（35 唯一）收敛到 **7**，且与安全白名单**完全一致**（有测试盯着）。
- 真实游戏验证本次 `NOT_RUN`，不冒充。