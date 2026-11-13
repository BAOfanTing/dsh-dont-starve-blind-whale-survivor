# Phase 4 · M3：Tool Adapter（MCP Schema → Function Calling + 白名单 + 参数校验）

> 结论：MCP 的 12 个只读工具已全部转成 Function Calling 定义，**约束完整保留**（minimum/maximum/enum/maxItems/minLength/required）；
> 白名单 + 参数校验在**程序层**执行（不依赖提示词）；13 个测试全过，39 个 agent 测试全过。

## 1. 新增文件

| 文件 | 内容 |
|---|---|
| `agent/src/mcp/toolAdapter.ts` | ToolAdapter：Schema 转换、白名单、参数校验（ajv）、结果压缩、调用统计 |
| `agent/test/m3.test.ts` | 13 个用例 |

依赖新增：`ajv@8.17.1`（真实 JSON Schema 校验）。

## 2. 三道安全边界（程序层，不靠提示词）

### ① 白名单（任务书 §13）

```ts
export const READ_ONLY_ALLOWLIST = [
  'get_game_status', 'get_bridge_status', 'get_player_status', 'get_inventory',
  'get_world_status', 'get_nearby_entities', 'get_nearby_resources', 'get_nearby_threats',
  'get_base_status', 'refresh_game_state', 'get_recent_events', 'get_command_result',
] as const
```

**双重检查**：① 必须在白名单内；② 不能命中危险动作模式：

```ts
export const FORBIDDEN_TOOL_PATTERNS = [/^move/i, /^attack/i, /^chop/i, /^mine/i, /^eat/i,
  /^craft/i, /^build/i, /^drop/i, /^kill/i, /^teleport/i, /^exec/i, /^shell/i, /^lua/i]
```

不在名单里的工具**连定义都不给模型**（`toolDefinitions()` 只返回白名单内的），调用时直接 `TOOL_NOT_ALLOWED`。
这样即使以后 MCP Server 加了写操作工具，Agent 也不会自动获得它。

### ② 参数校验（任务书 §7）

模型给的 `arguments` 是**字符串**，必须过两关：

```
JSON.parse 成功 → 是对象（不是数组/标量）→ ajv Schema 校验通过 → 才能执行
```

任一关失败都不执行，返回结构化错误给模型：

| 失败点 | 错误码 |
|---|---|
| JSON 解析失败 / 不是对象 | `INVALID_ARGUMENTS_JSON` |
| Schema 校验失败（越界/类型错/缺必填/enum 不符） | `INVALID_ARGUMENTS_SCHEMA` |
| 工具不在白名单 | `TOOL_NOT_ALLOWED` |
| 工具执行抛错 | `TOOL_CALL_FAILED` |

### ③ 约束保留

MCP Server 的 schema **原样**作为 Function Calling 的 `parameters`，模型能看见边界：

```json
"radius_tiles": { "type": "integer", "minimum": 2, "maximum": 20, "default": 16 }
"categories": { "type": "array", "maxItems": 10, "items": { "type": "string", "minLength": 1, "maxLength": 24 } }
"severity": { "type": "array", "items": { "type": "string", "enum": ["info","warning","critical"] } }
```

## 3. 踩到的一个真坑：`$schema` 版本不匹配

MCP Server 返回的 schema 带 `"$schema": "https://json-schema.org/draft/2020-12/schema"`，
而 **ajv 默认实例只认 draft-07** → 编译直接报：

```
no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

后果：12 个工具**全部被 skip**，`toolDefinitions()` 返回空数组（模型一个工具都看不到）。

**修复**：`validateSchema: false` + 编译前剥掉 `$schema` 字段。
我们实际用到的关键字（type/properties/required/minimum/maximum/enum/maxItems/minLength）
在 draft-07 语义一致，所以用默认方言校验是安全的。

> 这个坑如果没测出来，M4 的 Agent Loop 会"看起来在跑但从不调工具"，很难排查。

## 4. 实际运行结果

```
适配 12 个工具，跳过 0 个

给 LLM 的工具定义（前 3 个）：
  get_bridge_status  参数=[] 必填=[]
  get_game_status    参数=[include_raw,shard] 必填=[]
  get_player_status  参数=[shard] 必填=[]
    描述=…（只读工具，不会修改游戏状态）

=== 校验演示 ===
  ✅ 合法      get_nearby_entities -> {"radius_tiles":16,"limit":3}
  🚫 半径越界   get_nearby_entities -> [INVALID_ARGUMENTS_SCHEMA] /radius_tiles must be <= 20
  🚫 类型错     get_nearby_entities -> [INVALID_ARGUMENTS_SCHEMA] /radius_tiles must be integer
  🚫 缺必填     get_command_result  -> [INVALID_ARGUMENTS_SCHEMA] (root) must have required property 'command_id'
  🚫 坏 JSON   get_player_status   -> [INVALID_ARGUMENTS_JSON] Expected property name or '}'…
  🚫 越权工具   move_to             -> [TOOL_NOT_ALLOWED] 不在只读白名单内

=== 真实工具调用 ===
  ok=true elapsed=24ms
  content: {"ok":true,"freshness":{"stale":true,"stale_reason":"heartbeat_timeout",…}}
  → role:tool 消息: {role:"tool", tool_call_id:"call_demo_1", name:"get_player_status"}

统计: {"adapted":12,"calls":1,"blocked":0,"invalidArgs":0,"failures":0}
```

注意 `content` 里的 `freshness.stale: true` —— 游戏没在跑，MCP Server 如实标注了过期，Agent 层会把这个信息带给模型。

## 5. 结果压缩

工具结果默认上限 **4000 字符**，超了截断并标注 `（已截断，原长 N 字符）`。
优先用 `structuredContent`（去掉 `raw_snapshot` 这种大字段），避免把上下文塞爆。

## 6. 测试（13 个用例）

```
✔ 白名单：只适配 12 个只读工具，全部来自 MCP Server 实际清单
✔ Schema 转换：约束完整保留（minimum/maximum/enum/maxItems/minLength/required）
✔ Schema 转换：描述带上"只读"与必填参数提示
✔ 参数校验：合法参数通过并应用 default
✔ 参数校验：越界 / 类型错 / 缺必填 全部拒绝
✔ 参数校验：坏 JSON / 非对象 全部拒绝
✔ 白名单：越权工具名一律拒绝，且错误里给出可用工具
✔ executeToolCall：成功时返回压缩后的内容与结构化结果
✔ executeToolCall：越权/坏参数计入统计
✔ 结果压缩：超长结果被截断并标注原长
✔ toToolMessage：保留 tool_call_id 与工具名
✔ toolDefinitions：给 LLM 的定义与适配数量一致，且都是 function 类型
✔ refresh：MCP 工具清单变化后重建适配（不写死）
# tests 13 / pass 13
```

越权测试覆盖了 12 个危险工具名：`move_to / attack / chop_tree / mine_rock / eat / craft_item / build_wall / drop_item / execute_lua / run_shell / kill_mob / teleport` —— **全部被拒**。

## 7. 全量测试

| 套件 | 用例 | 结果 |
|---|---|---|
| agent（M1 + M2 + M3） | **39** | 全过 |

## 8. 未完成项

1. **没有多轮 Agent Loop**：M4 才把"模型要工具 → 执行 → 喂回 → 继续"串成循环。
2. **没有 tool_choice 策略**：目前固定 `auto`（M4 决定是否在某些轮次用 `none` 强制收敛）。
3. **没有工具调用去重**：如果模型在同一轮里重复调同一个工具同一个参数，会真的执行两次（只读工具无害，但浪费）。
4. **没有结果缓存**：`get_player_status` 连续调两次会打两次 MCP（MCP 层有 1.5s 缓存，能挡一部分）。
5. **`refresh()` 不是自动的**：M4 会在每轮 Loop 开始时刷新，或监听 `tools/list_changed`。

## 9. 风险

1. **`$schema` 兼容性是长期隐患**：如果 MCP Server 以后用了 draft-2020-12 独有的关键字（如 `prefixItems`、`unevaluatedProperties`），剥掉 `$schema` 后 ajv 可能校验不严。已在代码注释里写明。
2. **白名单硬编码在 Agent 侧**：MCP Server 加了新的只读工具，Agent 不会自动获得（需要改 `READ_ONLY_ALLOWLIST`）。这是**故意的安全设计**，但升级时要记得同步。
3. **`useDefaults: true` 会改写参数**：模型没给的参数会被填默认值再发给工具。这是好事（减少模型负担），但要注意"模型故意不传"和"忘了传"无法区分。
4. **结果压缩可能丢关键信息**：4000 字符上限对 `get_nearby_entities` 的 40 条实体够用，但 `include_raw=true` 时会被截断。

## 10. 下一步（M4）

Agent Loop + Task Planner：
- 多轮循环（MAX_AGENT_ROUNDS=4 / MAX_TOOL_CALLS_PER_ROUND=4 / TOOL_TIMEOUT_MS=15000 / AGENT_TIMEOUT_MS=60000，全部可配）；
- 每轮：构建消息 → 请求 LLM → 有 tool_calls 就校验+执行+喂回 → 没有就出最终答复；
- **正确保存 assistant 的 reasoning_content**（DeepSeek 带 tools 时必须回传）；
- 达到限制时终止并报告原因；
- Task Planner：短期/中期/长期/紧急目标 + 优先级 + 风险分析。
