// DSH 插件配置项定义、默认值读取、攻略提取、模组设置下发与提示词构建。

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AUTOPILOT_RULES,
  BUNDLED_GUIDES,
  GUIDE_TOPICS,
  RULES,
  normalizeExecutionMode,
  toolList,
} from '../tools.js'

export { AUTOPILOT_RULES, BUNDLED_GUIDES, GUIDE_TOPICS, RULES }

export const DEFAULTS = {
  port: 18090,
  gameDir: '',
  bridgeDir: '',
  actionTimeoutMinutes: 5,
  apiKey: '',
  baseUrl: 'https://token.sensenova.cn/v1',
  model: 'sensenova-6.8-flash',
  aiMaxTokens: 1024,
  freezeTime: true,
  idleSeconds: 5,
  extraInstructions: '',
  presetEnabled: false,
  gatewayEnabled: false,
  autoContinue: true,
  autoContinueMax: 3,
  presetName: '大肥鱼饿不死',
  basePreset: 'standard',
  autoInstallMod: true,
  sessionLogEnabled: true,
  sessionLogDir: '',
  mainGuide: BUNDLED_GUIDES.main ?? '',
  surviveGuide: BUNDLED_GUIDES.survive ?? '',
  fightGuide: BUNDLED_GUIDES.fight ?? '',
  cookGuide: BUNDLED_GUIDES.cook ?? '',
  executionMode: 'assisted',
}

export const GUIDE_KEYS = [
  ['mainGuide', 'main', '主攻略', 'Assisted/Manual 每次连接都会读给 AI：游戏常识、前几天怎么活下来（Autopilot 不自动注入，需要时用 get_guide 读）'],
  ['surviveGuide', 'survive', '生存', '季节、食物、光源、建家、冬天和夏天（AI 需要时用 get_guide 读）'],
  ['fightGuide', 'fight', '战斗', '怪物、Boss、走位和武器（AI 需要时读）'],
  ['cookGuide', 'cook', '烹饪', '锅的配方、食材、保质期（AI 需要时读）'],
]

/** 取 DSH 自带的包（@deepseek-ai/schemastery / dsh-tools）：直接 import，不行再去 DSH 目录里查找。 */
export async function loadHostModule(id) {
  try {
    return await import(id)
  } catch {}
  const bases = []
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  if (home && existsSync(join(home, 'profiles'))) {
    try {
      for (const profile of readdirSync(join(home, 'profiles'))) {
        bases.push(join(home, 'profiles', profile))
      }
    } catch {}
  }
  for (const start of [process.argv[1], process.execPath, process.cwd()]) {
    let dir = start ? dirname(start) : null
    for (let i = 0; dir && i < 8; i++, dir = dirname(dir)) bases.push(dir)
  }
  for (const base of bases) {
    try {
      const resolved = createRequire(join(base, 'noop.js')).resolve(id)
      return await import(pathToFileURL(resolved).href)
    } catch {}
  }
  return null
}

const schemastery = await loadHostModule('@deepseek-ai/schemastery')
export const z = schemastery ? (schemastery.default ?? schemastery) : null

/** DSH 只把标了 volatile 的设置交给配置卡片：这样卡片里改了就立刻生效，不用重启插件。 */
const volatileAll = (dict) => Object.fromEntries(Object.entries(dict)
  .map(([key, schema]) => [key, typeof schema.volatile === 'function' ? schema.volatile() : schema]))

export const Config = z
  ? z.object(volatileAll({
      port: z.number().min(1).max(65535).step(1).default(DEFAULTS.port)
        .description('插件里 MCP 服务器的端口。地址是 http://127.0.0.1:端口/mcp。改了以后重启 DSH 才生效。'),
      gameDir: z.string().default(DEFAULTS.gameDir)
        .description('《饥荒联机版》的安装目录（里面有 bin64 和 mods 的那个文件夹）。留空会自动在 Steam 库里找。'),
      bridgeDir: z.string().default(DEFAULTS.bridgeDir)
        .description('一般不用填。自动找不到游戏的状态文件时，把游戏写出来的 whale_state.json 所在目录填在这里。'),
      actionTimeoutMinutes: z.number().min(1).max(60).step(1).default(DEFAULTS.actionTimeoutMinutes)
        .description('单个动作最多等多少分钟（睡觉、走近路比较久）。超时会告诉模型先 get_state 看看。'),
      apiKey: z.string().role('textarea').default(DEFAULTS.apiKey)
        .description(
          '内置 AI 用的 API Key（游戏里按 F8 让它自己玩，不经过 DSH 会话）。留空就读环境变量 SENSENOVA_API_KEY / DEEPSEEK_API_KEY。\n'
          + '只存在你自己的 DSH 配置里，不会发到别处。',
        ),
      baseUrl: z.string().default(DEFAULTS.baseUrl)
        .description('模型接口地址（任何 OpenAI 兼容的 /chat/completions 都行）。默认 SenseNova：https://token.sensenova.cn/v1（和 DSH 里的配置一致）。'),
      model: z.string().default(DEFAULTS.model)
        .description('内置 AI 用哪个模型。要支持 function calling，默认 sensenova-6.8-flash（和 DSH 模型目录里那个一致）。'),
      aiMaxTokens: z.number().min(256).max(8192).step(64).default(DEFAULTS.aiMaxTokens)
        .description('内置 AI 每次回复最多输出多少 token。'),
      freezeTime: z.boolean().default(DEFAULTS.freezeTime)
        .description('AI 思考超时自动暂停世界（房主生效，默认开启）：等待大模型思考超过下面设定的秒数时暂停，思考结束或动作开始前立刻恢复。'),
      idleSeconds: z.number().min(1).max(120).step(1).default(DEFAULTS.idleSeconds)
        .description('AI 思考超过多少秒后自动暂停世界（默认 5 秒）。'),
      extraInstructions: z.string().role('textarea').default(DEFAULTS.extraInstructions)
        .description('给 AI 的额外要求，比如“先建好家和锅，再考虑下洞”。每次 get_state 都会看到。'),
      ...Object.fromEntries(GUIDE_KEYS.map(([field, key, label, what]) => [
        field,
        z.string().role('textarea').default(BUNDLED_GUIDES[key] ?? '')
          .description(`攻略·${label}（${what}）。改过的会给内置 AI / MCP 会话使用，优先于自带文件；清空或改回原样就用自带的那份。`),
      ])),
      presetEnabled: z.boolean().default(DEFAULTS.presetEnabled)
        .description(
          '开启后会多出一个「大肥鱼饿不死」会话预设：新建会话时选它，那个会话才连上饥荒、拿到玩游戏的工具；其他会话完全不受影响。\n'
          + '⚠ 已经聊过天的会话不能换预设（DSH 的规定），要玩请新建会话。\n'
          + '开关改了以后重启一次 DSH。',
        ),
      gatewayEnabled: z.boolean().default(DEFAULTS.gatewayEnabled)
        .description(
          '开启后所有会话（包括老会话）都会多一个工具「dst」：常驻上下文里只有它自己的简短说明，'
          + '要玩时先 action="help" 把规则和动作列表读进来。不想换预设、随时想玩就开这个。',
        ),
      autoContinue: z.boolean().default(DEFAULTS.autoContinue)
        .description('模型偶尔会把工具调用吐成一串坏掉的文字，DSH 会以为它说完了。开启后在这种会话里自动替它发一句“接着玩”。'),
      autoContinueMax: z.number().min(1).max(20).step(1).default(DEFAULTS.autoContinueMax)
        .description('连续自动续玩最多几次（中间有一次游戏动作成功就重新计数）。'),
      presetName: z.string().default(DEFAULTS.presetName)
        .description('预设显示的名字。改了以后重启 DSH。'),
      basePreset: z.string().default(DEFAULTS.basePreset)
        .description('在哪个预设的基础上加饥荒工具（默认 standard）。改了以后重启 DSH。'),
      autoInstallMod: z.boolean().default(DEFAULTS.autoInstallMod)
        .description('自动把插件里带的饥荒模组装进游戏的 mods 目录，并在 modsettings.lua 里打开它。游戏开着时会等关掉后再装。'),
      sessionLogEnabled: z.boolean().default(DEFAULTS.sessionLogEnabled)
        .description(
          '自动把会话日志写进 latestLogs/（session.txt / session.jsonl / server_log.txt）。里面逐条记下：\n'
          + '· AI 下的每个操作（CALL/DONE：动作名、参数、成功失败、耗时、返回原文，含 get_state 这类只读动作）\n'
          + '· 游戏状态（STATE：第几天、时段、血/饿/理智、位置、背包、手持）\n'
          + '· 角色周边环境（ENV：威胁/可拾取/可收获等附近物件，换帧时记一次）\n'
          + '· 模组保命反射与死亡、Lua 报错等游戏日志（REFLEX/DEATH/LOG）\n'
          + 'session.jsonl 是结构化版本，排查问题时按时间线对着看最方便。\n'
          + '每次插件启动或新会话开始都**覆盖写**，只保留最新一次的记录，不累积历史。',
        ),
      sessionLogDir: z.string().default(DEFAULTS.sessionLogDir)
        .description('日志目录。留空就用插件目录下的 latestLogs/。也可填绝对路径（例如把日志放到仓库里方便分析）。'),
      executionMode: z.string().default(DEFAULTS.executionMode)
        .description('运行模式：assisted（默认，混合模式：优先调用 run_skill / gather_area 批量推进，卡住或救急再用原子动作手动脱困）、autopilot（持续自主；模型只制定高层目标，用 advance_task 推进任务，原子动作由系统内部安全执行）、manual（单次指令驱动，模型用完整原子动作）。Autopilot 不向模型暴露原子动作；Assisted/Manual 暴露完整工具集。'),
    }))
  : undefined

const read = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

/** 这一刻的全部设置（活引用取当前值，没设置的用默认值）。 */
export function currentConfig(config) {
  const entries = Object.entries(config ?? {}).map(([key, value]) => [key, read(value)]).filter(([, value]) => value !== undefined)
  const merged = { ...DEFAULTS, ...Object.fromEntries(entries) }
  merged.executionMode = normalizeExecutionMode(merged.executionMode)
  return merged
}

/** F8 与 DSH 共用的工具表解析：永远以当前真实配置的 executionMode 为准。 */
export function toolsForExecutionMode(config) {
  return toolList(currentConfig(config).executionMode ?? 'autopilot')
}

/** 现在给模型看的攻略（插件里改过的优先）。 */
export function guidesOf(config) {
  const c = currentConfig(config)
  const out = {}
  for (const [field, key] of GUIDE_KEYS) {
    const custom = String(c[field] ?? '').trim()
    out[key] = custom && custom !== String(BUNDLED_GUIDES[key] ?? '').trim() ? custom : BUNDLED_GUIDES[key] ?? ''
  }
  return out
}

/** 推给模组的设置（模组读 whale_settings.json）。 */
export function modSettingsOf(config) {
  const c = currentConfig(config)
  return {
    pause: false,
    verbose: false,
    interval: 1,
    freezeTime: c.freezeTime === true,
    generatedBy: 'dsh-dont-starve-blind-whale-survivor',
    extra: String(c.extraInstructions ?? '').slice(0, 2000),
  }
}

/**
 * 连接时发给模型的说明：按 executionMode 选不同的动作手册。
 * - Assisted / Manual：完整原子动作手册（RULES），模型自己用 move_to / harvest / craft / attack 推进。
 * - Autopilot：高层任务驱动手册（AUTOPILOT_RULES），模型只用 advance_task 等高层工具，真正干活由系统内部执行链完成。
 */
export function buildInstructions(guides, mode = 'assisted') {
  const norm = normalizeExecutionMode(mode)
  const main = String(guides?.main ?? '').trim()
  const marker = '## 通过 MCP 玩的额外说明'
  const base = norm === 'autopilot' ? AUTOPILOT_RULES : RULES
  const at = base.indexOf(marker)
  const head = at >= 0 ? base.slice(0, at) : base
  const tail = at >= 0 ? base.slice(at) : ''
  const modeTail = ({
    autopilot: '## 运行模式：持续自主（Autopilot）\n你只负责**制定和监督高层目标**：开局 get_state 看一次，然后用 advance_task 反复推进任务看板，读回执决定下一步；原子动作由系统内部安全执行，你不需要也不能直接调用。生存危险（挨饿/天黑/低血/被袭）先自保，想停就调用 stop。',
    assisted: '## 运行模式：混合推进（Assisted：复合技能优先 + 原子动作救场）\n围绕用户目标或「任务看板」，**常规多步流程优先调用 `run_skill`（建议 `max_steps: 6~8`）或 `gather_area` / `advance_task` 批量推进**，减少逐个调用原子动作的耗时与 token 消耗；遇到技能 `blocked` / 失败、需要 `seek` 换区、战斗走位或精细救急时，直接用原子动作手动脱困（可同轮连发多步），解困后再交回技能继续推进。目标达成就停，等待下一次要求。',
    manual: '## 运行模式：手动（Manual）\n只执行用户当下这一条指令；完成即停，等用户下一条。不要自行连续推进长期目标。',
  })[norm]
  if (norm === 'autopilot') {
    return [head.trimEnd(), '', modeTail, '', tail].join('\n')
  }
  return [head.trimEnd(), '', '## 游戏常识', '', main || '（玩家把主攻略清空了）', '', modeTail, '', tail].join('\n')
}
