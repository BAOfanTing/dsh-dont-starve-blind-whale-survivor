// MCP 工具：名字、说明、参数，以及真正执行（转给游戏里的模组）
//
// 模型看到的每一条说明都是给它看的操作手册：说清楚单位（格子）、前置条件、失败了怎么办。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, freshnessLine, renderFallbackText, toJsonPayload } from './state/snapshot.js'
import { createDispatcher } from './dispatcher.js'
import { ACTION_SPECS } from './actions/specs/index.js'
import { CRAFTABLE_RECIPES, BUILDABLE_RECIPES } from './actions/specs/crafting.js'
import { kindsFor } from './actions/target-kinds.js'
import { derivePlan, planPayload, renderPlan, PLAN_SCHEMA } from './plan.js'
import { arbitrate, renderDecision } from './planner/decision-arbiter.js'
import { TaskSkillOrchestrator } from './planner/task-skill-orchestrator.js'
import { SkillExecutor, skillIds, hasSkill } from './skills/index.js'
import { LeaseManager, defaultLeaseFile } from './control.js'
import { WorldRuntimeManager } from './planner/world-runtime-manager.js'


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
   一次可以只发一个动作；如果要发多个，后面的动作会等前面成功才执行 —— 前面失败/结果不确定，后面的会被跳过并告诉你原因。
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

## 通过 MCP 玩的额外说明
- 玩家（人类）可能随时自己接手玩；如果动作被拒绝或者角色被移动了，先 get_state 看看发生什么。
- 想停下手里的动作用 stop。`

/** 动作工具：名字 -> 定义。schema 用 JSON Schema 子集（模型看得懂就行）。 */
const ACTION_TOOLS = [
  {
    name: 'move_to',
    description: '走到某个格子坐标。路上会自动绕开障碍；走不到会告诉你还差几格、被什么挡着。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: '目标格子 x' },
        z: { type: 'integer', description: '目标格子 z' },
        timeout: { type: 'number', description: '最多走多少秒（游戏时间），默认 60' },
      },
      required: ['x', 'z'],
    },
  },
  {
    name: 'stop',
    description: '立刻停下手里正在做的事（走路、砍树、打架都停）。',
    inputSchema: { type: 'object', properties: {} },
  },
  // ═══════════════ TARGET-REFRESH：不会过期的实时目标选择 ═══════════════
  // 为什么要有这五个：真机 94 次调用里 23 次 pickup + 3 次 chop + 2 次 harvest 全是 stale_snapshot
  // —— #N 只在当前扫描帧内有效，而模型一轮思考 30~60 秒。这五个动作只让模型说"要哪一类"，
  // 由游戏在动手那一刻用当前世界状态重新找最近的目标，所以**不需要 snapshot_id / #N**。
  {
    name: 'pickup_nearest',
    description:
      '捡起**最近的一类**地面材料 —— **不需要 #N / snapshot_id，所以永远不会 stale_snapshot**。\n'
      + 'target_kind 只能填这些固定类别（不能填 prefab 名、坐标或 GUID）：\n'
      + '  flint（燧石）、twigs（树枝）、cutgrass（割下的草）、log（木头）、rocks（石头）、\n'
      + '  goldnugget（金块）、charcoal（木炭）、petals（花瓣）。\n'
      + '服务端会当场重新找最近的、而且**现在真的能捡**的那一个（不成熟/被拿走的会自动跳过）。\n'
      + '只捡手边 2.5 格内的：附近有但够不着会回 out_of_range，并告诉你它在多远、哪个格子 —— 先 move_to 过去再试。\n'
      + '一类都没有会回 no_target（附近确实没有这种东西）。\n'
      + '成功与否以真实状态为准：会核对背包里该物品数量有没有变多，核对不上回 unverified，别自己宣布成功。',
    inputSchema: {
      type: 'object',
      properties: {
        target_kind: {
          type: 'string',
          enum: kindsFor('pickup_nearest'),
          description: '要捡哪一类（固定枚举）：flint / twigs / cutgrass / log / rocks / goldnugget / charcoal / petals',
        },
        radius: { type: 'number', description: '搜索半径（格），默认 16，最大 40' },
      },
      required: ['target_kind'],
    },
  },
  {
    name: 'pickup_food',
    description:
      '实时搜索并捡起**地上能吃的东西** —— 不需要 #N / snapshot_id，所以不会过期。\n'
      + '默认只找**自动进食安全**的食物（胡萝卜 carrot、浆果 berries、多汁浆果 berries_juicy、南瓜 pumpkin、\n'
      + '玉米 corn、茄子 eggplant、蜂蜜 honey、肉/小肉/蛙腿/鱼及它们的熟食）。\n'
      + '**生蘑菇不在里面**（生红蘑菇扣血、生绿/蓝蘑菇扣大量理智）—— 想吃蘑菇要先 cook 烤熟，再手动 eat。\n'
      + '这就是"背包里没吃的、但地上有南瓜/多汁浆果"时该用的动作：先 pickup_food，再 eat。\n'
      + '只捡手边 2.5 格内的；附近有但够不着会回 out_of_range 并给出它在哪个格子（先 move_to）。\n'
      + '一类都没有会回 no_target —— 这时不要原地反复试，改用 harvest_nearest 或走远去 seek。',
    inputSchema: {
      type: 'object',
      properties: {
        target_kind: {
          type: 'string',
          enum: kindsFor('pickup_food'),
          description: '要捡哪一类食物；不填 = safe_ground_food（全部安全食物）',
        },
        radius: { type: 'number', description: '搜索半径（格），默认 16，最大 40' },
      },
      required: [],
    },
  },
  {
    name: 'harvest_nearest',
    description:
      '采下**最近一株已经成熟**的食物植物 —— 不需要 #N / snapshot_id，所以不会过期。\n'
      + '能采的植株：普通浆果丛 berrybush/berrybush2、多汁浆果丛 berrybush_juicy、\n'
      + '地里的胡萝卜 carrot_planted、成熟蘑菇（红/绿/蓝）。\n'
      + 'target_kind 可选：ripe_food_plant（以上全部，默认推荐）/ berrybush / juicy_berrybush / carrot_plant / mushroom。\n'
      + '**未成熟的植株会被直接跳过**（不是报错）—— 所以你不用再判断"熟了没有"，也不会把没熟的当成可采目标。\n'
      + '一株成熟的都没有会回 no_target；有但够不着会回 out_of_range 并给出格子（先 move_to）。\n'
      + '本动作只负责采，**不会**顺手捡地上的东西 —— 地上的用 pickup_food / pickup_nearest。',
    inputSchema: {
      type: 'object',
      properties: {
        target_kind: {
          type: 'string',
          enum: kindsFor('harvest_nearest'),
          description: '要采哪一类：ripe_food_plant（任意成熟食物植物）/ berrybush / juicy_berrybush / carrot_plant / mushroom',
        },
        radius: { type: 'number', description: '搜索半径（格），默认 16，最大 40' },
      },
      required: ['target_kind'],
    },
  },
  {
    name: 'chop_nearest',
    description:
      '砍倒**最近的一棵树** —— 不需要 #N / snapshot_id，所以不会过期。\n'
      + 'target_kind 只能填 tree。服务端会当场找最近的一棵，并自动把斧头拿到手上（没斧头会回 no_tool）。\n'
      + '会一直砍到倒下（不是砍一下就停），木头进背包后回执会写清楚。\n'
      + '附近的树都超过 6 格会回 out_of_range 并给出最近的树在哪个格子 —— 先 move_to 过去再试。\n'
      + '附近没有树会回 no_target。',
    inputSchema: {
      type: 'object',
      properties: {
        target_kind: { type: 'string', enum: kindsFor('chop_nearest'), description: '固定填 tree' },
        radius: { type: 'number', description: '搜索半径（格），默认 16，最大 40' },
      },
      required: ['target_kind'],
    },
  },
  {
    name: 'mine_nearest',
    description:
      '挖开**最近的一块石头** —— 不需要 #N / snapshot_id，所以不会过期。\n'
      + 'target_kind：ordinary_rock（普通石头 rock1 / rock_flintless，出石头+燧石+硝石）\n'
      + '  或 gold_vein（金矿脉 = rock2，出金块）。服务端会当场找最近的一块，并自动把镐拿到手上（没镐回 no_tool）。\n'
      + '挖碎后回执会写明掉了什么。\n'
      + '附近的石头都超过 6 格会回 out_of_range 并给出格子 —— 先 move_to 过去再试；附近没有会回 no_target。',
    inputSchema: {
      type: 'object',
      properties: {
        target_kind: {
          type: 'string',
          enum: kindsFor('mine_nearest'),
          description: 'ordinary_rock（普通石头）或 gold_vein（金矿脉）',
        },
        radius: { type: 'number', description: '搜索半径（格），默认 16，最大 40' },
      },
      required: ['target_kind'],
    },
  },
  {
    name: 'pickup',
    description:
      '捡起地上**一个普通资源**（树枝 twigs / 割下的草 cutgrass / 燧石 flint）。\n'
      + '只能用 get_state 里「附近」列出的 #N 引用，并且必须带上那一帧的 snapshot_id；\n'
      + '快照变了（snapshot_id 对不上）会被拒绝，先重新 get_state 再看。\n'
      + '只能捡手边 2.5 格内的东西，远了会返回 out_of_range —— 本动作**不会**自己走过去，\n'
      + '要靠近请先用 move_to。\n'
      + '树、建筑、容器、NPC、生物、以及不在白名单里的东西都捡不了（返回 prefab_not_allowed / target_not_pickable）。\n'
      + '背包放不下会返回 inventory_full，地上的东西不会消失。\n'
      + '成功与否以游戏里的真实状态为准：会核对你背包里该物品的数量有没有变多；\n'
      + '核对不上会返回 unverified 或 unknown，别自己宣布“已经捡到了”。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·可拾取物」里的引用，形如 #3（必须是最近一次 get_state 的）' },
        snapshot_id: {
          type: 'string',
          description:
            '「附近」段开头那个 Nearby 快照 ID（形如 r1234-5678-n9）。'
            + '**不是**开头「状态快照序列号 s123」——填错了会回 stale_snapshot。'
            + '必须与 target_ref 来自同一次 get_state；拿不准就重新 get_state。',
        },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'harvest',
    description:
      '采下一个**已经成熟**的可收获对象（浆果丛 berrybush/berrybush2/berrybush_juicy、地里的胡萝卜 carrot_planted、成熟蘑菇等）。\n'
      + '只能用 get_state 的「可收获」段里的 #N 引用，并且必须带上那一帧的 snapshot_id；\n'
      + '快照变了会被拒绝（先重新 get_state）。\n'
      + '目标必须**当前成熟**（原生 CanBePicked）：没成熟返回 not_ready，次数用尽返回 already_harvested，\n'
      + '卡住返回 target_busy。\n'
      + '必须站在原生允许的距离内（约 1 格，规则是"目标物理半径 + 4"），远了返回 out_of_range ——\n'
      + '本动作**不会**自己走过去，要靠近请先用 move_to。\n'
      + '树、岩石、冰、建筑、草、树苗、农田、晾肉架、生物都采不了（返回 prefab_not_allowed / target_not_harvestable）。\n'
      + '采下的果实通常直接进背包；背包满或掉落类植物会掉在地上。所以**成功不等于东西一定在背包里**，\n'
      + '看回执里的说明。\n'
      + '本动作**不会**自动接着捡地上的东西 —— 要捡请另外调用 pickup。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·可收获」段里的引用，形如 #3（必须是最近一次 get_state 的）' },
        snapshot_id: {
          type: 'string',
          description:
            '「附近」段开头那个 Nearby 快照 ID（形如 r1234-5678-n9）。'
            + '**不是**开头「状态快照序列号 s123」——填错了会回 stale_snapshot。'
            + '必须与 target_ref 来自同一次 get_state；拿不准就重新 get_state。',
        },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'gather',
    description:
      '采集一丛**草**（得 cutgrass）、一棵**树苗**（得 twigs）或一朵**花**（得 petals，采集本身回理智）。\n'
      + '只能用 get_state 的「附近·可收获」段里的 #N 引用，并带上同一份结果的「Nearby 快照 ID」；\n'
      + '快照变了会被拒绝（先重新 get_state）。\n'
      + '只能采草丛 grass / 树苗 sapling / 花 flower —— 浆果丛请用 harvest，地上的东西请用 pickup。\n'
      + '采空还没长回来的会返回 already_harvested；没成熟的返回 not_ready。\n'
      + '距离和浆果丛一样紧（约 1 格）：够不着先 move_to，再重新 get_state。\n'
      + '成功与否以背包里 cutgrass/twigs 有没有变多为准，不只看回执。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·可收获」段里的引用，形如 #3（必须是最近一次 get_state 的）' },
        snapshot_id: {
          type: 'string',
          description:
            '「附近」段开头那个 Nearby 快照 ID（形如 r1234-5678-n9）。'
            + '**不是**开头「状态快照序列号 s123」——填错了会回 stale_snapshot。'
            + '必须与 target_ref 来自同一次 get_state；拿不准就重新 get_state。',
        },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'chop',
    description:
      '砍一棵树（需要背包里有斧头，会自动装备）。砍倒后木头掉在地上，记得用 pickup 捡。\n'
      + '只能用 get_state 里列出的 #N 引用 + 同一帧的 Nearby 快照 ID。\n'
      + '没有斧头会返回 no_tool 并告诉你先 craft axe。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'mine',
    description:
      '挖一块石头（需要镐，会自动装备）。出石头/燧石/金块，掉在地上记得 pickup。\n'
      + '只能用 #N 引用 + Nearby 快照 ID。没有镐会返回 no_tool。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'dig',
    description: '铲掉草皮/树桩/坟（需要铲子）。只能用 #N 引用 + Nearby 快照 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'hammer',
    description: '拆掉一个建筑（需要锤子）。只能用 #N 引用 + Nearby 快照 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'attack',
    description:
      '打一个东西（默认 1 下，可以用 times 指定几下）。血低于 25% 会自己放弃。\n'
      + '只能用 #N 引用 + Nearby 快照 ID。要打到死用 kill。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·威胁/生物」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        times: { type: 'number', description: '打几下，默认 1' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'kill',
    description:
      '一直打到目标死为止（自己血低于 25% 会自动放弃，别硬拼）。\n'
      + '只能用 #N 引用 + Nearby 快照 ID。打完记得 pickup 掉落。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·威胁/生物」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'fight_spider',
    description:
      '战术风筝蜘蛛：自动执行「打二撤一」策略，战斗结束后自动拾取战利品（蜘蛛丝/蜘蛛腺体/怪物肉）。\n'
      + '比 kill 更安全，自带反击判定和风筝逻辑。\n'
      + '只能用 #N 引用 + Nearby 快照 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·威胁/生物」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'wait',
    description: '等一会儿（游戏时间秒，1~30）。比如等火把烧完、等东西烤好。夜里手上没光时会立刻失败（先 equip torch / 点火），等的时候掉血也会提前结束。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '等多少秒，默认 3' },
      },
    },
  },
  {
    name: 'sleep',
    description:
      '在**帐篷/睡袋**里睡一觉（回血回理智、掉饥饿）。\n'
      + '附近要有帐篷（先 build tent；炼金引擎 → 帐篷那条链），或者背包里/地上有睡袋。\n'
      + '不用给引用：#N、snapshot_id 都不需要，服务端自己在 radius 内找最近的帐篷/睡袋。\n'
      + '一次睡多久由游戏定（通常睡到下一个时段）。核对以血/理智真的涨了、或时间真的往前走了为准；\n'
      + '附近没有帐篷/睡袋会返回 no_sleepingbag，回执里会说清楚。',
    inputSchema: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: '找帐篷/睡袋的范围（格），默认 20，最大 40' },
      },
    },
  },
  {
    name: 'drop',
    description: '把背包里的东西丢到地上（比如丢掉不重要的腾出格子）。要传英文名，比如 twigs、flint。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '丢哪个（英文名）' },
      },
      required: ['item'],
    },
  },
  {
    name: 'unequip',
    description: '脱下手上的/身上的装备，放回背包。slot 可选：hands（默认）/ body / head / back。',
    inputSchema: {
      type: 'object',
      properties: {
        slot: { type: 'string', description: '哪个位置：hands / body / head / back，默认 hands' },
      },
    },
  },
  {
    name: 'say',
    description: '在游戏聊天里说一句话（人类玩家看得到）。用来告诉玩家你在干什么、或者问问题。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说什么（最多 120 字）' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fuel',
    description:
      '给火堆/火坑**添柴**（快灭了就加）。要用「附近」里的 #N 引用指向那团火 + Nearby 快照 ID。\n'
      + '不填 item 就自动挑背包里最耐烧的东西（木头、草、树枝都行）。\n'
      + '天黑了火灭了会被查理打死 —— 看到燃料低于 30% 就该加。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里火堆的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        item: { type: 'string', description: '用哪种燃料（可选，比如 log / cutgrass / twigs）' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'use',
    description:
      '对目标做一次**交互**。可选动作（都是游戏里真实存在的）：\n'
      + '  ACTIVATE（通用激活：科学机器、帐篷、探测仪）、ACTIVATE_CONTAINER（开箱子/冰箱）、\n'
      + '  RUMMAGE（翻找）、TAKEITEM（取出）、READ（读书）、PICKUP（捡起）、OPEN_CRAFTING（打开制作台）。\n'
      + '要用 #N 引用 + Nearby 快照 ID。不填 action 就自动挑一个能用的。\n'
      + '这是通用交互入口 —— 箱子、科学机器、帐篷、书、天体探测仪都靠它。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        action: { type: 'string', description: '可选：ACTIVATE / ACTIVATE_CONTAINER / RUMMAGE / TAKEITEM / READ / PICKUP / OPEN_CRAFTING' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'inspect',
    description:
      '**查看**一个目标的详细信息：血量、能不能采、还要干几下、燃料剩多少、能不能吃。只读，不改世界。\n'
      + '拿不准某个东西是什么/什么状态时用它，比猜好。要用 #N 引用 + Nearby 快照 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'container_take',
    description:
      '从**箱子/冰箱**里拿东西出来。要用 #N 引用指向容器 + Nearby 快照 ID。\n'
      + '不填 item 就拿第一个；填了就拿那种（比如 log / flint / berries）。\n'
      + '拿出来的东西会进背包（背包满了会失败）。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·容器」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        item: { type: 'string', description: '拿哪种（可选，英文名）' },
        count: { type: 'number', description: '拿几个（可选）' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'container_put',
    description:
      '把背包里的东西**放进箱子/冰箱**（腾格子、囤物资）。要用 #N 引用 + Nearby 快照 ID。\n'
      + '必须指定 item（放哪种）。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·容器」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        item: { type: 'string', description: '放哪种（英文名，必填）' },
      },
      required: ['target_ref', 'snapshot_id', 'item'],
    },
  },
  {
    name: 'give',
    description:
      '把背包里的东西**给某个目标**（猪人收买、喂鸟、给队友）。要用 #N 引用 + Nearby 快照 ID。\n'
      + '必须指定 item。给完东西会从背包里消失。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·生物」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        item: { type: 'string', description: '给什么（英文名，必填）' },
      },
      required: ['target_ref', 'snapshot_id', 'item'],
    },
  },
  {
    name: 'cook',
    description:
      '**锅**（cookpot）：把材料放进去开始煮，或者把煮好的菜拿出来。\n'
      + '要用 #N 引用指向锅 + Nearby 快照 ID。\n'
      + '锅里已经在煮 → 告诉你还要等几秒；煮好了 → 自动拿出来；没在煮 → 放材料开始煮。\n'
      + '不填 items 就自动挑背包里的肉和菜（最多 4 样）。放进去后要等 40 秒左右再来拿。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·建筑」里锅的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        items: { type: 'string', description: '放什么材料（可选，逗号分隔，比如 "meat,berries,berries,berries"）' },
      },
      required: ['target_ref', 'snapshot_id'],
    },
  },
  {
    name: 'build',
    description:
      '在地上**造一个建筑**。只能造这几个（材料够、科技够才行）：\n'
      + '  campfire（营火，2 草 + 3 树枝）— 天黑没火会死，这是最要紧的\n'
      + '  firepit（石头火坑，2 石头 + 12 木头）— 不会灭，但要材料多\n'
      + '  chest（箱子，3 木板）— 存东西\n'
      + '  cookpot（锅，3 木炭 + 6 树枝 + 6 石头）— 要科学机器\n'
      + '  sciencemachine（科学机器，**4 log + 4 rocks + 1 goldnugget**）— 解锁更多配方\n'
      + '    注意：是原木 log（不是木板 boards —— 木板本身要站在科学机器旁边才能做）\n'
      + '  researchlab2 / alchemyengine（炼金引擎，4 boards + 2 cutstone + 2 transistor）— 第二级科技\n'
      + '    要先 build sciencemachine，**站在科学机器旁边**才能造；它是帐篷的前置\n'
      + '  tent（帐篷，6 silk + 4 twigs + 3 rope）— 睡一觉回血回理智\n'
      + '    要先有炼金引擎并站在它旁边（科技第一阶段之上）\n'
      + '会自动在你脚边挑一块空地放下。没材料会告诉你还差什么。\n'
      + '建造成功以**附近真的多了一个该建筑**为准：材料变少但没看到建筑时会返回 unverified（build_not_found），\n'
      + '别以为成功了 —— 再 get_state 看一眼，或者换一块空地重试。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: BUILDABLE_RECIPES, description: '造哪个：campfire / firepit / chest / cookpot / sciencemachine / researchlab2（炼金引擎）/ tent（帐篷）' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'recipes',
    description:
      '**查配方**（只读）：能造什么、还差什么材料、有没有解锁。\n'
      + 'filter 可以按名字过滤（比如 "axe"、"campfire"）；不填就列前 30 个。\n'
      + '拿不准某个东西怎么做时用它，比猜好。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '按名字过滤（可选）' },
        limit: { type: 'number', description: '最多列几个，默认 30' },
      },
    },
  },
  {
    name: 'lookup',
    description:
      '**查游戏数据**（只读）：某个东西是什么、怎么做、能用来干什么。\n'
      + '用英文 prefab 名查最准（比如 "axe"、"log"、"cookpot"）。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '查什么（英文 prefab 名）' },
      },
      required: ['q'],
    },
  },
  {
    name: 'probe',
    description:
      '**探测**附近有没有某种东西（只读，不靠 get_state）：告诉你有几个、在哪、多远。\n'
      + '比 get_state 更聚焦 —— 只想知道"附近有没有燧石"时用它。\n'
      + '找不到可以用 seek 走出去找。',
    inputSchema: {
      type: 'object',
      properties: {
        prefab: { type: 'string', description: '找什么（英文名，比如 flint、rocks、berries）' },
        radius: { type: 'number', description: '范围（格），默认 16' },
      },
      required: ['prefab'],
    },
  },
  {
    name: 'gather_area',
    description:
      '把附近能采的**一次采完**（草丛→cutgrass、树苗→twigs、浆果丛→berries、花→petals）。\n'
      + '不填 prefab 就采附近所有能采的；填了只采那一种（必须在白名单里）。\n'
      + '**会自己走过去**，采完会报"采了几个、得了什么"。\n'
      + '这是"一片草/一片浆果"最快的做法 —— 比一个目标一个目标调 gather/harvest 省很多次调用。\n'
      + '没成熟的、够不着的会自动跳过（回执里会说还有几个没采）。\n'
      + '**默认只采 8 格内、最多 8 个**：够用就再调一次，别把一轮动作拖成好几分钟；\n'
      + '采集时被怪打会立刻停下并告诉你先跑。',
    inputSchema: {
      type: 'object',
      properties: {
        prefab: { type: 'string', description: '只采这一种（可选）：grass / sapling / berrybush / berrybush2 / flower' },
        radius: { type: 'number', description: '范围（格），默认 8，最大 40' },
        limit: { type: 'number', description: '最多采几个，默认 8，最大 30' },
      },
    },
  },
  {
    name: 'seek',
    description:
      '**出去找东西**：从脚下开始一圈圈往外走（8 个方向 × 多环），边走边看，找到就报它在哪。\n'
      + '当 get_state 里附近没有你要的东西时用它（比如"找燧石"），别瞎猜坐标、也别随手捡别的。\n'
      + '它**只走路和看，不会自动去采/捡** —— 找到之后你再用 move_to 过去、用 pickup/gather/harvest 动手。\n'
      + '找不到会告诉你"走了多远也没看到"，可以换个方向再来一次，或者改找别的。',
    inputSchema: {
      type: 'object',
      properties: {
        prefab: { type: 'string', description: '要找的东西英文名，比如 flint、rocks、grass、berrybush、sapling' },
        step: { type: 'number', description: '每站往外走多少格，默认 10' },
        max_tiles: { type: 'number', description: '最多往外找多少格，默认 40' },
        look: { type: 'number', description: '每站看多大范围（格），默认 16' },
      },
      required: ['prefab'],
    },
  },
  {
    name: 'eat',
    description:
      '吃掉背包里的一份食物。不填 food 就自动挑最该吃的一份（优先新鲜、补得多的）。\n'
      + '只能吃白名单里的基础食物：berries、berries_juicy、carrot、corn、pumpkin、eggplant、honey、meat、'
      + 'smallmeat、froglegs、fish（以及它们的熟食 xxx_cooked）。生蘑菇可以手动指定，但自动挑食物会跳过它们'
      + '（生红蘑菇扣血、生绿蘑菇扣大量理智）。\n'
      + '**怪物肉、腐烂物不在白名单里**（会掉理智/掉血）。\n'
      + '⚠ **它只认背包里此刻真实存在的东西**：保命反射可能刚把食物吃掉/收走，所以**不要凭上一轮的背包**填 food。\n'
      + '被拒时（not_in_inventory / no_food / food_not_allowed）回执会直接列出"背包里现在真正能吃的"和正确 prefab 名，\n'
      + '照着那个改就行，别原地反复猜名字。注意**地上那株植物**叫 green_mushroom/blue_mushroom，\n'
      + '**采下来的物品**才叫 green_cap/blue_cap —— 想吃蘑菇先 cook 烤熟。\n'
      + '背包里没有安全食物时：用 pickup_food 捡地上的（胡萝卜/浆果/南瓜），或 harvest_nearest 采成熟的植株。\n'
      + '饿着才会吃：饥饿快满时会被拒（not_hungry），别浪费食物。\n'
      + '成功以饥饿值上涨、或该食物数量减少、或回血为准；回执会写清核对到了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        food: { type: 'string', description: '要吃哪种（可选，比如 berries）；不填就自动挑' },
      },
    },
  },
  {
    name: 'craft',
    description:
      '制作基础工具、装备或第一阶段科技材料。开放配方：\n'
      + '  · torch     = 2 cutgrass + 2 twigs（火把）\n'
      + '  · axe       = 1 twigs + 1 flint（斧头）\n'
      + '  · pickaxe   = 2 twigs + 2 flint（镐）\n'
      + '  · flowerhat = 12 petals（花环，戴头上持续恢复理智）\n'
      + '  —— 以上 4 个不需要科技，随时能做。\n'
      + '  · rope      = 3 cutgrass（绳子）\n'
      + '  · boards    = 4 log（木板）\n'
      + '  · backpack  = 4 cutgrass + 4 twigs（背包，多 8 格）\n'
      + '  · spear     = 2 twigs + 1 rope + 1 flint（长矛）\n'
      + '  · armorwood = 8 log + 2 rope（木甲，减伤）\n'
      + '  · cutstone  = 3 rocks（石砖）\n'
      + '  · transistor = 2 goldnugget + 1 cutstone（电子元件）\n'
      + '  —— 以上 7 个是**第一阶段科技**：要先 build sciencemachine，然后**站到它旁边**再做；\n'
      + '     离得远会返回 recipe_locked（这不是 bug，走回去再试）。\n'
      + '材料不够会返回 ingredients_missing 并告诉你还差几个（材料数字读自游戏原版配方表）。\n'
      + 'cutstone + transistor + boards 是炼金引擎（build researchlab2）的材料；\n'
      + '炼金引擎是帐篷（build tent，还要 silk×6 + twigs×4 + rope×3）的前置。\n'
      + '只能做背包里的成品，不会摆建筑（营火/火坑/科学机器/炼金引擎/帐篷用 build）。\n'
      + '成功以成品真的进了背包或自动穿戴为准。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: CRAFTABLE_RECIPES, description: '要做的东西：torch / axe / pickaxe / flowerhat（无需科技），或 rope / boards / backpack / spear / armorwood / cutstone / transistor（要在科学机器旁边）' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'equip',
    description:
      '装备背包里的工具、防具或光源：torch（火把）、axe（斧头）、pickaxe（镐）、flowerhat（花环，头部）、lantern（提灯）、minerhat（矿工帽，头部）。\n'
      + '只能装备**背包里已经有**的东西，没有会返回 not_in_inventory。\n'
      + '原来同部位的东西会自动收回背包。\n'
      + '成功以装备栏真的变成它为准。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', enum: ['torch', 'axe', 'pickaxe', 'lantern', 'minerhat', 'flowerhat'], description: '要装备的工具、防具或光源：torch / axe / pickaxe / lantern / minerhat / flowerhat' },
      },
      required: ['item'],
    },
  },
]

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

const LOCAL_TOOLS = [
  {
    name: 'advance_task',
    description: '自主任务执行：让系统从 Task Board 选择当前最高优先级的任务，并利用 Autopilot 运行时连续执行多个原子动作，直到任务完成、阻塞或达到步骤预算。\n'
      + '这是 Autopilot 模式下的核心推进工具，不需要手动指定 skill_id，系统会自动管理生命周期。',
    inputSchema: {
      type: 'object',
      properties: {
        max_steps: { type: 'number', description: '可选：本次执行的原子动作预算上限（1-10，默认 8）。' },
      },
    },
  },
  {
    name: 'get_state',
    description: '看现在的游戏状态：时间、位置、生命/饥饿/理智、背包、附近能采能捡的东西、敌人和危险提醒。\n'
      + '**任务开始时看一次就够**：动作回执里已经带着核对过的变化，不需要每个动作前后都重看。\n'
      + '只有结果不确定（stale_snapshot / unknown / unverified）、目标没了、角色或危险状态变了、\n'
      + '或者隔了很久需要重新判断时才再看。format=json 返回纯 JSON（笔记在 notes 字段里）。',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'text（默认）给人看的短文本；json 给程序用的结构化数据（含 notes / snapshot / state）',
        },
      },
    },
  },
  {
    name: 'get_guide',
    description: '读攻略：生存（季节、食物、光源、建家）、战斗（怪物和 Boss 打法）、烹饪（锅的配方）。不填 topic 返回目录。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'main / survive / fight / cook，不填就返回目录' },
      },
    },
  },
  {
    name: 'update_notes',
    description: '写下要长期记住的事（你的计划、家在哪、箱子放什么）。下次 get_state 会显示在最前面。传空字符串就是清空。',
    inputSchema: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: '笔记内容' },
      },
      required: ['notes'],
    },
  },
  {
    name: 'run_skill',
    description:
      '**执行一个复合技能**（多步骤工作流）—— 由系统负责把十几个原子动作串起来，你不需要自己编排。\n'
      + '每次调用推进**一个有边界的步骤**（最多下发一个原子动作），返回真实结果（用快照核对，不看"说成功"）。\n'
      + '可选 max_steps（1-8，默认 1）：在一次调用里**串行**连推多步（每步仍是单原子动作、有上限），加快走完长流程。\n'
      + '同一个技能重复调用会**恢复**原会话（不新建）；技能完成/失败后重复调用不会重跑（世界退化会自动重开）。\n'
      + '可用技能：\n'
      + '  · survival_stabilize（稳定生存：有光、吃饱、回血、基础工具）\n'
      + '  · establish_home（建立家园：勘察→选址→前往→收料→建科学机器→设家）\n'
      + '  · gather_resources（按缺口收集材料，含中间产物依赖）\n'
      + '技能内部动作仍走唯一 dispatcher（会占用控制权、遵守动作互斥）；紧急危险时 Lua Reflex 可抢占。\n'
      + '非生存技能遇到 P0/P1 生存紧急会自动暂停并把控制权交回生存（先 run survival_stabilize）。',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', enum: skillIds(), description: '要执行的技能 id（survival_stabilize / establish_home / gather_resources）' },
        task_id: { type: 'string', description: '可选：指定要推进/恢复的看板任务 id（若不指定则作为独立手动技能执行，不干扰自动调度任务）。' },
        skill_args: {
          type: 'object',
          description: '可选：传给技能实例的参数对象（如 gather_resources 可传 {"recipe":"researchlab2"} 或 {"target_items":{"log":4}}），中断恢复时自动保留。',
        },
        max_steps: { type: 'number', description: '可选：本次最多串行推进几步（1-8，默认 1）。' },
      },
      required: ['skill_id'],
    },
  },
]

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
export function toolList(mode = 'autopilot') {
  const normMode = normalizeExecutionMode(mode)
  return TOOLS.filter((tool) => {
    if (normMode === 'autopilot') {
      // Autopilot 模式：仅暴露 advance_task、stop 以及必要的只读查询（get_state, get_guide, update_notes）
      // 严禁暴露普通原子动作以及 run_skill（防止模型绕过任务看板直接指派技能）
      if (tool.name === 'run_skill') return false
      if (ACTION_TOOLS.some((t) => t.name === tool.name)) {
        return ['stop'].includes(tool.name)
      }
      return true
    }
    if (normMode === 'manual') {
      // Manual 模式：隐藏 advance_task，暴露全部原子工具与技能
      return tool.name !== 'advance_task'
    }
    // 'assisted' 暴露全部工具
    return true
  }).map((tool) => ({
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
  const mode = normalizeExecutionMode(ctx?.executionMode)

  const logPerm = (allowed, reason) => {
    try {
      if (typeof ctx?.log === 'function') {
        ctx.log('info', `[PERMISSION] mode=${mode} tool=${name} allowed=${allowed} reason=${reason}`)
      }
    } catch {}
  }

  // 服务端权限控制：以当前 executionMode 作为唯一事实来源
  if (mode === 'autopilot') {
    if (name === 'run_skill') {
      logPerm(false, 'run_skill_blocked_in_autopilot')
      return `失败：当前处于自主生存模式（Autopilot），禁止通过【run_skill】绕过任务看板直接指定技能。请使用【advance_task】由系统自动调度，或切换到 Assisted 模式。`
    }
    if (ACTION_NAMES.has(name) && !['stop'].includes(name)) {
      logPerm(false, 'atomic_action_blocked_in_autopilot')
      return `失败：当前处于自主生存模式（Autopilot），禁止直接调用底层原子动作【${name}】。请使用【advance_task】让系统自动调度任务与推进动作，或切换到 Assisted/Manual 模式。`
    }
  }
  if (mode === 'manual' && name === 'advance_task') {
    logPerm(false, 'advance_task_blocked_in_manual')
    return `失败：当前处于手动模式（Manual），禁止调用【advance_task】。请使用原子工具或切换到 Autopilot 模式。`
  }
  logPerm(true, 'allowed_by_mode')

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
  const trace = []
  let result = null
  try {
    for (let k = 0; k < maxSteps; k++) {
      result = await runtime.executeTask(skillId, taskId, skillArgs)
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
    log: (level, msg) => { try { ctx.log?.(level, msg) } catch {} },
  })
  ctx.orchestrator = runtime.orchestrator
  ctx.worldRuntime = runtime

  const maxSteps = Math.max(1, Math.min(10, Math.trunc(Number(input?.max_steps ?? 8)) || 8))
  let report = null
  try {
    report = await runtime.advanceTask({ maxSteps })
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
