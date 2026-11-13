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

/**
 * 动作白名单（M2.0 只开 R1 的移动/停止）。
 * args 里的键就是允许出现的参数名——出现别的键一律拒绝（防模型夹带）。
 */
export const ACTION_SPECS = {
  move_to: {
    riskLevel: 'R1',
    category: 'movement',
    description: '走到某个格子（服务端权威移动，走不到会如实报告）',
    // 真机（0.15.0）：位置变化要等状态文件下一帧（约 1 秒），
    // 只读一次快照会把"其实走到了"误判成 position_unchanged（unverified）。
    verifyWaitMs: 2500,
    args: {
      x: { type: 'number', integer: true, min: -2000, max: 2000, required: true },
      z: { type: 'number', integer: true, min: -2000, max: 2000, required: true },
      timeout: { type: 'number', min: 2, max: 120 },
    },
    /** 核对：位置必须真的变了（或者已经贴着目标 1 格内） */
    verify(before, after, args) {
      const a = before?.actor
      const b = after?.actor
      if (!a || !b || b.tileX === null || b.tileZ === null) return { ok: false, reason: 'no_position_after' }
      const moved = a.tileX !== b.tileX || a.tileZ !== b.tileZ
      const nearTarget =
        typeof args?.x === 'number' && typeof args?.z === 'number' &&
        Math.hypot(b.tileX - args.x, b.tileZ - args.z) <= 1.5
      if (moved || nearTarget) return { ok: true }
      return { ok: false, reason: 'position_unchanged' }
    },
  },
  stop: {
    riskLevel: 'R1',
    category: 'movement',
    description: '立刻停下手里的动作（走路/砍树/打架都停）',
    args: {},
    verify() {
      return { ok: true } // 停止没有可核对的“效果”，只要游戏确认即可
    },
  },
  /**
   * M2.1：按 #N 引用拾取地面普通资源。
   * 只接受 target_ref + snapshot_id，绝不接受 prefab / 坐标 / GUID / 任何授权字段。
   */
  pickup: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '从地上捡起一个普通资源（只能用当前 nearby 快照里的 #N）',
    requiresSnapshot: true, // args.snapshot_id 必须等于当前快照
    verifyWaitMs: 3000,     // 背包变化要等游戏写下一帧状态文件
    args: {
      target_ref: { type: 'string', pattern: '^#[0-9]{1,4}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对：执行前后「背包里该 prefab 的总数」必须增加。
     * 依据：scripts.zip 的 ACTIONS.PICKUP.fn 最终走 inventory:GiveItem；
     * GiveItem 放不下时会把物品丢回地面，而 PICKUP.fn 仍然 return true
     * —— 所以绝不能只看动作有没有报错。
     */
    verify(before, after, args) {
      const prefab = prefabOfRef(before, args?.target_ref)
      if (!prefab) return { ok: false, reason: 'unknown_ref' }
      const b = countInInventory(before, prefab)
      const a = countInInventory(after, prefab)
      if (a > b) return { ok: true, prefab, gained: a - b }
      return { ok: false, reason: 'inventory_unchanged', prefab }
    },
  },
  /**
   * M2.3：按 #N 收获已成熟的试点对象（本阶段只有普通浆果丛 berrybush / berrybush2）。
   * 底层原生动作是 ACTIONS.PICK（不是 ACTIONS.HARVEST）。
   * 只接受 target_ref + snapshot_id，绝不接受 prefab / 坐标 / GUID / 任何授权字段。
   */
  harvest: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '采下一个已经成熟的可收获对象（本阶段只支持浆果丛）',
    requiresSnapshot: true,
    verifyWaitMs: 4000,
    args: {
      target_ref: { type: 'string', pattern: '^#[0-9]{1,4}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对（不能只看原生动作有没有报错）：
     *   ① 背包里该产物数量增加（普通浆果丛的 berries 直接进包）；
     *   ② 同一个对象（prefab + 位置）的 harvest_ready 由 true 变 false（原生 canbepicked 翻转）；
     *   ③ 目标从可收获桶里消失。
     * 三条都不成立就返回 unverified —— 收获确实可能发生但产物落地了，不能因此谎报失败或成功。
     */
    verify(before, after, args) {
      const ref = args?.target_ref
      const target = itemOfRef(before, ref)
      if (!target) return { ok: false, reason: 'unknown_ref' }
      const product = target.product ?? null
      if (product) {
        const b = countInInventory(before, product)
        const a = countInInventory(after, product)
        if (a > b) return { ok: true, product, gained: a - b, how: "inventory" }
      }
      const same = findSameEntity(after, target)
      if (same && same.harvest_ready === false) return { ok: true, product, how: 'state_flipped' }
      if (!same && target.harvest_ready === true) return { ok: true, product, how: 'target_gone' }
      return { ok: false, reason: 'harvest_state_unchanged', product }
    },
  },
  /**
   * SURVIVAL-01：按 #N 采集草丛/树苗（白名单在 Lua 的 gatherrules）。
   * 和 pickup/harvest 完全同构：只接受 target_ref + snapshot_id。
   */
  gather: {
    riskLevel: 'R2',
    category: 'gathering',
    description: '采集草丛（得 cutgrass）或树苗（得 twigs）（只能用当前 nearby 快照里的 #N）',
    requiresSnapshot: true,
    verifyWaitMs: 3500,
    args: {
      target_ref: { type: 'string', pattern: '^#[0-9]{1,4}$', maxLength: 8, required: true },
      snapshot_id: { type: 'string', maxLength: 64, required: true },
    },
    /**
     * 核对：产物进背包 / 同一株的"可采"状态翻转 / 目标消失，三条路径命中任一即可。
     * 产物 prefab 由 Lua 的 gatherrules 决定（grass→cutgrass，sapling→twigs），这里照抄同一张表。
     */
    verify(before, after, args) {
      const item = itemOfRef(before, args?.target_ref)
      if (!item) return { ok: false, reason: 'unknown_ref' }
      const PRODUCT = { grass: 'cutgrass', sapling: 'twigs' }
      const product = PRODUCT[item.prefab]
      if (!product) return { ok: false, reason: 'prefab_not_allowed' }
      const b = countInInventory(before, product)
      const a = countInInventory(after, product)
      if (a > b) return { ok: true, product, gained: a - b }
      const same = findSameEntity(after, item)
      if (!same) return { ok: true, product, how: 'target_gone' }
      return { ok: false, reason: 'gather_state_unchanged', product }
    },
  },
  /**
   * SURVIVAL-01：吃背包里的白名单食物。
   * 模型只能给 prefab 名（白名单在 Lua 的 eatrules），或者干脆不给（服务端挑最该吃的）。
   * **绝不接受** GUID / 路径 / 任意物品名。
   */
  eat: {
    riskLevel: 'R1',
    category: 'survival',
    description: '吃掉背包里的一份食物（只能吃白名单里的基础食物；不填就自动挑）',
    verifyWaitMs: 2500,
    args: {
      food: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32 },
    },
    /**
     * 核对：饥饿值必须真的涨了（或该食物数量减少）。
     * 只看动作返回"吃了"是不够的 —— 原生 EAT 在饿满时也可能被吃掉但没收益。
     */
    verify(before, after, args) {
      const hb = before?.player?.hunger?.current
      const ha = after?.player?.hunger?.current
      const gained = typeof hb === 'number' && typeof ha === 'number' ? ha - hb : null
      const prefab = typeof args?.food === 'string' ? args.food : null
      const used = prefab ? countInInventory(before, prefab) - countInInventory(after, prefab) : 0
      if (gained !== null && gained > 0.5) return { ok: true, hungerGained: gained, used }
      if (used > 0) return { ok: true, used }
      return { ok: false, reason: 'hunger_unchanged' }
    },
  },
  /**
   * SURVIVAL-01：制作白名单里的基础工具（torch / axe / pickaxe）。
   * recipe 必须是白名单里的名字，**不接受**任意配方、建造、摆建筑。
   */
  craft: {
    riskLevel: 'R2',
    category: 'crafting',
    description: '制作一个基础工具（只开放 torch / axe / pickaxe）',
    verifyWaitMs: 3000,
    args: {
      recipe: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32, required: true },
    },
    /**
     * 核对：成品必须真的进了背包（数量 +1）。
     * 材料消耗由 Lua 侧先查（ingredients_missing），这里只确认结果。
     */
    verify(before, after, args) {
      const recipe = String(args?.recipe ?? '')
      const ALLOWED = new Set(['torch', 'axe', 'pickaxe'])
      if (!ALLOWED.has(recipe)) return { ok: false, reason: 'recipe_not_allowed' }
      const b = countInInventory(before, recipe)
      const a = countInInventory(after, recipe)
      if (a > b) return { ok: true, made: a - b }
      return { ok: false, reason: 'craft_not_in_inventory' }
    },
  },
  /**
   * SURVIVAL-01：装备白名单里的手持物品（torch / axe / pickaxe）。
   * 只能装备**背包里已有**的白名单物品，不接受任意物品名 / 槽位。
   */
  equip: {
    riskLevel: 'R1',
    category: 'survival',
    description: '把背包里的工具拿在手里（只开放 torch / axe / pickaxe）',
    verifyWaitMs: 2000,
    args: {
      item: { type: 'string', pattern: '^[a-z_]{1,32}$', maxLength: 32, required: true },
    },
    /**
     * 核对：装备栏（hand）必须真的变成这个物品。
     * 快照里 player.equipment.worn / slots 是游戏写的，不是我们猜的。
     */
    verify(before, after, args) {
      const item = String(args?.item ?? '')
      const ALLOWED = new Set(['torch', 'axe', 'pickaxe'])
      if (!ALLOWED.has(item)) return { ok: false, reason: 'item_not_equippable' }
      const handOf = (snap) => {
        const eq = snap?.player?.equipment
        if (!eq) return null
        const worn = eq.worn ?? eq.slots ?? null
        if (Array.isArray(worn)) {
          const found = worn.find((w) => String(w?.slot ?? w?.type ?? '').toUpperCase() === 'HANDS')
          return found?.prefab ?? found?.item ?? null
        }
        if (worn && typeof worn === 'object') {
          const hands = worn.hands ?? worn.HANDS
          if (typeof hands === 'string') return hands
          if (hands && typeof hands === 'object') return hands.prefab ?? hands.item ?? null
        }
        return null
      }
      const handAfter = handOf(after)
      if (handAfter === item) return { ok: true, hand: handAfter }
      return { ok: false, reason: 'hand_unchanged', hand: handAfter }
    },
  },
}


/** 从快照的 nearby 桶里按 #N 取条目本身（只读快照，不碰游戏） */
function itemOfRef(snapshot, ref) {
  if (!snapshot || typeof ref !== "string") return null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      if (item?.ref === ref) return item
    }
  }
  return null
}

/** 所有桶的条目（顺序无关） */
function allBucketItems(snapshot) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets) return []
  return Array.isArray(buckets) ? buckets.map((g) => g?.items ?? []) : Object.values(buckets)
}

/**
 * 在 after 快照里找"同一个实体"：prefab + 格子坐标一致。
 * 可收获对象（浆果丛）不会移动，所以这个匹配是可靠的；ref 会随排序变化，不能用来认实体。
 */
function findSameEntity(snapshot, target) {
  const pos = target?.position ?? null
  if (!pos) return null
  for (const items of allBucketItems(snapshot)) {
    for (const item of items) {
      const p = item?.position
      if (item?.prefab === target.prefab && p && p.x === pos.x && p.z === pos.z) return item
    }
  }
  return null
}
/** 从快照的 nearby 桶里按 #N 找 prefab（只读快照，不碰游戏） */
function prefabOfRef(snapshot, ref) {
  const buckets = snapshot?.nearby?.buckets
  if (!buckets || typeof ref !== 'string') return null
  const groups = Array.isArray(buckets) ? buckets.map((g) => g?.items ?? []) : Object.values(buckets)
  for (const items of groups) {
    for (const item of items ?? []) {
      if (item?.ref === ref) return item.prefab ?? null
    }
  }
  return null
}

/** 背包里某个 prefab 的总数（含堆叠数量） */
function countInInventory(snapshot, prefab) {
  const items = snapshot?.player?.inventory?.items
  if (!Array.isArray(items)) return 0
  let total = 0
  for (const item of items) {
    if (item?.prefab === prefab) total += Number(item.count ?? 1)
  }
  return total
}
export const OPEN_ACTIONS = Object.keys(ACTION_SPECS)

// ─────────────────────────── 参数校验 ───────────────────────────

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
      const checked = validateArgs(spec, args)
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
        })
      }
      return finish({ status: 'succeeded', reason: null, message: String(result.text ?? ''), commandId })
    },

    /** 便捷：把状态映射成给模型看的一句话（F8/MCP 共用） */
    describe(result) {
      if (!result) return ''
      switch (result.status) {
        case 'succeeded':
          return result.message || '完成'
        case 'unverified':
          return `游戏说做完了，但没核对上（${result.reason}）：${result.message}`
        case 'unknown':
          return `结果未知（${result.reason}），我先不重试，先 get_state 看看`
        case 'rejected':
          return `失败：${result.message}（${result.reason}）`
        default:
          return `失败：${result.message}（${result.reason}）`
      }
    },
  }
}
