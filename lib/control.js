// M2.0：控制权租约（Control Lease）+ Generation Fencing
//
// 谁需要它：F8 内置 AI 和 MCP 客户端都可能想操作同一个角色。同一时刻只允许一个"控制主体"。
//
// 为什么不能只用进程内布尔或锁：
//   ① 租约要能解释"这一条命令属于哪一代控制权"（generation），旧世代命令必须被拒；
//   ② 进程异常退出后，靠内存锁会永远卡死；
//   ③ 就算将来多开一个 Node 进程，也要能看见同一个租约——所以状态落盘（原子写）。
//
// 设计要点：
//   · 每次**换手**（不同 owner 拿到）generation +1；同一 owner 再次 acquire 视为续租，不涨世代
//     （否则它会把自己正在飞行的命令废掉）。
//   · 租约带环境指纹（runtime/session/shard/actor）：任何一个变了，旧租约立即失效。
//   · 过期时间用墙钟毫秒（和 Lua 的 os.time()*1000 同一坐标系）。
//   · 落盘失败不影响内存租约（进程内仍串行），但会记 lastError 供诊断。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const OWNERS = ['f8_agent', 'mcp_client', 'manual_test', 'system']

/** 默认租约时长：30 秒。F8 每步都会续租；MCP 单次调用后释放。 */
export const DEFAULT_TTL_MS = 30000

export function envFingerprintOf(snapshot) {
  return {
    runtimeId: snapshot?.nearby?.runtime_id ?? null,
    sessionId: snapshot?.identity?.sessionId ?? null,
    shardId: snapshot?.identity?.shardId ?? null,
    actorId: snapshot?.actor?.actorId ?? null,
  }
}

function sameEnv(a, b) {
  if (!a || !b) return false
  return (
    (a.runtimeId ?? null) === (b.runtimeId ?? null) &&
    (a.sessionId ?? null) === (b.sessionId ?? null) &&
    (a.shardId ?? null) === (b.shardId ?? null) &&
    (a.actorId ?? null) === (b.actorId ?? null)
  )
}

export class LeaseManager {
  /**
   * @param {{file?: string, now?: () => number, ttlMs?: number}} [options]
   */
  constructor({ file = '', now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    this.file = file
    this.now = now
    this.ttlMs = ttlMs
    this.lease = null
    this.lastError = null
    this._load()
  }

  // ── 持久化（尽力而为，失败不影响内存状态）──
  _load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.owner) this.lease = raw
    } catch (error) {
      this.lastError = `load: ${error?.message ?? error}`
    }
  }

  _persist() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.lease ?? null), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.lastError = `persist: ${error?.message ?? error}`
    }
  }

  // ── 内部 ──
  _expired(lease = this.lease) {
    if (!lease) return true
    return typeof lease.expiresAt === 'number' && lease.expiresAt <= this.now()
  }

  _clear(reason) {
    const previous = this.lease
    this.lease = null
    this._persist()
    return { previous, reason }
  }

  // ── 对外 ──

  /** 当前租约（可能已过期；调用方一般用 status()） */
  current() {
    return this.lease ? { ...this.lease } : null
  }

  status() {
    const lease = this.current()
    return {
      lease,
      active: Boolean(lease) && !this._expired(lease),
      expired: Boolean(lease) && this._expired(lease),
      ttlMs: this.ttlMs,
      lastError: this.lastError,
    }
  }

  /**
   * 申请控制权。
   * @param {string} owner
   * @param {object} env 环境指纹（runtime/session/shard/actor）
   * @param {{force?: boolean}} [opts] force = 人工接管/测试用
   */
  acquire(owner, env, opts = {}) {
    if (!OWNERS.includes(owner)) return { ok: false, reason: 'bad_owner' }
    const now = this.now()
    const existing = this.lease

    // 环境变了 → 旧租约作废（重启/换世界/换角色都不允许继承控制权）
    if (existing && !sameEnv(existing.env, env)) {
      this._clear('env_changed')
      this.lease = {
        owner,
        generation: (existing.generation ?? 0) + 1,
        env: { ...env },
        acquiredAt: now,
        expiresAt: now + this.ttlMs,
      }
      this._persist()
      return { ok: true, lease: this.current(), reason: 'env_changed_reacquired' }
    }

    if (existing && !this._expired(existing)) {
      if (existing.owner === owner) {
        // 同一 owner：续租，世代不变（否则会废掉自己飞行中的命令）
        existing.expiresAt = now + this.ttlMs
        this._persist()
        return { ok: true, lease: this.current(), reason: 'renewed' }
      }
      if (!opts.force) {
        // 别人正持有：明确拒绝，附上对方是谁
        return { ok: false, reason: 'lease_held', holder: existing.owner, generation: existing.generation, expiresAt: existing.expiresAt }
      }
      // 强制换手（人工接管）：世代 +1，旧命令立刻失效
      this.lease = {
        owner,
        generation: (existing.generation ?? 0) + 1,
        env: { ...env },
        acquiredAt: now,
        expiresAt: now + this.ttlMs,
        forced: true,
      }
      this._persist()
      return { ok: true, lease: this.current(), reason: 'taken_over' }
    }

    // 没租约 / 已过期：给新持有者（世代在上一代基础上 +1）
    this.lease = {
      owner,
      generation: (existing?.generation ?? 0) + 1,
      env: { ...env },
      acquiredAt: now,
      expiresAt: now + this.ttlMs,
    }
    this._persist()
    return { ok: true, lease: this.current(), reason: existing ? 'expired_reacquired' : 'acquired' }
  }

  /** 续租（只有持有者能续） */
  renew(owner, env) {
    const lease = this.lease
    if (!lease) return { ok: false, reason: 'no_lease' }
    if (lease.owner !== owner) return { ok: false, reason: 'not_owner', holder: lease.owner }
    if (this._expired(lease)) return { ok: false, reason: 'lease_expired' }
    if (env && !sameEnv(lease.env, env)) return { ok: false, reason: 'env_changed' }
    lease.expiresAt = this.now() + this.ttlMs
    this._persist()
    return { ok: true, lease: this.current(), reason: 'renewed' }
  }

  /** 释放（只有持有者能放；放完不涨世代，下一次 acquire 自然会 +1） */
  release(owner) {
    const lease = this.lease
    if (!lease) return { ok: true, reason: 'no_lease' }
    if (lease.owner !== owner) return { ok: false, reason: 'not_owner', holder: lease.owner }
    this._clear('released')
    return { ok: true, reason: 'released' }
  }

  /** 作废（环境变化 / 人工接管 / 紧急停止） */
  invalidate(reason = 'invalidated') {
    const had = Boolean(this.lease)
    this._clear(reason)
    return { ok: true, reason, hadLease: had }
  }

  /**
   * 校验"这一次请求"是否还拥有控制权。
   * @param {string} owner
   * @param {{generation?: number, env?: object}} check
   */
  validate(owner, check = {}) {
    const lease = this.lease
    if (!lease) return { ok: false, reason: 'no_lease' }
    if (lease.owner !== owner) return { ok: false, reason: 'not_owner', holder: lease.owner }
    if (this._expired(lease)) return { ok: false, reason: 'lease_expired' }
    if (check.env && !sameEnv(lease.env, check.env)) return { ok: false, reason: 'env_changed' }
    if (check.generation !== undefined && check.generation !== lease.generation) {
      return { ok: false, reason: 'stale_generation', expected: lease.generation }
    }
    return { ok: true, lease: this.current() }
  }
}

/** 默认租约文件位置（项目运行目录下；`.runtime/` 已 gitignore） */
export function defaultLeaseFile(root) {
  return join(root, '.runtime', 'm2-control.json')
}
