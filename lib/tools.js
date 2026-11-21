// MCP 工具：名字、说明、参数，以及真正执行（转给游戏里的模组）
//
// 模型看到的每一条说明都是给它看的操作手册：说清楚单位（格子）、前置条件、失败了怎么办。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, freshnessLine, renderFallbackText, toJsonPayload } from './state/snapshot.js'
import { createDispatcher } from './dispatcher.js'
import { ACTION_SPECS } from './actions/specs/index.js'
import { derivePlan, planPayload, renderPlan, PLAN_SCHEMA } from './plan.js'
import { arbitrate, renderDecision } from './planner/decision-arbiter.js'
import { TaskSkillOrchestrator } from './planner/task-skill-orchestrator.js'
import { SkillExecutor, skillIds, hasSkill } from './skills/index.js'
import { LeaseManager, defaultLeaseFile } from './control.js'
import { WorldRuntimeManager } from './planner/world-runtime-manager.js'
import { ACTION_TOOLS, LOCAL_TOOLS } from './actions/tool-defs.js'


/** 每个 bridge 一个 Dispatcher（M2.0：动作只有这一个出口） */
const dispatchers = new WeakMap()
function dispatcherFor(ctx) {
  const existing = dispatchers.get(ctx.bridge)
  if (existing) return existing
  const control = ctx.control ?? new LeaseManager({
    file: defaultLeaseFile(REPO_ROOT),
    authorityDirs: () => ctx.bridge?.leaseDirs?.() ?? [],
  })
  const dispatcher = createDispatcher({
    bridge: ctx.bridge,
    control,
    readSnapshot: () => readSnapshot(ctx),
    log: ctx.log ?? (() => {}),
    readLeaseAck: () => ctx.bridge?.readLeaseAck?.() ?? null,
  })
  dispatchers.set(ctx.bridge, dispatcher)
  return dispatcher
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
export const GUIDE_DIR = join(HERE, '..', 'DontStarveWhaleSurvivor', 'guide')

/** 攻略篇目：key -> {file, label, 说明} */
export const GUIDE_TOPICS = [
  { key: 'main', file: '攻略.md', label: '主攻略', hint: '游戏常识和前几天怎么活下来（默认就会读给 AI）' },
  { key: 'survive', file: '生存.md', label: '生存', hint: '季节、食物、光源、建家、冬天和夏天怎么过' },
  { key: 'fight', file: '战斗.md', label: '战斗', hint: '常见怪物、打法、Boss、走位和武器' },
  { key: 'cook', file: '烹饪.md', label: '烹饪', hint: '锅的配方、食材、保质期' },
]

function readGuide(file) {
  try {
    return readFileSync(join(GUIDE_DIR, file), 'utf8').trim()
  } catch {
    return ''
  }
}

export const BUNDLED_GUIDES = Object.fromEntries(GUIDE_TOPICS.map((t) => [t.key, readGuide(t.file)]))

/**
 * 把动作规格表渲染成一段"能力清单"。
 *
 * 为什么要生成而不是手写：RULES 里曾经硬编码"目前开放 8 个动作"，
 * 而 dispatcher 实际已放行 31 个 —— 模型读到的说明书和真实能力不一致，
 * 于是它不会去用已经能用的 chop / mine / cook / build。
 * 现在清单从 ACTION_SPECS 直接生成，加动作只需要加规格，提示词自动跟上。
 */
function capabilityList(specs) {
  const byCategory = new Map()
  for (const [name, spec] of Object.entries(specs)) {
    const cat = spec.category ?? 'other'
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat).push(name)
  }
  const label = {
    movement: '移动', gathering: '采集/劳作', crafting: '制作/建造', survival: '生存',
    interaction: '交互', combat: '战斗', info: '查询（只读）', social: '社交',
  }
  return [...byCategory.entries()]
    .map(([cat, names]) => `   · ${label[cat] ?? cat}：${names.join('、')}`)
    .join('\n')
}

/** 连接时发给模型的规则（每次连接都会读一遍）。 */
export const RULES = `你在《饥荒联机版》（Don't Starve Together）里操作一个角色，靠文字看世界、靠工具做事。

## 怎么玩
> **你只能通过调用工具来改变游戏。** 只回复自然语言（例如"我准备移动到附近的草丛"）**不会**执行任何动作，游戏状态不会改变。想做什么，就直接发出对应的工具调用；每轮至少发一个工具调用，直到目标完成或确实需要停手。
1. **任务开始时**调一次 get_state：它给你时间、位置、身体状况、背包、附近能采能捡的东西、敌人和危险提醒。
   **之后不要每做一个动作就重看一遍**：动作回执里已经带着核对过的结果（背包 +1 / 饥饿 +9 / 成品进包），
   直接用这些结果继续决策。只有下面这些情况才重新调 get_state：
   · 回执说 stale_snapshot / 结果未知 / 没核对上（unverified）
   · 目标没了、角色换了、死了变鬼
   · 状态明显过时（隔了很久），或者天黑了/要重新规划
   · 你自己拿不准
   get_state 末尾会给出「当前计划」：当前目标、原因、下一步。
   **计划是稳定的**：目标仍然成立就照它的下一步做，不要每轮自己从头重新推演；
   只有回执显示目标已完成/失败，或者出现更高优先级的危险（血低、天黑、敌人贴脸）时才换方向。
2. 坐标都是「格子」（1 格 = 4 个世界单位），get_state 里写的 (12,45) 就是 x=12、z=45，直接填进 move_to。
3. 动作回执就是"下一件事的依据"：成功就接着推进，失败就看原因换个做法。
   **确定能连着做的几步，请放在同一条回复里一起发**（重要：否则角色会在两步之间干等你思考好几秒）：
   例如"先 move_to 靠近，再 harvest_nearest / pickup_nearest / gather_area"，可以在一条回复里连续给出这几个工具调用，
   系统会**按顺序执行**，后面的要等前面成功才执行。只用 target_kind 的 nearest 动作（pickup_nearest / pickup_food /
   harvest_nearest / chop_nearest / mine_nearest）跨步安全，适合紧跟 move_to 连发；用 #N + snapshot_id 的动作
   **不要**跨步连发（移动后那一帧就失效了）。前面失败/结果不确定时，后面的会被跳过并告诉你原因。
4. 动作失败会告诉你原因（附近没有、走不到、够不着、还没成熟……），别原样重复同一个失败动作，换个目标或者先解决原因。
5. **能用的动作共 ${Object.keys(ACTION_SPECS).length} 个**，按用途分组：
${capabilityList(ACTION_SPECS)}
   工具列表里列出来的动作都能真的用，没列出来的就是没开放。参数写法以工具列表为准。
   造东西之前先用 recipes 查材料够不够，别盲试；想省调用次数时，一片草/浆果用 gather_area 一次采完，
   附近没有要的东西就用 seek 出去找（它只报位置，找到再动手）。
6. **要动手拿某个具体东西时，有三条路，优先用前两条（它们不会过期）**：
   ㋐ **只说类别**（最省事，推荐）：pickup_nearest / pickup_food / harvest_nearest / chop_nearest / mine_nearest。
      只填 target_kind（固定枚举，见工具说明），**不要**填 snapshot_id —— 游戏会在动手那一刻
      用当前世界状态重新找最近的目标。所以你想"捡一块燧石"，直接
      pickup_nearest {"target_kind":"flint"}；想吃东西就 pickup_food 再 eat。
      harvest_nearest 只会采**已经成熟**的植株（没熟的自动跳过，不会浪费一次调用）。
   ㋑ **用稳定句柄**：get_state 的「附近」里，每个能操作的目标后面会带一个「句柄h…」。
      把它填进那 16 个用 #N 的动作的 target_handle（填了就不用填 snapshot_id）。
      句柄跨快照有效，目标没了会回 target_gone，**不会**被换成别的东西。
   ㋒ **用 #N + Nearby 快照 ID**（要精确指定"就是这一个"时）：
      引用来自最近一次 get_state 的「附近」段，必须连**「附近」段开头那个「Nearby 快照 ID」**
      （形如 r1234-5678-n9）一起传。⚠ 第一行的「状态快照序列号 s123」**不是**它。
      **不要把 snapshot_id 加 1 或往上猜** —— 编号每帧重排，猜不到；连着猜两次会被熔断
      （stale_snapshot_circuit_open），那一轮就白费了。快照 ID 变了就重新 get_state，**原样照抄**。
   用 #N 的动作**都不会自己走过去**：够不着就先 move_to 靠近（回执会告诉你目标在多远、哪个格子），
   再重新 get_state 拿新的引用。背包类动作（eat / craft / equip / drop / unequip）只需要物品名。
7. **eat 只吃背包里现在真正有的东西**：回执说 not_in_inventory / no_food 时，**不要相信上一轮的背包** ——
   模组的保命反射可能刚把东西吃掉/收走。回执里会列出"背包里现在真正能吃的"，照着那个来。
   生蘑菇（green_cap/blue_cap/red_cap）不在自动进食名单里：先 cook 烤熟再吃。
   注意**地上那株植物**叫 green_mushroom/blue_mushroom，**采下来的物品**才叫 green_cap/blue_cap。
8. 别忘了记笔记：想长期记住的计划（比如「家在 (12,45)，箱子在左边」）用 update_notes 写下来，下次 get_state 会显示在最前面。
   **笔记按世界分别保存**：换存档/换世界后旧世界的基地坐标和目标进度**不会再出现**（get_state 会显示当前的世界标识）。
9. **家与长期发展（层级规划）**：get_state 末尾会给出「发展阶段 / 营地候选 / 任务看板 / 下一步」。
   按它的任务顺序推进：先勘察选址 → 前往营地 → 建第一座科学机器（解锁科技）→ 设家；
   之后所有基地建筑（科学机器/炼金引擎/箱子/锅/帐篷）都要在**家的锚点范围内**建。
   **绝不允许"材料一够就在脚下乱造科学机器"**（工具层会直接拒绝：no_camp_site / not_at_camp / no_home / out_of_home_range）。
   生存永远高于发展：血低、饿、天黑没光时先解决生存，恢复后再继续长期任务（长期目标会保留，不会丢）。
10. 攻略用 get_guide 按需读（生存、战斗、烹饪各一篇），不用一次全读完。

## 这个游戏最要命的几件事
- **生存永远高于一切科技与长期目标（即使笔记写了目标）**：造科学机器、炼金引擎、帐篷等长期任务，**只有在饱食充足（≥60%）、背包常备≥2份食物、理智健康（≥50%）且有光源时才能推进**。一旦背包食物不足或饥饿低于 60%，**必须立刻暂停任何采矿/砍树/造机器任务**，优先搜集食物！沃尔夫冈（Wolfgang）等高消耗角色饥饿下降极快，背包必须常备 3~5 份食物。
- **天黑要有光**：黄昏之前必须有火把（torch）、营火（campfire，2 木头 + 3 干草）或者火坑。火堆会烧完，要留意别让它灭。
- **会饿**：饥饿到 0 会持续掉血。背包里没吃的时**不要干等**：
  地上有胡萝卜/浆果/南瓜就用 pickup_food，附近有成熟的浆果丛/蘑菇就用 harvest_nearest，
  两样都没有再用 seek 走远找 —— 反复原地试同一个东西只是白费一轮。
- **nearest 动作只对手边约 2.5 格内有效**：若目标较远（回执报 out_of_range 并给出了坐标），**必须先 move_to 走近（离目标 1~2 格），再调用 nearest 动作**，不要隔着很远盲目调用。
- **探路与移动避开狭长半岛与海岸死角**：深陷半岛或海角极易被水域阻断（报在海里或不可达地面）或被障碍挡死，移动和采矿应尽量留在开阔陆地腹地。
- **会疯**：理智低了会出现暗影怪，晚上和在黑暗里掉得特别快。白天路过花朵可顺便采花（每朵 +5 理智），有 12 朵花瓣时 craft flowerhat 做花环戴上。
- **会冻死/热死**：冬天要有保暖衣物和火，夏天要降温（冰火、遮阳）。
- **血要主动回**：低于 50% 就别主动打架，低于 35% 先离开危险区。浆果只回饥饿、几乎不回血；
  回血要靠熟肉/药膏，别指望啃浆果把血补回来。
- **复活后很脆**：复活通常只有 25% 血。第一件事是 move_to 离开原地（尤其附近有青蛙/蜘蛛），
  别在原地接着采；活下来比多采两个草重要。
- **采集别贪多**：gather_area 默认只采 8 格内、最多 8 个；被怪打会立刻停下，先跑再回来。
- **时间在走**：你思考的时候游戏**不会**停（除非玩家在插件里开了「思考时暂停」）。所以动作要果断，别反复空想。
- **模组会自动保命**：血/饿见底、入夜没光、火要灭、被敌人贴脸、理智太低时，模组会自己动手（吃/举火把/做火把/添柴/后撤/采花），白天还会提前采 2 草 + 2 树枝。**残血被贴脸或天黑没光时，它会打断你正在跑的任务先保命**；做过的事会写进 get_state 的提示里，看到状态变了别惊讶。

## 生存硬常识（照着做，别踩坑）
- **先光后食、提前准备**：黄昏前就要有可携带光源（火把）；食物别等饿到见底才找。紧急时优先"最小够用"（先做/拿一把火把、先吃一口），**不要**为了凑满火堆/大锅的材料而在黑暗或饥饿里硬等。
- **站在火/火坑旁边不会回血**：光和热只止损（防黑暗掉血、防冻/过热）。低血要靠熟肉/药膏等**真实回血**，并确认血量真的涨了；回饥饿≠回血。
- **只有便携光源才照路**：附近有火 ≠ 整条路亮；火堆"存在" ≠ "正在燃烧"（看火焰挡位/燃料）。夜间离开营地必须手持火把。
- **火把看剩余燃料，不只看把数**；火会烧完，要补柴——但一次一份，添完等状态更新再判断，别狂加浪费。
- **配方"能做" ≠ "该做"，也 ≠ "工具已在身上"**：造之前先用 recipes 查材料；工具要真拿在手里、看耐久；**别拿"砸巨石得燧石"当第一个燧石来源**（没镐砸不动，先捡地上散落的燧石）。
- **石头分两种**：普通大石头（rock1）**不含金**；带金的是另一种（rock2）。别看是石头就当金矿。
- **地上食物 ≠ 背包里的食物**；锅里做好的菜 ≠ 已在你包里（要取出来才算吃到）。
- **"补食物"看的是当前饥饿值**，不是"捡到 1 个食物"就算够了；饱食够时别浪费食物。
- **黄昏不必停工**：只要路线安全、有便携光，黄昏还能干活；别一到黄昏就原地等天亮。
- **死了/变鬼先离原地**（复活通常只有 25% 血），别在原地接着采，活下来比多采两个草重要。

## 通过 MCP 玩的额外说明
- 玩家（人类）可能随时自己接手玩；如果动作被拒绝或者角色被移动了，先 get_state 看看发生什么。
- 想停下手里的动作用 stop。`

/** 动作工具：名字 -> 定义。schema 用 JSON Schema 子集（模型看得懂就行）。 */

// ── 宏（任务级接口）：M2.2.1 起**不再暴露给模型** ──
// 它们仍然实现在模组里（macros.lua 的 A.register），只是不对模型开放：
// dispatcher 白名单只放行 move_to / stop / pickup / harvest，宏一律会被拒绝，
// 暴露它们只会让模型看到一堆"点了必然失败"的工具（见 docs/REFACTOR_AUDIT.md R2）。
// 将来要重新开放某个宏时，把它加回 ACTION_TOOLS/MACRO_TOOLS 并在 dispatcher 里放行即可。
// TARGET-REFRESH：所有"要 #N + snapshot_id"的动作，也接受**稳定句柄** target_handle。
// 在装配阶段统一补进去，而不是在 16 个工具定义里各抄一遍 —— 少抄一处就会出现
// "dispatcher 能用、模型却看不见"的漂移（这类漂移以前踩过）。
// required 保持不变（没有句柄时 #N + snapshot_id 仍是必填）；dispatcher 的 validateArgs
// 会在**给了句柄**时把这两项放宽（两种引用二选一）。
for (const tool of ACTION_TOOLS) {
  const spec = ACTION_SPECS[tool.name]
  if (spec?.requiresSnapshot !== true) continue
  const schema = tool.inputSchema ?? (tool.inputSchema = { type: 'object', properties: {} })
  const props = schema.properties ?? (schema.properties = {})
  if (!props.target_handle) {
    props.target_handle = {
      type: 'string',
      description:
        '可选：用「附近」里那个目标的稳定句柄（形如 h1a）代替 #N + snapshot_id。'
        + '句柄**跨快照有效**（#N 只在一帧内有效），所以它不会 stale_snapshot；'
        + '目标没了/被捡走会回 target_gone，**绝不会**被换成另一个东西。填了它就不用填 snapshot_id。',
    }
  }
  if (typeof tool.description === 'string' && !tool.description.includes('target_handle')) {
    tool.description +=
      '\n也可以只用 target_handle（「附近」里那个「句柄h…」）代替 #N + snapshot_id：'
      + '句柄跨快照有效，不会过期。'
  }
}


export const TOOLS = [...LOCAL_TOOLS, ...ACTION_TOOLS]

export const EXECUTION_MODES = ['autopilot', 'assisted', 'manual']

/**
 * 规范化运行模式（非法或未指定时安全回退为 autopilot）。
 * @param {string} [mode]
 * @returns {'autopilot' | 'assisted' | 'manual'}
 */
export function normalizeExecutionMode(mode) {
  if (!mode || typeof mode !== 'string') return 'autopilot'
  const norm = mode.trim().toLowerCase()
  if (norm === 'assisted' || norm === 'all') return 'assisted'
  if (norm === 'manual') return 'manual'
  if (norm === 'autopilot') return 'autopilot'
  // 未知 executionMode 明确回退到安全默认 autopilot，不得意外放开所有工具
  return 'autopilot'
}

/**
 * 给 MCP 的 tools/list 用的格式（支持按 executionMode 过滤）。
 * @param {string} [mode] - 'autopilot' | 'assisted' | 'manual'
 */
export function toolList(_mode = 'autopilot') {
  // 统一模式语义（R8.x）：Manual / Assisted / Autopilot 暴露**完全相同**的完整工具集。
  // 模式只决定“谁在驱动、是否连续自主”，不再裁剪工具；安全由 dispatcher → Control Lease → Lua Guard → 核验保证。
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }))
}

const ACTION_NAMES = new Set(ACTION_TOOLS.map((t) => t.name))
/** 宏的名字（任务级接口）：和原子动作一样，模组里必须有对应实现。 */
const MACRO_NAMES = new Set()

/** 「干活」类动作：默认要一直干到目标消失才算一个（见下面的 until_gone 说明）。 */
// M2.2.1：采集类动作（chop/mine/hammer/dig）已不对模型暴露，所以这个集合现在是空的。
// 保留它和下面的 until_gone 分支是为了**不改动执行器逻辑**；将来重新开放采集动作时直接填回来即可。
const WORK_TOOLS = new Set()

/**
 * 执行一个工具。返回字符串（给模型看）。
 * ctx: { bridge, notes: {read, write}, guides: {main,...}, extraInstructions, log, executionMode }
 */
export async function executeTool(name, args, ctx) {
  // 统一模式语义（R8.x）：三种模式工具集与决策逻辑完全相同，不再按 executionMode 拦截任何工具。
  // 模式只影响“谁在驱动/是否连续自主”；每个动作仍走 dispatcher → Control Lease → Lua Guard → 真机核验。
  const input = { ...(args ?? {}) }
  // 模组里 count 的原意是「挥几下」，只有 until_gone=true 时才是「干倒几个目标」。
  // 模型不该知道这个历史包袱：除草/砍树/挖矿/拆东西默认给它 until_gone=true。
  // （真机踩到：chop {"count":1} 回「连着干了 1 次」，树没倒、木头没掉。）
  if (WORK_TOOLS.has(name) && input.until_gone === undefined) input.until_gone = true
  if (name === 'get_state') return getState(input, ctx)
  if (name === 'get_guide') return getGuide(input, ctx)
  if (name === 'update_notes') return updateNotes(input, ctx)
  if (name === 'run_skill') return runSkillTool(input, ctx)
  if (name === 'advance_task') return advanceTaskTool(input, ctx)
  if (name === 'stop') return stopTool(input, ctx)
  if (!ACTION_NAMES.has(name) && !MACRO_NAMES.has(name)) throw new Error(`没有这个工具：${name}`)

  // ★ 家园建造门槛（Planning Layer）：装配了 planner 时，科技/储物类基地建筑必须先有家、
  //   且建在家的锚点范围内；首个科学机器必须先选定营地并到场。直接堵死"材料齐了就地建机器"。
  //   只在快照可用（游戏在跑）时判定；没装配 planner（测试/老环境）时完全不拦，保持行为不变。
  if (name === 'build' && ctx.planner && typeof ctx.planner.guardBuild === 'function') {
    const snap = readSnapshot(ctx)
    if (snap && !snap.stale) {
      const gate = ctx.planner.guardBuild(input.recipe, snap)
      if (gate) return `失败：${gate.message}（${gate.reason}）`
    }
  }

  // M2.0：所有动作只能经过 Dispatcher（校验 → 租约 → 下发 → 核对）
  const dispatcher = dispatcherFor(ctx)
  const outcome = await dispatcher.dispatch({ tool: name, args: input, owner: ctx.owner ?? 'system', ownerInstanceId: ctx.ownerInstanceId })
  // OBSERVATION-01：把结构化结果（含 verified）留在 ctx 上，供 Agent 维护"已知背包"。
  // 只读地暴露，不影响返回给模型的文本。
  try { ctx.lastOutcome = outcome } catch {}
  return dispatcher.describe(outcome)
}

/**
 * TARGET-REFRESH：当前世界的标识（长期笔记按它分开存）。
 * 取不到就返回 null —— 调用方退回"未绑定世界"的单文件笔记，并在文本里**明确说明**，
 * 这样绝不会把某个具体世界的基地坐标当成当前世界的。
 */
function worldKeyOf(snapshot) {
  const k = snapshot?.identity?.worldKey
  return typeof k === 'string' && k !== '' && k !== 'unknown' ? k : null
}

/** 读当前世界的笔记 + 世界切换提示所需的信息 */
function notesInfo(ctx, snapshot) {
  const worldKey = worldKeyOf(snapshot)
  const content = ctx.notes?.read?.(worldKey) ?? ''
  const prevWorldKey = ctx.lastWorldKey === undefined ? null : ctx.lastWorldKey
  const switched = prevWorldKey !== null && worldKey !== null && prevWorldKey !== worldKey
  try { ctx.lastWorldKey = worldKey } catch {}
  return {
    content: String(content ?? ''),
    worldKey,
    worldKeySource: snapshot?.identity?.worldKeySource ?? 'none',
    switchedFrom: switched ? prevWorldKey : null,
  }
}

function notesPrefix(ctx, info = null) {
  const notes = info ?? notesInfo(ctx, readSnapshot(ctx))
  const extra = (ctx.extraInstructions ?? '').trim()
  const parts = []
  if (notes.switchedFrom !== null && notes.switchedFrom !== undefined) {
    // 任务书 §5：世界一换，旧世界的坐标/基地/未完成目标就不能再当"当前"用。
    parts.push(
      `⚠ 世界换了（上一个：${notes.switchedFrom} → 现在：${notes.worldKey}）：`
      + '旧世界的基地坐标和未完成目标**已归档、不再显示**，不要照着旧笔记走。\n',
    )
  }
  if (notes.content.trim()) {
    parts.push(`你的笔记（上次记下的，还作数）：\n${notes.content.trim()}\n`)
  }
  if (notes.worldKey === null) {
    parts.push('（世界标识暂时读不到，笔记用的是"未绑定世界"的那一份 —— 里面的坐标不保证属于当前世界，别直接照着走。）\n')
  } else {
    parts.push(`（笔记按世界分开存：本世界 = ${notes.worldKey}，来源 ${notes.worldKeySource}。）\n`)
  }
  if (extra) parts.push(`玩家的额外要求：${extra}\n`)
  return parts.join('\n') + '\n'
}

/**
 * 读一份归一化快照。
 * F8（内置 AI）、MCP 客户端、HUD、测试**都走这一个函数** —— 只有这一处解析状态文件，
 * 所以两边看到的必然是同一份快照、同一套字段。
 */
export function readSnapshot(ctx) {
  const state = ctx.bridge.readState()
  if (!state) return null
  const ageMs = Number.isFinite(state.ageMs)
    ? state.ageMs
    : Math.max(0, Date.now() - Number(state.mtimeMs ?? state.mtime ?? 0))
  return normalizeState(state.json, { ageMs, path: state.path })
}

/** [PLANNER] 决策日志（有 ctx.log 时才输出；纯可观测性，不改变任何行为）。 */
function logDecision(ctx, decision, devPlan) {
  const log = ctx.log
  if (typeof log !== 'function' || !decision) return
  const base = {
    world_key: decision.world_key,
    task_id: decision.current_task?.id ?? null,
    skill_id: decision.current_skill?.id ?? null,
    stage: decision.current_stage?.index ?? null,
    priority: decision.priority,
  }
  const emit = (tag, extra) => { try { log('info', `[PLANNER] ${tag} ` + JSON.stringify({ ...base, ...extra })) } catch {} }
  emit('DECISION', { reason: decision.decision_reason, next: decision.next_action })
  if (decision.goal_title) emit('GOAL_SELECTED', { goal: decision.goal_title })
  if (decision.current_task) emit('TASK_SELECTED', { progress: decision.task_progress })
  for (const b of decision.blocked_tasks ?? []) emit('TASK_BLOCKED', { task_id: b.id, reason: b.reason })
}

function getState(input, ctx) {
  const snapshot = readSnapshot(ctx)
  if (!snapshot) {
    return '连不上游戏：找不到大肥鱼饿不死写的状态文件。\n'
      + '确认：1) 饥荒联机版已经通过 Steam 打开并读档进世界；2) mods 里装了大肥鱼饿不死；'
      + '3) 世界是本地主机（自己开的）。装好模组后要重新读档一次。'
  }

  // 计划层：用同一份快照推导"现在最该做的一件事"。
  // 上一次的计划放在 ctx 上（F8 / MCP 共用），目标仍然成立就保持不动，避免每轮重新规划。
  // TARGET-REFRESH：快照里带了 world_key，plan.js 会在换世界时丢掉上一份计划
  //（旧世界的基地坐标/未完成目标不能混进新世界）。
  const plan = derivePlan(snapshot, ctx.lastPlan)
  try {
    ctx.setPlan?.(plan)
    ctx.lastPlan = plan
  } catch {}

  // 笔记：按世界读（换世界会给出明确提示）
  const notes = notesInfo(ctx, snapshot)

  // 层级规划（家园/阶段/任务看板）：只有装配了 planner 才生效（F8/MCP 生产环境装配；
  // 单元测试的假 ctx 没有 planner，行为与以前完全一致，不破坏既有测试）。
  let devPlan = null
  if (ctx.planner && typeof ctx.planner.plan === 'function') {
    try {
      devPlan = ctx.planner.plan(snapshot)
      try { ctx.lastDevelopment = devPlan } catch {}
    } catch (error) {
      devPlan = null
      try { ctx.plannerError = String(error?.message ?? error) } catch {}
    }
  }

  // ★ Phase G1：唯一决策出口。装配 planner 时，用 Decision Arbiter 把「生存规则引擎(plan)」
  //   和「发展阶段/任务看板(devPlan)」合并成**一个** decision —— 文本和 JSON 都只从它派生，
  //   不再同时渲染两套互相独立的下一步。没装 planner（测试/老环境）时退回旧的 renderPlan。
  const decision = devPlan ? arbitrate(snapshot, { devPlan, survivalPlan: plan }) : null
  logDecision(ctx, decision, devPlan)

  const format = String(input?.format ?? 'text').toLowerCase()
  if (format === 'json') {
    // OBSERVATION-01：JSON 模式必须是**纯 JSON**（笔记放进 notes 字段），
    // 否则 JSON.parse 会失败 —— 之前这里是 notesPrefix(ctx) + JSON.stringify(...)。
    const payload = toJsonPayload(snapshot, {
      notes: notes.content,
      extraInstructions: ctx.extraInstructions ?? '',
    })
    // TARGET-REFRESH：JSON 模式也要能看出"笔记属于哪个世界"和"世界换过"
    if (payload.notes !== undefined && payload.notes !== null && typeof payload.notes === 'object') {
      payload.notes.world_key = notes.worldKey
      payload.notes.world_key_source = notes.worldKeySource
      payload.notes.switched_from = notes.switchedFrom
    }
    if (decision) {
      // 唯一入口：decision。兼容旧调用方的 plan / development 两个字段**都从这里派生**，
      // 不再是两套独立规划（任务书 §二：兼容字段必须来自同一个决策对象）。
      payload.decision = decision
      payload.plan = planFromDecision(decision, plan)
      payload.development = developmentFromDecision(decision, devPlan)
    } else {
      // 纯 JSON 模式也不能把计划拼到字符串前面；放进字段里，调用方照样能 JSON.parse
      payload.plan = planPayload(plan)
    }
    return JSON.stringify(payload, null, 1)
  }

  // 文本优先用 Lua 从同一份 data 渲染好的那份；没有才在 Node 侧兜底（老格式/被截断）
  const body = snapshot.text || renderFallbackText(snapshot)
  const tail = decision ? renderDecision(decision, devPlan) : renderPlan(plan)
  return notesPrefix(ctx, notes) + freshnessLine(snapshot) + body + '\n' + tail
}

/** 兼容字段 plan：从唯一 decision 派生（不再调用 derivePlan 二次规划）。 */
function planFromDecision(decision, survivalPlan) {
  return {
    schema: PLAN_SCHEMA,
    world: decision.world_key,
    goal_id: decision.current_task?.id ?? decision.current_skill?.id ?? survivalPlan?.goalId ?? null,
    title: decision.goal_title ?? decision.primary_goal ?? null,
    why: decision.decision_reason,
    next: decision.next_action,
    priority: decision.priority,
    since: survivalPlan?.since ?? null,
    changed: survivalPlan?.changed ?? false,
    candidates: survivalPlan?.candidates ?? [],
  }
}

/** 兼容字段 development：同样从唯一 decision 派生。 */
function developmentFromDecision(decision, devPlan) {
  return {
    stage: decision.current_stage?.index ?? null,
    stage_title: decision.current_stage?.title ?? null,
    stage_goal: decision.primary_goal ?? null,
    priority: decision.priority,
    decision_reason: decision.decision_reason,
    current_task: decision.current_task ?? null,
    current_skill: decision.current_skill ?? null,
    task_progress: decision.task_progress ?? null,
    completion: decision.completion ?? null,
    blocked_tasks: decision.blocked_tasks ?? [],
    next: decision.next_action || null,
    camp_site: devPlan.primarySite ?? null,
    backup_site: devPlan.backupSite ?? null,
    home_building_id: devPlan.memory?.home_building_id ?? null,
    home_anchor: devPlan.memory?.home_anchor ?? null,
    tasks: (devPlan.board?.tasks ?? []).map((t) => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority,
      progress: t.progress ?? null, blocked_reason: t.blocked_reason ?? null,
    })),
  }
}

function getGuide(input, ctx) {
  const topic = String(input.topic ?? '').trim()
  const guides = ctx.guides ?? BUNDLED_GUIDES
  if (!topic) {
    return ['# 攻略目录（用 get_guide 挑一篇读）', ...GUIDE_TOPICS.map((t) => `- ${t.key}（${t.label}）：${t.hint}`)].join('\n')
  }
  const key = topic.toLowerCase()
  const found = GUIDE_TOPICS.find((t) => t.key === key || t.label === topic)
  if (!found) return `没有「${topic}」这篇攻略。能读的：${GUIDE_TOPICS.map((t) => t.key).join('、')}`
  const text = guides[found.key] ?? ''
  if (!text) return `${found.label} 这篇攻略是空的（玩家可能清空了它）`
  return `# ${found.label}\n\n${text}`
}

function updateNotes(input, ctx) {
  const text = String(input.notes ?? '').trim()
  if (!ctx.notes?.write) return '这个环境不能记笔记'
  // TARGET-REFRESH：写到**当前世界**的笔记文件里（换世界不会互相覆盖、也不会串坐标）
  const worldKey = worldKeyOf(readSnapshot(ctx))
  ctx.notes.write(text, worldKey)
  try { ctx.lastWorldKey = worldKey } catch {}
  const where = worldKey === null ? '（世界标识读不到，写进了"未绑定世界"的那一份）' : `（本世界 ${worldKey}）`
  return text ? `记下了${where}：\n${text}` : `笔记清空了${where}`
}

/**
 * run_skill：执行一个复合技能（多步骤），单次推进一个有边界的步骤。
 * 复用唯一 dispatcher，不新建执行通道；技能实例持久化到本世界记忆。
 */
async function runSkillTool(input, ctx) {
  const skillId = String(input?.skill_id ?? '').trim()
  if (!skillId) return `失败：缺少 skill_id（可用：${skillIds().join('、')}）`
  if (!hasSkill(skillId)) return `失败：没有这个技能 ${skillId}（可用：${skillIds().join('、')}）`
  if (!ctx.planner || typeof ctx.planner.memoryFor !== 'function') {
    return '失败：当前环境没有装配规划记忆（planner），不能执行技能'
  }
  const snap = readSnapshot(ctx)
  if (!snap) return '连不上游戏：找不到状态文件，先确认游戏已读档进世界。'
  const worldKey = snap.identity?.worldKey ?? null
  const store = ctx.planner.store
  const mem = store ? store.load(worldKey) : ctx.planner.memoryFor(snap)
  const dispatcher = dispatcherFor(ctx)
  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey,
    store,
    dispatcher,
    readSnapshot: () => readSnapshot(ctx),
    guardBuild: (recipe, s) => {
      if (ctx.planner && typeof ctx.planner.guardBuild === 'function') {
        return ctx.planner.guardBuild(recipe, s)
      }
      return null
    },
    readAuthority: () => (ctx.control && typeof ctx.control.readAuthority === 'function' ? ctx.control.readAuthority() : null),
    log: (level, msg) => { try { ctx.log?.(level, msg) } catch {} },
  })
  ctx.orchestrator = runtime.orchestrator
  ctx.worldRuntime = runtime

  const inputTaskId = input?.task_id ? String(input.task_id).trim() : null
  const taskId = inputTaskId || `manual:${skillId}`
  const skillArgs = (input?.skill_args && typeof input.skill_args === 'object' && !Array.isArray(input.skill_args))
    ? input.skill_args
    : ((input?.args && typeof input.args === 'object' && !Array.isArray(input.args)) ? input.args : null)
  const maxSteps = Math.max(1, Math.min(8, Math.trunc(Number(input?.max_steps ?? 1)) || 1))
  const owner = ctx.owner ?? 'system'
  const ownerInstanceId = ctx.ownerInstanceId ?? null
  const trace = []
  let result = null
  try {
    for (let k = 0; k < maxSteps; k++) {
      result = await runtime.executeTask(skillId, taskId, skillArgs, { owner, ownerInstanceId })
      trace.push(result)
      if (['completed', 'failed', 'blocked', 'rejected'].includes(result.status)) break
    }
  } catch (e) {
    return `技能执行异常：${String(e?.message ?? e)}`
  }
  try { ctx.lastOutcome = result } catch {}
  return formatSkillResult(skillId, result, runtime.memory, trace, taskId)
}

function formatSkillResult(skillId, result, mem, trace = null, taskId = null) {
  const lines = [`技能 ${skillId} → ${result?.status ?? '未知'}`]
  if (Array.isArray(trace) && trace.length > 1) {
    lines.push(`本次连续推进 ${trace.length} 步：`)
    for (const t of trace) {
      const bits = [t.status]
      if (t.step) bits.push(t.step)
      if (t.reason) bits.push(t.reason)
      lines.push(`  · ${bits.join(' / ')}${t.detail ? ' — ' + String(t.detail).split('\n')[0] : ''}`)
    }
  }
  if (result?.step) lines.push(`当前步骤：${result.step}`)
  if (result?.reason) lines.push(`原因：${result.reason}`)
  if (result?.detail) lines.push(String(result.detail))
  const inst = result?.instance_id ? mem?.skill_instances?.[result.instance_id] : (taskId ? Object.values(mem?.skill_instances ?? {}).find((x) => x.task_id === taskId) : mem?.skill_instances?.[skillId])
  if (inst) lines.push(`进度：第 ${inst.step_index} 步，累计调用 ${inst.calls ?? 0} 次（实例 ${inst.instance_id}，状态 ${inst.status}）`)
  if (result?.status === 'completed') lines.push('技能已完成（已用快照证据核对，非"自称成功"）。')
  else if (result?.status === 'blocked') lines.push('技能被阻塞/暂停：处理完原因后再调用 run_skill 继续（进度已保存）。')
  else if (result?.status === 'failed') lines.push('技能失败：已达到重试/预算上限，检查原因后再决定是否重来。')
  return lines.join('\n')
}

/** 攻略的当前内容（DSH 插件里改过的优先）。 */
export function guideText(key, overrides, bundled = BUNDLED_GUIDES) {
  const custom = (overrides?.[key] ?? '').trim()
  if (custom && custom !== (bundled[key] ?? '').trim()) return custom
  return bundled[key] ?? ''
}


/**
 * advance_task：自主任务执行（Autopilot）。
 */
async function advanceTaskTool(input, ctx) {
  if (!ctx.planner || typeof ctx.planner.memoryFor !== 'function') {
    return '失败：当前环境没有装配规划记忆（planner），不能执行自主任务'
  }
  const snap = readSnapshot(ctx)
  if (!snap) return '连不上游戏：找不到状态文件，先确认游戏已读档进世界。'
  const worldKey = snap.identity?.worldKey ?? null
  const store = ctx.planner.store
  const dispatcher = dispatcherFor(ctx)

  const runtime = WorldRuntimeManager.getOrCreate({
    worldKey,
    store,
    dispatcher,
    readSnapshot: () => readSnapshot(ctx),
    guardBuild: (recipe, s) => {
      if (ctx.planner && typeof ctx.planner.guardBuild === 'function') {
        return ctx.planner.guardBuild(recipe, s)
      }
      return null
    },
    readAuthority: () => (ctx.control && typeof ctx.control.readAuthority === 'function' ? ctx.control.readAuthority() : null),
    log: (level, msg) => { try { ctx.log?.(level, msg) } catch {} },
  })
  ctx.orchestrator = runtime.orchestrator
  ctx.worldRuntime = runtime

  const maxSteps = Math.max(1, Math.min(10, Math.trunc(Number(input?.max_steps ?? 8)) || 8))
  const owner = ctx.owner ?? 'system'
  const ownerInstanceId = ctx.ownerInstanceId ?? null
  let report = null
  try {
    report = await runtime.advanceTask({ maxSteps, owner, ownerInstanceId })
  } catch (err) {
    return `Autopilot 执行异常：${String(err?.message ?? err)}`
  }

  try { ctx.lastOutcome = report } catch {}
  return formatAdvanceTaskReport(report)
}

/**
 * stopTool：最高优先级停止工具（ISSUE-07）。
 */
async function stopTool(input, ctx) {
  // R8.0：若上游接入了 StopCoordinator（生产 index.js 注入 ctx.stopCoordinator），
  // 所有 stop 工具都走统一协调入口（停 Agent/Runtime/技能 → 下发 stop → 确认后才释放租约）。
  if (ctx.stopCoordinator && typeof ctx.stopCoordinator.requestStop === 'function') {
    const r = await ctx.stopCoordinator.requestStop({ source: 'stop_tool', requester: ctx.owner ?? 'system', reason: 'stop_tool' })
    try { ctx.lastOutcome = r } catch {}
    return r.ok
      ? `已停止（${r.status}）：${r.detail}`
      : `停止未确认（${r.status}）：${r.detail}${r.quarantined ? '【隔离中，禁止新任务】' : ''}`
  }
  let stopReport = null
  const snap = readSnapshot(ctx)
  const worldKey = snap?.identity?.worldKey ?? null
  const dispatcher = dispatcherFor(ctx)
  let runtime = ctx.worldRuntime ?? null

  if (!runtime && ctx.planner) {
    const store = ctx.planner.store
    runtime = WorldRuntimeManager.getOrCreate({
      worldKey,
      store,
      dispatcher,
      readSnapshot: () => readSnapshot(ctx),
      guardBuild: (recipe, s) => (ctx.planner?.guardBuild ? ctx.planner.guardBuild(recipe, s) : null),
      readAuthority: () => (ctx.control && typeof ctx.control.readAuthority === 'function' ? ctx.control.readAuthority() : null),
      log: (level, msg) => { try { ctx.log?.(level, msg) } catch {} },
    })
    ctx.worldRuntime = runtime
    ctx.orchestrator = runtime.orchestrator
  }

  if (runtime && typeof runtime.stop === 'function') {
    stopReport = await runtime.stop({
      timeoutMs: 5000,
      owner: ctx.owner ?? 'system',
      ownerInstanceId: ctx.ownerInstanceId,
    })
  } else {
    // 降级：直接通过 dispatcher 下发底层 stop
    let outcome = null
    try {
      outcome = await dispatcher.dispatch({ tool: 'stop', args: {}, owner: ctx.owner ?? 'system', ownerInstanceId: ctx.ownerInstanceId })
    } catch (err) {
      outcome = { status: 'failed', reason: 'dispatch_error', message: String(err?.message ?? err) }
    }
    const succeeded = outcome?.status === 'succeeded'
    stopReport = {
      stop_requested: true,
      stop_status: succeeded ? 'succeeded' : 'in_flight',
      active_command_id: outcome?.commandId ?? null,
      active_task_id: null,
      active_instance_id: null,
      next_action_allowed: false,
      detail: outcome?.message || (succeeded ? '已停止' : '停止请求已下发'),
    }
  }

  try { ctx.lastOutcome = stopReport } catch {}
  return formatStopReport(stopReport)
}

function formatAdvanceTaskReport(report) {
  const lines = [
    `Autopilot 任务执行报告：`,
    `  · 任务状态：${report.task_status}`,
    `  · 动作预算：已用 ${report.budget_used ?? report.steps_executed} / 剩余 ${report.budget_remaining ?? report.remaining_budget}`,
    `  · 停止原因：${report.stop_reason}`,
  ]
  if (report.task_id) lines.push(`  · 当前任务：${report.task_id}`)
  if (report.skill_id) lines.push(`  · 对应技能：${report.skill_id}`)
  if (report.instance_id) lines.push(`  · 实例标识：${report.instance_id}`)
  if (report.current_step || report.next_step) lines.push(`  · 当前步骤：${report.current_step ?? report.next_step}`)
  if (report.survival_alert) lines.push(`  · 生存警报：${JSON.stringify(report.survival_alert)}`)
  if (report.actions_executed && report.actions_executed.length > 0) {
    lines.push(`  · 执行动作列表（共 ${report.actions_executed.length} 个）：`)
    for (const a of report.actions_executed) {
      const cmd = a.command_id ? ` [${a.command_id.slice(0, 8)}]` : ''
      lines.push(`     - ${a.tool}${cmd} → ${a.status} (${a.verified ? '已核验' : '未核验'})`)
    }
  }
  return lines.join('\n')
}

function formatStopReport(report) {
  return [
    `[STOP] 停止指令已执行：`,
    `  · 停止状态：${report.stop_status}`,
    `  · 下发命令：${report.active_command_id ?? '无'}`,
    `  · 中止任务：${report.active_task_id ?? '无'}`,
    `  · 中止实例：${report.active_instance_id ?? '无'}`,
    `  · 后续动作允许：${report.next_action_allowed ? '是' : '否'}`,
    report.detail ? `  · 说明：${report.detail}` : '',
  ].filter(Boolean).join('\n')
}

export { ACTION_NAMES, MACRO_NAMES }
