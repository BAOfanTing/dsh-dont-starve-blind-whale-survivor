# 全自动游玩测试闭环（AUTODEV）

把「改代码 → 真机跑 → 自动发现问题 → 自动修 → 不回归」做成一条闭环，目标是晚上挂机跑，
早上直接看 `AUTODEV_SUMMARY.md` 和 `.runtime/issue-report.json`。

> 设计原则：**确定性优先、诚实降级**。能不用模型的地方绝不用模型；做不到的能力明确标
> `skipped` 并写清原因，绝不把「没跑」说成「通过」。

---

## 1. 全链路

```
[1 静态与单测快检]  npm run lint → check:docs → check:hygiene → test （~10~40s，0 token）
        │失败→ 直接进 [5] 修，省掉重启游戏
        ▼通过
[2 环境重置与热加载] install-mod → 还原黄金存档 → 重启/重置 → unpause   （仅 --live）
        ▼
[3 分层真机测试]     Tier1 原子烟雾 → Tier2 场景注入 → Tier3 AI 长跑
        ▼
[4 质检员 Oracle]    session.jsonl + server_log.txt → issue-report.json（2~5KB）
        │无严重故障且无目标未达 → git commit ✅
        ▼有故障
[5 Coding Agent]     先写红灯测试 → 改源码 → 全量测试绿 → 护栏审计
        │连续 N 轮无改善/超轮次 → git reset 回最佳 + 人工介入报告 🛑
```

对应脚本/模块：

| 环节 | 文件 |
|---|---|
| 质检员（S0/S1/S2 判定 + 健康分 + 压报告） | [`lib/autodev/session-oracle.js`](../lib/autodev/session-oracle.js) / `node tools/analyze-session.mjs` |
| 护栏（禁删测试）+ 迭代决策 | [`lib/autodev/guardrails.js`](../lib/autodev/guardrails.js) |
| Tier1 确定性原子烟雾 | `node tools/run-live-tier1.mjs` |
| Tier1/2/3 漏斗编排 | `node tools/run-e2e-suite.mjs` |
| 主控闭环 | `node tools/auto-dev-loop.mjs` |
| 修复提示词模板 | [`tools/prompts/autofix-agent.md`](../tools/prompts/autofix-agent.md) |

---

## 2. 质检员 Oracle（最核心）

输入：`latestLogs/session.jsonl`（插件 `SessionLog` 覆盖写的结构化事件流）+
`latestLogs/server_log.txt`（游戏原生日志，GBK 自动解码）。
输出：`.runtime/issue-report.json`（默认压到 ≤5KB，每个故障只留故障前后上下文 + 当时 ENV/STATE）。

### 故障分级

| 级别 | 代码 | 判定规则 | 是否「严重」 |
|---|---|---|---|
| S0 | `crash` | server_log 出现 `Lua error` / `stack traceback` / `attempt to ...` | 是 |
| S0 | `death` | 出现 DEATH 事件，或 STATE `dead=true` / `ghost=true` | 是 |
| S1 | `loop` | 连续 ≥3 次相同 `tool+reason` 失败（repeated_failed_action / stale_snapshot_circuit_open / out_of_range / unverified 循环） | 是 |
| S1 | `idle_give_up` / `result_timeout` / `unknown` | 动作落入对应终态 | 是 |
| S1 | `state_stale` | 相邻 STATE 断档 > 15s（或单份 `age_ms` > 15s） | 是 |
| S1 | `unverified_rate` | 有状态的尝试中 unverified 占比 > 15% | 是 |
| S1 | `reflex_env_contradiction` | REFLEX 报缺某料，但同期 ENV 显示范围内存在 | 是 |
| S2 | `goal_missed` | 跑满步数预算（默认 40）仍缺必达里程碑（火把 / 活过第一夜） | 否（但阻断「全绿」） |

### 健康分

```
存活天数×100 + 里程碑得分 − Lua报错×500 − 死循环×100 − unverified率×50
```

里程碑权重默认：火把 20、科学机器 30、活过第一夜 40。用于自动回滚比较（分越高越好）。

### 单独使用

```bash
npm run analyze                                  # 分析 latestLogs → .runtime/issue-report.json
node tools/analyze-session.mjs --dir latestLogs --budget-steps 40
node tools/analyze-session.mjs --jsonl x.jsonl --server-log x.txt --max-bytes 5000
```

退出码：`0` 无严重故障；`2` 有 S0/S1；`1` 脚本自身出错。

---

## 3. 分层测试（快而全）

| 层 | 内容 | 耗时 / token | 说明 |
|---|---|---|---|
| Tier 1 | doctor → move_to → pickup/harvest/craft/chop/mine/eat/stop | ~40s / 0 | 区分「代码硬故障」与「环境资源不足软跳过」，硬故障 fail-fast |
| Tier 2 | 黑夜无光、残血遇怪、过热等极端场景注入 | ~2min / 0 | 需要能向游戏控制台灌指令的 `--injector` 模块；未配置→`skipped` |
| Tier 3 | AiRunner 自主生存长跑 | 5~15min / 耗 token | 需要 `--ai-runner`；未配置→`skipped`，绝不盲跑烧钱 |

Tier1 判定：
- **硬故障**（立刻停、必须修）：`stale_snapshot*`、`bridge_error`、`threw`、`unknown`、授权/租约类错误。
- **软跳过**（只记 warn，不算失败）：附近没燧石/没树、背包没吃的、材料不够、够不着。

```bash
node tools/run-live-tier1.mjs --dry-run     # 只 doctor
node tools/run-live-tier1.mjs --json
node tools/run-e2e-suite.mjs                # 默认跑 Tier1
node tools/run-e2e-suite.mjs --injector ./tools/xxx-injector.mjs --ai-runner ./tools/xxx-ai.mjs
```

---

## 4. 主控：auto-dev-loop

```bash
npm run autodev            # dry（默认）：lint/check:docs/test + 分析现有 latestLogs，产出摘要与报告
node tools/auto-dev-loop.mjs --dry-run
```

LIVE（会动游戏，按需再逐级打开 git / Agent）：

```bash
node tools/auto-dev-loop.mjs --live \
  --golden-save "<黄金存档目录>" \
  --server-reset-cmd "<重启或 c_reset 的命令>" \
  --max-steps 40

# 再打开自动修复（改 git + 调 Coding CLI）：
node tools/auto-dev-loop.mjs --live --allow-git --agent-cmd "claude -p"
```

常用参数：

| 参数 | 作用 |
|---|---|
| `--live` | 启用环境重置 + 分层真机测试 |
| `--skip-reset` | LIVE 时跳过「重装模组/还原存档/重启/unpause」（仅跑测试，避免副作用） |
| `--no-record` | LIVE 时不启用内置记录器（默认会自动边跑边录，供 Oracle 分析本轮） |
| `--golden-save <dir>` | 每轮覆盖回黄金存档（消除随机地图噪音） |
| `--server-reset-cmd "<cmd>"` | 重启/重置专用服或 `c_reset()` |
| `--max-steps N` | Tier3 / S2 的步数预算（默认 40） |
| `--allow-git` | 允许 commit / rollback（**默认关**，防止无声毁数据） |
| `--agent-cmd "<cmd>"` | 调用的 Coding Agent 命令（通过 `BWS_ISSUE_REPORT` / `BWS_PROMPT_FILE` 传参） |
| `--iterations N` / `--max-stagnant N` | 最大轮次 / 连续无改善上限（默认 5 / 2） |

**安全默认**：不写 `--live/--allow-git/--agent-cmd` 时，只做静态门禁 + 日志分析，不重启游戏、
不改 git、不调用模型。

---

## 5. 护栏与迭代决策

- **禁删测试**：`auditDiff()` 审计 `git diff`，出现「删除测试声明/断言」「删除整份测试文件」
  「新增 .skip/.todo 凑绿」任一即判失守。
- **核心文件标记**：改动 `guard.lua` / `guard_specs.lua` / `lib/control.js` /
  `lib/control/stop-coordinator.js` 会标 `touchedProtected`，要求对应专项测试全绿。
- **迭代决策**（`evaluateIteration`）：

| 条件 | 动作 |
|---|---|
| 单测未过 | `fix_unit` |
| 护栏失守 | `rollback` |
| 健康分上升 | `commit`（更新最佳检查点） |
| 分数下降、未到停滞上限 | `rollback` 重试 |
| 分数持平、未到上限 | `retry` |
| 连续无改善达上限 / 达最大轮次 | `stop`（回退最佳 + 人工 Review） |

---

## 6. 当前就绪度与扩展接入

1. **马上能用**：`npm run autodev` / `npm run analyze` 已可用——静态门禁 + 把现有日志压成
   `issue-report.json` 跑通。
2. **接通自动修复**：补 `--golden-save` 与 `--server-reset-cmd`（人工开着游戏窗口 + 桥接
   `c_reset()`），再加 `--allow-git --agent-cmd`。
3. **彻底无人值守**：在 `scripts/whale/actor.lua` 加测试专用无主角色开关（如 `HEADLESS_TEST_ACTOR = true`），
   配合 `dontstarve_dedicated_server_nullrenderer_x64.exe` + 黄金存档脚本，摆脱图形客户端；
   再把 Tier3 的 `--ai-runner` 接到 AiRunner。

> 目前 Tier2/Tier3 依赖的「通用控制台注入通道」和「AiRunner 运行器」本仓库尚未内置，
> 因此默认如实标 `skipped`。接上后按上面的 `--injector` / `--ai-runner` 即插即用。
