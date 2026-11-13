# 里程碑索引（M0–M2）

> 这份索引只做**导航和事实整理**，不重写任何原始报告。
> 原始文档的结论、证据和措辞一律保持原样，需要细节时请直接打开对应文件。
>
> 生成时间：M2.2.1（全项目瘦身）｜对应代码：`modinfo.lua 0.17.2` / `package.json 0.9.2`

---

## 0. 先读这段：仓库里有**两套**历史命名体系

| 体系 | 时间 | 是什么 | 现在还有效吗 | 归档位置 |
|---|---|---|---|---|
| **B 栈 M0 / M1 / M2** | 现行 | 现在这套系统（Lua 模组 + 插件内 MCP + 文件桥）的里程碑 | **有效**，就是当前架构 | `milestones/M0`、`M1`、`M2` |
| **早期 phase1 – phase6** | 更早 | A 栈：TypeScript 的 bridge / mcp-server / agent + HTTP 通信 | **全部废弃**，只作历史资料 | `legacy/phase1` – `legacy/phase6` |

两套体系**不是同一套编号**：`docs/archive/legacy/phase5` 里的 "m2" 是 A 栈第 5 期的第 2 个子阶段，**不是** B 栈的 M2。看文档时先看它在哪个目录。

### 关于 M3–M6

**本仓库不存在 M3、M4、M5、M6 阶段**，也没有对应的规划文档。

- 没有规划文档 = 没有写下来过，不是"漏归档"。
- 当前真正的"未来工作"散落在：`STATUS.md` 的「未完成的工作」、`legacy/audit-2026-11-12-100days.md`（100 天差距清单）、
  以及各阶段的 `*_known_limitations.md`（已随阶段归档）。
- 按本项目纪律：**没有实际代码与验证的阶段不写进历史成果**，所以这里不虚构 M3–M6 的条目。

---

## M0 · 架构审计与迁移决策

| 项 | 内容 |
|---|---|
| **阶段目标** | 搞清楚"饥荒的 Lua 模组没有网络能力"这件事怎么落地；审计已有的 A 栈，决定要不要推倒重来 |
| **实际实施** | DST 原生 API 与本机 `scripts.zip` 实测；A/B 两栈逐层对比；迁移方案；最终目录定案 |
| **最终结果** | 确定 B 栈形态：**Lua 模组只看和做 + 本地文件桥 + 插件进程内的 MCP 服务器**；A 栈整体归档 |
| **验证级别** | STATIC（代码/API 阅读）+ RUNTIME（真机读状态文件、真实游戏里确认 API 行为） |
| **重要架构决策** | ① Lua 模组不能监听端口 → 用文件桥；② B 栈唯一运行，不再维护两套；③ MCP 服务器跑在插件进程里，**不新起服务**；④ 动作必须在游戏里用原生 `BufferedAction` 执行 |
| **现在还有效吗** | **是**（这套架构一直用到 M2.3，M2.2.1 也没有改） |
| **原始文档** | `milestones/M0/M0_architecture_audit.md`、`M0_migration_plan.md`、`M0_final_directory.md`；API 实测在 `api/M0_api_validation.md` |

---

## M1 · 状态与观察（让模型"看得见"）

| 项 | 内容 |
|---|---|
| **阶段目标** | 把游戏翻译成模型能读的文字：状态文件、角色信息、附近实体、变化量 |
| **实际实施** | **M1.0** B 栈唯一运行（A 栈归档）→ **M1.1** Actor Provider + 统一 `get_state` → **M1.2** 真机冒烟 → **M1.4** 结构化 nearby + `#N` 引用 + Delta + 容量上限 + runtime_id 隔离 |
| **最终结果** | `whale_state.json` 由模组自己写；`get_state` 有稳定字段契约；nearby 结构化（后续 M2.2 才扩到 9 个桶）；引用只在当前快照内有效 |
| **验证级别** | UNIT（fengari 沙箱 + 假游戏）+ **RUNTIME**（M1.2 / M1.4 的真机报告，含真实存档与分片观察） |
| **重要架构决策** | ① 观察侧与执行侧共用同一份快照解析；② `#N` 引用必须带 `snapshot_id`；③ Delta 用**完整扫描集合**做基线（避免"掉出扫描半径"被误报成消失）；④ 上限：总数 60 / 每桶 12；⑤ `runtime_id` 隔离不同世界/进程 |
| **现在还有效吗** | **是**（字段契约见 `M1/M1_1_get_state_schema.md`、`M1/M1_4_nearby_schema.md`，`ARCHITECTURE.md` 有摘要） |
| **原始文档** | `milestones/M1/`（17 篇） |

---

## M2 · 安全控制与动作系统（让模型"动得了又动不坏"）

| 项 | 内容 |
|---|---|
| **阶段目标** | 开放动作，但不让模型绕过校验、不让 F8 和 MCP 互相打架、不让旧指令打在新世界上 |
| **实际实施** | **M2.0** Action Dispatcher + Control Lease + 跨进程互斥 + 代际隔离 → **M2.0.1** 租约安全审计（发现 P0）→ **M2.0.2** 修复 + 真机探测 3 轮 → **M2.0.3** 真机换手验证 16/16 → **M2.1** pickup → **M2.2** Actionable Nearby（`pickupables` 桶）→ **M2.3** harvest |
| **最终结果** | 模型只暴露 **7 个工具**（3 个只读 + `move_to`/`stop`/`pickup`/`harvest`）；动作只能经过 Dispatcher（校验 → 租约 → 下发 → 核对）；Lua 侧 Guard 再复核一遍；结果以游戏真实状态核对 |
| **验证级别** | UNIT（Node + fengari 沙箱）+ **RUNTIME**（M2.0.3 换手 16/16；M2.1 pickup、M2.2 nearby、M2.3 harvest 均在真实游戏里跑过，M2.3 真机 14/14） |
| **重要架构决策** | ① 白名单只在 `dispatcher.js` 一处；② `job_cleared` + `lease_id` + 时间窗构成换手 ACK 的硬条件；③ Harvest 底层用原生 `ACTIONS.PICK`（不是 `ACTIONS.HARVEST`）；④ 候选对象看**组件**不看 `pickable` 标签（标签 == 当前能不能采）；⑤ Harvest 与 Pickup 严格分开，不自动接续 |
| **现在还有效吗** | **是**（M2.2.1 只删了"模型可见但永远被拒"的冗余工具定义，白名单与安全闸没动） |
| **原始文档** | 阶段报告在 `milestones/M2/`；安全审计在 `security/`；原生 API 审计在 `api/` |

### M2 子阶段 → 文档对照

| 子阶段 | 报告（`milestones/M2/`，另有标注） |
|---|---|
| M2.0 底座 | `M2_action_architecture.md`、`M2_action_inventory.md`、`M2_test_report.md`、`M2_runtime_manual_checklist.md`；安全矩阵在 `security/M2_security_matrix.md` |
| M2.0.1 审计 | `security/M2_0_1_lease_security_audit.md` |
| M2.0.2 修复 | `security/M2_0_2_lease_fix_report.md`、`M2_0_2_security_test_report.md`、`M2_0_2_runtime_manual_checklist.md`、探测 3 轮 `M2_0_2_runtime_probe_round1~3.md`；限制在 `milestones/M2/M2_0_2_known_limitations.md` |
| M2.0.3 真机 | `security/M2_0_3_runtime_verify.md` |
| M2.1 pickup | 设计/报告在 `milestones/M2/`；API 审计 `api/M2_1_pickup_api_audit.md`；安全 `security/M2_1_pickup_security.md` |
| M2.2 nearby | 设计/实现/测试/清单/限制在 `milestones/M2/`；审查 `api/M2_2_nearby_audit.md` |
| M2.3 harvest | 设计/测试/清单/限制在 `milestones/M2/`；API 审计 `api/M2_3_harvest_api_audit.md`；安全 `security/M2_3_harvest_security.md` |

---

## 早期体系 phase1 – phase6（A 栈，全部废弃）

> 这两套东西（A 栈 / B 栈）曾经并行存在过一小段时间；M1.0 起 **B 栈唯一运行**。
> 这些文档里的架构、端口（18788 / 8790 / 8791）、TypeScript 代码**都不是当前系统**。

| 目录 | 当初是什么 | 现在的下落 | 还有参考价值的部分 |
|---|---|---|---|
| `legacy/phase1/`（9 篇） | 环境检查、最小模组、观察器、实体扫描、状态 Schema、Bridge、API 验证 | Lua 侧思路被 B 栈 M1 吸收 | `05-state-schema.md`（状态字段的早期设计）、`07-api-verification.md` |
| `legacy/phase2/`（6 篇） | `game-bridge`：TypeScript + HTTP 18788 的桥 | 代码在 `archive/legacy-game-bridge/` | 桥的职责划分、错误边界 |
| `legacy/phase3/`（6 篇） | TypeScript 的 MCP 服务器 | 代码在 `archive/legacy-mcp-server/`；现行是 `lib/mcp-server.js` | tools/resources/prompts 的分层 |
| `legacy/phase4/`（8 篇） | TypeScript 的 Agent（LLM provider、agent loop、上下文安全） | 代码在 `archive/legacy-agent/`；现行是 `lib/agent.js`（F8 内置 AI） | 上下文裁剪、真模型验证方法 |
| `legacy/phase5/`（10 篇） | 动作控制、移动、两次真机验证、采集、工具化、生存 | 动作层被 B 栈 M2 重做 | **两次真机验证的原始记录**（A 栈时期的证据，不能当现行版本的证据） |
| `legacy/phase6/`（9 篇） | 威胁分析、逃跑、战斗、季节、Boss、决策引擎 | 代码在 `archive/legacy-mcp-server/src/survival/`；Lua 在 `archive/phase-a/scripts/main/` | 敌人/Boss 档案（已提取为 `tests/fixtures/legacy-ts-profiles.json`） |

另外两份：

- `legacy/tool_migration_matrix.md` —— A 栈 43 个工具的去向（19 个 B 栈已有等价实现、11 个有价值、11 个依赖已归档的 Lua 实现、2 个不迁）。M1.0 期的资产保护清单。
- `legacy/audit-2026-11-12-100days.md` —— 「离 AI 自主活满 100 天还差什么」的差距审计。**仍是唯一一份系统的差距清单**，它的可执行项已摘进 `docs/STATUS.md` 的「未完成的工作」。

---

## 目录结构

```
docs/
├── ARCHITECTURE.md          ← 当前架构（唯一该读的架构文档）
├── STATUS.md                ← 当前状态 / 验证等级 / 未完成工作
├── TESTING.md               ← 怎么跑测试（命令都验证过）
├── REFACTOR_AUDIT.md        ← M2.2.1 这次瘦身的审计与结果
├── dsh-plugin.md            ← 插件使用说明（package.json 打包，固定留在原位）
└── archive/
    ├── milestones/
    │   ├── INDEX.md         ← 本文件
    │   ├── M0/  (3)   M1/  (17)   M2/  (18)
    ├── security/   (11)     ← 租约/换手/guarded 动作的安全审计与真机轮次
    ├── api/        (4)      ← DST 原生 API 审计（pickup / nearby / harvest / M0）
    └── legacy/     (50)     ← phase1–6（48）+ 工具迁移矩阵 + 100 天差距审计
```

## 归档原则（M2.2.1 定下的规矩）

1. **只移动，不删除、不改写**原始结论。
2. 一份文档只放一个主目录；跨阶段的在**本索引**里建引用（例如 `api/M2_3_harvest_api_audit.md` 同时属于 M2.3）。
3. 安全证据（审计、修复、真机轮次）单独放 `security/`，因为它们跨阶段都还有约束力。
4. 现行架构与历史架构**不混放**：`docs/ARCHITECTURE.md` 只讲现在，历史在 `archive/`。
5. 归档目录里的代码（`archive/legacy-*`、`archive/phase-a`）不参与构建、不被任何现行代码引用。