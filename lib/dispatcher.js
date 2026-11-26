// 唯一动作分发入口（Action Dispatcher）
//
// 所有会改游戏状态的动作都必须走这里：F8 内置 AI、MCP 客户端、人工测试，一个都不能绕。
// 它把「校验 → 租约 → 下发 → 等结果 → 核对」串成一条链，并统一返回结构化状态。
//
// 状态机：
//   rejected   —— 请求本身不合法 / 没有控制权 / 游戏不可用（**没有发到游戏**）
//   succeeded  —— 游戏确认做完，并且核对通过
//   unverified —— 游戏说做完了，但核对没通过（例如位置没变）
//   failed     —— 游戏明确报失败
//   expired    —— 命令过期
//   unknown    —— 已经下发但拿不到结果（**绝不自动重试**，避免重复执行）
//
// 关键原则：accepted ≠ succeeded；写入命令文件 ≠ 游戏执行；没有证据就不报成功。

import { randomUUID } from 'node:crypto'

import { envFingerprintOf } from './control.js'
import { ACTION_SPECS } from './actions/specs/index.js'
import {
  countInInventory,
  findSameEntity,
  handItem,
  inventoryItems,
  itemOfRef,
  prefabOfRef,
} from './actions/state-query.js'

// 动作规格按领域放在 ./actions/specs/*.js，这里只保留"唯一出口"的职责：
// 白名单 → 参数校验 → 快照/租约校验 → 下发 → 等回执 → 用前后快照核对。
// 新增动作：在对应领域文件里加规格，然后确认它在 ACTION_SPECS 里即可（OPEN_ACTIONS 自动跟随）。
export { ACTION_SPECS }
export { handItem, inventoryItems }

/** 模型可以下发的动作 = 规格表里的全部动作（工具表必须与它完全一致，有测试盯着） */
export const OPEN_ACTIONS = Object.keys(ACTION_SPECS)

// ─────────────────────────── 参数校验 ───────────────────────────

/**
 * 参数归一化（纯格式）。
 * 将数字 15 / 字符串 "15" / "#15" 统一归一成 "#15"，安全校验（snapshot_id / Resolve）照旧执行。
 */
export function normalizeArgs(spec, args) {
  const input = args ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) return input
  const out = { ...input }
  for (const [name, rule] of Object.entries(spec.args ?? {})) {
    if (rule?.type !== 'string') continue
    const value = out[name]
    if (value === undefined || value === null) continue
    // target_ref：数字或裸数字都补成 #N
    if (name === 'target_ref') {
      // 引用是 **1 起**的（#1 是第一个）。0 / 负数不归一，留给校验去拒。
      if (typeof value === 'number' && Number.isFinite(value)) {
        const n = Math.trunc(value)
        if (n >= 1) out[name] = '#' + String(n)
      } else if (typeof value === 'string') {
        const s = value.trim()
        const m = s.match(/^#?([0-9]+)$/)
        if (m && Number(m[1]) >= 1) out[name] = '#' + String(Number(m[1]))   // 去掉前导零
        else out[name] = s
      }
      continue
    }
    // 其它字符串字段：去掉首尾空白（模型偶尔会带空格）
    if (typeof value === 'string') out[name] = value.trim()
  }
  return out
}

export function validateArgs(spec, args) {
  const input = args ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'bad_args' }

  // 未知字段：拒绝（模型不许夹带参数）
  for (const key of Object.keys(input)) {
    if (!spec.args[key]) return { ok: false, reason: `unknown_arg:${key}` }
  }

  // 带 target_handle 时，target_ref / snapshot_id 不再是必填（两种引用二选一）。
  // 这只放宽参数形状，不放宽任何安全校验：句柄仍须通过 Lua 的真实实体复检，过期一律 target_gone。
  const hasHandle = typeof input.target_handle === 'string' && input.target_handle !== ''

  for (const [name, rule] of Object.entries(spec.args)) {
    const value = input[name]
    if (value === undefined || value === null) {
      const relaxedByHandle = hasHandle && (name === 'target_ref' || name === 'snapshot_id')
      if (rule.required && !relaxedByHandle) return { ok: false, reason: `missing_arg:${name}` }
      continue
    }
    if (rule.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) return { ok: false, reason: `bad_type:${name}` }
      if (!Number.isFinite(value)) return { ok: false, reason: `infinite:${name}` }
      if (rule.integer && !Number.isInteger(value)) return { ok: false, reason: `not_integer:${name}` }
      if (rule.min !== undefined && value < rule.min) return { ok: false, reason: `out_of_range:${name}` }
      if (rule.max !== undefined && value > rule.max) return { ok: false, reason: `out_of_range:${name}` }
    } else if (rule.type === 'string') {
      if (typeof value !== 'string') return { ok: false, reason: `bad_type:${name}` }
      if (value === '') return { ok: false, reason: `empty_string:${name}` }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        return { ok: false, reason: `too_long:${name}` }
      }
      if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
        return { ok: false, reason: `bad_format:${name}` }
      }
      // 固定枚举（target_kind / recipe）在 Node 侧预检拒掉未知值；Lua 侧仍独立校验。
      if (rule.enum !== undefined && !rule.enum.includes(value)) {
        return { ok: false, reason: `bad_value:${name}` }
      }
    }
  }
  return { ok: true }
}

// ─────────────────────────── Dispatcher ───────────────────────────

/**
 * @param {object} options
 * @param {object} options.bridge   GameBridge（唯一发命令的地方）
 * @param {object} options.control  LeaseManager
 * @param {(ctx:any)=>any} options.readSnapshot 读归一化快照（tools.js 里那个）
 * @param {() => number} [options.now]
 * @param {(level:string,msg:string)=>void} [options.log]
 * @param {number} [options.commandTtlMs] 命令有效期（默认 8 秒；游戏卡住时不会执行几分钟前的旧命令）
 * @param {number} [options.timeoutMs]    等结果的上限
 */
// 动作分级超时上限：到达上限即按 unknown 返回，避免长时间阻塞。
// 采集/拾取类包含寻路与动作硬直给 30s；战斗类给 60s（budget_s≈45s）与防御预算对齐；
// use 需兼顾点火与撤离（LIGHT 点着后走开 6 格）给 35s。
const ACTION_TIMEOUT_CAP_MS = {
  move_to: 40000, go_to: 40000, seek: 45000, gather_area: 45000,
  chop: 30000, chop_nearest: 30000, mine: 30000, mine_nearest: 30000,
  harvest: 30000, harvest_nearest: 30000, pickup: 30000, pickup_nearest: 30000, pickup_food: 30000,
  attack: 30000, fight_spider: 60000, kill: 60000,
  eat: 15000, equip: 10000, unequip: 10000, fuel: 15000, add_fuel: 15000,
  craft: 20000, build: 20000, cook: 20000, drop: 10000, inspect: 8000,
  use: 35000,
}
const DEFAULT_ACTION_CAP_MS = 30000

export function createDispatcher({
  bridge,
  control,
  readSnapshot,
  now = () => Date.now(),
  log = () => {},
  commandTtlMs = 8000,
  timeoutMs = 120000,
  readLeaseAck = null,
} = {}) {
  let last = null

  // ── stale_snapshot 熔断 ────────────────────────────────────────────
  //
  // 按 (谁 + 哪个动作 + 哪个 #N) 计数，故意不含 snapshot_id 以拦截连续猜测 snapshot_id 的死循环。
  // 熔断只拦截注定失败的请求并提示替代方案，绝不放宽任何快照或实体校验。
  //
  // 清零条件：
  //   · 动作成功
  //   · 请求的 (动作, #N) 与记录不同（= 目标变了）
  //   · runtime_id 变了（换世界/重载）
  //   · 引用真的命中了当前快照（= 模型拿到了新鲜引用）
  const staleBreakers = new Map()
  const breakerKey = (owner, tool) => `${owner} ${tool}`

  const finish = (result) => {
    last = { ...result, at: now() }
    return last
  }

  const reject = (reason, message, extra = {}) =>
    finish({ status: 'rejected', reason, message: message ?? reason, ...extra })

  /** 熔断状态（诊断/测试用） */
  const staleState = () => Array.from(staleBreakers.entries()).map(([key, rec]) => ({ key, ...rec }))

  return {
    specs: ACTION_SPECS,

    status() {
      return { lease: control?.status?.() ?? null, last, stale: staleState() }
    },

    /**
     * 执行一个动作。
     * 支持 dispatch({ tool, args, ... }) 和 dispatch(tool, args, options) 两种调用签名。
     */
    async dispatch(first, maybeArgs, maybeOpts = {}) {
      let tool, args, owner, ownerInstanceId, signal, callTimeoutMs, callBudgetS
      if (typeof first === 'string') {
        tool = first
        args = maybeArgs ?? {}
        owner = maybeOpts?.owner ?? 'system'
        ownerInstanceId = maybeOpts?.ownerInstanceId
        signal = maybeOpts?.signal
        callTimeoutMs = maybeOpts?.timeoutMs
        callBudgetS = maybeOpts?.budget_s
      } else {
        const req = first || {}
        tool = req.tool
        args = req.args
        owner = req.owner ?? 'system'
        ownerInstanceId = req.ownerInstanceId
        signal = req.signal
        callTimeoutMs = req.timeoutMs
        callBudgetS = req.budget_s
      }
      if (signal?.aborted) return reject('aborted', '动作在下发前已被取消')

      // 1) 白名单
      const spec = ACTION_SPECS[tool]
      if (!spec) return reject('action_not_allowed', `未开放这个动作（只开放：${OPEN_ACTIONS.join('、')}）`)

      // 2) 参数
      // 先做纯格式归一（target_ref 补 # 号等），再做严格校验
      const normalized = normalizeArgs(spec, args)
      const checked = validateArgs(spec, normalized)
      if (!checked.ok) return reject(checked.reason, `参数不合法：${checked.reason}`)

      // 3) 游戏状态（用同一份快照；过期就不发）
      if (typeof readSnapshot !== 'function') return reject('no_snapshot_reader', '内部错误：没有快照读取器')
      const before = readSnapshot({ bridge })
      if (!before) return reject('game_not_ready', '连不上游戏（没进入世界？）')
      if (before.stale) {
        // 区分"暂停"和"退出世界" —— 提示与恢复路径不同
        const secs = Math.max(0, Math.round((before.ageMs ?? 0) / 1000))
        if (before.actor) {
          return reject('game_paused', `游戏暂停了（状态 ${secs} 秒没更新）：引擎不跑 tick，命令排不上队。让玩家切回游戏窗口解除暂停，再 get_state`)
        }
        return reject('game_not_ready', `游戏状态已经 ${secs} 秒没更新，而且读不到角色（可能退出世界了），先 get_state 确认`)
      }

      // 3.5) 目标引用：两种方式**二选一**
      //   · target_handle（稳定句柄 h…）：跨扫描有效，所以**不校验** snapshot_id
      //     —— 这正是"不会过期"的来源。但 Lua 侧仍然要在授权那一刻把句柄解析回真实实体，
      //     并重新过一遍候选/成熟度/距离检查；句柄过期一律 target_gone，绝不替换成别的对象。
      //   · target_ref + snapshot_id：当前帧的 #N，语义一个字都没放宽。
      const bkey = breakerKey(owner, tool)
      if (spec.requiresSnapshot) {
        // 注意：这里用**归一化后**的 normalized（target_ref 可能是数字 15 / "15"，归一成 "#15"）。
        // 原来这里读的是未归一化的 args，只是恰好没影响（以前只比 snapshot_id）。
        const hasHandle = typeof normalized?.target_handle === 'string' && normalized.target_handle !== ''
        if (hasHandle) {
          // 换了引用机制 = "目标引用变了" → 清掉这条动作的熔断计数
          staleBreakers.delete(bkey)
        } else if (typeof normalized?.target_ref !== 'string' || normalized.target_ref === '') {
          return reject(
            'missing_arg:target_ref',
            '要么给 #N + snapshot_id（当前帧的引用），要么给 target_handle（附近里那个「句柄h…」，跨帧有效）',
          )
        } else {
          const wanted = normalized?.snapshot_id
          const current = before.nearby?.snapshot_id ?? null
          if (!wanted || wanted !== current) {
            const runtimeId = before.nearby?.runtime_id ?? null
            const prev = staleBreakers.get(bkey)
            const sameRef = prev !== undefined && prev.ref === normalized.target_ref && prev.runtimeId === runtimeId
            const advice =
              '**不要**把 snapshot_id 加 1、不要预补偿、也不要指望"同编号还是原来那个东西"（编号每帧重排）。改用不会过期的办法：\n'
              + '· 只说类别：pickup_nearest {"target_kind":"flint"} / pickup_food / harvest_nearest / chop_nearest / mine_nearest\n'
              + '· 或者把附近里那个目标的「句柄h…」填进 target_handle\n'
              + '· 或者重新 get_state，把打印出来的 Nearby 快照 ID **原样照抄**（一个字都别改）'
            if (sameRef) {
              const count = prev.count + 1
              staleBreakers.set(bkey, { ...prev, count, at: now() })
              if (count >= 2) {
                // ★ 熔断：不再把注定失败的请求发到游戏
                return reject(
                  'stale_snapshot_circuit_open',
                  `stale_snapshot 已连续 ${count} 次（一直用 ${normalized.target_ref} 配一个往上猜的 snapshot_id），`
                  + `熔断：不再重试这个旧引用。\n${advice}`,
                  { stale: { tool, ref: normalized.target_ref, wanted: wanted ?? null, current, count, circuit: 'open' } },
                )
              }
              return reject(
                'stale_snapshot',
                `附近快照变了（你给的 ${wanted ?? '空'}，当前 ${current ?? '无'}）。\n${advice}`,
                { stale: { tool, ref: normalized.target_ref, wanted: wanted ?? null, current, count, circuit: 'closed' } },
              )
            }
            staleBreakers.set(bkey, {
              ref: normalized.target_ref, count: 1, runtimeId, at: now(), wanted: wanted ?? null, current,
            })
            return reject(
              'stale_snapshot',
              `附近快照变了（你给的 ${wanted ?? '空'}，当前 ${current ?? '无'}）。\n${advice}`,
              { stale: { tool, ref: normalized.target_ref, wanted: wanted ?? null, current, count: 1, circuit: 'closed' } },
            )
          }
          // 引用命中了当前快照 → 模型拿到了新鲜引用，这条动作的熔断计数清零
          staleBreakers.delete(bkey)
        }
      }
      // 4) 角色（Node 侧只做"看起来能不能控"，最终由 Lua 判定）
      if (!before.actor || before.actor.valid !== true) return reject('actor_invalid', '没有可操作的角色')
      if (before.actor.alive !== true) return reject('actor_dead', '角色已经死了')
      if (before.actor.isGhost) return reject('actor_is_ghost', '角色处于灵魂状态')

      // 4.5) Reflex 避让：若 Reflex 正在保命逃跑/接管中，普通动作不发往游戏冲撞 Reflex
      if (before.reflex?.active === true && tool !== 'stop') {
        return reject(
          'reflex_active',
          'Lua Reflex 正在保命接管中（如逃跑/紧急避险），普通动作暂停下发',
          { reflex: before.reflex },
        )
      }

      // 5) 租约（Node 侧第一道闸）：**每次重新读最新权威状态**
      const env = envFingerprintOf(before)
      // 两阶段换手：看到 revoking 时尝试用 Lua 的确认完成；拿不到确认就保持拒绝
      const current = control?.readAuthority?.()
      if (current?.status === 'revoking' && typeof control.completeHandover === 'function') {
        control.completeHandover(typeof readLeaseAck === 'function' ? readLeaseAck() : null)
      }
      const leaseCheck = control?.validate?.(owner, { ownerInstanceId, env }) ?? { ok: false, reason: 'authority_unavailable' }
      if (!leaseCheck.ok) {
        return reject(
          'control_denied',
          `没有有效控制权：${leaseCheck.reason}`,
          { lease: leaseCheck },
        )
      }
      const lease = leaseCheck.lease // 这是刚从权威文件读出来的记录，不是内存旧副本

      // 6) 组装命令信封（Lua 会用同一套字段再校验一遍）
      // 用归一化后的参数（否则补的 # 号传不到 Lua）
      args = normalized
      const commandId = randomUUID()
      const createdAt = now()
      const envelope = {
        protocol_version: 1,
        command_id: commandId,
        action: tool,
        args: args ?? {},
        requested_by: owner,
        owner_type: lease.owner_type,
        owner_instance_id: lease.owner_instance_id,
        authority_epoch: lease.authority_epoch,
        lease_id: lease.lease_id,
        lease_generation: lease.generation,
        lease_expires_at: lease.expires_at,
        runtime_id: env.runtimeId,
        session_id: env.sessionId,
        shard_id: env.shardId,
        actor_id: env.actorId,
        snapshot_id: before.nearby?.snapshot_id ?? null,
        // 目标引用（Lua 用它去 N.Resolve，禁止按 prefab 隐式搜索）
        target_ref: typeof args?.target_ref === 'string' ? args.target_ref : null,
        created_at: createdAt,
        expires_at: createdAt + commandTtlMs,
        // 动作预算与超时协调：优先采用调用方显式指定的 budget_s 与 timeoutMs
        budget_s: (() => {
          if (tool === 'stop') return 4
          if (callBudgetS !== undefined && callBudgetS !== null) return Math.max(3, Math.trunc(Number(callBudgetS)) || 3)
          const effMs = Math.min(callTimeoutMs ? Number(callTimeoutMs) : timeoutMs, ACTION_TIMEOUT_CAP_MS[tool] ?? DEFAULT_ACTION_CAP_MS)
          return Math.max(3, Math.floor(effMs / 1000) - 15)
        })(),
      }

      // 7) 下发（唯一真正写命令文件的地方）
      const effectiveTimeoutMs = (() => {
        const cap = ACTION_TIMEOUT_CAP_MS[tool] ?? DEFAULT_ACTION_CAP_MS
        if (tool === 'stop') return Math.min(callTimeoutMs ?? 5000, 5000, cap)
        if (callBudgetS !== undefined && callBudgetS !== null) {
          const b = Math.max(3, Math.trunc(Number(callBudgetS)) || 3)
          return Math.min(callTimeoutMs ? Number(callTimeoutMs) : (b + 15) * 1000, cap)
        }
        return Math.min(callTimeoutMs ? Number(callTimeoutMs) : timeoutMs, cap)
      })()
      let result
      try {
        result = await bridge.call(tool, args ?? {}, { timeoutMs: effectiveTimeoutMs, signal, envelope })
      } catch (error) {
        const message = String(error?.message ?? error)
        // 超时/等不到结果 → unknown：**绝不自动重试**
        if (/还没做完|timed out|timeout/i.test(message)) {
          return finish({ status: 'unknown', reason: 'result_timeout', message, commandId })
        }
        if (/被取消|aborted/i.test(message)) {
          return finish({ status: 'cancelled', reason: 'aborted', message, commandId })
        }
        return finish({ status: 'failed', reason: 'bridge_error', message, commandId })
      }

      if (!result.ok) {
        const reason = result.reason ?? 'action_failed'
        const rejectedReasons = new Set([
          'action_not_allowed', 'bad_protocol', 'missing_command_id', 'duplicate_command',
          'command_expired', 'stale_generation', 'lease_expired', 'no_actor_no_player',
          'actor_invalid', 'actor_not_player', 'actor_is_ghost', 'actor_dead', 'world_not_ready',
          'not_authoritative', 'runtime_mismatch', 'runtime_unknown', 'session_mismatch',
          'shard_mismatch', 'actor_mismatch', 'missing_generation', 'missing_expiry',
          'authority_unavailable', 'authority_revoking', 'authority_epoch_mismatch',
          'future_generation', 'wrong_owner', 'wrong_instance', 'stale_lease', 'lease_expired',
          'stale_snapshot', 'stale_snapshot_circuit_open', 'unknown_ref', 'entity_gone', 'in_limbo', 'prefab_not_allowed',
          'target_not_pickable', 'out_of_range', 'inventory_full', 'actor_busy',
          'missing_component:inventory', 'bad_format:target_ref', 'bad_format:snapshot_id',
          'target_not_harvestable', 'not_ready', 'already_harvested', 'target_busy',
          'harvest_rules_missing', 'wrong_category',
          // 实时目标选择 / 稳定句柄 / 科技条件拒绝码
          'target_kind_not_allowed', 'target_kind_mismatch', 'no_target', 'target_rules_missing',
          'target_not_workable', 'wrong_work_action', 'already_worked', 'target_not_edible',
          'unknown_handle', 'bad_handle', 'target_taken', 'handle_session_mismatch',
          'recipe_locked', 'no_resolved_target', 'missing_arg:target_ref', 'bad_value:target_kind',
          'bad_value:recipe', 'nearby_unavailable',
          'no_lighter', 'target_not_ignitable', 'already_burning', 'already_burnt',
          'reflex_active',
        ])
        const status = rejectedReasons.has(reason) ? 'rejected' : 'failed'
        return finish({ status, reason, message: String(result.text ?? ''), commandId })
      }

      // 8) 结果核对：用新快照验证"真的发生了"。
      //    pickup 的背包变化要等游戏写下一帧状态文件，所以按 spec.verifyWaitMs 轮询。
      let after = null
      const waitMs = Number(spec.verifyWaitMs ?? 0)
      if (waitMs > 0 && typeof spec.verify === 'function') {
        const deadline = Date.now() + waitMs // 用真实墙钟，避免注入固定时钟时死循环
        while (Date.now() < deadline) {
          try { after = readSnapshot({ bridge }) } catch { after = null }
          if (after && spec.verify(before, after, args ?? {}).ok) break
          await new Promise((r) => setTimeout(r, 250))
        }
      }
      if (!after) {
        try { after = readSnapshot({ bridge }) } catch {}
      }
      const verified = spec.verify(before, after, args ?? {})
      if (!verified.ok) {
        return finish({
          status: 'unverified',
          reason: verified.reason,
          message: String(result.text ?? ''),
          commandId,
          verified: { product: verified.product ?? null, prefab: verified.prefab ?? null },
        })
      }
      // 动作确认成功：附带已核对的结构化变化，并清零该动作的 stale 熔断计数。
      staleBreakers.delete(breakerKey(owner, tool))
      return finish({
        status: 'succeeded',
        reason: null,
        message: String(result.text ?? ''),
        commandId,
        verified: {
          pos: verified.pos ?? null,
          products: verified.products ?? null,
          dist: verified.dist ?? null,
          from: verified.from ?? null,
          product: verified.product ?? null,
          prefab: verified.prefab ?? null,
          gained: verified.gained ?? null,
          used: verified.used ?? null,
          made: verified.made ?? null,
          hand: verified.hand ?? null,
          hungerGained: verified.hungerGained ?? null,
          healthGained: verified.healthGained ?? null,
          how: verified.how ?? null,
        },
      })
    },

    /** 便捷：把状态映射成给模型看的一段话（F8/MCP 共用） */
    describe(result) {
      if (!result) return ''
      switch (result.status) {
        case 'succeeded': {
          // 把已核对的变化直接回显给模型，减少不必要的再次 get_state
          const base = result.message || '完成'
          const v = result.verified ?? {}
          const bits = []
          if (Array.isArray(v.products) && v.products.length > 0) {
            for (const g of v.products) bits.push(`${g.prefab} +${g.gained}`)
          } else if (v.product && typeof v.gained === 'number' && v.gained > 0) bits.push(`${v.product} +${v.gained}`)
          else if (v.prefab && typeof v.gained === 'number' && v.gained > 0) bits.push(`${v.prefab} +${v.gained}`)
          if (typeof v.made === 'number' && v.made > 0) bits.push(`成品 +${v.made}`)
          if (String(v.how ?? '').startsWith('auto_equipped')) bits.push(`已自动拿在手里/身上（${v.hand ?? '装备槽'}）`)
          if (typeof v.used === 'number' && v.used > 0) bits.push(`消耗/移出 ${v.used} 个`)
          if (typeof v.hungerGained === 'number' && v.hungerGained > 0) bits.push(`饥饿 +${Math.round(v.hungerGained)}`)
          if (typeof v.healthGained === 'number' && v.healthGained > 0) bits.push(`生命 +${Math.round(v.healthGained)}`)
          if (v.hand) bits.push(`手持 ${v.hand}`)
          if (v.pos) {
            const moved = v.from ? `（${v.from.x},${v.from.z} → ${v.pos.x},${v.pos.z}）` : ''
            const near = typeof v.dist === 'number' ? `，距目标 ${v.dist.toFixed(1)} 格` : ''
            bits.push(`现在位置 (${v.pos.x},${v.pos.z})${moved}${near}`)
          }
          const extra = bits.length > 0 ? `【已核对】${bits.join('，')}` : '【已核对】'
          return `${base}\n${extra}`
        }
        case 'unverified':
          return `游戏说做完了，但没核对上（${result.reason}）：${result.message}`
        case 'unknown':
          return `结果未知（${result.reason}）：**不确定是否成功，不要当成功**。先 get_state 看真实状态，再决定要不要重试`
        case 'rejected':
          return `失败：${result.message}（${result.reason}）`
        default:
          return `失败：${result.message}（${result.reason}）`
      }
    },
  }
}
