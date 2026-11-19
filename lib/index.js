// dsh-dont-starve-blind-whale-survivor：在 DSH 里让 AI 玩《饥荒联机版》
//
// 三块东西：
//   1. 插件设置（这个文件的 Config）：端口、游戏目录、额外要求、攻略、会话预设……
//   2. 本机 MCP 服务器（lib/mcp-server.js）：把 20 多个动作暴露成 MCP 工具，
//      DSH 的会话预设或入口工具连上来玩，别的 MCP 客户端（WorkBuddy / Claude Code）也能连。
//   3. 文件桥（lib/bridge.js）：MCP 服务器 ←→ 游戏里的 Lua 模组（饥荒模组不能开端口，只能这么通）。
//
// 另外：自动把仓库里的 Lua 模组装进游戏的 mods 目录，并在 modsettings.lua 里打开它。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMod } from './mod-install.js'
import { GameBridge } from './bridge.js'
import { createMcpServer } from './mcp-server.js'
import { ACTION_NAMES, BUNDLED_GUIDES, GUIDE_TOPICS, MACRO_NAMES, RULES, executeTool, readSnapshot, toolList } from './tools.js'
import { AiRunner } from './agent.js'
import { LeaseManager, defaultLeaseFile, envFingerprintOf } from './control.js'
import { SessionLog } from './session-log.js'
import { createNotesStore } from './notes-store.js'
import { createPlanner } from './planner/planner-core.js'

export const name = 'dsh-dont-starve-blind-whale-survivor'

const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  port: 18090,
  gameDir: '',
  bridgeDir: '',
  actionTimeoutMinutes: 5,
  apiKey: '',
  baseUrl: 'https://token.sensenova.cn/v1',
  model: 'sensenova-6.8-flash',
  aiMaxTokens: 1024,
  freezeTime: false,
  idleSeconds: 8,
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
}

/** 会话预设的 id。 */
export const PRESET_ID = 'dsh-dont-starve-blind-whale-survivor'
/** 入口工具的名字。 */
export const GATEWAY_TOOL = 'dst'
/** 预设里连游戏的 MCP 服务器名。 */
export const MCP_SERVER_NAME = 'dst'

const GUIDE_KEYS = [
  ['mainGuide', 'main', '主攻略', '每次连接都会读给 AI：游戏常识、前几天怎么活下来'],
  ['surviveGuide', 'survive', '生存', '季节、食物、光源、建家、冬天和夏天（AI 需要时用 get_guide 读）'],
  ['fightGuide', 'fight', '战斗', '怪物、Boss、走位和武器（AI 需要时读）'],
  ['cookGuide', 'cook', '烹饪', '锅的配方、食材、保质期（AI 需要时读）'],
]

/** 取 DSH 自带的包（@deepseek-ai/schemastery）：直接 import，不行再去 DSH 目录里翻。找不到也不让插件挂掉。 */
async function loadHostModule(id) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  try {
    return await import(id)
  } catch {}
  const bases = []
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  if (home && existsSync(join(home, 'profiles'))) {
    try {
      for (const profile of (await import('node:fs')).readdirSync(join(home, 'profiles'))) {
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
const z = schemastery ? (schemastery.default ?? schemastery) : null
const dshTools = await loadHostModule('@deepseek-ai/dsh-tools')
const defineTool = dshTools?.defineTool ?? ((definition) => definition)

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
        .description('AI 思考时暂停世界（需要同时开启"思考时暂停世界"模组选项）。'),
      idleSeconds: z.number().min(2).max(120).step(1).default(DEFAULTS.idleSeconds)
        .description('AI 思考时暂停世界前等待的空闲秒数。'),
      extraInstructions: z.string().role('textarea').default(DEFAULTS.extraInstructions)
        .description('给 AI 的额外要求，比如“先建好家和锅，再考虑下洞”。每次 get_state 都会看到。'),
      ...Object.fromEntries(GUIDE_KEYS.map(([field, key, label, what]) => [
        field,
        z.string().role('textarea').default(BUNDLED_GUIDES[key] ?? '')
          .description(`攻略·${label}（${what}）。改过的会推给游戏里的 AI，优先于文件；清空或改回原样就用模组自带的那份。`),
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
    }))
  : undefined

const read = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

/** 这一刻的全部设置（活引用取当前值，没设置的用默认值）。 */
export function currentConfig(config) {
  const entries = Object.entries(config ?? {}).map(([key, value]) => [key, read(value)]).filter(([, value]) => value !== undefined)
  return { ...DEFAULTS, ...Object.fromEntries(entries) }
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
function modSettingsOf(config) {
  const c = currentConfig(config)
  return {
    pause: false, // 由上下文单独控制
    verbose: false,
    interval: 1,
    freezeTime: c.freezeTime === true,
    generatedBy: 'dsh-dont-starve-blind-whale-survivor',
    extra: String(c.extraInstructions ?? '').slice(0, 2000),
  }
}

// TARGET-REFRESH：长期笔记按**世界**分开存（旧世界的基地坐标不会带进新世界）。
// 之前这里是两个直接读写 notes.md 的小函数；现在统一走 lib/notes-store.js，
// 由它负责"哪个世界读哪个文件"以及 world_key 缺失时的向后兼容。
const notesStore = createNotesStore()
const readNotes = (worldKey) => notesStore.read(worldKey).content
const writeNotes = (text, worldKey) => notesStore.write(text, worldKey)

// 层级规划：长期阶段 / 任务看板 / 家园记忆（按世界隔离，落盘到 planner-memory/）。
// F8 与 MCP 都通过 runTool 的 ctx 拿到它；get_state 追加「发展阶段/任务看板」，build 前做家园门槛。
const planner = createPlanner()

/** 连接时发给模型的说明：规则 + 主攻略。 */
export function buildInstructions(guides) {
  const marker = '## 通过 MCP 玩的额外说明'
  const at = RULES.indexOf(marker)
  const head = at >= 0 ? RULES.slice(0, at) : RULES
  const tail = at >= 0 ? RULES.slice(at) : ''
  const main = String(guides?.main ?? '').trim()
  return [
    head.trimEnd(),
    '',
    '## 游戏常识',
    '',
    main || '（玩家把主攻略清空了）',
    '',
    tail,
  ].join('\n')
}

export function apply(ctx, config) {
  const log = (level, msg) => {
    try {
      ctx.logger?.(level, '[dsh-dont-starve-blind-whale-survivor] ' + msg)
    } catch {}
  }
  if (!z) log('warn', '找不到 @deepseek-ai/schemastery，插件页的配置卡片读不到设置；插件按默认设置工作')

  const bridge = new GameBridge({ log, pollMs: 150 })
  let lastSettingsHash = ''
  let inFlight = 0
  let lastCallAt = Date.now()
  let paused = false

  /**
   * 确保世界**没有**被我们冻住。
   * ★ TARGET-REFRESH：这里原来还会 `setPause(true)`（AI 思考时暂停世界）。
   *   那条路已经删掉 —— 自动暂停会让刚下发的动作永远等不到游戏 tick，
   *   最后变成 result_timeout（真机：chop_nearest 120 秒超时 + 日志里的 Server Autopaused）。
   *   现在这个函数只做"解除残留暂停"这一件事：玩家自己按 ESC 暂停，我们不插手。
   */
  const setPause = (want) => {
    if (paused === want) return
    paused = want
    bridge.setPause(want)
  }

  // M2.0：F8 与 MCP 共享同一个控制权租约（落盘，多进程也看得见）
  // M2.0.2：owner 实例身份（进程内稳定；MCP 是服务实例级，不是连接级——见已知限制）
  const INSTANCES = { f8_agent: randomUUID(), mcp_client: randomUUID(), manual_test: randomUUID(), system: randomUUID() }
  const control = new LeaseManager({
    file: defaultLeaseFile(join(HERE, '..')),
    authorityDirs: () => (bridge.leaseDirs ? bridge.leaseDirs() : []),
  })
  bridge.getAuthority = () => control?.readAuthority?.() ?? null

  // 计划层：F8 和 MCP 共用同一份"当前目标"。
  // get_state 推导一次就放在这里；目标仍然成立时不会因为换了调用方而重新规划。
  let sharedPlan = null

  // 会话日志（latestLogs/）。在下面的 ctx.effect 里创建 —— runTool 定义在它之前，
  // 所以用这个可变的引用：null 表示日志没开（设置里关掉 / 启动失败），runTool 会跳过记录。
  let sessionLog = null
  let currentDshStep = null

  /**
   * 记一次「还没走到 executeTool 就被挡下」的操作（控制权没抢到、F8 正在玩）。
   * 不记的话日志里会出现空洞，排查时分不清是模型没调、还是被拒了。
   */
  const logBlockedTool = (toolName, args, owner, reason, text, step = null) => {
    const seq = sessionLog?.beginTool({ tool: toolName, args, by: owner, step })
    sessionLog?.endTool({ seq, tool: toolName, by: owner, ok: false, status: 'rejected', reason, ms: 0, text, step })
  }

  /** 用当前快照算环境指纹（runtime/session/shard/actor） */
  const leaseEnv = () => envFingerprintOf(readSnapshot({ bridge }))

  /**
   * runTool: 真正执行一个工具（MCP 和内置 AI 都走这里）。
   * step: 可选关联的 AI 决策步数，留痕到 session 日志里。
   */
  const runTool = async (toolName, args, { internal = false, owner = 'system', ownerInstanceId, withOutcome = false, step = null } = {}) => {
    if (!internal && runner.running && ACTION_NAMES.has(toolName)) {
      const blocked = '内置 AI 正在自己玩（游戏里按 F8 停掉它），停掉以后再用 DSH 玩'
      logBlockedTool(toolName, args, owner, 'f8_agent_running', blocked)
      return blocked
    }
    // 每一次 AI 操作都在这里留痕（call + 结果）：MCP 会话、F8 内置 AI、dst 入口工具都走这条路。
    // 写盘失败由 session-log 内部吞掉（只往 stderr 打一行），绝不会影响玩游戏。
    const seq = sessionLog?.beginTool({ tool: toolName, args, by: owner, internal, step }) ?? null
    const startedAt = Date.now()
    inFlight++
    lastCallAt = Date.now()
    
    // 动作执行前必须先确保世界解冻（如果世界处于暂停状态，服务端的动作将无法 tick 执行）
    setPause(false)
    
    void leaseEnv() // 顺手刷新一次（只读）
    try {
      const ctx = {
        bridge,
        control,
        owner,
        ownerInstanceId: ownerInstanceId ?? INSTANCES[owner] ?? INSTANCES.system,
        notes: { read: readNotes, write: writeNotes },
        guides: guidesOf(config),
        extraInstructions: currentConfig(config).extraInstructions,
        actionTimeoutMs: Number(currentConfig(config).actionTimeoutMinutes) * 60 * 1000,
        planner,
        log,
        lastPlan: sharedPlan,
        setPlan: (plan) => { sharedPlan = plan },
      }
      const text = await executeTool(toolName, args, ctx)
      // 动作类工具在 ctx.lastOutcome 上留了结构化结果（status= succeeded/rejected/...），
      // 比解析中文回执可靠；get_state 之类只读工具没有 outcome，按文本判断。
      const outcome = ctx.lastOutcome ?? null
      sessionLog?.endTool({
        seq,
        step,
        tool: toolName,
        by: owner,
        ms: Date.now() - startedAt,
        status: outcome?.status ?? null,
        reason: outcome?.reason ?? null,
        ok: outcome ? outcome.status === 'succeeded' : !/^失败[:：]/.test(String(text ?? '')),
        text,
      })
      if (!withOutcome) return text
      return { text, outcome }
    } catch (error) {
      sessionLog?.endTool({
        seq, step, tool: toolName, by: owner,
        ok: false, status: 'threw', reason: String(error?.message ?? error),
        ms: Date.now() - startedAt,
        text: '抛错：' + String(error?.stack ?? error),
      })
      throw error
    } finally {
      inFlight--
      lastCallAt = Date.now()
    }
  }

  const runner = new AiRunner({
    log,
    bridge,
    sessionLog: () => sessionLog,
    settings: () => {
      const c = currentConfig(config)
      return {
        apiKey: String(c.apiKey || process.env.SENSENOVA_API_KEY || process.env.DEEPSEEK_API_KEY || ''),
        baseUrl: c.baseUrl,
        model: c.model,
        maxTokens: c.aiMaxTokens,
      }
    },
    instructions: () => buildInstructions(guidesOf(config)),
    toolList,
    callTool: async (toolName, args, extra = {}) => {
      // F8 的动作：先确保租约在手上（续租；被别人抢走就返回控制权错误）
      // M2.2.2/P2：交接窗口（revoking → ACK → active）只有一两百毫秒，用有限等待跨过去，
      // 别把这段正常交接当成失败浪费掉模型的工具调用。等待期间的安全条件一条没放宽。
      if (ACTION_NAMES.has(toolName) || MACRO_NAMES.has(toolName)) {
        const acq = await control.acquireWithWait('f8_agent', leaseEnv(), {
          ownerInstanceId: INSTANCES.f8_agent,
          readAck: () => (bridge.readLeaseAck ? bridge.readLeaseAck() : null),
          // 游戏暂停时不白等：直接说"暂停了"，别报 handover_pending 让人误会成控制权问题
          isGameAlive: () => { const s = readSnapshot({ bridge }); return !(s && s.stale) },
        })
        if (acq.waitedMs > 0) log('info', `控制权交接等待 ${acq.waitedMs}ms（${acq.attempts} 次尝试）`)
        if (!acq.ok) {
          // 这条路径不经过 runTool，得自己记一条，否则「F8 想动但控制权不在手上」在日志里看不见
          const denied = `失败：控制权不在手上（${acq.reason}）（control_denied）`
          logBlockedTool(toolName, args, 'f8_agent', acq.reason ?? 'control_denied', denied)
          return denied
        }
      }
      return runTool(toolName, args, {
        internal: true,
        owner: 'f8_agent',
        ownerInstanceId: INSTANCES.f8_agent,
        withOutcome: true,
        step: extra?.step ?? null,
      })
    },
    onStatus: () => publishHud(),
  })

  /** 把现在的情况写到游戏里的小窗。 */
  const publishHud = () => {
    try {
      const c = currentConfig(config)
      const status = runner.status()
      const game = bridge.status()
      const lines = []
      if (!game.connected) lines.push('游戏没连上（模组没装好 / 还没进世界）')
      if (status.error) lines.push(status.error)
      if (status.running) {
        lines.push(status.action ? `正在做：${status.action}` : '思考中…')
      } else {
        const hasKey = Boolean(c.apiKey || process.env.SENSENOVA_API_KEY || process.env.DEEPSEEK_API_KEY)
        lines.push(hasKey ? 'F8 让它自己玩' : '没配 API Key（插件设置里填）')
      }
      if (status.result && !status.running) lines.push(`上次：${status.result}`)
      else if (status.result) lines.push(`结果：${status.result}`)
      lines.push('F8 开/停 · F7 显示/隐藏小窗')
      bridge.writeHud({ v: 1, ai: status.running, step: status.step, lines })
    } catch {}
  }

  const server = createMcpServer({
    log,
    bridge,
    settings: () => {
      const c = currentConfig(config)
      return {
        port: c.port,
        gameDir: c.gameDir,
        actionTimeoutMinutes: c.actionTimeoutMinutes,
        freezeTime: c.freezeTime,
        idleSeconds: c.idleSeconds,
        extraInstructions: c.extraInstructions,
      }
    },
    toolList,
    instructions: () => buildInstructions(guidesOf(config)),
    executeTool: async (toolName, args) => {
      // MCP 客户端每次动作前抢租约：F8 正在玩时会拿到 lease_held → dispatcher 报 control_denied
      // M2.2.2/P2：交接窗口用有限等待跨过去（acquireWithWait 内部每轮都重新校验，
      // 并且会持续尝试用 Lua 的 ACK 收尾；超时只返回真实原因，绝不自动放行）。
      const acq = await control.acquireWithWait('mcp_client', leaseEnv(), {
        ownerInstanceId: INSTANCES.mcp_client,
        readAck: () => (bridge.readLeaseAck ? bridge.readLeaseAck() : null),
        isGameAlive: () => { const s = readSnapshot({ bridge }); return !(s && s.stale) },
      })
      if (acq.waitedMs > 0) log('info', `控制权交接等待 ${acq.waitedMs}ms（${acq.attempts} 次尝试）`)
      try {
        return await runTool(toolName, args, {
          owner: 'mcp_client',
          ownerInstanceId: INSTANCES.mcp_client,
          step: currentDshStep,
        })
      } finally {
        // 换手中（revoking）不能释放——释放会把待确认的租约作废
        if (acq.ok && !acq.handover) control.release('mcp_client', { ownerInstanceId: INSTANCES.mcp_client })
      }
    },
  })

  server.setSettingsHandler((next) => {
    // 外部（测试 / 别的工具）通过 POST /settings 改设置：这里只记日志，真设置还是 DSH 那边管
    log('info', '收到外部设置：' + createHash('sha256').update(JSON.stringify(next)).digest('hex').slice(0, 8))
  })

  // ── 启动 MCP 服务器（端口被占就等一会儿再试）──
  ctx.effect(() => {
    let disposed = false
    let tries = 0
    const attempt = async () => {
      if (disposed) return
      const port = Number(currentConfig(config).port)
      try {
        await server.start(port)
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          if (++tries <= 20) {
            log('warn', `端口 ${port} 被占了，10 秒后再试（可能另一个 DSH 已经在跑）`)
            setTimeout(attempt, 10000)
          } else {
            log('error', `端口 ${port} 一直被占用，AI 连不上游戏；改一下插件设置里的端口`)
          }
          return
        }
        log('error', 'MCP 服务器起不来：' + String(error?.message ?? error))
      }
    }
    attempt()
    return () => {
      disposed = true
      server.stop().catch(() => {})
    }
  })

  // ── 把设置推给游戏（改了十几秒内生效；游戏没开就安静等着）──
  ctx.effect(() => {
    const sync = () => {
      const settings = modSettingsOf(config)
      const hash = createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16)
      const game = currentConfig(config)
      const wanted = { ...settings, gameDir: game.gameDir, bridgeDir: game.bridgeDir }
      if (hash === lastSettingsHash) return
      lastSettingsHash = hash
      try {
        bridge.gameDir = game.gameDir
        bridge.bridgeDir = game.bridgeDir
        const wrote = bridge.pushSettings(wanted)
        if (wrote > 0) log('info', `设置已推送到游戏（${wrote} 个目录）`)
      } catch (error) {
        log('warn', '推设置失败：' + String(error?.message ?? error))
      }
    }
    sync()
    const timer = setInterval(sync, 15000)
    return () => clearInterval(timer)
  })

  // ── 确保世界不被冻住（已整体移除自动暂停功能，保证后台与运行流畅） ──
  ctx.effect(() => {
    setPause(false)
  })

  // ── 游戏里的快捷键：F8 让内置 AI 开始/停下；F7 只在客户端开关小窗，不写这个开关 ──
  ctx.effect(() => {
    let lastKey = ''
    const timer = setInterval(() => {
      let toggle
      try {
        toggle = bridge.readToggle()
      } catch {
        return
      }
      if (!toggle) return
      const key = `${toggle.ai === true}|${toggle.stop === true}|${toggle.ts ?? ''}`
      if (key === lastKey) return
      lastKey = key
      if (toggle.stop === true) {
        // 兼容旧的 stop 开关（其它客户端/脚本仍可能写 stop）：当作人工接管处理
        if (runner.running) runner.stop('收到停止开关')
        // M2.0：stop = 人工接管。force 换代，旧世代的命令立刻失效
        const takeover = control.acquire('manual_test', leaseEnv(), { force: true, ownerInstanceId: INSTANCES.manual_test })
        if (takeover.ok) {
          bridge.call('stop', {}, { timeoutMs: 10000 }).catch(() => {})
          log('info', `已人工接管（generation=${takeover.lease.generation}）`)
        }
      }
      if (toggle.ai === true && !runner.running) {
        const acq = control.acquire('f8_agent', leaseEnv(), { ownerInstanceId: INSTANCES.f8_agent })
        if (acq.ok) {
          if (acq.handover) control.completeHandover(bridge.readLeaseAck ? bridge.readLeaseAck() : null)
          runner.start()
        } else log('warn', `F8 没拿到控制权（${acq.reason}）`)
      } else if (toggle.ai === false && runner.running) {
        runner.stop('按 F8 停下了')
        control.release('f8_agent', { ownerInstanceId: INSTANCES.f8_agent })
      }
      publishHud()
    }, 500)
    return () => clearInterval(timer)
  })

  // ── 往游戏里的小窗推状态（每秒一次） ──
  ctx.effect(() => {
    publishHud()
    const timer = setInterval(publishHud, 1000)
    return () => {
      clearInterval(timer)
      try {
        runner.stop('DSH 插件停掉了')
        bridge.writeHud({ v: 1, ai: false, lines: ['大肥鱼：DSH 插件关掉了'] })
      } catch {}
    }
  })

  // ── 自动装模组 ──
  let lastInstall = ''
  const install = () => {
    const c = currentConfig(config)
    if (!c.autoInstallMod) return
    let result
    try {
      result = installMod({ gameDir: c.gameDir })
    } catch (error) {
      result = { state: 'error', message: String(error?.message ?? error) }
    }
    if (result.message === lastInstall) return
    lastInstall = result.message
    log(result.state === 'installed' || result.state === 'current' ? 'info' : 'warn', result.message)
  }
  ctx.effect(() => {
    install()
    const timer = setInterval(install, 60 * 1000)
    return () => clearInterval(timer)
  })

  // ── 内置会话日志（自动覆盖写）──
  // 每次插件启动、或检测到新的 DSH 会话开始玩 dst 时，把 latestLogs/ 清空重写，
  // 保证目录里永远只有「最新一次」的操作日志和游戏记录，而不是无限累积的历史。
  ctx.effect(() => {
    const c = currentConfig(config)
    if (c.sessionLogEnabled === false) return
    const configured = String(c.sessionLogDir || '').trim()
    const outDir = configured
      ? (isAbsolute(configured) ? configured : resolve(join(HERE, '..'), configured))
      : join(HERE, '..', 'latestLogs')
    // 局部变量不与外层同名，避免把 runTool 要用的那个引用遮蔽掉
    const instance = new SessionLog({
      outDir,
      bridge,
      log,
      intervalMs: 500,
      stateEveryMs: 5000,
      envEveryMs: 1000,
      sourceEveryMs: 5000,
      explicit: c.bridgeDir ? { bridgeDir: c.bridgeDir } : {},
    })
    try {
      instance.start()
      log('info', `会话日志已开启（覆盖写）：${outDir}`)
    } catch (error) {
      log('warn', '会话日志启动失败：' + String(error?.message ?? error))
      return
    }
    // 从这里开始，runTool 记的每条操作都会落到这个实例上
    sessionLog = instance
    // 新的 DSH 会话开始玩 dst = 新的一局，覆盖写重置；同时提取 DSH 模型的思考与回复留痕
    const seenSessions = new Set()
    const dshSessions = new Map()
    const getDshState = (id) => {
      let s = dshSessions.get(id)
      if (!s) dshSessions.set(id, (s = { step: 0, isDst: false, pendingThought: null, turnLogged: false, lastMsgSig: '' }))
      return s
    }

    let off = null
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        const id = session?.id
        if (!id || !event) return
        const sess = getDshState(id)
        if (session?.presetId === PRESET_ID || session?.definition?.id === PRESET_ID) {
          sess.isDst = true
        }

        switch (event.type) {
          case 'turn/start': {
            sess.pendingThought = null
            sess.turnLogged = false
            sess.lastMsgSig = ''
            if (sess.isDst) {
              sess.step += 1
              currentDshStep = sess.step
              instance.recordAiTurn({
                step: sess.step,
                observeReason: 'dsh_turn',
              })
            }
            break
          }

          case 'assistant/message': {
            const parsed = extractDshMessage(event.data?.message)
            if (!parsed) break

            const callsDst = parsed.toolCalls?.some((c) => isDstTool(c.name))
            if (callsDst) {
              sess.isDst = true
              if (!seenSessions.has(id)) {
                seenSessions.add(id)
                currentDshStep = null
                try { instance.reset(`新会话 ${id}`) } catch {}
              }
            }

            const model = event.data?.message?.model || event.data?.model || session?.model || 'dsh-model'
            const usage = event.data?.message?.usage || event.data?.usage
            const tokens = usage?.total_tokens ?? (usage ? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) : null)
            const sig = `${parsed.thought || ''}|${parsed.content || ''}|${parsed.toolCalls?.length || 0}`
            if (sig && sig === sess.lastMsgSig) break
            sess.lastMsgSig = sig

            const thoughtData = {
              step: sess.step || 1,
              thought: parsed.thought,
              content: parsed.content,
              model,
              tokens,
              toolCalls: parsed.toolCalls,
            }

            if (sess.isDst) {
              if (sess.step === 0) sess.step = 1
              thoughtData.step = sess.step
              currentDshStep = sess.step
              sess.turnLogged = true
              instance.recordAiThought(thoughtData)
            } else {
              sess.pendingThought = thoughtData
            }
            break
          }

          case 'tool/call': {
            const toolName = event.data?.name
            if (isDstTool(toolName)) {
              sess.isDst = true
              if (!seenSessions.has(id)) {
                seenSessions.add(id)
                currentDshStep = null
                try { instance.reset(`新会话 ${id}`) } catch {}
              }
              if (sess.step === 0) sess.step = 1
              currentDshStep = sess.step

              if (sess.pendingThought && !sess.turnLogged) {
                sess.turnLogged = true
                sess.pendingThought.step = sess.step
                instance.recordAiThought(sess.pendingThought)
                sess.pendingThought = null
              }
            }
            break
          }

          case 'tool/result': {
            sess.turnLogged = false
            break
          }

          case 'turn/end': {
            sess.pendingThought = null
            break
          }
        }
      })
    }
    return () => {
      try { typeof off === 'function' ? off() : off?.dispose?.() } catch {}
      instance.stop()
      // 只在还是自己时清空：effect 重跑时新实例可能已经接上了
      if (sessionLog === instance) sessionLog = null
    }
  })

  // 预设和入口工具都跟着设置走：插件页里打开开关，十几秒内生效，不用重启 DSH
  setupPreset(ctx, config, log)
  setupGateway(ctx, config, log)
  registerAutoContinue(ctx, config, log)
}

/** 预设里连游戏的 MCP 客户端那一行（用 DSH 自带的 @deepseek-ai/dsh-mcp-client）。 */
export function mcpClientRow(config) {
  const c = currentConfig(config)
  return {
    id: 'mcp-dst',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: MCP_SERVER_NAME,
      transport: 'streamable-http',
      url: `http://127.0.0.1:${c.port}/mcp`,
      toolCallTimeoutMs: c.actionTimeoutMinutes * 60 * 1000,
      reconnect: { maxAttempts: 100000 },
    },
  }
}

/**
 * 挑一个能用的基础预设。
 * 玩家设的 basePreset 优先；找不到就按常见 id 试一遍；再不行就拿现有的第一个。
 * （不同机器上 DSH 自带的预设 id 不一样，写死一个会直接注册失败，预设列表里就什么也没有。）
 */
export function resolveBasePreset(presets, want) {
  const defs = presets?.definitions
  if (!defs || typeof defs.get !== 'function') return null
  const direct = defs.get(want)
  if (direct) return { id: want, definition: direct }
  for (const id of ['standard', 'default', 'minimal', 'general', 'aurabot-private']) {
    const found = defs.get(id)
    if (found) return { id, definition: found }
  }
  if (typeof defs.keys === 'function') {
    for (const id of defs.keys()) {
      const found = defs.get(id)
      if (found) return { id, definition: found }
    }
  }
  return null
}

/** 现在都有哪些预设 id（给日志用）。 */
function presetIds(presets) {
  try {
    const defs = presets?.definitions
    if (!defs) return ''
    if (typeof defs.keys === 'function') return [...defs.keys()].join(', ')
    if (typeof defs[Symbol.iterator] === 'function') return [...defs].map(([id]) => id).join(', ')
  } catch {}
  return ''
}

/**
 * 会话预设：按设置动态注册/注销。
 * 每 5 秒比对一次设置——在插件页里打开开关，十几秒内预设就会出现，不用重启 DSH；
 * 基础预设还没注册好（DSH 启动顺序）也会自己等到有为止。
 */
export function setupPreset(ctx, config, log, { everyMs = 5000 } = {}) {
  ctx.effect(() => {
    let disposed = false
    let unregister = null
    let registeredWith = ''
    let busy = false
    const warned = new Set()
    const warnOnce = (key, message) => {
      if (warned.has(key)) return
      warned.add(key)
      log('warn', message)
    }

    const tick = async () => {
      if (disposed || busy) return
      busy = true
      try {
        let presets
        try {
          presets = ctx.get?.('agentPresets')
        } catch {}
        if (!presets?.register) {
          warnOnce('noservice', '这个版本的 DSH 没有会话预设服务，没有创建饥荒预设')
          return
        }
        const c = currentConfig(config)
        if (!c.presetEnabled) {
          if (unregister) {
            const remove = unregister
            unregister = null
            registeredWith = ''
            try {
              await remove()
            } catch {}
            log('info', '已关掉饥荒会话预设')
          }
          return
        }
        if (typeof presets.definitions?.has === 'function' && presets.definitions.has(PRESET_ID) && !unregister) {
          warnOnce('exists', `已经有 id 为「${PRESET_ID}」的预设了（可能在 profile 里手写过），没有重复创建`)
          return
        }
        const resolved = resolveBasePreset(presets, c.basePreset)
        if (!resolved) {
          warnOnce('nobase', `还找不到能当底子的预设（现在有：${presetIds(presets) || '一个都没有'}），等它注册好再试`)
          return
        }
        if (resolved.id !== c.basePreset) {
          warnOnce('fallback', `没找到基础预设「${c.basePreset}」，改用「${resolved.id}」（现在有：${presetIds(presets)}）`)
        }
        const want = `${resolved.id}::${c.presetName}`
        if (unregister && registeredWith === want) return
        if (unregister) {
          const remove = unregister
          unregister = null
          registeredWith = ''
          try {
            await remove()
          } catch {}
        }
        const plugins = (resolved.definition?.config?.plugins ?? []).map((row) => ({ ...row }))
        const remove = await presets.register({
          id: PRESET_ID,
          name: c.presetName,
          description: `在「${resolved.id}」的基础上，加上玩《饥荒联机版》的工具（游戏要开着、装了大肥鱼饿不死模组）`,
          order: 50,
          plugins: [...plugins, mcpClientRow(config)],
        })
        if (disposed) {
          await remove?.()
          return
        }
        unregister = remove
        registeredWith = want
        log('info', `已创建会话预设「${c.presetName}」（基于 ${resolved.id}）：新建会话时选它就能玩饥荒`)
      } catch (error) {
        log('warn', '创建饥荒预设失败：' + (error?.message ?? error))
      } finally {
        busy = false
      }
    }

    tick()
    const timer = setInterval(tick, everyMs)
    return () => {
      disposed = true
      clearInterval(timer)
      const remove = unregister
      unregister = null
      try {
        remove?.()
      } catch {}
    }
  })
}

// ───────────────────────── 单入口工具 dst ─────────────────────────

/** 发一条 JSON-RPC 给自己的 MCP 服务器（和预设里的客户端走同一个地址）。 */
export async function mcpCall(port, method, params, signal) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal,
  })
  const body = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? parseSseResult(await res.text())
    : await res.json()
  if (body.error) throw new Error(body.error.message ?? `MCP 错误 ${body.error.code}`)
  return body.result
}

/** 从 SSE 文本里取出 JSON-RPC 回复（忽略 ": keep-alive" 注释行）。 */
export function parseSseResult(text) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    const message = JSON.parse(data)
    if ('result' in message || 'error' in message) return message
  }
  throw new Error('游戏的回复里没有结果（连接可能中途断了）')
}

/** action="help" 的内容：规则 + 动作列表（主攻略去掉，要看用 get_guide）。 */
export function helpText(instructions, tools) {
  let rules = instructions ?? ''
  const guideStart = rules.indexOf('## 游戏常识')
  const extra = rules.indexOf('## 通过 MCP 玩的额外说明')
  if (guideStart >= 0 && extra > guideStart) rules = rules.slice(0, guideStart) + rules.slice(extra)
  const lines = tools.map((tool) => {
    const props = tool.inputSchema?.properties ?? {}
    const required = new Set(tool.inputSchema?.required ?? [])
    const params = Object.keys(props).map((key) => (required.has(key) ? key : key + '?')).join(', ')
    const summary = String(tool.description ?? '').split(/[。.\n]/)[0]
    return `- ${tool.name}(${params})：${summary}`
  })
  return [
    `# 用 ${GATEWAY_TOOL} 工具玩《饥荒联机版》`,
    `下面说的每个“工具”，都通过 ${GATEWAY_TOOL} 工具调用：action 填动作名，args 填参数对象，例如 {"action":"move_to","args":{"x":64,"z":15}}。参数后面带 ? 的可以不填。`,
    '',
    rules.trim(),
    '',
    `## 全部动作（${tools.length} 个；不确定参数时先按名字和说明猜，失败信息会说哪里不对）`,
    ...lines,
  ].join('\n')
}

export function setupGateway(ctx, config, log, { everyMs = 5000 } = {}) {
  const c = currentConfig(config)
  const timeoutMs = c.actionTimeoutMinutes * 60 * 1000
  const tool = defineTool({
    name: GATEWAY_TOOL,
    description:
      '玩《饥荒联机版》（游戏要开着、装了大肥鱼饿不死模组）。第一次用先调 action="help"，会告诉你操作规则和全部动作；'
      + '**开始时**先 action="get_state" 看一次游戏状态；之后用动作回执里已核对的结果继续推进，不用每个动作都重看。'
      + '然后 action=动作名、args=参数对象，比如 {"action":"stop"}、{"action":"move_to","args":{"x":64,"z":15}}。'
      + '攻略用 action="get_guide"。',
    parameters: {
      action: { type: 'string', required: true, description: '动作名：help、get_state、get_guide，或 help 列出的任意动作' },
      args: { type: 'object', additionalProperties: true, description: '动作的参数对象；没有参数就不填' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '').trim()
      const signal = exec?.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      try {
        if (!action || action === 'help') {
          const init = await mcpCall(c.port, 'initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'dsh-dst-gateway', version: '1' },
          }, signal)
          const list = await mcpCall(c.port, 'tools/list', {}, signal)
          return helpText(init?.instructions, list?.tools ?? [])
        }
        const result = await mcpCall(c.port, 'tools/call', { name: action, arguments: args?.args ?? {} }, signal)
        const text = (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        return text || '（游戏没有返回内容）'
      } catch (error) {
        if (signal.aborted && !exec?.signal?.aborted) return `失败：等了 ${c.actionTimeoutMinutes} 分钟还没做完，已放弃等待。先 action="get_state" 看看现在的情况`
        const reason = error?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(String(error?.message))
          ? '连不上插件里的 MCP 服务器：确认 DSH 里这个插件装着、端口没被占'
          : String(error?.message ?? error)
        return '失败：' + reason
      }
    },
  })
  ctx.effect(() => {
    let off = null
    let warned = false
    let disposed = false
    const tick = () => {
      if (disposed) return
      let tools
      try {
        tools = ctx.get?.('tools')
      } catch {}
      if (!tools?.register) {
        if (!warned) {
          warned = true
          log('warn', '这个版本的 DSH 没有工具注册服务，没有添加 dst 入口工具')
        }
        return
      }
      const enabled = currentConfig(config).gatewayEnabled === true
      if (enabled && !off) {
        try {
          off = tools.register(tool)
          log('info', '已在所有会话里添加 dst 入口工具')
        } catch (error) {
          log('warn', '添加 dst 入口工具失败：' + (error?.message ?? error))
        }
      } else if (!enabled && off) {
        const remove = off
        off = null
        try {
          typeof remove === 'function' ? remove() : remove?.dispose?.()
        } catch {}
        log('info', '已撤掉 dst 入口工具')
      }
    }
    // 开关跟着设置走：插件页里打开十几秒内就生效，不用重启 DSH
    tick()
    const timer = setInterval(tick, everyMs)
    return () => {
      disposed = true
      clearInterval(timer)
      const remove = off
      off = null
      try {
        typeof remove === 'function' ? remove() : remove?.dispose?.()
      } catch {}
    }
  })
}

// ───────────────────────── 模型回复坏了自动续玩 ─────────────────────────

const BROKEN_TOOL_CALL = /｜DSML｜|<｜tool▁call/

export const AUTO_CONTINUE_TEXT =
  '（自动续玩）你上一条回复的工具调用格式坏了，没有执行。不用解释，直接接着玩：拿不准就 get_state 看一眼再行动。'

export function isDstTool(toolName) {
  if (typeof toolName !== 'string') return false
  if (toolName === GATEWAY_TOOL) return true
  if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return true
  if (ACTION_NAMES.has(toolName) || MACRO_NAMES.has(toolName) || toolName === 'get_state' || toolName === 'get_guide') return true
  return false
}

export function extractDshMessage(message) {
  if (!message) return null
  let thought = message.reasoning_content || message.reasoningContent || message.thought || null
  let content = ''
  const toolCalls = []

  const rawContent = message.content
  if (typeof rawContent === 'string') {
    content = rawContent
  } else if (Array.isArray(rawContent)) {
    const textParts = []
    const thoughtParts = []
    for (const part of rawContent) {
      if (!part) continue
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text)
      } else if (part.type === 'thinking' || part.type === 'think' || part.type === 'reasoning') {
        thoughtParts.push(part.thinking || part.think || part.reasoning || part.text || '')
      } else if (part.type === 'tool-call' || part.type === 'tool_use' || part.type === 'tool_call') {
        toolCalls.push({
          name: part.name || part.toolName || part.tool_name,
          args: part.arguments || part.args,
        })
      }
    }
    if (thoughtParts.length > 0) {
      const joined = thoughtParts.filter(Boolean).join('\n').trim()
      if (joined) thought = thought ? thought + '\n' + joined : joined
    }
    content = textParts.join('').trim()
  }

  // 检查正文中的 <think>...</think> 标签（DeepSeek / Qwen 等模型）
  if (typeof content === 'string' && content.includes('<think>')) {
    const m = content.match(/<think>([\s\S]*?)(?:<\/think>|$)/)
    if (m) {
      const extracted = m[1].trim()
      thought = thought ? thought + '\n' + extracted : extracted
      content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim()
    }
  }

  // 兼容 OpenAI 格式的 message.tool_calls
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = call.function || call
      let args = fn.arguments ?? fn.args
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = {} }
      }
      toolCalls.push({ name: fn.name, args })
    }
  }

  return {
    thought: thought ? thought.trim() : null,
    content: content ? content.trim() : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  }
}

function registerAutoContinue(ctx, config, log) {
  if (typeof ctx.on !== 'function') return
  const sessions = new Map()
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (!state) sessions.set(id, (state = { playing: false, broken: false, streak: 0, calls: new Set() }))
    return state
  }
  const timers = new Set()

  const continueLater = (sessionId, attempt = 0) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      const agent = ctx.get?.('agents')?.get?.(sessionId)
      if (!agent) return
      if (agent.status !== 'idle') {
        if (attempt < 20) continueLater(sessionId, attempt + 1)
        return
      }
      if (agent.inbox?.nextTurn?.length) return
      try {
        agent.followup(Object.freeze({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: AUTO_CONTINUE_TEXT }],
          source: { kind: name, form: 'notice', summary: '模型回复坏了，自动接着玩' },
        }))
        log('info', `会话 ${sessionId} 的模型回复坏了，已自动发“接着玩”`)
      } catch (error) {
        log('warn', `自动续玩失败：${error?.message ?? error}`)
      }
    }, 1500)
    timers.add(timer)
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const id = session?.id
      if (!id || !event) return
      const state = stateOf(id)
      switch (event.type) {
        case 'turn/start':
          state.playing = false
          state.broken = false
          state.calls.clear()
          return
        case 'tool/call':
          if (isDstTool(event.data?.name)) {
            state.playing = true
            state.calls.add(event.data.callId)
          }
          return
        case 'tool/result': {
          const message = event.data?.message
          if (message && !message.isError && state.calls.has(message.toolCallId)) state.streak = 0
          return
        }
        case 'assistant/message': {
          const raw = event.data?.message?.content
          const text = typeof raw === 'string'
            ? raw
            : (Array.isArray(raw) ? raw.filter((part) => part && part.type === 'text').map((part) => part.text).join('') : '')
          const hasToolCall = Array.isArray(raw) && raw.some((part) => part && part.type === 'tool-call')
          state.broken = !hasToolCall && BROKEN_TOOL_CALL.test(text)
          return
        }
        case 'turn/end':
          if (!state.playing || !state.broken || event.data?.reason?.kind !== 'completed') return
          state.broken = false
          if (!currentConfig(config).autoContinue) return
          if (state.streak >= Number(currentConfig(config).autoContinueMax)) {
            log('warn', `会话 ${id} 连续 ${state.streak} 次自动续玩都没有成功的游戏动作，不再自动续玩`)
            return
          }
          state.streak++
          continueLater(id)
          return
      }
    })
    return () => {
      off?.()
      timers.forEach(clearTimeout)
      timers.clear()
    }
  })
}

export { GUIDE_TOPICS, BUNDLED_GUIDES, RULES }
