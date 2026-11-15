// MCP 工具：名字、说明、参数，以及真正执行（转给游戏里的模组）
//
// 模型看到的每一条说明都是给它看的操作手册：说清楚单位（格子）、前置条件、失败了怎么办。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, freshnessLine, renderFallbackText, toJsonPayload } from './state/snapshot.js'
import { createDispatcher } from './dispatcher.js'
import { ACTION_SPECS } from './actions/specs/index.js'
import { derivePlan, planPayload, renderPlan } from './plan.js'
import { LeaseManager, defaultLeaseFile } from './control.js'


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
6. 用 #N 引用的动作（pickup / harvest / gather / chop / mine / dig / hammer / attack / kill /
   fuel / use / inspect / container_* / give / cook）：引用来自最近一次 get_state 的「附近」段，
   必须连**「附近」段开头那个「Nearby 快照 ID」**（形如 r1234-5678-n9）一起传。
   ⚠ 第一行的「状态快照序列号 s123」**不是**它，填错会回 stale_snapshot。
   这类动作**都不会自己走过去**：够不着就先 move_to 靠近，再重新 get_state 拿新的 #N
   （快照变了，旧引用会被拒绝）。背包类动作（eat / craft / equip / drop / unequip）只需要物品名。
7. 别忘了记笔记：想长期记住的计划（比如「家在 (12,45)，箱子在左边」）用 update_notes 写下来，下次 get_state 会显示在最前面。
8. 攻略用 get_guide 按需读（生存、战斗、烹饪各一篇），不用一次全读完。

## 这个游戏最要命的几件事
- **天黑要有光**：黄昏之前必须有火把（torch）、营火（campfire，2 木头 + 3 干草）或者火坑。火堆会烧完，要留意别让它灭。
- **会饿**：饥饿到 0 会持续掉血。背包里要常备吃的；看见成熟的浆果丛可以用 harvest 采。
- **会疯**：理智低了会出现暗影怪，晚上和在黑暗里掉得特别快。
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
      + '  sciencemachine（科学机器，4 木板 + 4 石头 + 1 金块）— 解锁更多配方\n'
      + '会自动在你脚边挑一块空地放下。没材料会告诉你还差什么。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: ['campfire', 'firepit', 'chest', 'cookpot', 'sciencemachine'], description: '造哪个' },
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
      + '只能吃白名单里的基础食物：berries、carrot、corn、pumpkin、eggplant、honey、meat、'
      + 'smallmeat、froglegs、fish。生蘑菇可以手动指定，但自动挑食物会跳过它们'
      + '（生红蘑菇扣血、生绿蘑菇扣大量理智）。\n'
      + '**怪物肉、腐烂物不在白名单里**（会掉理智/掉血）。\n'
      + '饿着才会吃：饥饿快满时会被拒（not_hungry），别浪费食物。\n'
      + '成功以饥饿值上涨或该食物数量减少为准。',
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
      '制作一个基础工具。**只开放 3 个配方**：\n'
      + '  · torch   = 2 cutgrass + 2 twigs\n'
      + '  · axe     = 1 twigs + 1 flint\n'
      + '  · pickaxe = 2 twigs + 2 flint\n'
      + '三个都不需要科学机器。材料不够会返回 ingredients_missing 并告诉你还差几个。\n'
      + '只能做背包里的成品，不会摆建筑（营火/火坑/房屋都还没开放）。\n'
      + '成功以成品真的进了背包为准。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: ['torch', 'axe', 'pickaxe'], description: '要做的东西：torch / axe / pickaxe' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'equip',
    description:
      '装备背包里的工具或光源：torch（火把）、axe（斧头）、pickaxe（镐）、lantern（提灯）、minerhat（矿工帽，头部）。\n'
      + '只能装备**背包里已经有**的东西，没有会返回 not_in_inventory。\n'
      + '原来手里的东西会自动收回背包。\n'
      + '成功以装备栏真的变成它为准。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', enum: ['torch', 'axe', 'pickaxe', 'lantern', 'minerhat'], description: '要装备的工具或光源：torch / axe / pickaxe / lantern / minerhat' },
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
const LOCAL_TOOLS = [
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
]

export const TOOLS = [...LOCAL_TOOLS, ...ACTION_TOOLS]

/** 给 MCP 的 tools/list 用的格式（去掉内部字段）。 */
export function toolList() {
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
 * ctx: { bridge, notes: {read, write}, guides: {main,...}, extraInstructions, log }
 */
export async function executeTool(name, args, ctx) {
  const input = { ...(args ?? {}) }
  // 模组里 count 的原意是「挥几下」，只有 until_gone=true 时才是「干倒几个目标」。
  // 模型不该知道这个历史包袱：除草/砍树/挖矿/拆东西默认给它 until_gone=true。
  // （真机踩到：chop {"count":1} 回「连着干了 1 次」，树没倒、木头没掉。）
  if (WORK_TOOLS.has(name) && input.until_gone === undefined) input.until_gone = true
  if (name === 'get_state') return getState(input, ctx)
  if (name === 'get_guide') return getGuide(input, ctx)
  if (name === 'update_notes') return updateNotes(input, ctx)
  if (!ACTION_NAMES.has(name) && !MACRO_NAMES.has(name)) throw new Error(`没有这个工具：${name}`)

  // M2.0：所有动作只能经过 Dispatcher（校验 → 租约 → 下发 → 核对）
  const dispatcher = dispatcherFor(ctx)
  const outcome = await dispatcher.dispatch({ tool: name, args: input, owner: ctx.owner ?? 'system', ownerInstanceId: ctx.ownerInstanceId })
  // OBSERVATION-01：把结构化结果（含 verified）留在 ctx 上，供 Agent 维护"已知背包"。
  // 只读地暴露，不影响返回给模型的文本。
  try { ctx.lastOutcome = outcome } catch {}
  return dispatcher.describe(outcome)
}

function notesPrefix(ctx) {
  const notes = ctx.notes?.read?.() ?? ''
  const extra = (ctx.extraInstructions ?? '').trim()
  const parts = []
  if (notes.trim()) parts.push(`你的笔记（上次记下的，还作数）：\n${notes.trim()}\n`)
  if (extra) parts.push(`玩家的额外要求：${extra}\n`)
  return parts.length > 0 ? parts.join('\n') + '\n' : ''
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

function getState(input, ctx) {
  const snapshot = readSnapshot(ctx)
  if (!snapshot) {
    return '连不上游戏：找不到大肥鱼饿不死写的状态文件。\n'
      + '确认：1) 饥荒联机版已经通过 Steam 打开并读档进世界；2) mods 里装了大肥鱼饿不死；'
      + '3) 世界是本地主机（自己开的）。装好模组后要重新读档一次。'
  }

  // 计划层：用同一份快照推导"现在最该做的一件事"。
  // 上一次的计划放在 ctx 上（F8 / MCP 共用），目标仍然成立就保持不动，避免每轮重新规划。
  const plan = derivePlan(snapshot, ctx.lastPlan)
  try {
    ctx.setPlan?.(plan)
    ctx.lastPlan = plan
  } catch {}

  const format = String(input?.format ?? 'text').toLowerCase()
  if (format === 'json') {
    // OBSERVATION-01：JSON 模式必须是**纯 JSON**（笔记放进 notes 字段），
    // 否则 JSON.parse 会失败 —— 之前这里是 notesPrefix(ctx) + JSON.stringify(...)。
    const payload = toJsonPayload(snapshot, {
      notes: ctx.notes?.read?.() ?? '',
      extraInstructions: ctx.extraInstructions ?? '',
    })
    // 纯 JSON 模式也不能把计划拼到字符串前面；放进字段里，调用方照样能 JSON.parse
    payload.plan = planPayload(plan)
    return JSON.stringify(payload, null, 1)
  }

  // 文本优先用 Lua 从同一份 data 渲染好的那份；没有才在 Node 侧兜底（老格式/被截断）
  const body = snapshot.text || renderFallbackText(snapshot)
  return notesPrefix(ctx) + freshnessLine(snapshot) + body + '\n' + renderPlan(plan)
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
  ctx.notes.write(text)
  return text ? `记下了：\n${text}` : '笔记清空了'
}

/** 攻略的当前内容（DSH 插件里改过的优先）。 */
export function guideText(key, overrides, bundled = BUNDLED_GUIDES) {
  const custom = (overrides?.[key] ?? '').trim()
  if (custom && custom !== (bundled[key] ?? '').trim()) return custom
  return bundled[key] ?? ''
}

export { ACTION_NAMES, MACRO_NAMES }
