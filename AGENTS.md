# 仓库开发与代理规范

## 1. 架构与唯一事实来源
- **游戏数据与配方**：`lib/game-data/recipes-and-foods.js` 维护合成/建造配方、食物定义、`SCIENCE_ONE_BUILDINGS` 与 `EQUIPPABLE_ITEMS`，严禁在动作规格或技能中重复定义。
- **工具与规格契约**：`lib/actions/specs/`（`ACTION_SPECS`）与 `lib/tools.js`（`TOOLS`）定义对外工具表面；`README.md` 中的工具计数与工具名由 `npm run check:docs` 强制校验。
- **目标与规则同源**：`DontStarveWhaleSurvivor/scripts/whale/*rules.lua`（`pickuprules`、`harvestrules`、`eatrules`、`equiprules`、`craftrules`、`targetrules`）由观察端（`observe.lua` / `nearby.lua`）与执行端（`guard.lua`）共用；`lib/actions/target-kinds.js` 与 `targetrules.lua` 保持逐项一致。
- **插件入口**：`lib/index.js` 装配 `lib/dsh/{config,preset,gateway,session-hooks}.js`；修改 `lib/dsh/config.js` 中的 `Config` 后必须执行 `npm run build:client`。

## 2. 不可动摇的安全边界与核心能力
- **唯一动作出口**：所有游戏动作必须经过 `lib/dispatcher.js`（`ACTION_SPECS` 白名单、AJV 参数校验、`snapshot_id` 核对、陈旧引用熔断、动作后快照核验）。
- **控制权租约与停止隔离**：跨进程互斥由 `lib/control.js` 管理（两阶段换手 + 含 `job_cleared` 在内的五项 ACK 硬校验）；停止协调与超时隔离由 `lib/control/stop-coordinator.js` 负责。
- **Lua 复核闸与原生动作通道**：`guard.lua` 与 `actor.lua` 独立复核每条命令，仅通过 `BufferedAction -> locomotor:PushAction` 下发。
- **运行模式与伴生防御**：Autopilot 模式仅暴露 `AUTOPILOT_TOOL_WHITELIST` 并在 `executeTool` 做纵深拦截。严禁破坏温蒂伴生防御（`actions/core.lua` 的 `A.may_preempt`、`battle.lua`、`abigail_flower` 保护）、Localhost HTTP 桥（`lib/http-server.js` + `bridge.lua`）、思考超时自动暂停（`shouldPauseOnThinking` + `DoStaticPeriodicTask`）与 `lib/autodev/` 闭环。

## 3. 测试目录与验证门禁
- `tests/{bridge,control,planner,skills,autodev,lua}/` 按模块域组织 `*.test.mjs` 测试集；共用夹具放在 `tests/helpers/`。
- 严禁删除、注释或 `.skip` 任何有效测试断言。
- 按验证等级如实报告证据（`UNIT`、`INTEGRATION`、`RUNTIME`、`END_TO_END`）。
- 每次提交前必须跑通以下四道门禁：
  ```bash
  npm run lint && npm run check:docs && npm run check:hygiene && npm test
  ```

## 4. 仓库卫生与提交约定
- **常青文档原则**：活代码、注释、测试与活文档（`README.md`、`docs/*.md`、`DontStarveWhaleSurvivor/guide/*.md`）只描述当前真实结构与不变量，严禁残留阶段编号、工单号或日期排错日记；历史记录统一归档至 `docs/archive/`。
- **单一锁文件**：根目录仅保留 `package-lock.json`。
- **提交信息规范**：遵循 `commitlint.config.cjs` 的 Conventional Commits 格式（如 `fix(control): ...`、`refactor(dsh): ...`、`docs(docs): ...`），subject 使用中文；可用作用域为 `bridge`、`control`、`planner`、`skills`、`lua`、`dsh`、`autodev`、`docs`、`ci`、`test`、`chore`（作用域可选）。
