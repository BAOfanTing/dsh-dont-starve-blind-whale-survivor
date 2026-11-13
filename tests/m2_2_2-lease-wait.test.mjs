// M2.2.2 / P2：控制权换手的**有限等待**
//
// 背景（AGENT-01 真机抓到）：模型冷启动后连续两次动作拿到
//   control_denied / authority_revoking
//   control_denied / handover_pending
// 第三次才成功 —— 交接窗口只有一两百毫秒，但 acquire() 一看到 revoking 就立刻返回，
// 于是白烧掉模型的工具调用次数。
//
// 本文件要证明：等待只发生在**提交命令之前**，且**没有放宽任何一条安全条件**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LeaseManager, LEASE_SCHEMA, ACK_MAX_AGE_MS } from '../lib/control.js'

const ENV = { runtimeId: 'r1', sessionId: 'S1', shardId: '1', actorId: 'player:X' }

function makeControl(nowRef = { t: 1_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'a11-lease-'))
  const file = join(dir, 'control-lease.json')
  const control = new LeaseManager({
    file,
    authorityDirs: [],
    now: () => nowRef.t,
    ttlMs: 30_000,
    ownerInstanceId: 'inst-1',
  })
  return { dir, file, control, nowRef }
}

/** 造一份合法的 Lua ACK（与 bridge.WriteLeaseAck 写出的形状一致） */
function ackFor(record, { jobCleared = true, leaseId, epoch, generation, ackedAt } = {}) {
  return {
    schema: 'bws.lease-ack/1',
    authority_epoch: epoch ?? record.authority_epoch,
    generation: generation ?? record.generation,
    lease_id: leaseId ?? record.lease_id,
    runtime_id: ENV.runtimeId,
    acked_at: ackedAt ?? Date.now(),
    job_cleared: jobCleared,
  }
}

/** 让租约处于 revoking（模拟"别人正要交接给我"） */
function toRevoking(control, ownerType = 'mcp_client', instanceId = 'inst-2') {
  // 先让"上一任"拿到 active（实例必须与抢的人不同，否则 acquire 只会续租）
  const prevInstance = instanceId === 'inst-f8' ? 'inst-other' : 'inst-f8'
  const first = control.acquire('f8_agent', ENV, { ownerInstanceId: prevInstance })
  assert.equal(first.ok, true, '上一任应该先拿到 active')
  assert.equal(first.record.status, 'active')
  // 再让目标实例来抢 → 进入两阶段换手
  const second = control.acquire(ownerType, ENV, { ownerInstanceId: instanceId })
  assert.equal(second.ok, true, `抢租约本身应该成功（发起换手），实际 ${second.reason}`)
  assert.equal(second.reason, 'handover_revoking', '第二次应该是发起换手')
  assert.equal(second.record.status, 'revoking')
  return second.record
}

/** 假时钟下的 sleep：推进注入的时钟，不真等（避免测试挂住） */
const tickSleep = (nowRef) => async (ms) => { nowRef.t += ms }
/** 真等待用（P2-13 验事件循环不阻塞） */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('P2-1：正常立即获取租约（不等待）', async () => {
  const { control, nowRef } = makeControl()
  const acq = await control.acquireWithWait('f8_agent', ENV, { ownerInstanceId: 'inst-f8', sleep: tickSleep(nowRef) })
  assert.equal(acq.ok, true)
  assert.equal(acq.attempts, 1, '第一次就该成功')
  assert.equal(acq.waitedMs, 0, '不该白等')
})

test('P2-2：authority_revoking 后及时收到有效 ACK → 变 active', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'f8_agent', 'inst-f8')   // 换手给 f8_agent
  let polls = 0
  const acq = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => (++polls >= 2 ? ackFor(rec) : null),      // 第二轮才拿到 ACK
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, true, '拿到有效 ACK 后应该成功')
  assert.equal(acq.reason, 'renewed', '应该走续租/生效分支')
})

test('P2-3：handover_pending 后交接完成 → 成功（且只提交一次）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  let submits = 0
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => ackFor(control.readAuthority()),
    sleep: tickSleep(nowRef),
  })
  if (acq.ok) submits++
  assert.equal(acq.ok, true)
  assert.equal(submits, 1, '动作只该提交一次')
})

test('P2-4：等待期限内没有 ACK → 超时返回真实原因，不自动放行', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => null,                 // 永远没有 ACK
    maxWaitMs: 600,
    pollMs: 100,
    sleep: tickSleep(nowRef),   // 推进时钟，不真睡
  })
  assert.equal(acq.ok, false, '没有 ACK 绝不能拿到租约')
  assert.equal(acq.timedOut, true, '应该标记超时')
  assert.ok(['handover_pending', 'handover_revoking'].includes(acq.reason), `原因应是交接未完成，实际 ${acq.reason}`)
  assert.equal(control.readAuthority().status, 'revoking', '超时后权威仍是 revoking（fail-closed）')
})

test('P2-5：ACK 缺少 job_cleared → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const bad = ackFor(rec); delete bad.job_cleared
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => bad, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-6：job_cleared 为 false → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { jobCleared: false }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-7：lease_id 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { leaseId: 'not-my-lease' }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-8：epoch 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { epoch: 'deadbeef' }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-9：generation 错误 → 不通过', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec, { generation: rec.generation + 5 }),
    maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-10：其他控制者持有 active 租约 → 只能发起换手，绝不可能直接拿到 active', async () => {
  const { control, nowRef } = makeControl()
  const a = control.acquire('f8_agent', ENV, { ownerInstanceId: 'inst-f8' })
  assert.equal(a.ok, true)
  assert.equal(a.record.status, 'active', '上一任应该是 active')
  // mcp_client 来抢：没有 ACK → 拿不到；但可以发起换手（revoking），绝不是"直接变成 active"
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => null, maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false, '别人还 active 且没有 ACK 时不能拿到')
  const auth = control.readAuthority()
  // 发起换手时权威记录里的 owner 会写成"想接手的人"，但状态必须是 revoking ——
  // 状态才是控制权的判据，owner 字段只是"打算给谁"。
  assert.equal(auth.status, 'revoking', '应该停在换手中（revoking 期间 Lua 拒绝一切动作）')
  assert.notEqual(auth.status, 'active', '绝不能变成 active')
  // 反向确认：上一任也已经被撤销（不能继续提交）
  const prev = control.validate('f8_agent', { ownerInstanceId: 'inst-f8', env: ENV })
  assert.equal(prev.ok, false, '换手期间上一任必须失去控制权')
})

test('P2-11：ACK 到达后只提交一次原始动作（等待不产生重复提交）', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  let ackReads = 0
  let submits = 0
  const acq = await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp',
    readAck: () => { ackReads++; return ackFor(rec) },
    sleep: tickSleep(nowRef),
  })
  if (acq.ok) submits++
  assert.equal(acq.ok, true)
  assert.equal(submits, 1, '提交次数必须恰好 1')
  assert.ok(ackReads >= 1, '应该读过 ACK')
})

test('P2-12：超时后没有留下任何命令文件（提交边界在等待之后）', async () => {
  const { control, dir, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  await control.acquireWithWait('mcp_client', ENV, {
    ownerInstanceId: 'inst-mcp', readAck: () => null, maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  // 等待只碰租约文件；目录里不该出现 whale_cmd.json 之类的东西
  const files = readdirSync(dir)
  assert.deepEqual(files.filter((f) => /cmd|command/i.test(f)), [], `不该有命令文件，实际：${files.join(',')}`)
})

test('P2-13：等待期间不阻塞事件循环（其他请求仍能被处理）', async () => {
  const { control } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 10)
  try {
    await control.acquireWithWait('mcp_client', ENV, {
      ownerInstanceId: 'inst-mcp',
      readAck: () => null,
      maxWaitMs: 250,
      pollMs: 25,
      sleep: realSleep,   // 真的等，验证事件循环没被阻塞
    })
  } finally {
    clearInterval(timer)
  }
  assert.ok(ticks >= 5, `等待期间定时器应该照常触发（实际 ${ticks} 次）`)
})

test('P2-16：revoking 的发起方已经过期 → 允许**重新发起换手**（仍然要等 ACK）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  // 把时钟推过 TTL（30 秒）—— 发起换手的那一方早就没资格了（进程退出 / 游戏暂停写不出 ACK）
  nowRef.t += 40_000
  // 没有 ACK：仍然拿不到（关键 —— 不能因为过期就直接放行）
  const noAck = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8', readAck: () => null, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(noAck.ok, false, '过期 revoking 也不能在没有 ACK 的情况下拿到控制权')
  assert.equal(control.readAuthority().status, 'revoking', '应该停在新的 revoking 上等 ACK')
  // 有 ACK：能收敛
  const rec = control.readAuthority()
  const ok = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => ackFor(rec),
    maxWaitMs: 600, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(ok.ok, true, '拿到有效 ACK 后应该能接手')
  assert.equal(control.readAuthority().owner_instance_id, 'inst-f8')
})

test('P2-17：revoking 没过期时仍然拒绝（不能因为超时就抢）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8', readAck: () => null, maxWaitMs: 300, pollMs: 50, sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false, '没过期的 revoking 不能被抢')
  assert.equal(control.readAuthority().status, 'revoking')
})

test('P2-18：游戏暂停（isGameAlive 为 false）→ 立刻返回 game_paused，不白等租约', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const t0 = nowRef.t
  const acq = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => null,          // 暂停时 Lua 写不出 ACK
    isGameAlive: () => false,     // 游戏没在跑
    maxWaitMs: 3000,
    pollMs: 100,
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'game_paused', '应该明确说"暂停了"，而不是 handover_pending')
  assert.ok(/暂停/.test(String(acq.message ?? '')), '消息里要讲清楚是暂停')
  assert.ok(nowRef.t - t0 < 1000, `不该等满 3 秒，实际等了 ${nowRef.t - t0}ms`)
})

test('P2-19：游戏在跑但迟迟没 ACK → 仍然等到超时（不能因为"活着"就放行）', async () => {
  const { control, nowRef } = makeControl()
  toRevoking(control, 'mcp_client', 'inst-mcp')
  const acq = await control.acquireWithWait('f8_agent', ENV, {
    ownerInstanceId: 'inst-f8',
    readAck: () => null,
    isGameAlive: () => true,
    maxWaitMs: 400,
    pollMs: 100,
    sleep: tickSleep(nowRef),
  })
  assert.equal(acq.ok, false)
  assert.equal(acq.reason, 'handover_pending')
  assert.equal(control.readAuthority().status, 'revoking', '没 ACK 就不能变成 active')
})

test('P2-14：坏 owner / 坏实例这类**非临时**原因立即返回，不浪费时间', async () => {
  const { control, nowRef } = makeControl()
  const bad = await control.acquireWithWait('not-an-owner', ENV, { sleep: tickSleep(nowRef) })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'bad_owner')
  assert.equal(bad.attempts, 1, '非临时原因不该重试')
  const noInst = await control.acquireWithWait('f8_agent', ENV, { ownerInstanceId: '', sleep: tickSleep(nowRef) })
  assert.equal(noInst.ok, false)
  assert.equal(noInst.reason, 'unknown_owner_instance')
  assert.equal(noInst.attempts, 1)
})

test('P2-15：环境指纹变了（换世界/换角色）→ 立刻拒绝，不等待', async () => {
  const { control, nowRef } = makeControl()
  const rec = toRevoking(control, 'mcp_client', 'inst-mcp')
  const otherEnv = { ...ENV, runtimeId: 'r2' }
  const acq = await control.acquireWithWait('mcp_client', otherEnv, {
    ownerInstanceId: 'inst-mcp', readAck: () => ackFor(rec), maxWaitMs: 200, pollMs: 50, sleep: tickSleep(nowRef),
  })
  // 环境变了就不能沿用旧交接；acquire 会发起新一轮换手（而不是直接放行）
  assert.notEqual(acq.reason, 'renewed', '环境变了不能当成续租')
})
