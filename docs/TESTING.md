# 测试与验证说明

> 所有命令均可在仓库根目录直接执行；真机验证命令需本地已打开《饥荒联机版》并房主读档进世界。

---

## 1. 静态门禁与自动化测试

```bash
npm run lint         # Node 语法 + Lua 语法（luaparse）+ 工具表面 / 契约一致性检查
npm run check:docs   # 校验 README.md 中的动作/本地工具计数与全部工具名是否与代码一致
npm test             # 全套单元测试与集成测试（node --test tests/**/*.test.mjs）
```

Windows PowerShell 下也可用 `./test.ps1` 运行完整测试集；按模块域单独运行可直接指定子目录，例如：

```bash
node --test --test-force-exit "tests/control/*.test.mjs"
node --test --test-force-exit "tests/lua/*.test.mjs"
```

---

## 2. 测试目录结构（按模块域组织）

```text
tests/
  helpers/   # 共用测试夹具与 fengari Lua 运行时加载器（helpers, target-harness, reflex-harness, lua-mod-harness, lua-harness）
  bridge/    # 文件桥、HTTP 通道、MCP Server、动态工具列表、会话日志、client 构建与插件安装
  control/   # Control Lease、两阶段换手与 ACK、Stop 协调器、Dispatcher、stale 熔断、unknown/unverified 对账
  planner/   # plan 纯函数、任务看板 DAG、阻塞生命周期、任务-技能编排、世界记忆、Autopilot 隔离、建筑与配方
  skills/    # SkillExecutor、复合技能（establish-home / gather-resources / survival-stabilize）、游戏数据与配方一致性
  autodev/   # 会话分析（session-oracle）、自动评分与护栏（guardrails）、自动迭代闭环
  lua/       # 生产 Lua 模块在 fengari 下的行为、规则校验（guard/pickup/harvest/eat/equip/target/reflex/battle）与 API 约束
```

---

## 3. 验证等级与诚实标注

| 等级 | 含义 | 运行前提 |
|---|---|---|
| `UNIT` | Node 纯逻辑与规则校验（无游戏进程） | 仅需 Node.js |
| `INTEGRATION` | 假文件桥 / HTTP 服务器 + `fengari` 加载生产 Lua 运行 | 仅需 Node.js |
| `RUNTIME` | 真机运行游戏并校验实时状态/文件桥/动作执行 | 本地 DST 开房读档 |
| `END_TO_END` | 真实模型（DSH MCP 或 F8）驱动真机运行整套生存任务 | 本地 DST + API Key / DSH |

文档与报告不得把 `UNIT` / `INTEGRATION` 的通过表述为真机或端到端通过。

---

## 4. 真机与自动化验证工具

### 4.1 单动作与状态观察（RUNTIME）

```bash
node tools/verify-live.mjs state                      # 读取一次实时状态快照
node tools/verify-live.mjs nearest flint --wait 5     # 等待 5 秒后执行实时选目标拾取
node tools/verify-live.mjs lookup axe                 # 验证无副作用信息查询
node tools/watch-state.mjs                            # 实时打印状态与事件流
node tools/watch-counters.mjs                         # 实时监控动作与反射计数器
node tools/unpause.mjs                                # 手动解除服务器暂停
```

### 4.2 会话录制与自动验收（END_TO_END / AUTODEV）

- **会话录制**：启用插件「自动写会话日志」后，在插件目录 `latestLogs/` 下生成 `session.txt`、`session.jsonl` 与 `server_log.txt`（每次启动或新会话覆盖写入）；也可独立运行 `node tools/session-recorder.mjs`。
- **分层真机套件**：`node tools/run-e2e-suite.mjs` / `node tools/run-live-tier1.mjs`（需本地世界与配套重置命令，详见 [AUTODEV.md](AUTODEV.md)）。
- **自动化质检闭环**：

```bash
npm run analyze        # 确定性解析 latestLogs 生成 .runtime/issue-report.json
npm run autodev        # dry 模式：静态门禁 + 日志质检 + 生成 AUTODEV_SUMMARY.md
npm run autodev:live   # live 模式：重装模组并执行分层真机测试（可选 --allow-git --agent-cmd）
```
