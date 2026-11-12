// Phase 6 真机验证脚本
//
// 干什么（全部只读，除了最后一步需要授权）：
//   ① 等游戏连上 Bridge（游戏必须**未暂停**）
//   ② 读快照，确认 Phase 6 的 threats / environment 段真的由 Lua 采上来了
//   ③ 用只读命令 get_combat_status 验证战斗执行器加载 + 战斗 API 探测结果
//   ④ 用只读命令 probe_combat_api 逐项确认 TryAttack / CanAttack / GetAttackRange 是否存在
//   ⑤ （可选，--combat）授权后对最近的合法普通敌人下发一次 start_combat，观察状态机推进，
//      然后 abort_combat 收尾
//
// 用法：
//   node survival/test/p6-combat.mjs                 # 只读验证
//   node survival/test/p6-combat.mjs --combat        # 额外跑一次真实战斗（会真的打怪！）
//   node survival/test/p6-combat.mjs --combat --target hound
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRIDGE = process.env.BWS_BRIDGE_URL ?? 'http://127.0.0.1:18788'
const TOKEN = (process.env.BWS_TOKEN ?? readFileSync(join(ROOT, '.runtime', 'token.txt'), 'utf8')).trim()
const args = process.argv.slice(2)
const wantCombat = args.includes('--combat')
const targetArg = (() => {
  const index = args.indexOf('--target')
  return index >= 0 ? args[index + 1] : null
})()

async function api(path, options = {}) {
  const url = new URL(BRIDGE + path)
  url.searchParams.set('token', TOKEN)
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  let data = null
  try { data = text.length > 0 ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 300) } }
  return { status: response.status, data }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForGame(timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const status = await api('/api/v1/bridge/status').catch(() => null)
    const sessions = status?.data?.sessions ?? []
    const alive = sessions.find((session) => session.alive === true)
    if (alive !== undefined) return alive
    await sleep(2000)
    const wait = Math.round((Date.now() - started) / 1000)
    if (wait % 10 === 0) console.log(`  等一下…已经等了 ${wait}s（游戏要进世界并且**没有暂停**）`)
  }
  return null
}

async function getState() {
  const response = await api('/api/v1/state')
  return response.data
}

async function command(type, params = {}, options = {}) {
  const enqueue = await api('/api/v1/commands/enqueue', {
    method: 'POST',
    body: {
      type,
      params,
      shard: 'master',
      ...(options.controllerId === undefined ? {} : { controller_id: options.controllerId }),
      ...(options.sessionId === undefined ? {} : { session_id: options.sessionId }),
    },
  })
  if (enqueue.status !== 200) {
    return { ok: false, status: enqueue.status, error: enqueue.data }
  }
  const id = enqueue.data.command.id
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  while (Date.now() < deadline) {
    const list = await api('/api/v1/commands')
    const found = (list.data.commands ?? []).find((entry) => entry.id === id)
    if (found !== undefined && ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(found.status)) {
      return { ok: found.status === 'SUCCEEDED', command: found }
    }
    await sleep(300)
  }
  return { ok: false, error: 'timeout', command_id: id }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const failures = []
function check(condition, message, detail) {
  if (condition) {
    console.log(`  ✅ ${message}`)
  } else {
    console.log(`  ❌ ${message}${detail === undefined ? '' : `（${JSON.stringify(detail)}）`}`)
    failures.push(message)
  }
}

async function main() {
  section('① 等游戏连上')
  const session = await waitForGame()
  if (session === null) {
    console.log('  ❌ 没等到游戏会话：先开游戏、读档进世界、关掉暂停菜单再跑一次')
    process.exitCode = 2
    return
  }
  console.log(`  session=${session.session_id} 玩家=${session.player_status?.prefab ?? '?'} 位置=(${session.player_status?.tile_x ?? '?'},${session.player_status?.tile_z ?? '?'})`)

  section('② 快照里的 Phase 6 数据（threats / environment）')
  const state = await getState()
  const snapshot = state?.snapshot ?? {}
  const threats = snapshot.threats
  const environment = snapshot.environment
  check(threats !== undefined && threats !== null, '快照里有 threats 段（Lua 威胁观察器在工作）', Object.keys(snapshot))
  if (threats !== undefined && threats !== null) {
    console.log(`  敌对 ${threats.hostile_count} 个，追击 ${threats.chasing_count ?? '?'}，出手 ${threats.attacking_count ?? '?'}，Boss ${threats.boss_count ?? '?'}`)
    const first = (threats.threats ?? [])[0]
    if (first !== undefined) {
      console.log(`  最近：${first.prefab} 距离 ${first.distance} 格 hp=${first.hp ?? '?'} 追击=${first.targeting_player} 攻击距离=${first.attack_range ?? '?'}`)
      check(typeof first.distance === 'number', '敌人距离是真实数字')
      check('targeting_player' in first, '敌人是否追击玩家有字段（不是猜的）')
    }
  }
  check(environment !== undefined && environment !== null, '快照里有 environment 段（环境危险读数）', Object.keys(snapshot))
  if (environment !== undefined && environment !== null) {
    console.log(`  季节=${environment.season} 剩余天数=${environment.remaining_days_in_season ?? '?'} 夜=${environment.is_night} 有光=${environment.in_light} 体温=${environment.player_temperature ?? '?'}`)
    check(environment.season !== undefined, '季节来自游戏世界状态')
  }

  section('③ 战斗执行器状态（只读命令 get_combat_status）')
  const combatStatus = await command('get_combat_status', {})
  check(combatStatus.ok, 'get_combat_status 执行成功', combatStatus.error)
  if (combatStatus.ok) {
    const result = combatStatus.command.result ?? {}
    console.log(`  state=${result.state} 目标=${result.target ?? '无'} 命中=${result.hits ?? 0}`)
    const api = result.api ?? {}
    console.log(`  API：${JSON.stringify(api)}`)
    check(api.player_combat === true, '玩家 combat 组件可读')
    check(api.locomotor_goto === true, 'locomotor:GoToPoint 可用（Kiting 移动路径）')
    check(api.try_attack === true || api.buffered_action === true, '至少有原生攻击路径（TryAttack 或 BufferedAction）')
    if (api.try_attack !== true) {
      console.log('  ⚠️ TryAttack 不可用：控制器会退回 BufferedAction(ATTACK)，Kiting 精度会下降')
    }
  }

  section('④ 战斗 API 探测（只读命令 probe_combat_api）')
  const probe = await command('probe_combat_api', {})
  check(probe.ok, 'probe_combat_api 执行成功', probe.error)
  if (probe.ok) {
    console.log(`  ${JSON.stringify(probe.command.result?.api ?? {}, null, 0)}`)
  }

  if (!wantCombat) {
    section('完成（只读验证）')
    summary()
    return
  }

  section('⑤ 真实战斗（需要授权：会真的打怪）')
  const sync = await api('/api/v1/control/sync', {
    method: 'POST',
    body: {
      controller_id: 'P6_TEST',
      session_id: 'P6S',
      mode: 'SUPERVISED',
      lease_seconds: 120,
      reason: 'Phase 6 真机战斗验证',
    },
  })
  check(sync.status === 200, '拿到控制权（SUPERVISED）', sync.data)

  const started = await command('start_combat', {
    confirmed: true,
    radius: 12,
    ...(targetArg === null ? {} : { target_prefab: targetArg }),
    controller_id: 'P6_TEST',
    session_id: 'P6S',
  }, { controllerId: 'P6_TEST', sessionId: 'P6S', timeoutMs: 8_000 })
  console.log(`  下发 start_combat：${started.ok ? '已接受' : '被拒绝'}`)
  if (started.command !== undefined) {
    console.log(`  result=${JSON.stringify(started.command.result)} error=${started.command.error ?? 'null'}`)
  } else {
    console.log(`  error=${JSON.stringify(started.error)}`)
  }

  for (let index = 1; index <= 6; index += 1) {
    await sleep(1500)
    const status = await command('get_combat_status', {})
    const result = status.command?.result ?? {}
    console.log(`  t+${index * 1.5}s 状态=${result.state} 命中=${result.hits ?? 0} 距离=${result.target_distance ?? '?'} 生命=${result.hp_percent ?? '?'}%`)
    if (['COMPLETE', 'ABORTED', 'IDLE'].includes(String(result.state))) break
  }

  section('⑥ 收尾：中止战斗 + 清控制权')
  const aborted = await command('abort_combat', { controller_id: 'P6_TEST', session_id: 'P6S' }, { controllerId: 'P6_TEST', sessionId: 'P6S', timeoutMs: 8_000 })
  console.log(`  abort_combat：${aborted.ok ? '已停止' : '被拒绝'} ${JSON.stringify(aborted.command?.result ?? aborted.error)}`)
  await api('/api/v1/control/sync', {
    method: 'POST',
    body: { controller_id: 'P6_TEST', session_id: 'P6S', mode: 'SUPERVISED', holder: null, lease_seconds: 0, reason: '测试结束' },
  })
  summary()
}

function summary() {
  console.log('')
  if (failures.length === 0) {
    console.log('结论：全部检查通过')
  } else {
    console.log(`结论：${failures.length} 项没通过`)
    for (const failure of failures) console.log(`  · ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('脚本异常：', error)
  process.exitCode = 1
})
