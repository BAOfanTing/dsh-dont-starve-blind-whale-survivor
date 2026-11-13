# Phase 6 · M5：Season Manager 四季生存管理

> 结论：**完成**。四季各有检查清单与准备计划，**季节和剩余天数全部读游戏世界状态**；
> 拿不到剩余天数时 `confidence='predicted'` 并明确说"预测不可靠"，完全拿不到季节时
> `'unreliable'`。配套的 Lua 任务链（`autumn_prep` / `winter_prep` / `spring_prep` / `summer_prep`）
> 真正执行"机械的那一半"（采草/砍木/捡木/做工具/生火/进食）。

## 1. 文件修改清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `mcp-server/src/survival/season.ts` | 新增 | `detectSeason()` / `assessSeason()` |
| `DontStarveWhaleSurvivor/scripts/main/task_runner.lua` | 修改 | +4 条季节准备任务链 |
| `mcp-server/src/tools/phase6Tools.ts` | 新增 | `get_seasonal_readiness` / `prepare_for_season` |
| `mcp-server/test/p6.test.ts` | 新增 | 3 个季节用例（含"剩余天数缺失必须报不可靠"） |

## 2. 实现原理

### 2.1 季节判断：不写死日期

```ts
// ① 优先读 world.season（游戏 worldstate 的真实字段）
// ② 没有就用 is_autumn / is_winter / is_spring / is_summer 布尔开关
// ③ 两者都没有 → 'UNKNOWN'，confidence='unreliable'
```

任务书 §8 明确「不能把季节开始和结束日期写死」——这里**没有任何日期常量**，
所有"还剩几天"都来自 `world.remaining_days_in_season`。

| 拿到什么 | confidence | 说明（输出给 AI 的原话） |
|---|---|---|
| 季节 + 剩余天数 | `verified` | "季节与剩余天数都来自游戏世界状态：WINTER，本季还剩 3 天" |
| 只有季节 | `predicted` | "季节来自游戏，但**拿不到剩余天数**：具体哪天换季/哪天来 Boss 只能估，不可靠" |
| 都没有 | `unreliable` | "拿不到季节数据：下面的季节计划仅供参考" |

后两种情况还会额外塞一条 warning：`不要按固定日期安排（例如"第 21 天必来巨鹿"这种假设）`。

### 2.2 检查清单

**通用（每季都查）**：燃料 ≥6、食物 ≥4、武器伤害 ≥34、护甲减伤 ≥70%、随身光源、
基地/落脚点（附近结构物 ≥3，`null` 表示没扫描数据）。

**季节专属**：

| 季节 | 专属检查 | 计划要点（都映射到已实现的工具） |
|---|---|---|
| 秋季 | 保暖装备、保温石、烹饪锅（无数据 → `ok:null`） | 砍树 → 采草/枝 → 做斧头护甲 → 保暖帽+保温石 → 建营火 → 囤食物 |
| 冬季 | 体温 >5℃、保暖装备、保温石、取暖燃料 ≥10 | 保火 → 穿暖再出门 → 白天采集黄昏回 → 听吼声先确认撤离 → 保持 4+ 食物 |
| 春季 | 防雨装备、潮湿 <35%、理智 ≥40、避雷（无数据 → `ok:null`） | 做雨伞/雨帽 → 火堆挪到有顶处 → 雨天不站空旷地 → 关注理智 → 青蛙雨往基地走 |
| 夏季 | 防暑装备、体温 <60℃、基地防火（无数据 → `ok:null`） | 草帽/遮阳伞/降温石 → 只在早晚出门 → 清可燃物 → 备降温物资 → 补水 |

`ok: null` 的项（例如"有没有烹饪锅""野火风险"）**不参与打分**，也不会被当成"不达标"。
这是刻意的：没有数据就说没有数据，不假装知道。

### 2.3 `prepare_for_season` 怎么"真的执行"

第一版策略：**计划在 Node，机械执行交给 Lua 任务链**（Phase 5 M6 已有、真机验证过的机制）。

```
prepare_for_season(season=WINTER, execute=false)          → 只返回计划
prepare_for_season(season=WINTER, execute=true, confirmed=true)
  → 控制权检查 → 优先级门禁 → 下发 start_task(winter_prep)
  → 返回 command_id + 计划 + 明确说明"任务链只做机械步骤"
```

任务链里**没有**保暖帽/保温石/雨伞/降温石：那些配方第一批不在制作白名单里，
需要看材料够不够，交给 AI 用 `craft_item` 单独决定（计划里写清楚了）。

## 3. 关键代码

```ts
let confidence: SeasonConfidence = 'unreliable'
if (season !== 'UNKNOWN' && remaining !== null) {
  confidence = 'verified'
} else if (season !== 'UNKNOWN') {
  confidence = 'predicted'
  predictionNote = `季节来自游戏（${source}），但**拿不到剩余天数**：具体哪天换季/哪天来 Boss 只能估，不可靠`
}
```

Lua 任务链（节选）：

```lua
TASKS.winter_prep = {
  name = 'winter_prep',
  desc = '冬季准备：草 → 树枝 → 火把 → 木头 → 营火 → 进食（快进快出，别在夜里乱跑）',
  steps = { ... { job = 'make_fire', args = { recipe = 'campfire' },
                 need = function(p) return count_prefab(p,'cutgrass') >= 3 and count_prefab(p,'log') >= 2 end,
                 retry = 1, optional = false, timeout = 180, why = '建营火（冬天没火会冻死）' }, ... },
}
```

## 4. 实际测试

```
✔ P6-M5：季节来自世界状态；拿不到剩余天数必须报"不可靠"
✔ P6-M5：四季各有专属检查与计划（春=防雨/夏=防暑/秋=保暖/冬=体温）
```

第二条用例特意逐季断言专属检查键（`rain_gear` / `summer_gear` / `thermal_stone` / `body_temp`），
防止以后改模板时"四季写成一套"。

## 5. 预期结果（对照验收）

| 验收项 | 结果 |
|---|---|
| ⑧ 能够根据四季生成准备计划 | ✅ 四季各一套检查 + 有序计划 + 可执行任务链 |
| ⑫ 无数据不编造 | ✅ 剩余天数缺失 → `predicted` + warning；季节缺失 → `unreliable` |

## 6. 性能

`assessSeason` **3.4 µs**。

## 7. 已知问题

1. **剩余天数依赖 `world.remainingdaysinseason`**：某些构建/分片可能没有这个字段
   （`world_observer.lua` 是"有就写"），此时自动降级成 `predicted`。
2. **"有没有烹饪锅"查不到**：`nearby.entities` 只分到 `category=structure`，
   分不出是不是锅。已在检查项里如实标 `ok:null`。
3. **季节专属配方不在白名单**：保暖帽/保温石/雨伞/降温石第一批不能自动做（要手动或换 MCP 的 craft）。
4. **任务链是通用模板**：四条链的步骤高度相似（顺序与阈值不同），
   本质是"通用资源准备 + 季节优先级"，不是"冬季专用最优策略"。
5. **没有真机验证**：`prepare_for_season` 只在沙箱里验证了下发命令的路径。
