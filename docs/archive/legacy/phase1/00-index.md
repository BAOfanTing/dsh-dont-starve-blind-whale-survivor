# Blind Whale Survivor · Phase 1 交付物索引

> 目标：把《饥荒联机版》的游戏状态**读**出来（纯文字/JSON），交给外部服务；**本阶段不做任何游戏操作**。

## 交付物对照

| # | 交付物 | 文件 |
|---|---|---|
| 1 | 完整 Lua Mod 源码 | `DontStarveWhaleSurvivor/`（Phase 1 部分在 `scripts/main/`） |
| 2 | 完整 TypeScript Bridge 源码 | `bridge/src/`、`bridge/test/` |
| 3 | JSON Schema | `schema/state.schema.json` |
| 4 | 安装脚本 | `install.ps1`（装游戏模组）、`install-bridge.ps1`（装依赖+编译+测试） |
| 5 | 启动脚本 | `start-bridge.ps1` |
| 6 | 环境配置说明 | 本文 §2 ~ §4 + `docs/phase1/01-env-check.md` |
| 7 | API 验证报告 | `docs/phase1/07-api-verification.md` |
| 8 | 集成测试报告 | `docs/phase1/08-integration-report.md` |

## 里程碑文档

| 文档 | 内容 |
|---|---|
| `01-env-check.md` | 环境检查：系统/游戏/日志/模组加载机制/沙箱白名单/可用 API |
| `02-minimal-mod.md` | 最小模组：加载检测 + 首个 `[BWS]` 日志 |
| `03-player-world-observers.md` | 玩家 / 背包 / 世界观察器（字段来源逐条列出） |
| `04-entity-scan.md` | 附近实体扫描（分类/上限/缓存）+ **日志长度上限** |
| `05-state-schema.md` | 序列化与契约（两条 wire 记录 + GameState + 合并规则） |
| `06-bridge.md` | TypeScript Bridge（tail/校验/合并/REST） |
| `07-api-verification.md` | 每条游戏 API 的来源与实机验证结果 |
| `08-integration-report.md` | 五个场景实测 + 端到端 + 发现并修复的 7 个缺陷 |

## 1. 架构（一句话）

```
游戏服务端(分片进程) ──print──> master/caves_server_log.txt
                                   │  [BWS] {"type":"state"|"nearby"|"boot", ...}
                                   ▼
                        Bridge(轮询 tail → ajv 校验 → 按 tick 合并)
                                   ▼
                        GET /api/game/{state,player,inventory,world,nearby}
```

## 2. 环境要求

| 项 | 要求 | 本机实测 |
|---|---|---|
| 系统 | Windows（脚本是 PowerShell） | Win10 19045 |
| 游戏 | 饥荒联机版，**本地开世界**（服务器端模组） | 762172 |
| Node.js | ≥ 20（Bridge 用 NodeNext ESM） | v24.13.1 |
| 游戏模组 | `<游戏>/mods/DontStarveWhaleSurvivor`，并在 `mods/modsettings.lua` 里 `ForceEnableMod("BlindWhaleSurvivor")` | 已装 v0.6.0 |

## 3. 快速开始

```powershell
cd E:\Cache\XinLuguWuyu\dsh-dont-starve-blind-whale-survivor

# 1) 装/更新游戏模组（插件会自动装，这里手动跑也行）
node tools/install-mod.mjs

# 2) 装 Bridge 依赖 + 编译 + 跑单测
powershell -ExecutionPolicy Bypass -File install-bridge.ps1

# 3) 启动 Bridge（先开游戏、读档进世界）
powershell -ExecutionPolicy Bypass -File start-bridge.ps1
```

然后：

```powershell
curl http://127.0.0.1:18081/health
curl http://127.0.0.1:18081/api/game/status
curl http://127.0.0.1:18081/api/game/state
```

## 4. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BWS_LOG_DIR` | 自动找 | `…\Klei\DoNotStarveTogether` |
| `BWS_LOG_FILES` | `master_server_log.txt,caves_server_log.txt` | 跟哪些日志 |
| `BWS_INCLUDE_CLIENT` | 不跟 | `1` = 也跟 `client_log.txt`（客户端数据不权威，默认不要） |
| `BWS_PORT` / `BWS_HOST` | 18081 / 127.0.0.1 | 只本机 |
| `BWS_POLL_MS` | 300 | 轮询间隔 |
| `BWS_MAX_TICK_GAP` | 3 | state 与 nearby 配对允许的 tick 差 |
| `BWS_SCHEMA` | 仓库里的 schema | 契约路径 |

游戏内可调（`modinfo.lua` 的 `configuration_options`，在游戏模组设置里改）：

| 选项 | 默认 | 说明 |
|---|---|---|
| `OBSERVER_INTERVAL` | 2 秒 | state 记录间隔 |
| `OBSERVER_SCAN_RADIUS` | 16 格 | 实体扫描半径（2~40） |
| `OBSERVER_SCAN_SECONDS` | 4 秒 | 扫描间隔（≥ state 间隔） |

## 5. 测试

```powershell
# Lua 侧 + DSH 插件侧（71+ 个用例，用 fengari 真跑 Lua）
node --test "tests/*.test.mjs"

# Bridge 侧（22 个用例）
cd bridge; npm run build; node --test "dist/test/*.test.js"
```

## 6. 明确不做的事（Phase 1 边界）

- ❌ 不操作角色：不移动、不采集、不战斗、不寻路、不调 AI
- ❌ 不做 MCP（留给后续阶段）
- ❌ 不做 DeepSeek 内置 Agent
- ✅ 只读：状态观察 + 结构化输出 + 对外查询接口
