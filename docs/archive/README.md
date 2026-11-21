# 历史文档归档（Archive）

> ⚠️ 本目录下的文档是**历史存档**（主要来自 2026-11-19 的架构审计与更早的设计提案），
> 描述的是**当时**的代码与结论，**可能已经过时**，请不要当作当前事实。
>
> 当前有效的权威文档：
> - 架构：[docs/ARCHITECTURE.md](../ARCHITECTURE.md)
> - 状态与能力：[docs/STATUS.md](../STATUS.md)
> - 变更记录：[docs/CHANGELOG.md](../CHANGELOG.md)

## 内容

| 文件 | 是什么 |
|---|---|
| `audit/CODEBASE_INVENTORY.md` | 全库模块清单与 active/legacy/duplicate/dead 状态判定 |
| `audit/CALL_GRAPH.md` | 从 MCP/F8 到 Dispatcher / Lua Guard / Actions 的端到端调用图 |
| `audit/DUPLICATE_LOGIC.md` | 7 处重复/平行系统剖析 |
| `audit/ACTION_REGISTRY.md` | 动作 + 本地工具的全量矩阵与审计 |
| `audit/DOCUMENT_CONFLICTS.md` | 审计当时 README/ARCHITECTURE/STATUS 的版本与计数冲突 |
| `audit/REFACTOR_ROADMAP.md` | Phase R 治理路线图与目标架构草案 |
| `ARCHITECTURE_ANALYSIS.md` | 更早（Phase A）的层级规划设想 |

> 注：这些报告里出现的测试数、工具数等是**当时**的数字，会与今天不同；以 `npm test` 实测与当前文档为准。
