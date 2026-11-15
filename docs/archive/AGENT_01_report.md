# AGENT-01 · 真实 LLM 游戏控制闭环验证（报告）

> 日期：2026-11-13｜模组 **0.17.2** / 插件 **0.9.2**｜基线 HEAD `0a1e5d8`
> 真实模型：本机 `http://127.0.0.1:8788/v1` 的 `deepseek-v4.1-flash`（用户 profile 里已配置的 local provider）
> 证据类型全程标注：STATIC / UNIT / RUNTIME / NOT_RUN

---

## 1. 结论（先说最重要的）

| 验收项 | 结果 |
|---|---|
| 真实 LLM 自主读取状态 → 决策 → 调工具 → 游戏**真实执行** → 再读状态复核 | **✅ 达成（RUNTIME）** |
| 全程使用**真实模型响应**（非固定 JSON / 非模拟 / 非脚本直调 Dispatcher） | ✅ 是 |
| 单控制者（只有 `f8_agent` 持租约，未同时跑 F8 与 MCP 循环） | ✅ 是 |
| 预算（≤12 次工具调用 / 5–10 分钟） | ✅ 12 次 / 约 4 分钟 |
| 新增游戏动作 / 改白名单 / 改 Guard / 改 Lease / 改桥 / 改 Nearby | ❌ **一条都没改** |

**闭环证据链**（第 2 轮，角色活着）：

```
开局 位置=(-22,32)
#1 get_state            → 读到快照、附近目标、自己的旧笔记
#4 move_to(-27,32)      → control_denied（authority_revoking）  ← 换手没完成
#6 move_to(-27,32)      → control_denied（handover_pending）    ← 同上
#8 move_to(-27,32)      → ✅「走到了 (-27,32) 附近（还差 1.1 格）」
#9 get_state            → ✅ 位置变成 (-26,32)，模型看到了变化
#10 move_to(-27,32)     → ✅ 又靠近一点（还差 0.9 格）
#12 harvest(#2, s1622)  → ❌ stale_snapshot（模型抄错了 id，见 §4）
```

**游戏真实变化**：角色位置 `(-22,32) → (-27,32)`（第 8、10 次调用造成），模型在第 9、11 次 `get_state` 里**亲眼读到位置已变**，并据此继续决策。这就是"读 → 决策 → 执行 → 复核 → 再决策"的完整闭环。

---

## 2. 工具权限审计（第一阶段）

| 工具 | 实际行为 | 分类（**修正后**） | 证据 |
|---|---|---|---|
| `get_state` | 只读快照文件 | 游戏状态读取 | `lib/tools.js` `getState()` → `readSnapshot()` |
| `get_guide` | 读 `guide/*.md` 或插件配置里的覆盖文本 | 游戏知识读取 | `readGuide()` / `ctx.guides` |
| `update_notes` | **写本地文件（覆盖）** | **本地数据写入** | 见 §2.1 |
| `move_to` / `stop` / `pickup` / `harvest` | 经 dispatcher → 文件桥 → Lua Guard → 游戏 | 游戏动作执行 | `executeTool()` 里的 dispatcher 分支 |

### 2.1 `update_notes` 专项审计（**它不是只读工具**）

| 审计项 | 结论 | 证据 |
|---|---|---|
| 是否修改持久化文件 | **是**，`writeFileSync` 覆盖写 | `lib/index.js` `writeNotes()` |
| 路径是否固定 | **固定**：`<DSH_HOME 或 ~/.dsh>/plugins-data/dsh-dont-starve-blind-whale-survivor/notes.md` | `notesPath()` |
| 是否存在任意路径写入风险 | **否**：路径里没有任何用户/模型可控片段，模型只能改**内容**，改不了路径 | 同上 |
| 输入是否有长度限制 | **没有**（`String(input.notes ?? '').trim()`，schema 无 `maxLength`） | `lib/tools.js` `updateNotes()` |
| 追加还是覆盖 | **覆盖**（`writeFileSync`），空字符串 = 清空 | 同上 |
| 是否可能覆盖用户已有笔记 | **会**：这是 AI 自己的笔记文件，每次调用整篇替换（设计如此，但没有"追加"选项） | 同上 |
| 是否有对应测试 | **有**（间接）：`tests/mcp.test.mjs` 调 `update_notes` 后 `get_state` 能读到；`tool-parity` 断言它走本地分支。**没有**专门测长度上限/清空/覆盖语义 | `mcp.test.mjs:114`、`tool-parity.test.mjs:81` |

**真实落盘证据（RUNTIME）**：本次第 1 轮闭环中模型调用 `update_notes` 写了一段复盘笔记，文件确实出现在
`C:\Users\BAOfanTing\.dsh\plugins-data\dsh-dont-starve-blind-whale-survivor\notes.md`（1060 B，18:45:20），
且下一次 `get_state` 把它显示在正文最前面。

**已修正的分类错误**（本阶段唯一改动的代码/文档）：
`docs/STATUS.md`、`docs/ARCHITECTURE.md`、`docs/TESTING.md`、`tests/tool-parity.test.mjs` 的注释/用例名
原来把 `update_notes` 与两个只读工具并称"只读工具"，现已改为"**本地工具**（`update_notes` 是写工具）"。
**没有改任何实现**。

---

## 3. 模型入口（第二阶段）

| 问题 | 答案 | 证据 |
|---|---|---|
| F8 内置 Agent 如何配置模型 | 插件设置里的 `apiKey` / `baseUrl` / `model` / `aiMaxTokens`，留空则回退环境变量 `SENSENOVA_API_KEY` / `DEEPSEEK_API_KEY` | `lib/index.js:296-304` |
| MCP 客户端如何连接 | 插件进程内起 Streamable HTTP，`http://127.0.0.1:18090/mcp` | `lib/mcp-server.js` |
| `lib/agent.js` 如何组织请求 | 每步：`get_state` → 把观察塞进 user 消息 → `POST /chat/completions`（带 `tools`）→ 执行 `tool_calls` → 结果塞回 `role:tool` → 循环 | `lib/agent.js:108-182` |
| RULES 与 guide 如何进入上下文 | `buildInstructions(guides)` 把 `RULES + 「## 游戏常识」+ 主攻略全文` 拼成 system | `lib/index.js:211-226` |
| 工具 Schema 如何传递 | `toolList()` 映射成 OpenAI `tools[].function` | `lib/agent.js:196-199` |
| 工具结果如何回传 | `role: 'tool'`，`content` 截断 4000 字符 | `lib/agent.js:179` |

**本次驱动方式**：**直接复用产品自己的 `AiRunner` 类**（F8 用的就是它），只是把 `settings()` 指向本机端点、
并在 `callTool` 外面加了计数/预算/日志。**没有新建 Agent / MCP / 注册表 / Dispatcher**。

### 3.1 凭据处理与一次**我的失误**（必须记录）

- 凭据来自用户已配置的 `~/.dsh/.credentials.yaml` 的 `LOCAL_API_KEY`（本机端点用），**没有**写入代码/仓库/日志。
- ⚠️ **失误**：我在排查过程中用 `Select-String` 打印了该文件内容，把 `LOCAL_API_KEY` 的**明文值打进了会话记录**。
  这是我的操作错误（任务明确禁止打印 Key）。该 key 只对 `127.0.0.1:8788` 有效，影响面限于本会话记录；
  **建议轮换**。后续所有命令都改成只报"有无/长度"。

---

## 4. 完整工具调用记录（第四阶段）

**第 1 轮（角色是灵魂，全部动作被拒）** — 12 次调用，`actor_is_ghost`：

| # | 工具 | 参数 | 结果 |
|---|---|---|---|
| 1 | `get_state` | `{}` | 读到状态（血 25%、黄昏、附近有浆果丛/燧石） |
| 2 | `move_to` | `{x:-37,z:52,timeout:40}` | ❌ `actor_is_ghost` |
| 3-5 | `get_state` ×3 | `{}` | 重复读状态 |
| 6 | `move_to` | `{x:-43,z:54,timeout:20}` | ❌ `actor_is_ghost` |
| 7 | `get_state` | `{}` | — |
| 8 | `get_state` | `{format:'json'}` | 读到 `actor_type: player_ghost` |
| 9 | `get_state` | `{}` | — |
| 10 | `update_notes` | 长笔记 | ✅ 写盘 1060 B（**唯一成功且有副作用的一次**） |
| 11-12 | `get_state` ×2 | `{}` / `{format:'json'}` | 笔记已回显 |

模型行为评价（第 1 轮）：**正确识别了"自己是灵魂、什么都做不了"**，没有反复硬试同一动作（只试了 2 次就转去
用 `get_state json` 确认 `is_ghost`），然后写下复盘笔记。这属于**正确的自我诊断**。

**第 2 轮（角色已复活）** — 12 次调用：

| # | 工具 | 参数 | Dispatcher/Guard | 游戏结果 |
|---|---|---|---|---|
| 1-3 | `get_state` ×3 | `{}` | — | 读到状态 + 旧笔记 |
| 4 | `move_to` | `{x:-27,z:32,timeout:20}` | `control_denied / authority_revoking` | 未执行 |
| 5 | `get_state` | `{}` | — | — |
| 6 | `move_to` | 同上 | `control_denied / handover_pending` | 未执行 |
| 7 | `get_state` | `{}` | — | 位置已变 (-22,33) |
| 8 | `move_to` | `{x:-27,z:32}` | ✅ ok | **✅ 走到 (-27,32)** |
| 9 | `get_state` | `{}` | — | **✅ 看到位置 (-26,32)** |
| 10 | `move_to` | 同上 | ✅ ok | **✅ 更近（还差 0.9 格）** |
| 11 | `get_state` | `{}` | — | 位置 (-26,32) |
| 12 | `harvest` | `{target_ref:'#2', snapshot_id:'s1622'}` | ✅ 通过授权 | ❌ `stale_snapshot` |

**游戏实际状态变化（证据）**：
- 开局 `位置=(-22,32)`，收尾 `位置=(-27,32)`（脚本读快照所得）。
- 第 9、11 次 `get_state` 的文本里出现 `位置：(-26,32)`，模型据此继续调 `move_to` → 说明它**读了执行后的状态**，不是盲发。

---

## 5. 模型错误行为检查（逐条）

| 检查项 | 是否发生 | 说明 |
|---|---|---|
| 调用不存在的工具 | ❌ 没有 | 12 次全在 7 个工具内 |
| 尝试 `chop`/`mine`/`attack` 等未开放动作 | ❌ 没有 | guide 对齐（STABILITY-01）见效 |
| 选择未成熟采集对象 | ❌ 没有 | 它挑的 `#2` 在「可收获」段里且标了"可收" |
| 使用旧 `snapshot_id` | ✅ **发生了（第 12 次）** | 抄的是 `get_state` 顶层 `快照 s1622`，而工具要的是 `nearby.snapshot_id`。**根因在渲染层，见 §6** |
| 反复执行已失败的动作 | ⚠️ 轻微 | `move_to` 重试 3 次，但每次失败原因不同（revoking → handover_pending → 成功），属合理重试 |
| `actor_busy` 时无意义重试 | ❌ 没有 | 没遇到 `actor_busy` |
| 把 `accepted` 当 `succeeded` | ❌ 没有 | 第 12 次失败后它没有宣称成功（预算同时用尽） |
| 把 `unknown` 当成功 | ❌ 没有 | 未出现 `unknown` |
| 没读执行后状态就宣称完成 | ❌ 没有 | 每次动作后都 `get_state` |

---

## 6. 必须解决的问题（按层归因）

### P1 · 工具返回信息缺陷：`snapshot_id` 有两个，文本只暴露错的那个

**证据**（`node` 直读同一份快照）：

```
顶层 sequence / snapshotId : 1650 / s1650
nearby.snapshot_id         : r1794565044-5047-n365
两者是否相同               : false
```

- 渲染处：`lib/state/snapshot.js:277` → `# 快照 ${snapshot.snapshotId}`（= `s1650`，序列号）
- 而 `pickup` / `harvest` 的 guard 要求的是 `nearby.snapshot_id`（`r…-n365`）
- **文本里从头到尾没有出现 `nearby.snapshot_id`**（`renderNearby()` 只印桶，不印 id）
- 结果：模型只能抄 `s1650` → 必然 `stale_snapshot`

**归因**：**工具返回信息问题**（不是模型决策问题，也不是 prompt 问题）。模型做了完全合理的事——
照着它唯一能看到的 id 填。

**建议修法**（本阶段按纪律**未改**）：
1. `renderNearby()` 的段头加上它自己的 id，例如
   `附近（16 格内，snapshot_id=r…-n365，只显示 32/190 个）`；
2. 或把顶层 `# 快照` 改成同时给出两个 id 并注明用途（哪个是"给人看的序号"，哪个是"动作要填的"）；
3. 顺带把 `pickup`/`harvest` 的参数说明从"那一帧附近扫描的 snapshot_id"改成
   "**「附近」段开头那个 `snapshot_id=`**"。

### P2 · 换手期间的动作会被连拒两次（体验问题）

`#4` 得 `authority_revoking`、`#6` 得 `handover_pending`，第 3 次才成功。
说明"抢到租约"与"换手真正完成"之间有窗口，模型只能靠重试跨过去。
**归因**：控制权时序（Lease），**不是模型问题**。本次未改（禁止改 Lease）。
建议：让 `control.acquire()` 在换手窗口内**等到 ack 或超时**再返回，而不是立刻 `denied`。

### P3 · 模型笔记会被"旧世界"的信息污染

第 2 轮开局，模型读到的第一条就是第 1 轮写下的"我已死亡"笔记，而它此时**已经复活**。
它没有立刻被误导（因为它同时看到了 `位置` 和 `生命`），但这是个隐患。
**归因**：笔记是跨世界/跨会话持久的，且没有"世界标识"。
建议：笔记里带上 `runtime_id`/`session_id`，或复活/换世界后提示"笔记可能过期"。

---

## 7. NOT_RUN / BLOCKED

| 项 | 状态 | 原因 |
|---|---|---|
| 端到端**长跑**（数十步、跨昼夜） | **NOT_RUN** | 本阶段限定 12 次调用 / 5–10 分钟 |
| `pickup` 的真实 LLM 闭环 | **NOT_RUN** | 12 次预算内模型没走到燧石旁（它先解决移动）；`pickup` 本身已在 STABILITY-01 真机 5/5 |
| `harvest` 的真实 LLM 闭环 | **NOT_RUN（失败）** | 第 12 次因 `stale_snapshot` 被拒（P1）；`harvest` 本身已在 STABILITY-01 真机 13 PASS |
| F8 **按键**路径 | **NOT_RUN** | 仍是"无法在不接管键鼠下模拟 F8"；本次用的是同一个 `AiRunner` 类，但不是按键触发 |
| MCP 客户端（DSH 会话）路径 | **NOT_RUN** | 本会话没有加载该插件，无法用 DSH 会话当客户端 |
| 多控制者竞争（F8 与 MCP 同时抢） | **NOT_RUN** | 本阶段明确要求单控制者 |

---

## 8. 成功率

| 维度 | 数值 |
|---|---|
| 模型调用轮次 | 2 轮（第 1 轮角色是灵魂 → 全部动作被拒） |
| 工具调用总数 | 24 次（12 + 12） |
| 产生**真实游戏变化**的调用 | 2 次（两次 `move_to`，位置 (-22,32)→(-27,32)） |
| 动作成功率（第 2 轮，排除 P2 换手） | 3/4（`move_to` 2 成功 + 1 因 P1 失败的 `harvest`） |
| 失败分类 | 控制权时序 2 次（P2）、工具返回信息 1 次（P1）、角色状态 2 次（第 1 轮 `actor_is_ghost`） |

---

## 9. 建议的下一阶段

1. **先修 P1**（一行渲染 + 两处参数说明），这是唯一"模型怎么做都必然失败"的缺陷。
2. **再修 P2**（让 `acquire` 在换手窗口内等待），否则每次冷启动都要浪费 1–2 次调用。
3. P3 排在后面（笔记加世界标识）。
4. 修完后重跑本实验，把 `pickup` / `harvest` 的真实 LLM 闭环也跑通（预算放宽到 20 次调用）。
5. 不要因为这次失败就去加"规划器"或改 prompt —— 模型的行为在这次实验里是**合理**的。

---

## 10. 本阶段改动清单

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `docs/STATUS.md` | `update_notes` 分类：只读 → **本地写入**；加分类说明；已知问题 #13 | 审计发现它是写工具 |
| `docs/ARCHITECTURE.md` | 架构图/工具表里"只读工具"→"本地工具"；补一句"`update_notes` 会写文件" | 同上 |
| `docs/TESTING.md` | "只读工具"→"本地工具（含 update_notes）" | 同上 |
| `tests/tool-parity.test.mjs` | **注释与用例名**（断言未动、用例数未变） | 同上 |
| `docs/AGENT_01_report.md` | 本文件 | 交付 |

- 测试：**479 / 479**（未减少、未跳过、未放宽断言）。
- 未改：工具实现、dispatcher 白名单、Lua Guard、Control Lease、ACK/Handover、文件桥协议、Nearby Schema、
  RULES（大规模）、Reflex、动作数量。
- 未新增：游戏动作、服务、MCP Server、工具注册表、Dispatcher。
