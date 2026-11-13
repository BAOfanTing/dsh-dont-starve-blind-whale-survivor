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

export class LeaseManager {
  /**
   * @param {object} options
   * @param {string} [options.file]          Node 侧权威租约文件（唯一写入者）
   * @param {Array<{dir:string,channel:string}>} [options.authorityDirs]  Lua 可读副本目录
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {string} [options.ownerInstanceId] 本 manager 的默认实例 id
   */
  constructor({ file = '', authorityDirs = [], now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, ownerInstanceId } = {}) {
    this.file = file
    this.lockFile = file ? `${file}.lock` : ''
    this.authorityDirs = authorityDirs
    this.now = now
    this.ttlMs = ttlMs
    this.ownerInstanceId = ownerInstanceId ?? randomUUID()
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
      if (held.expires_at > this.now() || pidAlive(held.pid)) {
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

  /** 锁内执行：读最新 → 决策 → 写 → 释放。写失败即拒绝，不报告成功 */
  _withLock(ownerType, instanceId, fn) {
    const lock = this._acquireLock(ownerType, instanceId)
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
  acquire(ownerType, env, opts = {}) {
    if (!OWNERS.includes(ownerType)) return { ok: false, reason: 'bad_owner' }
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
      // revoking 期间：除 force 外一律不允许抢占
      if (fresh.status === 'revoking' && !opts.force) {
        return { ok: false, reason: 'handover_pending', generation: fresh.generation }
      }
      // 其他情况（不同实例 / 过期 / 环境变化 / force）→ 换代 + 两阶段撤销
      const generation = fresh.generation + 1
      return { ok: true, reason: 'handover_revoking', handover: true,
               record: this._record({ status: 'revoking', generation, ownerType, instanceId, env, previous: fresh }) }
    })
  }

  /**
   * 完成换手：必须读到 Lua 的撤销确认（epoch + generation + runtime 匹配）才发布 active。
   * 拿不到确认 → 保持 revoking（fail-closed），绝不超时后自动放行。
   */
  completeHandover(ack) {
    return this._withLock('system', this.ownerInstanceId, (fresh) => {
      if (!fresh || fresh.status !== 'revoking') return { ok: false, reason: 'no_pending_handover' }
      if (!ack || ack.authority_epoch !== fresh.authority_epoch || Number(ack.generation) !== fresh.generation ||
          ack.runtime_id !== fresh.runtime_id) {
        return { ok: false, reason: 'handover_ack_invalid' }
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
