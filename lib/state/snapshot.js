// 状态快照的**唯一**读取/归一化层（Node 侧）
//
// 为什么要它：M1.0 之前有 5 处在各自解析鲸鱼状态文件（游戏缓存、工具、Agent、HUD、测试）。
// M1.1 起：**文件 → normalizeState() → 谁要谁拿**，F8（内置 AI）和 MCP 都走这一条，
// 保证两边看到的是同一份快照、同一套字段。
//
// 数据来源与边界（必须记住）：
//   · 文件由 Lua 的 scripts/whale/bridge.lua 写（唯一写入者），外面只读。
//   · 新格式（schema = bws.state/1）带 data.observer / data.actor / data.player / data.world。
//   · 老格式（只有 text、没有 data.schema）仍然能读：标 textSource = "legacy" 并照原样给文本。
//   · ageMs 用「文件 mtime」算，另外把「这份数据是什么时候采样的」（observer.sample_age_ms）单独给出 ——
//     两者不是一回事：文件可能每秒重写，但采样按 OBSERVER_INTERVAL 才更新一次。

export const STATE_SCHEMA = 'bws.state/1'

/** 状态多久没更新就算"不新鲜"（毫秒）。和 Lua 侧 1 秒写盘 + 网络无关，只看磁盘。 */
export const STALE_MS = 15000

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)

/** 从 bridge.readState() 的返回值里取出状态（兼容传 json 或传整个候选对象） */
export function pickState(stateOrJson) {
  if (!isPlainObject(stateOrJson)) return null
  if (isPlainObject(stateOrJson.json)) return stateOrJson.json
  return stateOrJson
}

/**
 * 把一份状态文件归一化成程序能直接用的对象。
 * @param {object} raw  状态文件解析后的 JSON（= bridge.readState().json）
 * @param {{ageMs?: number, path?: string, now?: number}} [opts]
 */
export function normalizeState(raw, opts = {}) {
  const json = pickState(raw)
  const now = num(opts.now) ?? Date.now()
  const ageMs = num(opts.ageMs) ?? null

  if (!json) {
    return {
      schema: 'none',
      ok: false,
      status: 'missing',
      text: '',
      textSource: 'none',
      errors: ['没有状态文件（游戏没开 / 没进世界 / 模组没装）'],
      unavailableFields: [],
      identity: emptyIdentity(),
      actor: null,
      observer: { snapshotId: null, sequence: null, status: 'missing' },
      ageMs,
      stale: true,
    }
  }

  const data = isPlainObject(json.data) ? json.data : {}
  const observer = isPlainObject(data.observer) ? data.observer : {}
  const schema = str(data.schema) ?? 'legacy'
  const isNew = schema === STATE_SCHEMA

  const text = typeof json.text === 'string' ? json.text : ''
  const status = str(observer.status) ?? (json.ready === true ? 'ok' : 'unknown')

  const errors = Array.isArray(observer.errors) ? observer.errors.map(String) : []
  if (!isNew) errors.push('状态文件是老格式（没有 data.schema），字段可能不全')

  const unavailable = Array.isArray(observer.unavailable_fields) ? observer.unavailable_fields.map(String) : []

  // 采样时间：新格式给的是"数据什么时候采的"；老格式没有，只能退回文件时间
  const sampleAgeMs = num(observer.sample_age_ms)
  const effectiveAgeMs = ageMs === null ? null : ageMs

  const actor = isNew && isPlainObject(data.actor) ? normalizeActor(data.actor) : null
  const player = isNew && isPlainObject(data.player) ? data.player : null
  const world = isNew && isPlainObject(data.world) ? data.world : null

  return {
    schema,
    ok: status === 'ok',
    status,
    sequence: num(observer.sequence) ?? num(json.seq),
    snapshotId: str(observer.snapshot_id),
    observedAt: num(observer.timestamp) ?? num(json.t),
    sampledAt: num(observer.sampled_at),
    reused: observer.reused === true,
    sampleAgeMs,
    mod: str(json.mod),
    // R8.5：源码构建标识（游戏实际加载的那份源码，而不是只有版本号）
    build: str(json.build),
    identity: normalizeIdentity(data.identity),
    actor,
    player,
    world,
    nearby: isNew && isPlainObject(data.nearby) ? data.nearby : null,
    character: isNew && isPlainObject(data.character) ? data.character : null,
    companion: isNew && isPlainObject(data.companion) ? data.companion : null,
    combat: isNew && isPlainObject(data.combat) ? data.combat : null,
    quest_guide: isNew && isPlainObject(data.quest_guide) ? data.quest_guide : null,
    dangerZones: Array.isArray(data.danger_zones) ? data.danger_zones.map((dz) => ({
      x: num(dz?.x),
      z: num(dz?.z),
      radius: num(dz?.radius) ?? 10,
      source: str(dz?.source) ?? 'threat',
      ageS: num(dz?.age_s) ?? 0,
      ttlS: num(dz?.ttl_s) ?? 60,
    })) : [],
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
    reflex: isPlainObject(data.reflex) ? data.reflex : null,
    observer: {
      snapshotId: str(observer.snapshot_id),
      sequence: num(observer.sequence),
      status,
      errors: Array.isArray(observer.errors) ? observer.errors.map(String) : [],
      unavailableFields: unavailable,
    },
    errors,
    unavailableFields: unavailable,
    players: num(data.players),
    mastersim: typeof data.mastersim === 'boolean' ? data.mastersim : null,
    text,
    textSource: text ? (isNew ? 'lua' : 'legacy') : 'none',
    ageMs: effectiveAgeMs,
    stale: effectiveAgeMs === null ? true : effectiveAgeMs > STALE_MS,
    path: opts.path ?? null,
    serverNow: now,
  }
}

function emptyIdentity() {
  return {
    sessionId: null, clusterId: null, clusterIdSource: 'unavailable', shardId: null,
    // TARGET-REFRESH：长期笔记绑定"哪个世界（存档 + 分片）"
    worldKey: null, worldKeySource: 'none',
  }
}

function normalizeIdentity(raw) {
  const identity = isPlainObject(raw) ? raw : {}
  return {
    sessionId: str(identity.session_id),
    clusterId: str(identity.cluster_id),
    clusterIdSource: str(identity.cluster_id_source) ?? 'unavailable',
    shardId: str(identity.shard_id),
    worldKey: str(identity.world_key),
    worldKeySource: str(identity.world_key_source) ?? 'none',
  }
}

function normalizeActor(raw) {
  if (!isPlainObject(raw)) return null
  return {
    actorId: str(raw.actor_id),
    actorIdKind: str(raw.actor_id_kind) ?? 'unknown',
    actorType: str(raw.actor_type) ?? 'unknown',
    prefab: str(raw.prefab),
    name: str(raw.name),
    valid: raw.valid === true,
    alive: raw.alive === true,
    isGhost: raw.is_ghost === true,
    missingComponents: Array.isArray(raw.missing_components) ? raw.missing_components.map(String) : [],
    tileX: num(raw.tile_x),
    tileZ: num(raw.tile_z),
    x: num(raw.x),
    y: num(raw.y),
    z: num(raw.z),
  }
}

/** 给模型看的"这份状态新不新"一句话（F8 和 MCP 都会看到同一句） */
export function freshnessLine(snapshot) {
  if (!snapshot || snapshot.status === 'missing') return ''
  const bits = []
  // 刚写出来的文件不啰嗦（0 秒这种噪音会让人以为出问题）；用 Lua 的文本时它自己已经带快照号
  if (snapshot.ageMs !== null && snapshot.ageMs >= 2000) {
    bits.push(`文件 ${Math.max(0, Math.round(snapshot.ageMs / 1000))} 秒前写过`)
  }
  if (snapshot.sampleAgeMs !== null && snapshot.sampleAgeMs > 1500) {
    bits.push(`数据是 ${Math.round(snapshot.sampleAgeMs / 1000)} 秒前采样的`)
  }
  if (snapshot.reused === true) bits.push('这次没重新采样（观察器间隔未到）')
  // SURVIVAL-01：把"暂停"和"退出"区分开 —— 这两种情况的处理方式完全不同。
  //   · 暂停：游戏还开着、角色还在，只是引擎不跑 tick（窗口失焦/开菜单/开了"思考时暂停"）
  //     → 让玩家切回游戏窗口就能恢复，命令会一直排不上队
  //   · 退出：状态文件停更且进程不在
  //   只靠"文件多少秒没写"分不出来，所以看文件还在不在 + 停更时长：
  //   停更超过 STALE_MS 但文件仍然存在 → 最可能是暂停（真退出时文件一般还在，但客户端进程会消失，
  //   这里拿不到进程信息，所以措辞上只说"最可能"）。
  if (snapshot.stale) {
    const secs = Math.max(0, Math.round((snapshot.ageMs ?? 0) / 1000))
    if (snapshot.actor) {
      bits.push(`⚠ 状态已经 ${secs} 秒没更新：游戏**很可能被暂停了**（窗口失焦 / 开着菜单 / 开了"思考时暂停"）。`
        + ' 暂停时引擎不跑 tick，命令会一直排不上队 —— 先让玩家切回游戏窗口并解除暂停，再 get_state')
    } else {
      bits.push(`⚠ 状态已经 ${secs} 秒没更新，而且读不到角色：游戏可能已经退出世界或关掉了`)
    }
  }
  if (bits.length === 0) return ''
  return `（${bits.join('；')}）\n`
}

/** 桶的展示顺序（与 Lua 的 N.BUCKETS 一致） */
const BUCKET_LABELS = [
  ['threats', '威胁'],
  ['pickupables', '可拾取物'],
  ['harvestables', '可收获'],
  ['food', '食物'],
  ['resources', '资源'],
  ['containers', '容器'],
  ['structures', '建筑'],
  ['creatures', '生物'],
  ['other', '其它'],
]

/**
 * 把 nearby 渲染成几行文本（支持 M1.4 对象结构和 M1.1 数组结构）。
 * 只读快照里的字段：不重新扫描、不重新编号、不重算 Delta、不把 previous_ref 当当前引用。
 */
export function nearbyLines(nearby) {
  if (!nearby) return []
  const status = nearby.status ?? 'unknown'
  const radius = nearby.radius ?? '?'
  // M2.2.2：nearby 的扫描 id 必须进文本（模型调 pickup/harvest 要填的就是它）。
  // 只在可用时打印；error 时绝不回显历史 id。
  const nearbySid = status !== 'error' && nearby.snapshot_id ? String(nearby.snapshot_id) : null
  // OBSERVATION-01：这一帧还剩多久有效（真机上模型思考比快照刷新慢，写出来比让它盲试好）
  const scanInfo = nearby.scan ?? null
  let leftSec = null
  if (scanInfo && typeof scanInfo.scan_seconds === 'number' && typeof scanInfo.age_ms === 'number') {
    leftSec = Math.max(0, scanInfo.scan_seconds - scanInfo.age_ms / 1000)
  }
  const head = `附近（${radius} 格内${nearbySid ? `，Nearby 快照 ID：${nearbySid}` : ''}`
  const leftHint = leftSec !== null ? `，这一帧大约还剩 ${leftSec.toFixed(1)} 秒有效` : ''

  if (status === 'error') {
    return [`附近：暂时读不到（扫描出错：${nearby.error ?? '未知原因'}）`]
  }

  const buckets = nearby.buckets
  const isObjectShape = buckets !== null && typeof buckets === 'object' && !Array.isArray(buckets)

  // 统一成 [{key,label,items}]
  let groups = []
  if (isObjectShape) {
    for (const [key, label] of BUCKET_LABELS) {
      const list = Array.isArray(buckets[key]) ? buckets[key] : []
      if (list.length > 0) groups.push({ key, label, items: list })
    }
    // 出现未知桶名时也带上（防御）
    for (const key of Object.keys(buckets)) {
      if (BUCKET_LABELS.some(([k]) => k === key)) continue
      const list = Array.isArray(buckets[key]) ? buckets[key] : []
      if (list.length > 0) groups.push({ key, label: key, items: list })
    }
  } else if (Array.isArray(buckets)) {
    // M1.1 老结构：[{kind,label,items}]
    groups = buckets
      .filter((group) => Array.isArray(group?.items) && group.items.length > 0)
      .map((group) => ({ key: group.kind ?? 'other', label: group.label ?? group.kind ?? '其它', items: group.items }))
  }

  if (status === 'empty' || groups.length === 0) {
    if (status === 'empty') return [`${head}）：没什么值得注意的`]
  }

  let suffix = ''
  if (typeof nearby.total_found === 'number' && typeof nearby.total_returned === 'number' && nearby.truncated === true) {
    suffix = `，只显示 ${nearby.total_returned}/${nearby.total_found} 个`
  }
  const lines = [`${head}${leftHint}${suffix}）：`]
  for (const group of groups) {
    const parts = group.items.map((item) => {
      const label = item.label ?? item.name ?? item.prefab ?? '?'
      const ref = typeof item.ref === 'string' ? `${item.ref} ` : ''
      const pos = item.position ?? (item.tile_x !== undefined ? { x: item.tile_x, z: item.tile_z } : null)
      const where = pos && pos.x !== undefined ? `(${pos.x},${pos.z}) ` : ''
      const distance = item.distance ?? item.dist
      const dist = distance !== undefined ? `距${distance}` : ''
      const hp = item.health !== undefined ? ` ${item.health}/${item.max_health ?? '?'}血` : ''
      const work = item.work_action ? ` 可${item.work_action}` : ''
      // 与 Lua 侧文本一致：堆叠数 >1 时显示（拾取物要能看出"这里有 3 个树枝"）
      const stack = typeof item.stack_size === 'number' && item.stack_size > 1 ? ` ×${item.stack_size}` : ''
      // M2.3：可收获对象必须让模型看出"现在能不能采"（原生 canbepicked）
      const ready = item.harvest_ready === true ? ' 已成熟' : (item.harvest_ready === false ? ' 未成熟' : '')
      return `${ref}${label} ${where}${dist}${hp}${work}${stack}${ready}`.trim()
    })
    lines.push(`  ${group.label}：${parts.join('；')}`)
  }

  const delta = nearby.delta
  if (delta && delta.status === 'ok') {
    const bits = []
    const added = Array.isArray(delta.added) ? delta.added : []
    const removed = Array.isArray(delta.removed) ? delta.removed : []
    const changed = Array.isArray(delta.changed) ? delta.changed : []
    for (const item of added) bits.push(`新出现 ${item.ref ?? ''} ${item.label ?? item.prefab ?? '?'}`.trim())
    if ((delta.removed_count ?? removed.length) > 0) {
      const names = removed.map((item) => item.label ?? item.prefab ?? '?').join('、')
      bits.push(`消失 ${delta.removed_count ?? removed.length} 个（${names}）`)
    }
    for (const item of changed) bits.push(`变化 ${item.ref ?? ''} ${item.label ?? item.prefab ?? '?'}`.trim())
    if (bits.length > 0) lines.push(`  变化：${bits.join('；')}`)
  }

  // not_returned_count 在 Lua 里放在 delta 下（0.13.3 起）；兼容未来放到外层的写法
  const notReturned = nearby.delta?.not_returned_count ?? nearby.not_returned_count
  if (typeof notReturned === 'number' && notReturned > 0) {
    lines.push(`  未列出 ${notReturned} 个（附近还有，但这次没有编号，不能直接对它操作）`)
  }

  // M2.2.2：把"这些 #N 属于哪一份 nearby 快照"写在引用旁边
  if (nearbySid && groups.length > 0) {
    lines.push(`  ↑ 以上 #N 引用属于 Nearby 快照 ID：${nearbySid}；调 pickup/harvest 时 snapshot_id 必须填这个（不要填上面的状态快照序列号）`)
  }

  return lines
}

/**
 * 兜底文本：只有 JSON、没有 Lua 渲染好的 text 时才用（老文件 / 文件被截断）。
 * 正常情况下 text 由 Lua 从**同一份 data** 渲染，Node 不再另写一套完整文案。
 */
export function renderFallbackText(snapshot) {
  if (!snapshot) return '读不到游戏状态。'
  const lines = []
  const head = [snapshot.snapshotId ? `# 状态快照序列号 ${snapshot.snapshotId}` : '# 状态快照序列号 ?']
  if (snapshot.world?.day !== undefined) head.push(`第${snapshot.world.day}天`)
  if (snapshot.world?.phase_name) head.push(snapshot.world.phase_name)
  if (snapshot.world?.season_name) head.push(snapshot.world.season_name)
  head.push(`状态 ${snapshot.status}`)
  lines.push(head.join(' · '))

  if (!snapshot.actor) {
    lines.push('现在没有可观察的角色。')
    for (const error of snapshot.errors) lines.push(`  - ${error}`)
    return lines.join('\n')
  }

  const actor = snapshot.actor
  const player = snapshot.player ?? {}
  const pieces = [actor.name ?? actor.prefab ?? '?']
  if (player.health) pieces.push(`生命 ${Math.floor(player.health.current)}/${Math.floor(player.health.max)}`)
  if (player.hunger) pieces.push(`饥饿 ${Math.floor(player.hunger.current)}/${Math.floor(player.hunger.max)}`)
  if (player.sanity) pieces.push(`理智 ${Math.floor(player.sanity.current)}/${Math.floor(player.sanity.max)}`)
  lines.push(`你：${pieces.join('  ')}`)
  if (actor.tileX !== null && actor.tileZ !== null) lines.push(`位置：(${actor.tileX},${actor.tileZ})`)
  for (const line of nearbyLines(snapshot.nearby)) lines.push(line)
  if (snapshot.unavailableFields.length > 0) {
    lines.push(`读不到的字段：${snapshot.unavailableFields.join('、')}`)
  }
  return lines.join('\n')
}

/** 给 get_state format=json 用的紧凑 JSON（去掉内部字段；**字段名统一 snake_case**，与协议文档一致） */
export function toJsonPayload(snapshot, extras = {}) {
  if (!snapshot) return { ok: false, status: 'missing', errors: ['没有状态文件'] }
  const payload = {
    ok: snapshot.ok,
    schema: snapshot.schema,
    status: snapshot.status,
    sequence: snapshot.sequence,
    snapshot_id: snapshot.snapshotId,
    mod: snapshot.mod,
    // R8.5：源码构建标识（判断游戏实际加载的是哪份源码，而不是只看版本号）
    build: snapshot.build,
    identity: {
      session_id: snapshot.identity.sessionId,
      cluster_id: snapshot.identity.clusterId,
      cluster_id_source: snapshot.identity.clusterIdSource,
      shard_id: snapshot.identity.shardId,
      // TARGET-REFRESH：笔记按 world_key 分开存；换世界后旧坐标不会再被当成当前坐标
      world_key: snapshot.identity.worldKey,
      world_key_source: snapshot.identity.worldKeySource,
    },
    actor: snapshot.actor === null ? null : {
      actor_id: snapshot.actor.actorId,
      actor_id_kind: snapshot.actor.actorIdKind,
      actor_type: snapshot.actor.actorType,
      prefab: snapshot.actor.prefab,
      name: snapshot.actor.name,
      valid: snapshot.actor.valid,
      alive: snapshot.actor.alive,
      is_ghost: snapshot.actor.isGhost,
      missing_components: snapshot.actor.missingComponents,
      tile_x: snapshot.actor.tileX,
      tile_z: snapshot.actor.tileZ,
      x: snapshot.actor.x,
      y: snapshot.actor.y,
      z: snapshot.actor.z,
    },
    player: snapshot.player,
    world: snapshot.world,
    warnings: snapshot.warnings,
    nearby: snapshot.nearby,
    observer: {
      snapshot_id: snapshot.observer.snapshotId,
      sequence: snapshot.observer.sequence,
      status: snapshot.observer.status,
      age_ms: snapshot.ageMs,
      sample_age_ms: snapshot.sampleAgeMs,
      stale: snapshot.stale,
      errors: snapshot.errors,
      unavailable_fields: snapshot.unavailableFields,
    },
  }
  // OBSERVATION-01：笔记/额外要求作为 JSON **内部字段**返回。
  // 之前是 notesPrefix(ctx) + JSON.stringify(...) —— 拼在 JSON 前面会让整段不再是合法 JSON，
  // 模型如果按 JSON 解析就全错。这里保证 JSON.parse 一定成功。
  if (extras.notes) {
    payload.notes = { is_historical: true, content: String(extras.notes) }
  }
  if (extras.extraInstructions) {
    payload.player_instructions = String(extras.extraInstructions)
  }
  if (snapshot.quest_guide) {
    payload.quest_guide = snapshot.quest_guide
  }
  return payload
}
