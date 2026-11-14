// MCP 工具：名字、说明、参数，以及真正执行（转给游戏里的模组）
//
// 模型看到的每一条说明都是给它看的操作手册：说清楚单位（格子）、前置条件、失败了怎么办。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeState, freshnessLine, renderFallbackText, toJsonPayload } from './state/snapshot.js'
import { createDispatcher } from './dispatcher.js'
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
2. 坐标都是「格子」（1 格 = 4 个世界单位），get_state 里写的 (12,45) 就是 x=12、z=45，直接填进 move_to。
3. 动作回执就是"下一件事的依据"：成功就接着推进，失败就看原因换个做法。
   一次可以只发一个动作；如果要发多个，后面的动作会等前面成功才执行 —— 前面失败/结果不确定，后面的会被跳过并告诉你原因。
4. 动作失败会告诉你原因（附近没有、走不到、够不着、还没成熟……），别原样重复同一个失败动作，换个目标或者先解决原因。
5. **目前开放 8 个动作**：move_to（走）、stop（停）、pickup（捡地上的东西）、
   harvest（采成熟浆果丛）、gather（采草丛/树苗，得 cutgrass/twigs）、
   eat（吃背包里的食物）、craft（做 torch/axe/pickaxe）、equip（把工具拿在手里）。
   砍树、挖矿、战斗、建建筑、烹饪都还没开放，调了会被直接拒绝 —— 别浪费回合去试。
6. 捡东西 / 采东西的用法：用最近一次 get_state 的「附近·可拾取物」或「可收获」段里列出的 #N 引用，
   连**「附近」段开头那个「Nearby 快照 ID」**（形如 r1234-5678-n9）一起传给 pickup / harvest。
   ⚠ 第一行的「状态快照序列号 s123」**不是**它，填错会回 stale_snapshot。
   这两个动作**都不会自己走过去**：
   够不着就先 move_to 靠近，再重新 get_state 拿新的 #N（快照变了，旧引用会被拒绝）。
7. 别忘了记笔记：想长期记住的计划（比如「家在 (12,45)，箱子在左边」）用 update_notes 写下来，下次 get_state 会显示在最前面。
8. 攻略用 get_guide 按需读（生存、战斗、烹饪各一篇），不用一次全读完。

## 这个游戏最要命的几件事
- **天黑要有光**：黄昏之前必须有火把（torch）、营火（campfire，2 木头 + 3 干草）或者火坑。火堆会烧完，要留意别让它灭。
- **会饿**：饥饿到 0 会持续掉血。背包里要常备吃的；看见成熟的浆果丛可以用 harvest 采。
- **会疯**：理智低了会出现暗影怪，晚上和在黑暗里掉得特别快。
- **会冻死/热死**：冬天要有保暖衣物和火，夏天要降温（冰火、遮阳）。
- **血要主动回**：低于 35% 就很危险了；能回血的手段（药膏、食物）目前还没开放成动作，注意别硬撑。
- **时间在走**：你思考的时候游戏**不会**停（除非玩家在插件里开了「思考时暂停」）。所以动作要果断，别反复空想。
- **模组会自动保命**：血见底、入夜没光、火要灭、被敌人贴脸时，模组会在你没有下指令的空档自己动手（吃药/举火把/添柴/后撤）。它只在**没有任务在跑**的时候插手；这些动作不会出现在你的对话里，看到状态变了别惊讶。

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
      '采下一个**已经成熟**的可收获对象。本阶段只支持一种目标：普通浆果丛（berrybush / berrybush2）。\n'
      + '只能用 get_state 的「可收获」段里的 #N 引用，并且必须带上那一帧的 snapshot_id；\n'
      + '快照变了会被拒绝（先重新 get_state）。\n'
      + '目标必须**当前成熟**（原生 CanBePicked）：没成熟返回 not_ready，次数用尽返回 already_harvested，\n'
      + '卡住返回 target_busy。\n'
      + '必须站在原生允许的距离内（约 1 格，规则是"目标物理半径 + 4"），远了返回 out_of_range ——\n'
      + '本动作**不会**自己走过去，要靠近请先用 move_to。\n'
      + '树、岩石、冰、建筑、草、树苗、农田、晾肉架、生物都采不了（返回 prefab_not_allowed / target_not_harvestable）。\n'
      + '采下的浆果通常直接进背包；背包满时会掉在地上。所以**成功不等于东西一定在背包里**，\n'
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
      '采集一丛**草**（得 cutgrass）或一棵**树苗**（得 twigs）。\n'
      + '只能用 get_state 的「附近·可收获」段里的 #N 引用，并带上同一份结果的「Nearby 快照 ID」；\n'
      + '快照变了会被拒绝（先重新 get_state）。\n'
      + '只能采草丛 grass / 树苗 sapling —— 浆果丛请用 harvest，地上的东西请用 pickup。\n'
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
    name: 'eat',
    description:
      '吃掉背包里的一份食物。不填 food 就自动挑最该吃的一份（优先新鲜、补得多的）。\n'
      + '只能吃白名单里的基础食物：berries、carrot、corn、pumpkin、eggplant、red_cap、blue_cap、'
      + 'green_cap、honey、meat、smallmeat、froglegs、fish。\n'
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
      '把背包里的工具拿在手里。**只开放 3 种**：torch（火把）、axe（斧头）、pickaxe（镐）。\n'
      + '只能装备**背包里已经有**的东西，没有会返回 not_in_inventory。\n'
      + '原来手里的东西会自动收回背包。\n'
      + '成功以装备栏真的变成它为准。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', enum: ['torch', 'axe', 'pickaxe'], description: '要拿在手里的东西：torch / axe / pickaxe' },
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
          description: 'text（默认）给人看的短文本；json 给程序用的结构化数据（字段见 docs/archive/milestones/M1/M1_1_get_state_schema.md）',
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

  const format = String(input?.format ?? 'text').toLowerCase()
  if (format === 'json') {
    // OBSERVATION-01：JSON 模式必须是**纯 JSON**（笔记放进 notes 字段），
    // 否则 JSON.parse 会失败 —— 之前这里是 notesPrefix(ctx) + JSON.stringify(...)。
    const payload = toJsonPayload(snapshot, {
      notes: ctx.notes?.read?.() ?? '',
      extraInstructions: ctx.extraInstructions ?? '',
    })
    return JSON.stringify(payload, null, 1)
  }

  // 文本优先用 Lua 从同一份 data 渲染好的那份；没有才在 Node 侧兜底（老格式/被截断）
  const body = snapshot.text || renderFallbackText(snapshot)
  return notesPrefix(ctx) + freshnessLine(snapshot) + body
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
