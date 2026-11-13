// M2.0.1 审查用：在**独立 Node 进程**里跑一次 LeaseManager.acquire（由 m2_0_1_lease_security.test.mjs 启动）
//
// 用法：node tools/m2_0_1-lease-worker.mjs <leaseFile> <owner> <startAt> [force]
// 输出：一行 JSON（acquire 的结果 + 本进程看到的最终租约文件）
import { readFileSync } from 'node:fs'
import { LeaseManager } from '../lib/control.js'

const [, , file, owner, startAtArg, forceArg] = process.argv
const startAt = Number(startAtArg)
const ENV = { runtimeId: 'r-repro-0001', sessionId: 'sess-R', shardId: '1', actorId: 'player:KU_r' }

// 等到一个共同的时间点，尽量让多个进程同时进入 acquire
const wait = Math.max(0, startAt - Date.now())
setTimeout(() => {
  const c = new LeaseManager({ file, now: () => Date.now(), ttlMs: 30000 })
  const result = c.acquire(owner, ENV, { force: forceArg === 'force' })
  let onDisk = null
  try {
    onDisk = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  process.stdout.write(JSON.stringify({
    ok: result.ok,
    reason: result.reason,
    generation: result.lease?.generation ?? null,
    holder: result.holder ?? null,
    onDisk,
  }))
}, wait)
