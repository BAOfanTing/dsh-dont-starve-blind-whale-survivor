// 工具定义：MCP tools 的 name / description / inputSchema。
// 从 tools.js 抽出（纯数据搬移，行为不变）。ACTION_TOOLS 的 enum 用 target-kinds；
// build/craft 的枚举用配方表；run_skill 用 skills 的 skillIds。
import { kindsFor } from './target-kinds.js'
import { CRAFTABLE_RECIPES, BUILDABLE_RECIPES } from './specs/crafting.js'
import { skillIds } from '../skills/index.js'

export const ACTION_TOOLS = [
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
      + '  goldnugget（金块）、charcoal（木炭）、petals（花瓣）、abigail_flower（阿比盖尔之花）。\n'
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
          description: '要捡哪一类（固定枚举）：flint / twigs / cutgrass / log / rocks / goldnugget / charcoal / petals / abigail_flower',
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
    },
  },
  {
    name: 'fight_spider',
    description:
      '战术风筝战斗（蜘蛛/野狗）：自动执行打二撤一风筝策略，战斗结束后自动拾取战利品（蜘蛛丝/腺体/狗牙/怪物肉/宝石）。\n'
      + '比普通 kill 更安全，自带反击判定和风筝逻辑。\n'
      + '只能用 #N 引用 + Nearby 快照 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近·威胁/生物」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
      },
      required: [],
    },
  },
  {
    name: 'summon_companion',
    description:
      '召唤角色的专属伴生生物（例如温蒂使用背包里的阿比盖尔之花召唤阿比盖尔）。\n'
      + '不需要参数；背包中必须持有阿比盖尔之花，且阿比盖尔当前未在场。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
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
      required: [],
    },
  },
  {
    name: 'use',
    description:
      '对目标做一次**交互**。可选动作（都是游戏里真实存在的）：\n'
      + '  ACTIVATE（通用激活：科学机器、帐篷、探测仪）、ACTIVATE_CONTAINER（开箱子/冰箱）、\n'
      + '  RUMMAGE（翻找）、TAKEITEM（取出）、READ（读书）、PICKUP（捡起）、OPEN_CRAFTING（打开制作台）、\n'
      + '  LIGHT（点火/点燃：用手里或背包里的火把/打火机点燃树木等可燃物）。\n'
      + '要用 #N 引用（或 target_handle）+ Nearby 快照 ID。不填 action 就自动挑一个能用的。\n'
      + '这是通用交互入口 —— 箱子、科学机器、帐篷、书、天体探测仪、点火烧树都靠它。\n'
      + '\n'
      + '⚠ **点火取木炭的正确节奏（别一棵接一棵点）**：火会自己向周围的树蔓延，一棵点着之后\n'
      + '  旁边会连片烧成焦树、各自掉 `charcoal`。所以：\n'
      + '  ① 点 1 棵 → 等它烧完（约 45 秒，期间用 wait 等，别急着点第二棵）；\n'
      + '  ② 把这一片掉出来的木炭用 `pickup_nearest {"target_kind":"charcoal"}` 全捡了；\n'
      + '  ③ 还不够才去点下一棵。\n'
      + '  已烧焦的树**不要 chop**（它的 workable 已被移除，会报 target_not_workable）——\n'
      + '  木炭是烧完自动掉在地上的，直接捡。\n'
      + '  另外点火后角色会自动撤到 6 格外（防止被蔓延的火烧死），捡炭前要先 move_to 走回火点。',
    inputSchema: {
      type: 'object',
      properties: {
        target_ref: { type: 'string', description: '「附近」里的引用，形如 #3' },
        snapshot_id: { type: 'string', description: '「附近」段开头那个 Nearby 快照 ID' },
        action: { type: 'string', description: '可选：ACTIVATE / ACTIVATE_CONTAINER / RUMMAGE / TAKEITEM / READ / PICKUP / OPEN_CRAFTING / LIGHT' },
      },
      required: [],
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
      required: [],
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
      required: [],
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
      required: ['item'],
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
      required: ['item'],
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
      required: [],
    },
  },
  {
    name: 'build',
    description:
      '在地上**造一个建筑**。只能造这几个（材料够、科技够才行）：\n'
      + '  campfire（营火，2 木头 + 3 草）— 天黑没火会死，这是最要紧的\n'
      + '  firepit（石头火坑，12 石头 + 2 木头）— 不会灭，但要材料多\n'
      + '  chest（箱子，3 木板）— 存东西\n'
      + '  cookpot（锅，3 石砖 + 6 木炭 + 6 树枝）— 要科学机器\n'
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
      '制作基础工具、装备或第一/二阶段科技材料。开放配方：\n'
      + '  · torch     = 2 cutgrass + 2 twigs（火把）\n'
      + '  · axe       = 1 twigs + 1 flint（斧头）\n'
      + '  · pickaxe   = 2 twigs + 2 flint（镐）\n'
      + '  · flowerhat = 12 petals（花环，戴头上持续恢复理智）\n'
      + '  —— 以上 4 个不需要科技，随时能做。\n'
      + '  · shovel    = 2 twigs + 2 flint（铲子）\n'
      + '  · rope      = 3 cutgrass（绳子）\n'
      + '  · boards    = 4 log（木板）\n'
      + '  · backpack  = 4 cutgrass + 4 twigs（背包，多 8 格）\n'
      + '  · spear     = 2 twigs + 1 rope + 1 flint（长矛）\n'
      + '  · armorwood = 8 log + 2 rope（木甲，减伤）\n'
      + '  · cutstone  = 3 rocks（石砖）\n'
      + '  · transistor = 2 goldnugget + 1 cutstone（电子元件）\n'
      + '  —— 以上 8 个是**第一阶段科技**：要先 build sciencemachine，然后**站到它旁边**再做；\n'
      + '     离得远会返回 recipe_locked（这不是 bug，走回去再试）。\n'
      + '  · goldenaxe     = 4 twigs + 2 goldnugget（黄金斧头）\n'
      + '  · goldenpickaxe = 4 twigs + 2 goldnugget（黄金镐）\n'
      + '  · goldenshovel  = 4 twigs + 2 goldnugget（黄金铲）\n'
      + '  —— 以上 3 个是**第二阶段科技**：要站在炼金引擎（researchlab2）旁边做。\n'
      + '材料不够会返回 ingredients_missing 并告诉你还差几个（材料数字读自游戏原版配方表）。\n'
      + 'cutstone + transistor + boards 是炼金引擎（build researchlab2）的材料；\n'
      + '炼金引擎是帐篷（build tent，还要 silk×6 + twigs×4 + rope×3）的前置。\n'
      + '只能做背包里的成品，不会摆建筑（营火/火坑/科学机器/炼金引擎/帐篷用 build）。\n'
      + '成功以成品真的进了背包或自动穿戴为准。',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', enum: CRAFTABLE_RECIPES, description: '要做的东西：torch / axe / pickaxe / flowerhat（无需科技），shovel / rope / boards / backpack / spear / armorwood / cutstone / transistor（科学机器），或 goldenaxe / goldenpickaxe / goldenshovel（炼金引擎）' },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'equip',
    description:
      '装备背包里的工具、防具或光源：torch（火把）、axe（斧头）、pickaxe（镐）、shovel（铲子）、goldenaxe（黄金斧头）、goldenpickaxe（黄金镐）、goldenshovel（黄金铲）、flowerhat（花环，头部）、lantern（提灯）、minerhat（矿工帽，头部）、spear（长矛）。\n'
      + '只能装备**背包里已经有**的东西，没有会返回 not_in_inventory。\n'
      + '原来同部位的东西会自动收回背包。\n'
      + '成功以装备栏真的变成它为准。',
    inputSchema: {
      type: 'object',
      properties: {
        item: {
          type: 'string',
          enum: [
            'torch', 'axe', 'pickaxe', 'shovel', 'goldenaxe', 'goldenpickaxe', 'goldenshovel',
            'lantern', 'minerhat', 'flowerhat', 'spear',
          ],
          description: '要装备的工具、防具或光源：torch / axe / pickaxe / shovel / goldenaxe / goldenpickaxe / goldenshovel / lantern / minerhat / flowerhat / spear',
        },
      },
      required: ['item'],
    },
  },
]

export const LOCAL_TOOLS = [
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
      + '  · survival_stabilize（稳定生存：有光、吃饱、回血、野狗防御、基础工具）\n'
      + '  · establish_home（建立家园：勘察→选址→前往→收料→建科学机器→设家）\n'
      + '  · gather_resources（按缺口收集材料，含中间产物依赖）\n'
      + '  · craft_or_build（按配方补齐材料并制作/建造目标）\n'
      + '  · food_production（食物生产闭环：急救进食→取锅→备料→下锅→维持储备）\n'
      + '技能内部动作仍走唯一 dispatcher（会占用控制权、遵守动作互斥）；紧急危险时 Lua Reflex 可抢占。\n'
      + '非生存技能遇到 P0/P1 生存紧急会自动暂停并把控制权交回生存（先 run survival_stabilize）。',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', enum: skillIds(), description: '要执行的技能 id（survival_stabilize / establish_home / gather_resources / craft_or_build / food_production）' },
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
