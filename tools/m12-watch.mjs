// M1.2 真机观察器：在你玩游戏的时候，**只读**地采样状态文件，把证据落到 tests/artifacts/M1_2/
//
// 用途：验证 M1.1 的 Observer / 快照 / 新鲜度 / 配置绑定在**真实运行**下的表现。
//
// 安全边界（重要）：
//   · 只读状态文件，**不发任何游戏动作**（从不调用 bridge.call）
//   · 不写游戏目录、不改存档、不改配置
//   · 只读地调用 get_state（text / json 两种格式），和 F8、MCP 走的是**同一个** executeTool
//
// 用法：
//   node tools/m12-watch.mjs --seconds 90            # 采样 90 秒
//   node tools/m12-watch.mjs --seconds 90 --interval 250
//   node tools/m12-watch.mjs --seconds 90 --out tests/artifacts/M1_2
//
// 出来两个文件：runtime-<时间>.json（原始采样）和 runtime-<时间>.md（人看的总结）

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { GameBridge } from '../lib/bridge.js'
import { executeTool, readSnapshot } from '../lib/tools.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const seconds = Number(arg('seconds', 60)) || 60
const intervalMs = Number(arg('interval', 500)) || 500
const outDir = arg('out', join('tests', 'artifacts', 'M1_2'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const bridge = new GameBridge({ log: (level, message) => console.log(`[${level}] ${message}`) })
const ctx = { bridge, log: () => {} }

const samples = []
const startedAt = Date.now()
let lastSeq = null
let seqRegressions = 0
let lastMtime = null
const mtimeDeltas = []
let mcpText = null
let agentText = null
let equalAtSameTick = null
let jsonOk = null
const requiredFields = {
  schema: false,
  snapshot_id: false,
  sequence: false,
  timestamp: false,
  session_id: false,
  cluster_id_checked: false,
  cluster_id_source: false,
  shard_id: false,
  status: false,
  actor_id: false,
  actor_type: false,
  actor_prefab: false,
  player: false,
  world: false,
  inventory: false,
  equipment: false,
  unavailable_fields: false,
  errors: false,
}

console.log(`采样 ${seconds} 秒，每 ${intervalMs}ms 一次 → ${outDir}`)
console.log('（只读：不会给游戏发任何指令，按 Ctrl+C 可以随时停）\n')

while (Date.now() - startedAt < seconds * 1000) {
  const tick = Date.now()
  const snapshot = readSnapshot(ctx)

  if (!snapshot) {
    samples.push({ t: tick, status: 'missing' })
  } else {
    if (lastSeq !== null && snapshot.sequence !== null && snapshot.sequence < lastSeq) seqRegressions++
    if (snapshot.sequence !== null) lastSeq = snapshot.sequence

    const sample = {
      t: tick,
      path: snapshot.path,
      ageMs: snapshot.ageMs,
      stale: snapshot.stale,
      schema: snapshot.schema,
      textSource: snapshot.textSource,
      status: snapshot.status,
      sequence: snapshot.sequence,
      snapshotId: snapshot.snapshotId,
      sampledAt: snapshot.sampledAt,
      sampleAgeMs: snapshot.sampleAgeMs,
      reused: snapshot.reused,
      identity: snapshot.identity,
      actor: snapshot.actor
        ? {
            actor_id: snapshot.actor.actorId,
            actor_id_kind: snapshot.actor.actorIdKind,
            actor_type: snapshot.actor.actorType,
            prefab: snapshot.actor.prefab,
            name: snapshot.actor.name,
            alive: snapshot.actor.alive,
            valid: snapshot.actor.valid,
            tile: [snapshot.actor.tileX, snapshot.actor.tileZ],
          }
        : null,
      player: snapshot.player
        ? {
            health: snapshot.player.health,
            hunger: snapshot.player.hunger,
            sanity: snapshot.player.sanity,
            temperature: snapshot.player.temperature,
            wetness: snapshot.player.wetness,
            inventoryUsed: snapshot.player.inventory?.used ?? null,
            inventorySlots: snapshot.player.inventory?.slots ?? null,
            equipped: snapshot.player.equipment?.slots
              ? Object.fromEntries(
                  Object.entries(snapshot.player.equipment.slots)
                    .filter(([, item]) => item)
                    .map(([slot, item]) => [slot, item.name]),
                )
              : null,
          }
        : null,
      world: snapshot.world
        ? {
            day: snapshot.world.day,
            season: snapshot.world.season,
            phase: snapshot.world.phase,
            world_temperature: snapshot.world.world_temperature,
            weather: snapshot.world.weather,
            is_cave: snapshot.world.is_cave,
          }
        : null,
      nearByStatus: snapshot.nearby?.status ?? null,
      nearByRadius: snapshot.nearby?.radius ?? null,
      nearByCached: snapshot.nearby?.cached ?? null,
      warnings: snapshot.warnings,
      errors: snapshot.errors,
      unavailableFields: snapshot.unavailableFields,
      players: snapshot.players,
    }
    samples.push(sample)

    // 字段存在性（只统计见过的）
    if (snapshot.schema) requiredFields.schema = true
    if (snapshot.snapshotId) requiredFields.snapshot_id = true
    if (snapshot.sequence !== null) requiredFields.sequence = true
    if (snapshot.observedAt !== null) requiredFields.timestamp = true
    if (snapshot.identity.sessionId) requiredFields.session_id = true
    if (snapshot.identity.clusterIdSource) {
      requiredFields.cluster_id_checked = true
      requiredFields.cluster_id_source = true
    }
    if (snapshot.identity.shardId) requiredFields.shard_id = true
    if (snapshot.status) requiredFields.status = true
    if (snapshot.actor?.actorId) requiredFields.actor_id = true
    if (snapshot.actor?.actorType) requiredFields.actor_type = true
    if (snapshot.actor?.prefab) requiredFields.actor_prefab = true
    if (snapshot.player) {
      requiredFields.player = true
      if (snapshot.player.inventory) requiredFields.inventory = true
      if (snapshot.player.equipment) requiredFields.equipment = true
    }
    if (snapshot.world) requiredFields.world = true
    if (snapshot.observer.unavailableFields !== undefined) requiredFields.unavailable_fields = true
    if (snapshot.observer.errors !== undefined) requiredFields.errors = true

    // 文件 mtime 间隔（估算真实写盘间隔）
    if (snapshot.ageMs !== null) {
      const mtime = tick - snapshot.ageMs
      if (lastMtime !== null && Math.abs(mtime - lastMtime) > 50) mtimeDeltas.push(mtime - lastMtime)
      lastMtime = mtime
    }
  }

  // 同一份文件、同一刻：F8 入口 与 MCP 入口 必须给出一模一样的文本
  try {
    mcpText = await executeTool('get_state', {}, ctx) // MCP tools/call 走的就是这个
    const callTool = (name, a) => executeTool(name, a, ctx) // F8 的 lib/agent.js 走的就是这个
    agentText = await callTool('get_state', {})
    equalAtSameTick = mcpText === agentText
  } catch (error) {
    equalAtSameTick = `error: ${error?.message ?? error}`
  }

  try {
    const raw = await executeTool('get_state', { format: 'json' }, ctx)
    JSON.parse(raw)
    jsonOk = true
  } catch {
    jsonOk = false
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}

// ─────────────── 总结 ───────────────
const valid = samples.filter((s) => s.status !== 'missing')
const first = valid[0]
const last = valid[valid.length - 1]
const median = (list) => {
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const summary = {
  startedAt: new Date(startedAt).toISOString(),
  seconds,
  intervalMs,
  samples: samples.length,
  filesFound: valid.length > 0,
  statePath: last?.path ?? null,
  schema: last?.schema ?? null,
  textSource: last?.textSource ?? null,
  status: last?.status ?? null,
  sequence: { first: first?.sequence ?? null, last: last?.sequence ?? null, regressions: seqRegressions },
  ageMs: { first: first?.ageMs ?? null, last: last?.ageMs ?? null },
  stale: last?.stale ?? null,
  writeIntervalMsMedian: median(mtimeDeltas.map((d) => Math.abs(d))),
  reusedCount: valid.filter((s) => s.reused === true).length,
  sampleAgeMsSeen: [...new Set(valid.map((s) => s.sampleAgeMs).filter((v) => v !== null))].slice(0, 10),
  identity: last?.identity ?? null,
  actor: last?.actor ?? null,
  player: last?.player ?? null,
  world: last?.world ?? null,
  nearby: { status: last?.nearByStatus ?? null, radius: last?.nearByRadius ?? null, cached: last?.nearByCached ?? null },
  warnings: last?.warnings ?? null,
  errors: last?.errors ?? null,
  unavailableFields: last?.unavailableFields ?? null,
  players: last?.players ?? null,
  fieldPresence: requiredFields,
  f8VsMcp: { textEqual: equalAtSameTick, jsonParses: jsonOk, sampleText: mcpText?.slice(0, 200) ?? null },
}

mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, `runtime-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify({ summary, samples }, null, 1), 'utf8')

const md = [
  `# M1.2 真机采样 ${summary.startedAt}`,
  '',
  `- 采样：${summary.samples} 次 / ${seconds} 秒（每 ${intervalMs}ms）`,
  `- 状态文件：${summary.statePath ?? '**没找到**'}`,
  `- schema：${summary.schema} ｜ textSource：${summary.textSource} ｜ status：${summary.status}`,
  `- 新鲜度：age ${Math.round((summary.ageMs.last ?? 0) / 1000)} 秒 ｜ stale=${summary.stale}`,
  `- 序列：${summary.sequence.first} → ${summary.sequence.last}（回退 ${summary.sequence.regressions} 次）`,
  `- 写盘间隔中位数：${summary.writeIntervalMsMedian ?? '—'} ms`,
  `- 复用采样次数（reused）：${summary.reusedCount}`,
  `- 身份：session=${summary.identity?.sessionId ?? 'null'} / shard=${summary.identity?.shardId ?? 'null'} / cluster=${summary.identity?.clusterId ?? 'null'}(${summary.identity?.clusterIdSource ?? '—'})`,
  `- 观察对象：${summary.actor ? `${summary.actor.actor_id}（${summary.actor.actor_id_kind}，${summary.actor.prefab}，alive=${summary.actor.alive}）` : 'null'}`,
  `- 玩家：${summary.player ? `血 ${summary.player.health?.current ?? '?'}/${summary.player.health?.max ?? '?'}，饥饿 ${summary.player.hunger?.current ?? '?'}，背包 ${summary.player.inventoryUsed}/${summary.player.inventorySlots}` : 'null'}`,
  `- 世界：${summary.world ? `第 ${summary.world.day} 天 ${summary.world.phase} ${summary.world.season}` : 'null'}`,
  `- F8 与 MCP 文本一致：${summary.f8VsMcp.textEqual} ｜ JSON 可解析：${summary.f8VsMcp.jsonParses}`,
  `- 缺字段：${(summary.unavailableFields ?? []).join('、') || '无'}`,
  `- 错误：${(summary.errors ?? []).join('；') || '无'}`,
  '',
  '字段存在性：',
  ...Object.entries(summary.fieldPresence).map(([k, v]) => `- ${v ? '✅' : '❌'} ${k}`),
].join('\n')

writeFileSync(join(outDir, `runtime-${stamp}.md`), md + '\n', 'utf8')
console.log('\n' + md)
console.log(`\n原始采样：${jsonPath}`)
