// MCP 工具：名字、说明、参数，以及真正执行（转给游戏里的模组）
//
// 模型看到的每一条说明都是给它看的操作手册：说清楚单位（格子）、前置条件、失败了怎么办。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
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
1. 每次行动前先调 get_state：它给你时间、位置、身体状况、背包、附近能采能砍能挖的东西、敌人和危险提醒。
2. 坐标都是「格子」（1 格 = 4 个世界单位），get_state 里写的 (12,45) 就是 x=12、z=45，直接填进 move_to。
3. 一次只做一件事，看完动作结果再做下一件。动作有长有短：砍一棵树几秒，睡一觉可能好几分钟。
4. 动作失败会告诉你原因（附近没有、走不到、材料不够、不会做……），别原样重复同一个失败动作，换个目标或者先解决原因。
5. 不确定东西叫什么名字时，用 go_to 试探（比如 {\"target\":\"berrybush\"}），找不到会告诉你。
6. **砍/挖/拆下来的东西掉在地上，不会自己进背包**：砍完树用 pickup（{\"item\":\"log\",\"count\":4}）把木头捡回来；挖矿同理捡 rocks/flint/goldnugget。pick 只采「活的」浆果丛、草、树苗。
7. 别忘了记笔记：想长期记住的计划（比如「家在 (12,45)，箱子在左边」）用 update_notes 写下来，下次 get_state 会显示在最前面。
8. 攻略用 get_guide 按需读（生存、战斗、烹饪各一篇），不用一次全读完。

## 这个游戏最要命的几件事
- **天黑要有光**：黄昏之前必须有火把（torch）、营火（campfire，2 木头 + 3 干草）或者火坑。火堆会烧完，**要 add_fuel 续火**。天黑了没光，查理会一直打你。
- **会饿**：饥饿到 0 会持续掉血。背包里要常备吃的，看到浆果丛、胡萝卜就采。
- **会疯**：理智低了会出现暗影怪，晚上和在黑暗里掉得特别快。
- **会冻死/热死**：冬天要有保暖衣物和火，夏天要降温（冰火、遮阳）。
- **血要主动回**：低于 35% 就用 heal（药膏/腺体，没有就吃东西），别等它自己好。
- **时间在走**：你思考的时候游戏**不会**停（除非玩家在插件里开了「思考时暂停」）。所以动作要果断，别反复空想。
- **模组会自动保命**：血见底、入夜没光、火要灭、被敌人贴脸时，模组会在你没有下指令的空档自己动手（吃药/举火把/添柴/后撤）。它只在**没有任务在跑**的时候插手；这些动作不会出现在你的对话里，看到状态变了别惊讶。

## 通过 MCP 玩的额外说明
- 玩家（人类）可能随时自己接手玩；如果动作被拒绝或者角色被移动了，先 get_state 看看发生什么。
- say 会在游戏聊天里说话（人类玩家看得到），需要交流时用它。
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
    name: 'go_to',
    description: '走到附近某个东西旁边（不像 move_to 要自己找坐标，比如走到最近的浆果丛、火堆、蜘蛛）。名字用 prefab 或中文名都行；也可以用 tag:hostile 这种标签找。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要找的东西，比如 berrybush、spider、cookpot、firepit、tag:hostile' },
        radius: { type: 'integer', description: '搜索半径（格），默认 30' },
        timeout: { type: 'number', description: '最多走多少秒，默认 90' },
      },
      required: ['target'],
    },
  },
  {
    name: 'pick',
    description: '采集附近「活的」能采的东西：浆果丛、树枝、干草、蘑菇、胡萝卜这类。默认采最近的一个；count 可以连续采几次。注意：地上的掉落物（木头、石头、燧石）不归它管，用 pickup。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '只要某一种（可选），比如 berrybush' },
        count: { type: 'integer', description: '连续采几次，默认 1' },
        radius: { type: 'integer', description: '搜索半径（格），默认 12' },
      },
    },
  },
  {
    name: 'pickup',
    description: '捡起掉在地上的东西：砍下来的木头（log）、挖出来的石头/燧石/金块（rocks/flint/goldnugget）、蜘蛛掉的丝和腺体、拆房子掉的猪皮、地上能捡的种子和齿轮。砍完挖完先 pickup 再走，不然东西留在原地。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '只要某一种（可选），比如 log、flint、rocks；不填就捡最近的' },
        count: { type: 'integer', description: '捡几个，默认 1（同一个格子摞着的算一次）' },
        radius: { type: 'integer', description: '搜索半径（格），默认 12' },
      },
    },
  },
  {
    name: 'chop',
    description: '砍树（要有斧头，没斧头会告诉你）。默认一直砍到这棵树倒下才算一棵，所以 count 是「砍倒几棵」。木头会掉在地上，砍完记得 pickup log。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '指定树（可选），比如 evergreen、deciduoustree' },
        count: { type: 'integer', description: '砍倒几棵，默认 1' },
        radius: { type: 'integer', description: '搜索半径（格），默认 20' },
        until_gone: { type: 'boolean', description: '默认 true：一直砍倒才算数。设成 false 时 count 变成「挥几下」（一般别用）' },
        max_hits: { type: 'integer', description: '最多挥几下就放弃，默认 30' },
      },
    },
  },
  {
    name: 'mine',
    description: '挖石头/矿石（要镐）。默认要挖到这块矿被挖空才算一块，所以 count 是「挖空几块」；掉出来的石头/燧石/金块在地上，记得 pickup。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '指定矿（可选），比如 rock1、flintless_rock' },
        count: { type: 'integer', description: '挖空几块，默认 1' },
        radius: { type: 'integer', description: '搜索半径（格），默认 20' },
        until_gone: { type: 'boolean', description: '默认 true：挖空才算数。设成 false 时 count 变成「挖几下」' },
        max_hits: { type: 'integer', description: '最多挖几下就放弃，默认 30' },
      },
    },
  },
  {
    name: 'hammer',
    description: '用锤子拆掉建筑/墙/猪人房这类东西，拆下来会掉材料（掉在地上，要 pickup）。默认拆干净一个才算一个。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '指定要拆的东西（可选）' },
        count: { type: 'integer', description: '拆掉几个，默认 1' },
        radius: { type: 'integer', description: '搜索半径（格），默认 15' },
        until_gone: { type: 'boolean', description: '默认 true：拆干净才算数。设成 false 时 count 变成「敲几下」' },
        max_hits: { type: 'integer', description: '最多敲几下就放弃，默认 30' },
      },
    },
  },
  {
    name: 'dig',
    description: '用铲子挖草根、树桩、便便堆这类可以挖走的东西（要铲子）。挖出来的东西在地上，记得 pickup。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '指定要挖的东西（可选）' },
        count: { type: 'integer', description: '挖几个，默认 1' },
        radius: { type: 'integer', description: '搜索半径（格），默认 15' },
        until_gone: { type: 'boolean', description: '默认 true：挖到目标消失才算数。设成 false 时 count 变成「挖几下」' },
        max_hits: { type: 'integer', description: '最多挖几下就放弃，默认 30' },
      },
    },
  },
  {
    name: 'attack',
    description: '打附近的敌人（不填 target 就打最近的一个）。会先换上背包里伤害最高的武器；自己血少于 30% 会先吃东西。打不死会告诉你。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '指定敌人（可选），比如 spider、hound、pighouse 那种别填' },
        count: { type: 'integer', description: '最多打几下，默认 30' },
        slice: { type: 'integer', description: '自动找敌人的搜索半径（格），默认 12' },
      },
    },
  },
  {
    name: 'eat',
    description: '吃东西。不填 item 就挑背包里最划算的（补饥饿多、还新鲜）。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '指定吃的东西（可选），比如 berries、carrot、cookedmeat' },
      },
    },
  },
  {
    name: 'cook',
    description: '把背包里的生食材放到附近的营火/火坑上烤。需要有烧着的火，烤好的东西记得拿走吃掉。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '指定食材（可选），不填就用背包里第一个能烤的' },
        radius: { type: 'integer', description: '找火的半径（格），默认 12' },
      },
    },
  },
  {
    name: 'craft',
    description: '做东西（在背包里造出来）。用游戏的配方名，比如 torch、campfire、axe、pickaxe、spear、cutstone。要会做（解锁过配方）且材料够。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: '配方名，比如 torch' },
        count: { type: 'integer', description: '做几个，默认 1' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'build',
    description: '把要摆放的东西放到地上（建筑、墙、箱子、科学机器这类）。不填坐标就摆在身边一格。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: '配方名，比如 campfire、firepit、sciencemachine、chest' },
        x: { type: 'integer', description: '摆在哪个格子（可选）' },
        z: { type: 'integer', description: '摆在哪个格子（可选）' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'make_fire',
    description: '在脚下生一堆营火（要 2 个木头 + 3 个干草）。天要黑了、又没火把的时候用它。已经烧着的火不会自己续，要用 add_fuel。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: '默认 campfire，也可以 firepit（要石头）' },
      },
    },
  },
  {
    name: 'add_fuel',
    description: '往附近烧着的火堆/火坑里添柴（自动挑燃料值最高的，尽量不烧吃的）。火要灭之前续上，不然天黑就没光了。返回会告诉你燃料从百分之几升到百分之几。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '指定烧什么（可选），比如 log、twigs、cutgrass' },
        radius: { type: 'integer', description: '找火的半径（格），默认 12' },
      },
    },
  },
  {
    name: 'heal',
    description: '回血：优先用治疗类物品（治疗药膏/蜘蛛腺体/蜂蜜药膏），没有再吃东西垫血。血低于 35% 就该用了，别等被打死。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '指定用什么（可选），比如 healing_salve、spidergland、cookedmeat' },
      },
    },
  },
  {
    name: 'equip',
    description: '把背包里的东西拿到手上/穿戴上（火把、斧头、武器、护甲、帽子）。火把拿在手里就会发光。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要拿的东西，比如 torch、axe、grass_armor' },
      },
      required: ['item'],
    },
  },
  {
    name: 'drop',
    description: '把背包里的东西丢在地上（背包满了、或者想留点东西给人类玩家）。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要丢的东西' },
        count: { type: 'integer', description: '丢几个（目前整摞丢）' },
      },
      required: ['item'],
    },
  },
  {
    name: 'sleep',
    description: '用帐篷/睡袋/床睡觉（跳过夜晚并回一点血，但会掉饥饿和理智）。要附近有帐篷，或者背包里有睡袋。饥荒没有别的「睡到天亮」的办法。',
    inputSchema: {
      type: 'object',
      properties: {
        radius: { type: 'integer', description: '找帐篷的半径（格），默认 20' },
      },
    },
  },
  {
    name: 'say',
    description: '在游戏聊天里说话（联机时人类玩家看得见）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话' },
      },
      required: ['text'],
    },
  },
  {
    name: 'wait',
    description: '原地等一会儿（游戏时间）。比如等锅里的东西熟、等火灭、等天亮。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '等多少秒（游戏时间），默认 3' },
      },
    },
  },
  {
    name: 'stop',
    description: '立刻停下手里正在做的事（走路、砍树、打架都停）。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const LOCAL_TOOLS = [
  {
    name: 'get_state',
    description: '看现在的游戏状态：时间、位置、生命/饥饿/理智、背包、附近能采能砍能挖的东西、敌人、火堆和危险提醒。每个动作前后都该先看这个。',
    inputSchema: { type: 'object', properties: {} },
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

/** 「干活」类动作：默认要一直干到目标消失才算一个（见下面的 until_gone 说明）。 */
const WORK_TOOLS = new Set(['chop', 'mine', 'hammer', 'dig'])

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
  if (name === 'get_state') return getState(ctx)
  if (name === 'get_guide') return getGuide(input, ctx)
  if (name === 'update_notes') return updateNotes(input, ctx)
  if (!ACTION_NAMES.has(name)) throw new Error(`没有这个工具：${name}`)

  const result = await ctx.bridge.call(name, input, { timeoutMs: ctx.actionTimeoutMs ?? 180000, signal: ctx.signal })
  return result.ok ? result.text : `失败：${result.text}`
}

function notesPrefix(ctx) {
  const notes = ctx.notes?.read?.() ?? ''
  const extra = (ctx.extraInstructions ?? '').trim()
  const parts = []
  if (notes.trim()) parts.push(`你的笔记（上次记下的，还作数）：\n${notes.trim()}\n`)
  if (extra) parts.push(`玩家的额外要求：${extra}\n`)
  return parts.length > 0 ? parts.join('\n') + '\n' : ''
}

function getState(ctx) {
  const state = ctx.bridge.readState()
  if (!state) {
    return '连不上游戏：找不到大肥鱼饿不死写的状态文件。\n'
      + '确认：1) 饥荒联机版已经通过 Steam 打开并读档进世界；2) mods 里装了大肥鱼饿不死；'
      + '3) 世界是本地主机（自己开的）。装好模组后要重新读档一次。'
  }
  const ageMs = Number.isFinite(state.ageMs)
    ? state.ageMs
    : Math.max(0, Date.now() - Number(state.mtimeMs ?? state.mtime ?? 0))
  const fresh = ageMs < 15000
  const text = state.json.text ?? '（模组没写状态）'
  const head = fresh ? '' : `（注意：这份状态是 ${Math.max(0, Math.round(ageMs / 1000))} 秒前的，游戏可能暂停了）\n`
  return notesPrefix(ctx) + head + text
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

export { ACTION_NAMES }
