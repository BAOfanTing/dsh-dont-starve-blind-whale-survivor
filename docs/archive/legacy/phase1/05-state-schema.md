# 里程碑 6：state_serializer 与 JSON Schema（契约冻结）

> 这一里程碑把「日志里输出什么」变成一份**可被机器校验的契约**：
> 结构统一在 `state_serializer.lua`，契约写在 `schema/state.schema.json`，测试用 `ajv` 真校验。

## 1. 文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/main/state_serializer.lua` | 新增 | 统一结构 + 三种 wire 记录 + 长度预算裁剪 + 打印 |
| `schema/state.schema.json` | 新增 | JSON Schema（draft-07），描述三种记录 + 合并后的 `GameState` |
| `DontStarveWhaleSurvivor/scripts/main/observer_manager.lua` | 重写 | 只管「取数 + 交给序列化器」，不再自己拼 JSON / 管预算 |
| `DontStarveWhaleSurvivor/modmain.lua` | 修改 | 追加 `modimport`（共 13 个模块） |
| `tests/phase1-serializer.test.mjs` | 新增 | 5 个用例：三种记录字段、预算裁剪、超长放弃、**真实记录过 schema** |
| `package.json` / `modinfo.lua` | 修改 | 版本 0.6.0；devDependencies 增加 `ajv` |

## 2. 为什么是「两种记录」而不是一个 JSON

饥荒日志**每行约 3.9K 字符截断**（里程碑 5 实机发现）。一条完整状态（player+inventory+world+40 实体）
实测 3.9K+，必定断在半截。

所以线上（wire）拆成三种记录，用 `tick` 配对：

| type | 内容 | 频率 |
|---|---|---|
| `boot` | 加载证明 + 端/分片/采样间隔 | 每次进世界一次 |
| `state` | `session / player / inventory / world / observer` | 每 `OBSERVER_INTERVAL`（默认 2s） |
| `nearby` | `radius_tiles / scanned / counts / entities` | 每 `OBSERVER_SCAN_SECONDS`（默认 4s，内容是缓存） |

Bridge 把同一 `session + tick` 的 `state` 与 `nearby` 合并成 `GameState` 对外服务（里程碑 7）。

## 3. 契约要点（`schema_version = "1"`）

- **每条记录都带**：`schema_version` / `type` / `phase` / `observer_version` / `side` / `shard`，
  以及可选的 `session` / `t`（unix 秒）/ `rt`（真实秒）/ `sim_tick`。
- **`state` 里绝不出现 `entities`**（schema 里用 `not: { required: ["entities"] }` 钉死）。
- **字段取不到就省略**，不写 `null`：地面分片没有 `cave` 段、没戴帽子没有 `equipment.head`。
- **布尔值 `false` 一定输出**，消费方不用猜「没有这个键」是什么意思。
- 合并后的 `GameState` 把时间戳收进 `timestamp: { unix, real_s, sim_tick }`，其余部分同名。

### 两条「历史兼容」约定（实机校验后加的）

| 情况 | 处理 |
|---|---|
| `tick` 位置 | 0.6.0+ 在记录顶层；更早版本只在 `observer.tick`。schema 不强制 → Bridge 用 `record.tick ?? record.observer.tick` 归一化 |
| `nearby.entities` 缺失 | 预算兜底时整段实体都不发（`oversize: true` / `returned: 0`）。schema 允许缺失 → Bridge 归一化成 `[]` |

### 空表的坑

Lua 分不清空数组和空对象，`{}` 会被编码成 `{}`。所以 `inventory.items` 在 schema 里允许
「数组」或「空对象」，Bridge 需要把 `{}` 归一化成 `[]`。这是本阶段唯一一个「形状不确定」的字段，
已经在 schema 里写明。

## 4. 长度预算（序列化器内）

```
MAX_RECORD_CHARS = 3500   -- 实测截断点在 3900 左右，留余量
```

`S.Emit(record, shrink)` 的顺序：

1. 编码，超预算且给了 `shrink` → 调它裁剪（目前只有 `nearby` 有：按距离保留前面的实体，
   `returned` 改成实际条数、`trimmed: true`；一条都放不下就整段不发 + `oversize: true`）；
2. 还超 → 丢掉 `entities` 并标 `oversize`；
3. 仍超 → **整条不打印**，返回 `false, "record_too_long:N"`，由观察器计入 `observer.errors`。

原则：**宁可少一条数据，也不能让日志里出现半截 JSON**（外面解析会直接失败）。

## 5. 验证结果

### 单测（不进游戏）

```powershell
node --test tests/phase1-serializer.test.mjs   # 5 例
node --test "tests/*.test.mjs"                 # 全项目 74 例
```

其中「真实记录通过 schema 校验」这一例是拿 **ajv** 对 `schema/state.schema.json` 编译后，
校验真实跑出来的 boot / state / nearby 三条记录，以及合并后的 `GameState`。

### 拿你机器上的真实日志做契约回归

```
真实日志按类型 [通过, 失败]: {"Boot":[3,0], "State":[118,0], "Nearby":[39,0]}
```

即：master / caves / client 三个日志里共 **160 条记录全部符合 schema**。

这一步当场抓出了两个「想当然」：
1. 老版本的 `state` 没有顶层 `tick`（只有 `observer.tick`）→ schema 放宽并定了归一化规则；
2. 预算兜底时 `nearby` 会连 `entities` 都不发 → schema 允许缺失。

## 6. 下一里程碑要用到的归一化规则（写给 Bridge）

```ts
// 1) 只采信服务端
if (record.side !== 'server') skip()
// 2) tick 归一化
const tick = record.tick ?? record.observer?.tick
// 3) 合并：同一个 session + tick 的 state 与 nearby 拼一起
// 4) 空表归一化
const items = Array.isArray(inv.items) ? inv.items : []
const entities = Array.isArray(nearby.entities) ? nearby.entities : []
// 5) 记录解析失败（半截行/坏 JSON）单独计数，不认为是「没有数据」
```

## 7. 已知限制

- schema 只覆盖 Phase 1 读到的字段；以后加字段要同时改 `state_serializer` 与 schema，
  并把 `schema_version` 往上提（Bridge 按版本决定怎么解析）。
- `counts` 的键是分类名，schema 用 `additionalProperties: integer` 放开（分类以后可能新增）。
- 采样 2 秒 / 扫描 4 秒是默认值，可在 modinfo 里改；Bridge 不应假定固定间隔。
