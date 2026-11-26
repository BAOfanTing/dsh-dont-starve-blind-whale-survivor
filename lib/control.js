// M2.0.2：控制权租约（Control Lease）—— 跨进程互斥 + 权威租约文件
//
// 三条硬规则（对应 M2.0.1 审计的 A/B/C）：
//   1. Node LeaseManager 是权威租约文件的**唯一写入者**；Lua 只读。
//   2. 每个 acquire/renew/release/invalidate 都在 O_EXCL('wx') 跨进程锁内，且**重新读盘**
//      （不再用构造时的内存副本）。
//   3. owner 身份 = owner_type + owner_instance_id；只有两者都相同且在有效期内才续租。
//
// 权威租约文件（Node 写、Lua 读）：
//   · 主文件 `<file>`（默认 .runtime/m2-control.json），只在锁内原子替换
//   · Lua 可读副本发布到文件桥目录：whale_lease.json / whale_io_lease.json
//   · schema: bws.control-lease/1，结构见 _record()
//
// generation 只由这里管理；Lua 不再自行抬高。authority_epoch 用于"权威状态丢失后重建"：
// 旧命令带旧 epoch，新 epoch 的权威文件不会接受它们；文件缺失时 Lua 直接 fail-closed。
//
// 换手（不同实例 / force）采用两阶段：
//   revoking → Lua 观察并 Abort 旧动作、写确认 → completeHandover() 验证确认后才 active。
//   revoking 期间 Lua 拒绝一切动作；拿不到确认绝不自动放行（fail-closed）。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { writeAtomic, withKleiHeader } from './bridge.js'

export const OWNERS = ['f8_agent', 'mcp_client', 'manual_test', 'system']
export const LEASE_SCHEMA = 'bws.control-lease/1'
/** 租约 30s、命令 8s（M2.0.1 审计确认正确，保持） */
export const DEFAULT_TTL_MS = 30000
/** 锁最长持有时间：崩溃后靠它过期恢复 */
export const LOCK_TTL_MS = 5000
/**
 * 换手确认（ACK）的最长有效期：ACK 必须是"这次换手之后"写的，
 * 不能拿一份很久以前的确认来把 revoking 放行。
 */
export const ACK_MAX_AGE_MS = 15000
/** 允许的时钟偏差：Lua 用 os.time()*1000（真实墙钟），和 Date.now() 同源 */
export const ACK_CLOCK_SKEW_MS = 3000

export function envFingerprintOf(snapshot) {
  return {
    runtimeId: snapshot?.nearby?.runtime_id ?? null,
    sessionId: snapshot?.identity?.sessionId ?? null,
    shardId: snapshot?.identity?.shardId ?? null,
    actorId: snapshot?.actor?.actorId ?? null,
  }
}

export function sameEnv(a, b) {
  if (!a || !b) return false
  return (
    (a.runtimeId ?? null) === (b.runtimeId ?? null) &&
    (a.sessionId ?? null) === (b.sessionId ?? null) &&
    (a.shardId ?? null) === (b.shardId ?? null) &&
    (a.actorId ?? null) === (b.actorId ?? null)
  )
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** 校验一份权威租约是否"结构完整可信"（缺字段一律判不可用） */
export function isVerifiableAuthority(a) {
  return Boolean(
    a && typeof a === 'object' &&
    a.schema === LEASE_SCHEMA &&
    typeof a.authority_epoch === 'string' && a.authority_epoch.length > 0 &&
    isInt(a.generation) &&
    typeof a.lease_id === 'string' && a.lease_id.length > 0 &&
    typeof a.owner_type === 'string' && OWNERS.includes(a.owner_type) &&
    typeof a.owner_instance_id === 'string' && a.owner_instance_id.length > 0 &&
    typeof a.expires_at === 'number' && Number.isFinite(a.expires_at) &&
    typeof a.runtime_id === 'string' &&
    typeof a.session_id === 'string' &&
    typeof a.shard_id === 'string' &&
    typeof a.actor_id === 'string' &&
    ['active', 'revoking', 'released', 'expired'].includes(a.status),
  )
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const SLEEP_ARR = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null
function sleepSync(ms) {
  if (SLEEP_ARR) {
    try {
      Atomics.wait(SLEEP_ARR, 0, 0, ms)
      return
    } catch {}
  }
  const end = Date.now() + ms
  while (Date.now() < end) {}
}

export class LeaseManager {
  /**
   * @param {object} options
   * @param {string} [options.file]          Node 侧权威租约文件（唯一写入者）
   * @param {Array<{dir:string,channel:string}>} [options.authorityDirs]  Lua 可读副本目录
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {string} [options.ownerInstanceId] 本 manager 的默认实例 id
   * @param {(level:string, message:string) => void} [options.log] 可选日志回调
   */
  constructor({ file = '', authorityDirs = [], now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, ownerInstanceId, log = () => {} } = {}) {
    this.file = file
    this.lockFile = file ? `${file}.lock` : ''
    this.authorityDirs = authorityDirs
    this.now = now
    this.ttlMs = ttlMs
    this.ownerInstanceId = ownerInstanceId ?? randomUUID()
    this.log = typeof log === 'function' ? log : () => {}
    this.lastError = null
    this.lease = this._readFile()
    // 权威状态丢失 → 新 epoch（旧命令带旧 epoch，绝不会被接受）
    this.epoch = this.lease?.authority_epoch ?? randomUUID()
  }

  // ── 读盘（原子写保证不会读到半截 JSON）──
  _readFile() {
    if (!this.file || !existsSync(this.file)) return null
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return isVerifiableAuthority(raw) ? raw : null
    } catch (error) {
      this.lastError = `read: ${error?.message ?? error}`
      return null
    }
  }

  /** 把权威租约写到主文件 + Lua 可读副本；失败抛错，由 _withLock 变成拒绝 */
  _persistAll(record) {
    const text = JSON.stringify(record)
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true })
      writeAtomic(this.file, text)
    }
    const dirs = typeof this.authorityDirs === 'function' ? this.authorityDirs() : this.authorityDirs
    for (const { dir, channel } of dirs) {
      mkdirSync(dir, { recursive: true })
      writeAtomic(join(dir, 'whale_io_lease.json'), text)
      writeAtomic(join(dir, 'whale_lease.json'), channel === 'persist' ? withKleiHeader(text) : text)
    }
    this.log('info', `[Lease] Wrote ${record.status} to ${dirs.length} dirs: ${text}`)
    this.lease = { ...record }
  }

  // ── 跨进程锁（O_EXCL 'wx'；Windows 上也原子）──
  _acquireLock(ownerType, instanceId) {
    if (!this.lockFile) return { ok: true, token: null }
    mkdirSync(dirname(this.lockFile), { recursive: true })
    const token = {
      owner_type: ownerType,
      owner_instance_id: instanceId,
      pid: process.pid,
      nonce: randomUUID(),
      acquired_at: this.now(),
      expires_at: this.now() + LOCK_TTL_MS,
    }
    try {
      const fd = openSync(this.lockFile, 'wx')
      writeFileSync(fd, JSON.stringify(token), 'utf8')
      closeSync(fd)
      return { ok: true, token }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        this.lastError = `lock: ${error?.message ?? error}`
        return { ok: false, reason: 'lock_error' }
      }
      const held = this._readLock()
      if (!held) return { ok: false, reason: 'lock_busy' }
      if (held.expires_at > this.now() && pidAlive(held.pid)) {
        return { ok: false, reason: 'lock_busy', holder: held }
      }
      // 原子抢清理权：rename 到唯一退休名，只有一个进程能成功
      const retired = `${this.lockFile}.retired-${token.nonce}`
      try {
        renameSync(this.lockFile, retired)
      } catch {
        return { ok: false, reason: 'lock_busy' }
      }
      try { unlinkSync(retired) } catch {}
      try {
        const fd = openSync(this.lockFile, 'wx')
        writeFileSync(fd, JSON.stringify(token), 'utf8')
        closeSync(fd)
        return { ok: true, token }
      } catch {
        return { ok: false, reason: 'lock_busy' }
      }
    }
  }

  _readLock() {
    try {
      const l = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      return l && typeof l === 'object' && l.nonce ? l : null
    } catch {
      return null
    }
  }

  /** 释放锁：必须 nonce 匹配（禁止删别人的锁） */
  _releaseLock(token) {
    if (!token || !this.lockFile) return true
    const held = this._readLock()
    if (!held || held.nonce !== token.nonce) return false
    try {
      unlinkSync(this.lockFile)
      return true
    } catch {
      return false
    }
  }

  /** 锁内执行：读最新 → 决策 → 写 → 释放。遇 lock_busy 短退避重试，写失败即拒绝，不报告成功 */
  _withLock(ownerType, instanceId, fn) {
    let lock = this._acquireLock(ownerType, instanceId)
    for (let attempt = 1; !lock.ok && lock.reason === 'lock_busy' && attempt <= 5; attempt++) {
      sleepSync(attempt * 15)
      lock = this._acquireLock(ownerType, instanceId)
    }
    if (!lock.ok) return { ok: false, reason: lock.reason, holder: lock.holder }
    let result
    try {
      const fresh = this._readFile()
      result = fn(fresh)
      if (result && result.ok && result.record) {
        try {
          this._persistAll(result.record)
        } catch (error) {
          this.lastError = `authority_write_failed: ${error?.message ?? error}`
          result = { ok: false, reason: 'authority_write_failed' }
        }
      }
    } catch (error) {
      this.lastError = `operation: ${error?.message ?? error}`
      result = { ok: false, reason: 'authority_write_failed' }
    } finally {
      if (!this._releaseLock(lock.token)) this.lastError = 'lock_release_nonce_mismatch'
    }
    // 把最终权威记录附到成功结果上（读盘为准）
    if (result?.ok) result.lease = this._readFile()
    return result
  }

  _record({ status, generation, ownerType, instanceId, env, previous }) {
    const now = this.now()
    return {
      schema: LEASE_SCHEMA,
      status,
      authority_epoch: this.epoch,
      generation,
      owner_type: ownerType,
      owner_instance_id: instanceId,
      lease_id: randomUUID(),
      runtime_id: String(env.runtimeId ?? ''),
      session_id: String(env.sessionId ?? ''),
      shard_id: String(env.shardId ?? ''),
      actor_id: String(env.actorId ?? ''),
      acquired_at: now,
      expires_at: now + this.ttlMs,
      previous_owner_type: previous?.owner_type ?? null,
      previous_owner_instance_id: previous?.owner_instance_id ?? null,
    }
  }

  // ── 对外 ──

  /** 读最新权威租约（不取锁；写入是原子 rename，读到的必然是完整版本） */
  readAuthority() {
    const a = this._readFile()
    return a && isVerifiableAuthority(a) ? a : null
  }

  current() {
    return this.readAuthority()
  }

  status() {
    const lease = this.readAuthority()
    return {
      lease,
      active: Boolean(lease) && lease.status === 'active' && lease.expires_at > this.now(),
      expired: Boolean(lease) && lease.expires_at <= this.now(),
      ttlMs: this.ttlMs,
      lastError: this.lastError,
    }
  }

  /**
   * 申请控制权。
   * @param {string} ownerType OWNERS 之一
   * @param {object} env 环境指纹
   * @param {{ownerInstanceId?:string, force?:boolean}} [opts]
   */
  acquire(ownerType, env, opts = {}) {    if (!OWNERS.includes(ownerType)) return { ok: false, reason: 'bad_owner' }
    const instanceId = opts.ownerInstanceId ?? this.ownerInstanceId
    if (typeof instanceId !== 'string' || instanceId.length === 0) return { ok: false, reason: 'unknown_owner_instance' }

    return this._withLock(ownerType, instanceId, (fresh) => {
      const now = this.now()
      if (!fresh) {
        // 权威文件丢失/损坏：换新 epoch 重建（旧 epoch 的命令永远不再被接受）
        this.epoch = randomUUID()
        return { ok: true, reason: 'authority_rebuilt', handover: false,
                 record: this._record({ status: 'active', generation: 1, ownerType, instanceId, env }) }
      }
      this.epoch = fresh.authority_epoch
      const expired = fresh.expires_at <= now
      const envChanged = !sameEnv(
        { runtimeId: fresh.runtime_id, sessionId: fresh.session_id, shardId: fresh.shard_id, actorId: fresh.actor_id },
        env,
      )
      const sameInstance = fresh.owner_type === ownerType && fresh.owner_instance_id === instanceId
      const active = fresh.status === 'active' && !expired && !envChanged

      // 同一实例、有效租约 → 续租（generation 不变）
      if (active && sameInstance && !opts.force) {
        return { ok: true, reason: 'renewed', handover: false,
                 record: { ...fresh, expires_at: now + this.ttlMs } }
      }
      // ★ 上一任已经主动 release：没有"正在跑的动作"要撤销，直接给新租约（active），
      //   不必走 revoking（真机踩到：MCP 每次 tools/call 都 acquire→release，
      //   若把 released 也当换手，下一次调用会被自己的 revoking 挡住）。
      if (fresh.status === 'released') {
        return { ok: true, reason: 'reacquired_after_release', handover: false,
                 record: this._record({ status: 'active', generation: fresh.generation + 1, ownerType, instanceId, env }) }
      }
      // revoking 期间：除 force 外一律不允许抢占。
      // ★ SURVIVAL-01 真机踩到的死锁：控制者进程异常退出、或游戏暂停/世界重载让 ACK 永远写不出来时，
      //   租约就停在 revoking —— 没人能补 ACK，之后所有控制者都拿到 handover_pending，永久卡死。
      //   （真机现象：状态文件 138 秒没更新＝游戏暂停，Lua 不 tick，自然写不出 ACK。）
      //   修法：**过期**的 revoking 允许**发起新一轮换手**（换新 epoch + generation+1），
      //   然后照常走 completeHandover 等 ACK —— **ACK 的五条硬条件一条都没放宽**。
      //   未过期的 revoking 仍然拒绝（不能因为超时就抢别人的换手）。
      if (fresh.status === 'revoking' && !opts.force) {
        if (!expired) {
          return { ok: false, reason: 'handover_pending', generation: fresh.generation }
        }
        this.epoch = randomUUID()
        const generation = fresh.generation + 1
        return { ok: true, reason: 'handover_restarted_after_stale_revoking', handover: true,
                 record: this._record({ status: 'revoking', generation, ownerType, instanceId, env, previous: fresh }) }
      }
      // 其他情况（不同实例 / 过期 / 环境变化 / force）→ 换代 + 两阶段撤销
      const generation = fresh.generation + 1
      return { ok: true, reason: 'handover_revoking', handover: true,
               record: this._record({ status: 'revoking', generation, ownerType, instanceId, env, previous: fresh }) }
    })
  }

  /**
   * 有限等待版的 acquire（M2.2.2 / P2）。
   *
   * 为什么需要它：正常的控制权交接要走两阶段（revoking → 等 Lua 写 ACK → active）。
   * 交接窗口通常只有一两百毫秒，但 `acquire()` 一看到 `revoking` 就立刻返回
   * `handover_pending`，于是真实模型冷启动时会连续浪费 1~2 次工具调用。
   *
   * 这里**只做等待**，不放宽任何条件：
   *   · 每一轮都重新调 `acquire()`（内部会重读权威文件、重算 env、重新校验）；
   *   · 只对**明确的临时状态**等待（`handover_pending`，以及本轮刚发起换手的 `handover_revoking`）；
   *   · 每次等待期间都尝试 `completeHandover(ack)`（ACK 由 Lua 写，五条硬条件仍由它自己校验）；
   *   · 超时就返回最后一次的真实原因，**绝不因为超时就把租约判为有效**；
   *   · 只有 `acquire()` 自己返回 `ok` 才算拿到（epoch/generation/owner/lease_id/env 全部照旧校验）。
   *
   * ⚠ 调用方必须在**提交动作命令之前**调用它。当前链路里 `acquire` 与 dispatcher 的
   * `validate` 都在 `bridge.call()`（真正写命令文件）之前，失败时不会留下任何命令文件。
   *
   * @param {string} ownerType
   * @param {object} env
   * @param {{ownerInstanceId?:string, force?:boolean, maxWaitMs?:number, pollMs?:number,
   *          readAck?:() => any, sleep?: (ms:number)=>Promise<void>}} [opts]
   * @returns {Promise<object>} 与 acquire() 同形状，另加 `waitedMs` 与 `attempts`
   */
  async acquireWithWait(ownerType, env, opts = {}) {
    const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : 3000
    const pollMs = Number.isFinite(opts.pollMs) ? Math.max(20, opts.pollMs) : 175
    const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const readAck = typeof opts.readAck === 'function' ? opts.readAck : null
    // SURVIVAL-01：可选的"游戏还在跑吗"探针。
    // 真机踩到：游戏暂停时引擎不跑 tick，Lua 永远写不出 ACK，于是这里会白白等满 3 秒，
    // 最后只报一句 handover_pending —— 看不出真正原因是"游戏暂停了"。
    // 传了 isGameAlive 就在这里先判一次，暂停就直接返回 game_paused（**不再等租约**）。
    const isGameAlive = typeof opts.isGameAlive === 'function' ? opts.isGameAlive : null
    const startedAt = this.now()
    // 双保险：除了时间上限，还有一个尝试次数上限。
    // 万一注入的时钟不前进（测试假时钟 / 系统时钟回拨），也不会在这里死循环。
    const maxAttempts = Math.max(3, Math.ceil(maxWaitMs / pollMs) + 2)
    let attempts = 0
    let last = null

    for (;;) {
      attempts++
      const acq = this.acquire(ownerType, env, opts)
      last = acq
      // ⚠ 关键：`acquire` 在**发起换手**时也会返回 ok=true（"抢这个动作本身成功了"），
      // 但此时租约还是 revoking，**不能提交动作**。只有真正落到 active 才算拿到。
      if (acq.ok && acq.handover !== true) {
        return { ...acq, waitedMs: this.now() - startedAt, attempts }
      }

      // 只有这两种是"交接正在进行"的临时状态；其他原因（bad_owner / 环境变了）立刻返回
      const transient = acq.handover === true
        || acq.reason === 'handover_pending'
      if (!transient) return { ...acq, waitedMs: this.now() - startedAt, attempts }

      // ★ 交接在等 ACK，但 ACK 是 Lua 写的 —— 游戏暂停时永远等不到。
      //   先问一句"游戏还在跑吗"：不在跑就直接说清楚，别让调用方以为是自己没抢到控制权。
      if (isGameAlive) {
        let alive = true
        try { alive = isGameAlive() !== false } catch { alive = true }
        if (alive === false) {
          return {
            ok: false,
            reason: 'game_paused',
            timedOut: true,
            waitedMs: this.now() - startedAt,
            attempts,
            message: '游戏暂停了（引擎不跑 tick，换手确认写不出来）。让玩家切回游戏窗口解除暂停，再 get_state',
          }
        }
      }

      // 交接没完成时，每一轮都试着用 Lua 的 ACK 收尾。
      // 注意：`handover_pending`（别人已发起换手，我在等）也要试 —— 真实链路里
      // Lua 的 ACK 是下个 tick 才写的，只有反复尝试才能把 revoking 收敛成 active。
      // ACK 的五条硬条件仍由 completeHandover 自己校验，这里不做任何放行判断。
      if (readAck) {
        try { this.completeHandover(readAck()) } catch {}
      }

      if (this.now() - startedAt >= maxWaitMs || attempts >= maxAttempts) {
        return { ...acq, waitedMs: this.now() - startedAt, attempts, timedOut: true }
      }
      await sleep(pollMs)
    }
  }

  /**
   * 完成换手：必须读到 Lua 的撤销确认（epoch + generation + runtime 匹配）才发布 active。
   * 拿不到确认 → 保持 revoking（fail-closed），绝不超时后自动放行。
   */
  /**
   * 完成换手：只有拿到**针对本次换手**、且明确报告"旧动作已清干净"的确认，才发布 active。
   *
   * 安全契约（M2.3 收紧，依据 M2.0.1 审计的 P0 项）：
   *   · epoch / generation / runtime_id / lease_id 必须逐项精确匹配；
   *   · **lease_id 必须存在**（以前是可选的，等于允许一份缺字段的确认放行）；
   *   · **job_cleared 必须是布尔 true**（缺字段 / false / 非布尔一律拒绝）——
   *     这是"旧动作真的停了"的唯一凭据，没有它就不许换手；
   *   · ACK 必须带时间戳、不能早于本次换手、也不能太旧（防重放旧确认）。
   * 任何一条不满足都保持 revoking（fail-closed）。
   */
  completeHandover(ack) {
    return this._withLock('system', this.ownerInstanceId, (fresh) => {
      if (!fresh || fresh.status !== 'revoking') return { ok: false, reason: 'no_pending_handover' }
      if (!ack || typeof ack !== 'object') return { ok: false, reason: 'handover_ack_missing' }
      if (ack.authority_epoch !== fresh.authority_epoch) {
        return { ok: false, reason: 'handover_ack_epoch_mismatch' }
      }
      if (Number(ack.generation) !== fresh.generation) {
        return { ok: false, reason: 'handover_ack_generation_mismatch' }
      }
      if (ack.runtime_id !== fresh.runtime_id) {
        return { ok: false, reason: 'handover_ack_runtime_mismatch' }
      }
      if (typeof ack.lease_id !== 'string' || ack.lease_id === '') {
        return { ok: false, reason: 'handover_ack_lease_id_missing' }
      }
      if (ack.lease_id !== fresh.lease_id) {
        return { ok: false, reason: 'handover_ack_lease_id_mismatch' }
      }
      // ★ 核心：旧动作必须被明确报告为"已经清干净"
      if (ack.job_cleared !== true) {
        return { ok: false, reason: 'handover_job_not_cleared' }
      }
      const ackedAt = Number(ack.acked_at)
      if (!Number.isFinite(ackedAt)) {
        return { ok: false, reason: 'handover_ack_no_timestamp' }
      }
      if (ackedAt < fresh.acquired_at - ACK_CLOCK_SKEW_MS) {
        return { ok: false, reason: 'handover_ack_stale' }
      }
      if (this.now() - ackedAt > ACK_MAX_AGE_MS) {
        return { ok: false, reason: 'handover_ack_expired' }
      }
      return { ok: true, reason: 'handover_completed',
               record: { ...fresh, status: 'active', acquired_at: this.now(), expires_at: this.now() + this.ttlMs } }
    })
  }

  /** 续租：只有 (type, instance) 匹配且在有效期内 */
  renew(ownerType, env, { ownerInstanceId } = {}) {
    const instanceId = ownerInstanceId ?? this.ownerInstanceId
    if (typeof instanceId !== 'string' || !instanceId) return { ok: false, reason: 'unknown_owner_instance' }
    return this._withLock(ownerType, instanceId, (fresh) => {
      if (!fresh) return { ok: false, reason: 'no_lease' }
      if (fresh.owner_type !== ownerType) return { ok: false, reason: 'wrong_owner', holder: fresh.owner_type }
      if (fresh.owner_instance_id !== instanceId) return { ok: false, reason: 'wrong_owner_instance' }
      if (fresh.status !== 'active') return { ok: false, reason: 'stale_lease' }
      if (fresh.expires_at <= this.now()) return { ok: false, reason: 'lease_expired' }
      if (env && !sameEnv({ runtimeId: fresh.runtime_id, sessionId: fresh.session_id, shardId: fresh.shard_id, actorId: fresh.actor_id }, env)) {
        return { ok: false, reason: 'env_changed' }
      }
      return { ok: true, reason: 'renewed', record: { ...fresh, expires_at: this.now() + this.ttlMs } }
    })
  }

  /** 释放：只有 (type, instance) 匹配 */
  release(ownerType, { ownerInstanceId } = {}) {
    const instanceId = ownerInstanceId ?? this.ownerInstanceId
    if (typeof instanceId !== 'string' || !instanceId) return { ok: false, reason: 'unknown_owner_instance' }
    return this._withLock(ownerType, instanceId, (fresh) => {
      if (!fresh || fresh.status === 'released') return { ok: true, reason: 'no_lease' }
      if (fresh.owner_type !== ownerType) return { ok: false, reason: 'wrong_owner', holder: fresh.owner_type }
      if (fresh.owner_instance_id !== instanceId) return { ok: false, reason: 'wrong_owner_instance' }
      return { ok: true, reason: 'released', record: { ...fresh, status: 'released' } }
    })
  }

  /** 作废（紧急停止）：发布 released */
  invalidate(reason = 'invalidated', { ownerType = 'system', ownerInstanceId } = {}) {
    const instanceId = ownerInstanceId ?? this.ownerInstanceId
    return this._withLock(ownerType, instanceId, (fresh) => ({
      ok: true, reason, hadLease: Boolean(fresh),
      record: fresh ? { ...fresh, status: 'released', expires_at: this.now() } : null,
    }))
  }

  /**
   * 校验一次动作请求是否仍拥有控制权（dispatcher 每次必调，**重新读盘**）。
   * 返回 { ok, lease, reason }；lease 是最新的权威记录。
   */
  validate(ownerType, { ownerInstanceId, env, generation, authorityEpoch } = {}) {
    const instanceId = ownerInstanceId ?? this.ownerInstanceId
    const lease = this.readAuthority()
    if (!lease) return { ok: false, reason: 'authority_unavailable' }
    if (lease.status !== 'active') return { ok: false, reason: lease.status === 'revoking' ? 'authority_revoking' : 'stale_lease', lease }
    if (lease.expires_at <= this.now()) return { ok: false, reason: 'lease_expired', lease }
    if (lease.owner_type !== ownerType) return { ok: false, reason: 'wrong_owner', lease }
    if (lease.owner_instance_id !== instanceId) return { ok: false, reason: 'wrong_owner_instance', lease }
    if (generation !== undefined && generation !== lease.generation) return { ok: false, reason: 'stale_generation', lease }
    if (authorityEpoch !== undefined && authorityEpoch !== lease.authority_epoch) return { ok: false, reason: 'authority_epoch_mismatch', lease }
    if (env && !sameEnv({ runtimeId: lease.runtime_id, sessionId: lease.session_id, shardId: lease.shard_id, actorId: lease.actor_id }, env)) {
      return { ok: false, reason: 'env_changed', lease }
    }
    return { ok: true, lease }
  }
}

export function defaultLeaseFile(root) {
  return join(root, '.runtime', 'm2-control.json')
}
