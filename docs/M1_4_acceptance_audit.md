# M1.4 验收审计 · 四项代码审查

> 审计对象：`0.13.1`（审查基线）→ 审计过程中按"明确安全洞"补了最小防护，**0.13.2**
> 审计方式：读代码 + 沙箱探针（`tools/m14-audit-probes.mjs`）+ 真机采样（`tools/m14-watch.mjs`）
> 结论速览：**4 项里 1 项通过（Q1，附建议）、2 项发现真问题（Q2 只建议、Q3 已加最小防护）、1 项部分通过（Q4，附建议）**

---

## Q1 · Schema 版本兼容性 —— 通过（有一处需要记录）

### 事实

| 问题 | 结论 | 证据 |
|---|---|---|
| 根 Schema 是否仍 `bws.state/1` | **是**，没动 | `observe.lua:O.SCHEMA = "bws.state/1"`；`lib/state/snapshot.js:STATE_SCHEMA` |
| 同一 Schema 下有没有字段类型变化 | **有**：`data.nearby.buckets` 从**数组**（M1.1）变成**对象**（M1.4） | M1.1：`buckets:[{kind,label,items}]`；M1.4：`buckets:{threats:[],food:[],…}` |
| 有没有 `nearby.schema` | 有：`bws.nearby/1`，但**只有 M1.4 的负载才有** | `nearby.lua:N.SCHEMA`；老负载没有这个字段 → 可据此区分新旧 |
| 老结构能否读 | **能**（Node 原样透传，不崩、不丢） | 实测：`normalizeState` → `nearby.status="legacy"`、`toJsonPayload` 保留数组 |
| 新结构能否读 | **能** | 真机样本 + `M1.4-22`（deepEqual 钉住 buckets/refs/delta） |
| Node 是否假设 buckets 一定是数组 | **没有**：生产代码从不遍历 `nearby.buckets`（只透传）；只有测试与采样工具遍历，且两者都写了 `Array.isArray` 双分支 | `lib/state/snapshot.js`（无 buckets 引用）；`tools/m14-watch.mjs` 的 `flatRefs/bucketCounts` |
| 其他消费者 | 无（MCP `get_state` 只返回文本/整块 JSON；没有工具按桶取值） | `lib/tools.js` |
| 旧文件是否仍走 legacy | 是：没有 `data.schema` → `schema="legacy"`、`textSource="legacy"`，`nearby` 为 `undefined` | `M1.1-17`、真机旧文件冒烟 |

### 结论与最小方案（**未改动，等你确认**）

- 根 `bws.state/1` 不需要升版：**信封结构没变，变的是 `data.nearby` 内部**，而且新旧可以靠
  「`nearby.schema` 是否存在 / `Array.isArray(nearby.buckets)`」可靠区分。
- 建议（M2 开工前，5 行以内）：
  1. `lib/state/snapshot.js` 增加 `nearbyBuckets(nearby)` 小工具：数组→`{kind:items}` 归一化，对象原样返回；
     以后任何消费者都只调它，不再自己判断。
  2. `docs/M1_4_nearby_schema.md` 明确写"`buckets` 在 0.13.0 起是对象；0.12.x 是数组"，已写。
- 不建议现在升 `bws.state/2`：会让 M1.2 已验收的旧文件兼容逻辑多一条分支，收益为零。

---

## Q2 · Delta 是否把"被截断的实体"误报成 removed —— **确认是缺陷**（只给建议，未改代码）

### 代码事实

```lua
-- nearby.lua:build()
local kept = {}                       -- ← 经过"单桶上限 + 总量上限"之后的可返回集合
for ... if count < max_per_bucket and total < max_total then kept[...] end
local delta = compute_delta(kept, baseline_key(identity))   -- ← ★ 拿截断后的集合做比较
```

`compute_delta` 只收到 `kept`，于是：

- `prev.by_guid` 记的是**上一次的 kept**，不是上一次的完整扫描；
- 一个实体**仍然存在**，只因排序变化掉出前 N / 被单桶上限挤出 → 被判成 `removed`；
- 反过来，一个实体重新挤进窗口 → 被判成 `added`（还会带一个新 `#N`，看起来像"新出现的"）。

### 沙箱复现（`node tools/m14-audit-probes.mjs` 探针 A）

```
第 1 次扫描：returned=3 found=4  refs=#1,#2,#3  delta=baseline
第 2 次扫描：removed_count=1
  removed=[{"previous_ref":"#1","prefab":"evergreen",...}]      ← 只是变远、被挤出窗口
  added  =[{"ref":"#3","prefab":"evergreen",...}]                ← 同一棵树重新进窗
世界里 4 棵树一棵都没少。
```

### 真机证据（`tests/artifacts/M1_4/`）

`m14-runtime-2026-11-12T16-00-57.json`（60 秒 / 16 次扫描，145 个候选只返回 24~27 个）：

| 快照 | added | removed | 说明 |
|---|---|---|---|
| n111 | `#19:robin` | `#26:twiggytree` | **树不会自己消失** → 被挤出窗口 |
| n113 | `#22:robin` | `#26:grass` | 草也不会消失 |
| n120 | `#12:twigs, #21:robin, #2:frog` | `#18:robin, #14:carrot_planted` | **胡萝卜（种在地里）被报消失** |
| n123 | — | `#3:frog` | 之前 `#2:frog` 还在被报"新增/变化" |

玩家这段基本站着不动（背包 0/15、天数不变，`seq` 连续），所以"多枝树/胡萝卜/草消失"只能是截断造成的。

### 影响

- 对 M1.4 本身：只是让模型看到错误的"变了"，会增加无效思考。
- 对 **M2**：`removed` 中的实体一旦被当成"已消失/已死"，会导致策略误判（例如以为资源没了、以为威胁走了）。
- 附加风险：`added` 里的 `ref` 是**新编号**，如果模型把"added"理解为"新出现的实体"，
  会把老实体当成新目标。

### 最小修复建议（等你确认再改）

1. `build()` 里用**完整扫描结果**（`scanned.entities`，截断前）建立"存在性基线"；
2. `added`：只报"当前 kept 里、上一次完整扫描里没有"的实体（有 ref，可操作）；
3. `removed`：只报"上一次完整扫描有、这一次完整扫描**也没有**"的实体（→ 语义变成"确实不在附近了"）；
   仍然带 `previous_ref` 并标注它只是历史；
4. `changed`：只在"两次都在完整扫描里、且当前在 kept 里（有 ref）"时给出；
5. 新增字段 `not_returned = total_found - total_returned`，让模型知道"还有 N 个没列出来"；
6. 回归测试：
   - 实体被截断挤出窗口 → **不得**出现 removed（探针 A 转成测试）；
   - 实体真的离开半径 → 必须出现 removed；
   - 实体在窗口外但仍在扫描内发生血量变化 → 不报 changed（没有 ref 没法操作）。

> 我没有改这一块：任务书要求"发现问题只给建议"。当前实机表现已记录在运行时报告里。

---

## Q3 · `snapshot_id` 与运行实例隔离 —— **确认有洞，已加最小防护（0.13.2）**

### 代码事实（0.13.1）

```lua
local scan_seq = 0
local function build(...) scan_seq = scan_seq + 1; local snapshot_id = "n" .. scan_seq ... end
local refs = {}   -- refs[snapshot_id] = { ["#1"]=entity, ... }
```

- `scan_seq` 每次模块加载都从 0 开始；`snapshot_id` 只有 `n<序号>`；
- `refs` 只增不减（旧快照的映射永远留着）；
- 真机已确认 **`session_id` 跨"重启游戏"不变**（两次采样都是 `5F056B29DE65C542`）；
- 因此：重启后新实例又产出 `n1`，而 Node/M2 手里上一次运行的 `(n1, #1)` **能命中新实例里的另一个实体**。

### 沙箱复现（探针 B，0.13.1 时输出）

```
运行实例 1：snapshot_id=n1 refs=#1:spider
运行实例 2：snapshot_id=n1 refs=#1:evergreen
→ 两次运行的 snapshot_id 相同？是（撞号）
用实例 1 的 (n1, #1) 在实例 2 里解析：解析成功 → evergreen     ← 命中了另一个实体
```

### 已实施的最小防护（`0.13.2`，`nearby.lua` 约 25 行）

| 改动 | 作用 |
|---|---|
| 模块加载时生成 `RUNTIME_ID`（`r<os.time>-<4位随机>`） | 每次"运行实例"（游戏启动/重新进世界）都不同 |
| `snapshot_id = "<RUNTIME_ID>-n<序号>"` | 跨运行不再撞号 |
| `nearby.runtime_id` 字段输出 | Node/M2 可把它写进命令里，服务端二次校验 |
| `Resolve()` 先比前缀 | 非当前实例的快照一律 `stale_snapshot` |
| `refs` 只保留**当前**扫描 | 同一运行内的旧 `#N` 也失效；顺便避免 `refs` 无限增长 |
| 新增测试 `tests/m1_4-runtime-id.test.mjs`（2 例） | 跨实例拒绝、同实例旧扫描号拒绝 |

探针 B 修复后：

```
运行实例 1：snapshot_id=r1794500000-5138-n1 refs=#1:spider
运行实例 2：snapshot_id=r1794500000-4852-n1 refs=#1:evergreen
用实例 1 的 (#1, r1794500000-5138-n1) 在实例 2 里解析：拒绝：stale_snapshot     ✓
```

### 仍然存在的次要问题（记录，不阻塞）

1. **引用表没有按 actor 隔离**：同一运行实例内换观察对象（未来无主幸存者/多角色）时，
   旧 actor 的 `#N` 仍在表里。当前只有一个玩家，风险为 0；M2 做多身体时要按
   `(runtime, actor, scan)` 三元组存。
2. **`#N` 的有效性还依赖"扫描是否还新鲜"**：`Resolve` 只校验快照号与实体有效性，
   不校验"实体是否仍在扫描半径内"。M2 执行前应再比一次距离/可见性（schema 文档里已写明这条要求）。
3. 真机样本里暂时**看不到 `runtime_id`**：正在跑的世界还是 0.13.1 的内存镜像，
   重新进一次世界后 `nearby.runtime_id` 才会出现。

---

## Q4 · Node 文本回退兼容 —— 部分通过（回退文本缺 nearby）

### 事实（`lib/state/snapshot.js`，实测脚本 `.runtime/m14-node-fallback.mjs`）

| 检查 | 结果 |
|---|---|
| 新结构（对象 buckets） | ✅ 原样透传，`toJsonPayload` 保留 refs/delta/snapshot_id |
| 旧结构（数组 buckets） | ✅ 原样透传，不崩、不丢 |
| Lua 文本缺失时回退 | ⚠️ 能出文本，但**只有**快照头 + 三围 + 位置；**没有 nearby、没有背包/装备、没有注意事项** |
| JSON 输出丢 nearby | ❌ 不丢 |
| `#N` 是否被改 | ❌ 不改（Node 完全不动 refs） |
| Delta 是否被重算 | ❌ 不重算（原样透传） |
| 空桶 | ✅ 对象里 7 个空数组原样保留（Lua 侧用了 `J.ARRAY` 保证 `[]`） |
| empty 与 error 是否混淆 | ✅ Node 不判断，原样给 `status`；文本由 Lua 渲染时已区分 |
| F8 / MCP 同一份快照 | ✅ 都是 `readSnapshot()`（M1.1-16 逐字节相等） |

### 影响

回退路径只在"Lua 文本为空/文件被截断"时用。这种时候模型会**看不到附近实体**（也就看不到 `#N`），
只能靠 `format=json` 补救——但默认格式是 text。这是覆盖率缺口，不是崩溃。

### 最小建议（等你确认）

在 `renderFallbackText()` 里补两段（约 20 行）：优先读 `snapshot.nearby`（兼容对象/数组），
按桶输出 `#N 名称 距离`；有 `delta` 时补一行变化。再补一个单测：`text=""` + 新结构 → 回退文本里必须出现 `#1`。

---

## 附：审查方法可复现

```powershell
node tools/m14-audit-probes.mjs        # Q2 / Q3 的沙箱探针（只读，不连游戏）
node tools/m14-watch.mjs --seconds 60  # 真机采样（只读，需要游戏在跑）
new-item -Force .runtime | out-null; node .runtime/m14-node-fallback.mjs   # Q4 的 Node 回退实验
node --test --test-force-exit "tests/*.test.mjs"   # 262/262
```
