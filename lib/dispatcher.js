// M2.0：唯一动作分发入口（Action Dispatcher）
//
// 所有会改游戏状态的动作都必须走这里：F8 内置 AI、MCP 客户端、人工测试，一个都不能绕。
// 它把「校验 → 租约 → 下发 → 等结果 → 核对」串成一条链，并统一返回结构化状态。
//
// 状态机（与任务书一致）：
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
 * 参数归一化（OBSERVATION-02）。
 *
 * 为什么需要：真机会话（session-403656e9）里模型把 target_ref 传成 `15`（数字）和
 * `"15"`（忘了 # 号），被硬拒成 bad_type / bad_format，白烧了 3 次调用。
 *
 * 这里做**纯格式**归一：数字 15 / 字符串 "15" / "#15" 都归一成 "#15"。
 * 不碰安全边界 —— 归一之后仍然要过 snapshot_id 校验和 Lua 的 Resolve，
 * 引用是否有效、实体是否还在、距离够不够，全都照旧检查。
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

  for (const [name, rule] of Object.entries(spec.args)) {
    const value = input[name]
    if (value === undefined || value === null) {
      if (rule.required) return { ok: false, reason: `missing_arg:${name}` }
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

  const finish = (result) => {
    last = { ...result, at: now() }
    return last
  }

  const reject = (reason, message, extra = {}) =>
    finish({ status: 'rejected', reason, message: message ?? reason, ...extra })

  return {
    specs: ACTION_SPECS,

    status() {
      return { lease: control?.status?.() ?? null, last }
    },

    /**
     * 执行一个动作。
     * @param {{tool:string, args:object, owner:string, ownerInstanceId?:string}} request
     */
    async dispatch({ tool, args, owner = 'system', ownerInstanceId } = {}) {
      // 1) 白名单
      const spec = ACTION_SPECS[tool]
      if (!spec) return reject('action_not_allowed', `M2.0 还没开放这个动作（只开放：${OPEN_ACTIONS.join('、')}）`)

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
        // SURVIVAL-01：区分"暂停"和"退出世界" —— 处理方式完全不同
        const secs = Math.max(0, Math.round((before.ageMs ?? 0) / 1000))
        if (before.actor) {
          return reject('game_paused', `游戏暂停了（状态 ${secs} 秒没更新）：引擎不跑 tick，命令排不上队。让玩家切回游戏窗口解除暂停，再 get_state`)
        }
        return reject('game_not_ready', `游戏状态已经 ${secs} 秒没更新，而且读不到角色（可能退出世界了），先 get_state 确认`)
      }

      // 3.5) 需要 #N 的动作：模型给的 snapshot_id 必须就是当前快照，否则 stale_snapshot
      if (spec.requiresSnapshot) {
        const wanted = args?.snapshot_id
        const current = before.nearby?.snapshot_id ?? null
        if (!wanted || wanted !== current) {
          return reject('stale_snapshot', `附近快照变了（你给的 ${wanted ?? '空'}，当前 ${current ?? '无'}），先 get_state 再决定`)
        }
      }
      // 4) 角色（Node 侧只做"看起来能不能控"，最终由 Lua 判定）
      if (!before.actor || before.actor.valid !== true) return reject('actor_invalid', '没有可操作的角色')
      if (before.actor.alive !== true) return reject('actor_dead', '角色已经死了')
      if (before.actor.isGhost) return reject('actor_is_ghost', '角色处于灵魂状态')

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
        // M2.1：pickup 的目标引用（Lua 用它去 N.Resolve，禁止 prefab 搜索）
        target_ref: typeof args?.target_ref === 'string' ? args.target_ref : null,
        created_at: createdAt,
        expires_at: createdAt + commandTtlMs,
        // 多步动作的**内部预算**（秒）。外层只等 timeoutMs，Lua 必须更早收尾，
        // 否则会被判成 result_timeout（真机踩过：gather_area 内部 240 秒、外层 120 秒）。
        // 留 15 秒余量给"写命令 → 游戏 tick → 写结果 → Node 轮询"这一圈。
        budget_s: Math.max(5, Math.floor(timeoutMs / 1000) - 15),
      }

      // 7) 下发（唯一真正写命令文件的地方）
      let result
      try {
        result = await bridge.call(tool, args ?? {}, { timeoutMs, envelope })
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
          'stale_snapshot', 'unknown_ref', 'entity_gone', 'in_limbo', 'prefab_not_allowed',
          'target_not_pickable', 'out_of_range', 'inventory_full', 'actor_busy',
          'missing_component:inventory', 'bad_format:target_ref', 'bad_format:snapshot_id',
          'target_not_harvestable', 'not_ready', 'already_harvested', 'target_busy',
          'harvest_rules_missing', 'wrong_category',
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
      // OBSERVATION-01：把**已核对的结构化变化**一起带回给模型 ——
      // 之前这里只留了 message，于是模型明明拿到了"背包 +1"的证据却看不见，
      // 只能再调一次 get_state 去确认（真机 40 次调用里 24 次是 get_state）。
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
          how: verified.how ?? null,
        },
      })
    },

    /** 便捷：把状态映射成给模型看的一段话（F8/MCP 共用） */
    describe(result) {
      if (!result) return ''
      switch (result.status) {
        case 'succeeded': {
          // OBSERVATION-01：把已核对的变化直接写给模型，省掉一次"为了确认而 get_state"
          const base = result.message || '完成'
          const v = result.verified ?? {}
          const bits = []
          if (Array.isArray(v.products) && v.products.length > 0) {
            for (const g of v.products) bits.push(`${g.prefab} +${g.gained}`)
          } else if (v.product && typeof v.gained === 'number' && v.gained > 0) bits.push(`${v.product} +${v.gained}`)
          else if (v.prefab && typeof v.gained === 'number' && v.gained > 0) bits.push(`${v.prefab} +${v.gained}`)
          if (typeof v.made === 'number' && v.made > 0) bits.push(`成品 +${v.made}`)
          if (v.how === 'auto_equipped') bits.push(`已自动拿在手里（${v.hand}）`)
          if (typeof v.used === 'number' && v.used > 0) bits.push(`吃掉 ${v.used} 个`)
          if (typeof v.hungerGained === 'number' && v.hungerGained > 0) bits.push(`饥饿 +${Math.round(v.hungerGained)}`)
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
