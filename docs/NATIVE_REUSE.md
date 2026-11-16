# 原版能力复用审计（NATIVE-REUSE）

> 阶段：NATIVE-REUSE｜模组 0.38.0｜插件 0.9.3
> 本机环境：`E:\SteamLibrary\steamapps\common\Don't Starve Together`，构建号 **762172**，
> `data/databundles/scripts.zip` 解包出 **4109** 个引擎 Lua 文件（`.runtime/dst-scripts/`）。
> **下面每一条"原版有/没有"都是对着这 4109 个文件核出来的，不是凭记忆。**

---

## 0. 一句话结论

饥荒已经给了我们三样**本来就在重复造**的东西：真实照明读数、绕障逃跑方向、玩家挥砍的正确动作路径。
这三样已经接进来（`scripts/whale/native.lua`），Reflex 的职责同时收窄成"现在就会死的五件事 + 解决不了就上报"。
行为树（Brain/BehaviourNode）**没有**接——原因是原版 BT 需要 `inst:SetBrain`，而那是给 NPC 用的，
给玩家挂 brain 会替换掉 `SGwilson` 之外的一整套控制流，属于"大规模重构"，本阶段明确不做。

---

## 1. 当前项目功能 → 原版能力 映射表

图例：**可直接调用** = 原版有现成函数，参数就对得上｜**薄封装** = 原版有但需要包一层适配｜
**自研** = 原版没有（或不可用于玩家），必须自己写｜**不适用** = 原版有但玩家角色用不了。

| # | 当前项目功能 | 现有实现文件 | 原版是否已有对应能力 | 结论 | 兼容性风险 |
|---|---|---|---|---|---|
| 1 | 寻路与移动 | `actions.lua` `JOBS.move_to` / `walk_to`（`locomotor:GoToPoint`） | ✅ `LocoMotor:GoToPoint`（locomotor.lua:1040）、`FindPath`、`Warp` | **可直接调用**（已经在用） | 低。`GoToPoint(pt, ba, run, overridedest)` 四参签名在 762172 未变 |
| 2 | 逃跑（撤离方向） | `reflex.lua` `reflex_flee`（原为直线后退） | ✅ `RunAway:GetRunAngle`（behaviours/runaway.lua:33-94）+ `FindWalkableOffset`（simutil.lua:330） | **薄封装 → 已接入** `native.FleeAngle` | 中。`RunAway` 构造只存参数，可安全实例化；但 `Visit()` 会自己驱动 locomotor，**不能用** |
| 3 | 追击与攻击 | `actions.lua` `attack_by_ref`（`BufferedAction + ACTIONS.ATTACK`） | ✅ `ACTIONS.ATTACK`（actions.lua:1961）+ `SGwilson` `ActionHandler`（SGwilson.lua:1382）；❌ `combat:TryAttack` 对玩家**无效** | **薄封装 → 已接入** `native.AttackAction` / `CanSwing` / `LastAttackTime` | 中。见 §3 的实测依据 |
| 4 | 寻找光源 | `reflex.lua` `nearby_light`（原按 `light` 标签 + 燃料猜） | ✅ `inst:IsInLight()`（entityscript.lua:2095，玩家有 LightWatcher）+ `Light:GetCalculatedRadius()`（pigbrain.lua:157 的用法）；❌ `lightsource` 标签**在本构建里没有写入方** | **薄封装 → 已接入** `native.IsLit` / `FindLitSource` | 低。但**不能**照抄 `FindLight` 行为节点，见 §4 |
| 5 | 采集与拾取 | `actions.lua` `JOBS.pickup` / `pick` / `gather`（`ACTIONS.PICKUP` / `PICK`） | ✅ `ACTIONS.PICKUP`（actions.lua:367，带 `extra_arrive_dist`）、`ACTIONS.PICK` | **可直接调用**（已经在用） | 低 |
| 6 | 砍树与挖矿 | `actions.lua` `job_work` / `work_by_ref`（`ACTIONS.CHOP` / `MINE` / `DIG` / `HAMMER` + `workable`） | ✅ 同名动作 + `components/workable.lua` | **可直接调用**（已经在用） | 低 |
| 7 | 进食与治疗 | `actions.lua` `JOBS.eat` / `heal`（`ACTIONS.EAT` / `HEAL`）+ `eatrules.lua` 白名单 | ✅ `ACTIONS.EAT`（actions.lua:365）、`Eater:CanEat`（eater.lua:320）、`ACTIONS.HEAL`（actions.lua:438） | **可直接调用 + 自研白名单** | 低。白名单是我们的安全边界，**不要**换成原版 `CanEat`（会把怪物肉放进来） |
| 8 | 制作与建造 | `actions.lua` `JOBS.craft` / `build`（`builder:MakeRecipe`） | ✅ `Builder:MakeRecipe`、`ACTIONS.BUILD`（actions.lua:2622） | **可直接调用**（已经在用） | 低。`MakeRecipeFromMenu` 在服务端不干活（已在代码注释里记着） |
| 9 | 动作排队与执行 | `actions.lua` `push()`（`locomotor:PushAction`） | ✅ `LocoMotor:PushAction`（locomotor.lua:882）→ `EntityScript:PushBufferedAction`（entityscript.lua:1634） | **可直接调用**（已经在用） | 低 |
| 10 | 动作完成与失败反馈 | `actions.lua` 各 JOBS 状态机 + `dispatcher` 的 `verify` | ✅ `BufferedAction:AddSuccessAction` / `AddFailAction`（bufferedaction.lua:74-88）、`actionfailed` 事件（entityscript.lua:1705） | **薄封装**：现在靠"前后状态比对"，原版有现成回调 | 低。改用回调是后续优化项，本阶段未做（会动到全部 JOBS） |
| 11 | 行为树调度 | 无（`reflex.lua` 自己写 P0-P3 优先级） | ✅ `Brain` / `BT` / `PriorityNode`（behaviourtree.lua:533） | **不适用** | **高**。`Brain` 要 `inst:SetBrain`，玩家身上会与 `SGwilson` + `playercontroller` 冲突；本阶段**不做** |
| 12 | 白天/夜晚判定 | `reflex.lua` `current_phase()`（`TheWorld.state.phase`） | ✅ 同上（世界状态字段） | **可直接调用**（已经在用） | 低。但"是否黑暗"必须用 `IsInLight`，不能用 phase（见 §4） |

### 1.1 每项的复用结论汇总

| 结论 | 项 |
|---|---|
| **原版可直接调用（无需改动）** | 1 寻路、5 拾取、6 砍挖、7 进食、8 制作、9 动作排队、12 时段 |
| **需要薄封装（本阶段已完成）** | 2 逃跑方向、3 玩家攻击、4 真实照明 |
| **需要自行实现（原版不可用）** | 10 完成/失败核对（原版回调可选，现状够用）、11 行为树调度（玩家挂 brain 不安全） |
| **不适用** | 11 |

---

## 2. 最值得复用的五项能力（按价值排序）

| 排名 | 能力 | 为什么最值钱 | 状态 |
|---|---|---|---|
| 1 | **真实照明读数**（`IsInLight` + `GetCalculatedRadius`） | 死亡统计里 8/10 是暗影生物，而暗影生物由低理智刷出、低理智由"没光"驱动。以前用"背包有没有火把 + 附近有没有 fire 标签"猜，会**误判**：举着烧空的火把、站在照不到的火堆旁都算"有光" | ✅ 已接入 |
| 2 | **绕障逃跑方向**（`RunAway:GetRunAngle`） | 真机第 6 天"直线撤离没甩脱、被 5 只蜘蛛围死"就是直线后退的必然结果。原版那套有 8 方向扇扫 + 偏转记忆 | ✅ 已接入 |
| 3 | **玩家挥砍的正确路径**（`ACTIONS.ATTACK` 的 BufferedAction） | 确认了 `combat:TryAttack` 对玩家**只发事件、不挥砍**（SGwilson 无 `doattack` 处理器）。这是"贴着怪站半天不掉血"的根因 | ✅ 已接入 |
| 4 | **动作完成回调**（`AddSuccessAction` / `AddFailAction`） | 比"前后状态比对"更准、更省 tick | ⬜ 未做（会动全部 JOBS，风险大于收益） |
| 5 | **`extra_arrive_dist` 自动接近**（`ACTIONS.PICK` / `PICKUP` 自带） | 已经在用；它解释了"为什么不需要先 `move_to` 再 `pickup`" | ✅ 已在用 |

---

## 3. 玩家攻击：为什么不能用 `combat:TryAttack`（源码 + 实证）

### 3.1 源码链

```
playercontroller.lua:1909   self.locomotor:PushAction(BufferedAction(self.inst, target, ACTIONS.ATTACK), true)
        ↓
SGwilson.lua:1382           ActionHandler(ACTIONS.ATTACK, ...)  → 进 "attack" 状态
SGwilson.lua:10787-10790    State{ name = "attack", ... }
SGwilson.lua:11066-11077    TimeEvent(8*FRAMES, ... inst:PerformBufferedAction())
        ↓
entityscript.lua:1679       PerformBufferedAction() → bufferedaction:Do()
        ↓
actions.lua:1961-1982       ACTIONS.ATTACK.fn → act.doer.components.combat:DoAttack(act.target)
        ↓
combat.lua:1120-1242        DoAttack → CalcDamage → targ.components.combat:GetAttacked_Internal
combat.lua:1231             self.lastdoattacktime = GetTime()      ← 真实出手时间戳
```

而 `combat:TryAttack`（combat.lua:829-843）只有：

```lua
function Combat:TryAttack(target)
    local target = target or self.target
    local is_attacking = self.inst.sg:HasStateTag("attack")
    if is_attacking then return true end
    if self:CanAttack(target) then
        self.inst:PushEvent("doattack", {target = target})
        return true
    end
    return false
end
```

`doattack` 的处理器在 `CommonHandlers.OnAttack()`（commonstates.lua:361）里，
而**只有** `SGplayer_hosted.lua:54`、`SGpig*.lua` 这类非玩家 stategraph 注册了它；
`SGwilson.lua` 全文**没有** `doattack` 字样（已 grep 确认，只有 `ActionHandler(ACTIONS.ATTACK, ...)`）。

**结论**：对玩家调 `TryAttack` 只会 `PushEvent("doattack")`，没有任何状态机接住它 → **不挥砍**。
外部证据一致：Sei 模组 `companion.lua:71-83` 用无头实测记录了同一个坑
（"a spider at 0.8 m stayed at full health for 10 s"），并加了一层 `doattack → ACTIONS.ATTACK` 翻译。

### 3.2 本项目的落地

`native.AttackAction(ent, target)` 造 `BufferedAction(ent, target, ACTIONS.ATTACK, nil)`，
由 `actions.lua` 现有的 `push()` → `loco:PushAction` 推给 `SGwilson`。
另外两处按原版语义补强：

- `native.CanSwing` 读 `Combat:InCooldown()`（combat.lua:128，玩家 `min_attack_period = TUNING.WILSON_ATTACK_PERIOD = 0.4s`，tuning.lua:43/119）。
  冷却没完就推，`SGwilson.lua:10791` 会直接 `ClearBufferedAction` 并把状态弹回 idle —— 白推。
- `native.LastAttackTime` 读 `combat.lastdoattacktime`（combat.lua:1231）。
  挥砍次数**按真实出手算**，不按我们推了几次算 —— 否则回执会撒谎（推了被丢掉也算一次）。

---

## 4. `lightsource` 标签：本构建里没有写入方（重要发现）

原版 `behaviours/findlight.lua` 是这么找光的：

```lua
local LIGHTS_TAGS = {"lightsource"}
function FindLight:PickTarget()
    self.targ = GetClosestInstWithTag(LIGHTS_TAGS, self.inst, self.see_dist)
end
```

我们**核对了构建 762172 的全部 4109 个 Lua 文件**：

| 出现 `lightsource` 的地方 | 性质 |
|---|---|
| `behaviours/findlight.lua:31,46` | 查询 |
| `brains/pigbrain.lua:150-157` | 查询 |
| `brains/hermitcrabbrain.lua:179,661,664` | 查询 |
| `components/crop.lua:113`、`prefabs/farm_plants.lua:30` | 查询（作物需光） |
| `prefabs/flower.lua:79` | 查询 |
| `widgets/uiclock.lua:186` | 查询（洞穴时钟） |
| `tuning.lua:7991-8005`、`components/vase.lua:117-136` | 只是**表字段名**，不是 tag |
| `prefabs/{booklight,cavelight,cavelightmoon,chesterlight}.lua` | 只是**资源文件名** `cave_exit_lightsource.zip` |
| **`AddTag("lightsource")`** | **0 处** |

进一步：把整个游戏安装目录（含 `bin64/*.exe`、`*.dll`）按字节搜 `lightsource`，**0 命中**；
作为对照，同一个文件里 `AddTag` / `GetLightAtPoint` / `LightWatcher` 都能搜到，
说明"搜不到"不是方法问题。

同时确认：**火焰的光不在火堆本体上**。
`prefabs/campfire.lua` 只 `AddTag("campfire"/"NPC_workable"/"cooker"/"storytellingprop")`，
真正的光来自子实体 `firefx_light`（`components/firefx.lua:18` `SpawnPrefab("firefx_light")`），
而 `prefabs/firefx_light.lua` 只 `AddTag("FX")`。

**所以**：`lightsource` 很可能由引擎侧（C++ 的 `Light` 组件注册）写入，Lua 侧不可见、不可验证。
按"拿不准的判据不能当安全边界"的原则，本项目**不依赖它**，改用两条可验证的路：

1. `inst:IsInLight()` —— 玩家身上有 `LightWatcher`（`player_common.lua:2446-2448` 设了
   `LightThresh .075` / `DarkThresh .05`），这是**引擎自己**算的"我是否被照亮"，权威。
2. `Light:GetCalculatedRadius()` —— 原版 `pigbrain.lua:157` 就是这么判"火堆够不够近"的，
   值由引擎给，可信。

`native.FindLitSource` 用的就是第 2 条（配合 `Light:IsEnabled()` 和燃料判空）。

> ⚠️ 遗留不确定项：`lightsource` 到底由谁写入，本阶段**没有验证成功**。
> 已记在这里，别再有人花时间从 Lua 侧找它。

---

## 5. 外部三个 Mod 的研究结论

| 仓库 | 许可 | 最后提交 | 行为树组织 | 对本项目的可用性 |
|---|---|---|---|---|
| `sei-studio/sei`（`native/dst-mod/sei`） | 见仓库 | 2026-11-15（活跃） | **原生** `Brain`/`BT`/`PriorityNode` + 8 层有序节点 | ⭐ 最有参考价值：**单槽位 + 树序即优先级**；`doattack → ACTIONS.ATTACK` 翻译层；`GetLightAtPoint` + 双阈值滞回 |
| `hineios/FAtiMA-DST` | **MIT**（2018 Fábio Almeida） | 2018-11-21 | 原生 `Brain` + `PriorityNode` | 骨架可参考；两个逻辑 bug（`OnSpringLenght` 拼错、death 载荷混用 `afflicter`/`attacker`），**别照抄** |
| `votus777/DST-AICompanion` | **MIT**（2024 Hansae，但**未保留上游署名**） | commit 日期不可信（14 个 commit 同一天、2 个 "Add files via upload"） | 同 FAtiMA（直接衍生） | **在 762172 上开箱即崩**：`GetModActualName` 传错名、mod 沙箱里调 `io.open`、玩家读 `components.follower`。只可读思路，不可抄代码 |

### 5.1 许可证分析（本项目 MIT）

| 情形 | 结论 |
|---|---|
| 直接复制 Sei / FAtiMA / AICompanion 的 Lua 代码 | 三者都有许可（MIT 或仓库声明），MIT 兼容 MIT；但**必须保留原版权声明** |
| 只借鉴**思路/调用方式**（本项目做法） | 不受版权约束（思想与 API 用法不受保护）。本项目**没有**复制任何外部代码 |
| 复制 AICompanion 代码 | ⚠️ 它未保留 FAtiMA 的署名；从它抄等于二次转授，需自行补上上游署名 |
| 复制三者的 `.dll` / `.exe` | ⚠️ 二进制是否被 MIT 覆盖**不明确**（GAIPS / FAtiMA-Toolkit 另有许可）。本项目不碰 |
| 复制 Klei 的 `scripts/*.lua` | ⚠️ 受 Klei EULA 约束，**不能进仓库**。所以 `tests/native-reuse.test.mjs` 只在本机有饥荒时读原版文件，仓库里不留副本 |

**本项目当前状态：零外部代码复制。** `native.lua` 全部是自写代码 + 对公开 API 的调用。

---

## 6. 已改动的文件（本阶段）

| 文件 | 改动 | 性质 |
|---|---|---|
| `DontStarveWhaleSurvivor/scripts/whale/native.lua` | **新增**。真实照明 / 原版逃跑角度 / 玩家攻击封装 | 复用层 |
| `DontStarveWhaleSurvivor/scripts/whale/reflex.lua` | 照明判断改走 native；逃跑方向改走原版几何；新增 `Needs()` 需求上报 + `report_need` / `clear_need` | 复用 + 职责收窄 |
| `DontStarveWhaleSurvivor/scripts/whale/observe.lua` | `warnings` 渲染 `reflex.Needs()`（`need_text`） | 上报出口 |
| `DontStarveWhaleSurvivor/scripts/whale/actions.lua` | `attack_by_ref`：走 `native.AttackAction` / `CanSwing`；挥砍次数按 `lastdoattacktime` 核对 | 复用 + 修正确性 |
| `DontStarveWhaleSurvivor/modmain.lua` | `modimport` native.lua（在 actions / reflex 之前） | 装配 |
| `tests/native-reuse.test.mjs` | **新增** 28 条测试（含装配链） | 验证 |
| `tests/lua-mod.test.mjs` | modimport 数量 18 → 19，补 native 的顺序断言 | 跟随 |

**没动的**（严格保护现有架构）：Control Lease、Lua Guard、Target Snapshot Resolve、
Dispatcher、ACK/Handover、单角色活动任务约束、文件桥协议。全部动作仍只经
`dispatcher → 文件桥 → Lua guard → JOBS 状态机 → push()` 这一条链路。

### 6.1 装配测试抓出来的一个真实缺口（已修）

写 `NR-26`（装配后 `Needs()` 能拿到需求）时发现：`try_action` 的 `canRun` 预判
"帮不上忙就别抢占" 只**跳过**、**不上报**。也就是说：

- 天黑、缺材料、反射造不出光 → `canRun` 返回 false → 什么都不做，也不说话；
- 这正是真机第 10 天黄昏那个死锁（模型不知道反射在等什么，反射也不知道模型该去做什么）。

修法：在 `canRun` 判为 false 的那个分支里调 `report_need`。这条测试现在守着它。
同样处理了"饿到极限但背包没吃的"（`food` / `hungry_without_food`）。

---

## 7. 验证等级（严格区分）

| 项 | 等级 | 证据 |
|---|---|---|
| 读完原版 13 个关键脚本 | **已阅读源码** | `.runtime/dst-scripts/scripts/`（762172 解包），行号写在代码注释里 |
| 读完 Sei / FAtiMA / AICompanion | **已阅读源码** | `CODE_ARCHAEOLOGY_REPORT.md`（含每条 API 的引擎行号核对） |
| `lightsource` 标签无写入方 | **已阅读源码 + 二进制核对** | 4109 个 Lua 全文 + 全安装目录字节搜索 |
| native.lua 接入 | **已完成代码接入** | `modmain.lua` 的 modimport + 三处调用点 |
| 单元测试 | **单元测试通过** | `node --test tests/*.test.mjs` → **722/722**（含新增 28 条） |
| 原版 `RunAway:GetRunAngle` 真的跑通 | **单元测试通过（真加载原版文件）** | `NR-12` / `NR-13`：测试里加载 `.runtime/dst-scripts/scripts/behaviours/runaway.lua` 原文并调用 |
| 装配后整条链还能工作 | **单元测试通过** | `NR-25..28`：util + actions + native + reflex 一起加载，验证照明/需求上报/攻击/逃跑落点 |
| 真实游戏测试 | **尚未验证** | 本机 5 个 `dontstarve_dedicated_server_nullrenderer_x64` 进程自 2026-11-13 起常驻但**未监听端口**（10999/10888 无 listener），Master 的 `whale_state.json` 停在 18:41，`server_log` 停在 18:43 —— 世界当前不在跑。**没有做真机验证，也不声称做过** |
| 原版行为树（Brain）复用 | **未验证 / 本阶段不做** | 理由见 §1 第 11 项 |

---

## 8. 下一步（按价值排序，本阶段未做）

1. **真机复验**（必须先做）：重新读档加载 0.38.0，确认
   ① 夜里 `light_check` 的 `has_usable_light` 与真机血量对得上；
   ② 被围时 `reflex_flee` 的落点不再是直线；
   ③ `attack` 回执里的"打了 N 下"与怪的实际掉血一致。
2. **需求上报的闭环**：现在 Reflex 会上报 `light` / `light_materials` / `food`，
   Node 侧 `lib/plan.js` 还**没有**读这些需求去改计划。这是"Reflex 报告 → Node 规划"缺的另一半。
3. **动作完成回调**：把 JOBS 里的前后比对逐步换成 `AddSuccessAction`，减少一次 tick 的延迟。
4. **行为树评估**：如果将来要做"跟随/守卫"这类持续行为，再单独评估
   `inst:SetBrain` 对玩家是否安全 —— 目前证据是不安全（会与 `SGwilson` + `playercontroller` 争控制）。
