// 只读工具实现（M3）
//
// 全部走 M2 的 Bridge Client：readSnapshot() 拿快照 + freshnessOf() 标注新鲜度。
// 每个工具都遵循同一套约定：
//   · 文本 content：给 AI 读的中文摘要，第一行永远是新鲜度提示；
//   · structuredContent：给程序解析的结构化 JSON，含 ok / freshness / 数据本体；
//   · 数据过期不抛错，而是如实标注（除非工具语义要求"必须是当前状态"）。
//
// 所有工具都是**只读**：不移动、不攻击、不采集、不制作、不建造、不丢弃。

import { z } from 'zod'
import { ToolError } from '../schemas/errors.js'
import {
  asBool,
  asDict,
  asList,
  asNum,
  asStr,
  freshnessLine,
  freshnessOf,
  itemLabel,
  nearbyMeta,
  parseItems,
  parseNearbyEntities,
  type Dict,
  type ItemView,
  type NearbyEntity,
} from './snapshot.js'
import type { ToolDefinition, ToolResult } from './definitions.js'

const radiusSchema = z.number().int().min(2).max(20).default(16)
const limitSchema = z.number().int().min(1).max(50).default(20)

/** 通用：取快照 + 新鲜度；游戏没连上时给明确错误 */
async function readState(ctx: { client: import('../bridge/client.js').BridgeClient }, options: { shard?: string | null; force?: boolean } = {}) {
  const read = await ctx.client.readSnapshot({ shard: options.shard ?? null, force: options.force ?? false })
  const snapshot = asDict(read.game.snapshot)
  if (snapshot === null) {
    throw new ToolError('GAME_DISCONNECTED', 'Bridge 里没有可用的游戏快照', {
      hint: '游戏没进世界 / 模组未启用；可以先看 get_bridge_status',
      detail: { session_id: read.game.session.session_id, stale_reason: read.staleReason },
    })
  }
  return { read, snapshot, freshness: freshnessOf(read) }
}

function textResult(lines: string[], structured: Dict): ToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured }
}

// ─────────────────────────── 玩家 ───────────────────────────

function playerView(snapshot: Dict) {
  const player = asDict(snapshot.player)
  if (player === null) return null
  const pos = asDict(player.position)
  const health = asDict(player.health)
  const hunger = asDict(player.hunger)
  const sanity = asDict(player.sanity)
  const temp = asDict(player.temperature)
  const moisture = asDict(player.moisture)
  return {
    valid: asBool(player.valid),
    prefab: asStr(player.prefab),
    name: asStr(player.name),
    guid: asNum(player.guid),
    userid: asStr(player.userid),
    is_ghost: asBool(player.is_ghost),
    tile: pos === null ? null : { x: asNum(pos.tile_x), z: asNum(pos.tile_z) },
    world_position: pos === null ? null : { x: asNum(pos.x), y: asNum(pos.y), z: asNum(pos.z) },
    health: health === null ? null : { current: asNum(health.current), max: asNum(health.max), percent: asNum(health.percent), dead: asBool(health.dead) },
    hunger: hunger === null ? null : { current: asNum(hunger.current), max: asNum(hunger.max), percent: asNum(hunger.percent) },
    sanity: sanity === null ? null : { current: asNum(sanity.current), max: asNum(sanity.max), percent: asNum(sanity.percent) },
    temperature: temp === null ? null : asNum(temp.current),
    moisture: moisture === null ? null : { value: asNum(moisture.value), percent: asNum(moisture.percent) },
  }
}

export function createReadTools(): ToolDefinition[] {
  return [
    {
      name: 'get_game_status',
      title: '游戏总状态',
      description:
        '一次拿到当前游戏状态总览：会话/分片、玩家、世界、背包摘要，以及这份数据有多新。数据过期时会明确标记 stale。',
      schema: z.object({
        include_raw: z.boolean().default(false).describe('是否附带原始快照 JSON（体积较大）'),
        shard: z.string().min(1).max(32).optional().describe('指定分片（master/caves），不填则自动选有玩家的那个'),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { include_raw?: boolean; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const player = playerView(snapshot)
        const world = asDict(snapshot.world)
        const inventory = asDict(snapshot.inventory)
        const items = parseItems(inventory)
        const meta = nearbyMeta(snapshot)
        const lines = [
          freshnessLine(freshness),
          `会话：${freshness.session_id} [${freshness.shard ?? '?'}] alive=${freshness.session_alive}`,
          player === null
            ? '玩家：无'
            : `玩家：${player.name ?? player.prefab ?? '?'} 生命 ${player.health?.percent ?? '?'}% 饥饿 ${player.hunger?.percent ?? '?'}% 理智 ${player.sanity?.percent ?? '?'}%`,
          world === null
            ? '世界：无'
            : `世界：第 ${asNum(world.day) ?? '?'} 天 ${asStr(world.phase) ?? '?'} ${asStr(world.season) ?? '?'} 温度 ${asNum(world.temperature) ?? '?'}`,
          inventory === null ? '背包：无' : `背包：${asNum(inventory.slots) ?? '?'} 格，已用 ${asNum(inventory.used) ?? items.length}`,
          meta.available ? `附近：扫到 ${meta.scanned ?? '?'} 个实体，返回 ${meta.returned ?? '?'} 个` : '附近：无扫描数据',
        ]
        return textResult(lines, {
          ok: true,
          freshness,
          session: { session_id: freshness.session_id, shard: freshness.shard, alive: freshness.session_alive },
          player,
          world:
            world === null
              ? null
              : {
                  day: asNum(world.day),
                  phase: asStr(world.phase),
                  season: asStr(world.season),
                  temperature: asNum(world.temperature),
                  is_raining: asBool(asDict(world.weather)?.is_raining),
                },
          inventory: inventory === null ? null : { slots: asNum(inventory.slots), used: asNum(inventory.used) ?? items.length, items },
          nearby: meta,
          ...(args.include_raw === true ? { raw_snapshot: snapshot } : {}),
        })
      },
    },
    {
      name: 'get_player_status',
      title: '玩家状态',
      description: '当前玩家的生命、饥饿、理智、体温、潮湿、是否死亡、所在格子坐标。',
      schema: z.object({
        shard: z.string().min(1).max(32).optional().describe('指定分片（master/caves），不填则自动选有玩家的那个'),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const player = playerView(snapshot)
        if (player === null) {
          throw new ToolError('GAME_DISCONNECTED', '这个分片里没有玩家', {
            hint: '玩家可能在另一个分片（洞穴/主世界）；试试指定 shard',
            detail: { session: freshness.session_id, shard: freshness.shard },
          })
        }
        const hp = player.health
        const lines = [
          freshnessLine(freshness),
          `玩家：${player.name ?? player.prefab ?? '?'}${player.is_ghost === true ? '（幽灵）' : ''}`,
          hp === null ? '生命：无' : `生命：${hp.current}/${hp.max}（${hp.percent}%）${hp.dead === true ? ' 已死亡' : ''}`,
          player.hunger === null ? '饥饿：无' : `饥饿：${player.hunger.current}/${player.hunger.max}（${player.hunger.percent}%）`,
          player.sanity === null ? '理智：无' : `理智：${player.sanity.current}/${player.sanity.max}（${player.sanity.percent}%）`,
          player.temperature === null ? '体温：无' : `体温：${player.temperature}`,
          player.tile === null ? '位置：未知' : `位置：格子 (${player.tile.x}, ${player.tile.z})`,
        ]
        return textResult(lines, { ok: true, freshness, player })
      },
    },

    {
      name: 'get_inventory',
      title: '背包',
      description: '背包格子使用情况、每件物品的数量/耐久/新鲜度/燃料/护甲，以及手持与装备栏。',
      schema: z.object({
        include_empty: z.boolean().default(false).describe('是否包含空格子信息'),
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { include_empty?: boolean; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const inventory = asDict(snapshot.inventory)
        if (inventory === null) {
          throw new ToolError('GAME_DISCONNECTED', '这个分片里没有背包数据', { detail: { shard: freshness.shard } })
        }
        const items = parseItems(inventory)
        const equipmentRaw = asDict(inventory.equipment)
        const equipment: Record<string, ItemView | null> = {}
        for (const slot of ['hands', 'head', 'body']) {
          const item = asDict(equipmentRaw?.[slot])
          equipment[slot] = item === null || item === undefined
            ? null
            : (parseItems({ items: [item] })[0] ?? null)
        }
        const slots = asNum(inventory.slots)
        const used = asNum(inventory.used) ?? items.length
        const lines = [
          freshnessLine(freshness),
          `背包：${used}/${slots ?? '?'} 格${asBool(inventory.is_full) === true ? '（已满）' : ''}`,
          ...items.map((item) => `  · ${itemLabel(item)}`),
          ...Object.entries(equipment)
            .filter(([, item]) => item !== null)
            .map(([slot, item]) => `装备[${slot}]：${itemLabel(item as ItemView)}`),
        ]
        if (items.length === 0) lines.push('  （空）')
        return textResult(lines, {
          ok: true,
          freshness,
          slots,
          used,
          is_full: asBool(inventory.is_full),
          empty_slots: args.include_empty === true && slots !== null ? slots - used : null,
          items,
          equipment,
        })
      },
    },

    {
      name: 'get_world_status',
      title: '世界状态',
      description: '天数、季节与季节进度、昼夜阶段、天气（雨/雪/潮湿/酸雨）、温度、月相；洞穴分片额外给出洞穴相位。',
      schema: z.object({
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const world = asDict(snapshot.world)
        if (world === null) {
          throw new ToolError('GAME_DISCONNECTED', '这个分片里没有世界数据', { detail: { shard: freshness.shard } })
        }
        const weather = asDict(world.weather)
        const time = asDict(world.time)
        const moon = asDict(world.moon)
        const cave = asDict(world.cave)
        const view = {
          day: asNum(world.day),
          cycles: asNum(world.cycles),
          phase: asStr(world.phase),
          is_day: asBool(world.is_day),
          is_dusk: asBool(world.is_dusk),
          is_night: asBool(world.is_night),
          season: asStr(world.season),
          season_progress: asNum(world.season_progress),
          elapsed_days_in_season: asNum(world.elapsed_days_in_season),
          remaining_days_in_season: asNum(world.remaining_days_in_season),
          temperature: asNum(world.temperature),
          time: time === null ? null : { of_day: asNum(time.of_day), in_phase: asNum(time.in_phase) },
          moon: moon === null
            ? null
            : {
                phase: asStr(moon.phase),
                is_full_moon: asBool(moon.is_full_moon),
                is_new_moon: asBool(moon.is_new_moon),
                is_waxing_moon: asBool(moon.is_waxing_moon),
              },
          weather: weather === null
            ? null
            : {
                is_raining: asBool(weather.is_raining),
                is_snowing: asBool(weather.is_snowing),
                is_wet: asBool(weather.is_wet),
                is_snow_covered: asBool(weather.is_snow_covered),
                is_acid_raining: asBool(weather.is_acid_raining),
                precipitation_rate: asNum(weather.precipitation_rate),
                wetness: asNum(weather.wetness),
                snow_level: asNum(weather.snow_level),
              },
          cave: cave === null
            ? null
            : { phase: asStr(cave.phase), moon_phase: asStr(cave.moon_phase), is_day: asBool(cave.is_day), is_night: asBool(cave.is_night) },
          shard: asStr(world.shard),
        }
        const lines = [
          freshnessLine(freshness),
          `世界：第 ${view.day ?? '?'} 天（cycles ${view.cycles ?? '?'}），${view.phase ?? '?'}，${view.season ?? '?'}`,
          `季节进度：已过 ${view.elapsed_days_in_season ?? '?'} 天 / 还剩 ${view.remaining_days_in_season ?? '?'} 天`,
          `温度：${view.temperature ?? '?'}${view.weather?.is_raining === true ? '，正在下雨' : ''}${view.weather?.is_snowing === true ? '，正在下雪' : ''}`,
          view.moon === null ? '月相：无' : `月相：${view.moon.phase ?? '?'}${view.moon.is_full_moon === true ? '（满月）' : ''}`,
        ]
        return textResult(lines, { ok: true, freshness, world: view })
      },
    },

    // ─────────────────────────── 环境感知 ───────────────────────────

    {
      name: 'get_nearby_entities',
      title: '附近实体',
      description: '列出玩家附近的实体（按距离排序），可按类别过滤。类别来自游戏端扫描：tree/rock/diggable/harvestable/creature/hostile/item/structure/damageable。',
      schema: z.object({
        radius_tiles: radiusSchema,
        limit: limitSchema,
        categories: z.array(z.string().min(1).max(24)).max(10).optional().describe('只返回这些类别，例如 ["tree","harvestable"]'),
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius_tiles?: number; limit?: number; categories?: string[]; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const meta = nearbyMeta(snapshot)
        if (!meta.available) {
          throw new ToolError('NOT_IMPLEMENTED', '这份快照里没有附近实体数据', {
            hint: '实体扫描是每 4 秒一次；等一下再试，或先调用 refresh_game_state',
          })
        }
        const all = parseNearbyEntities(snapshot)
        const limit = args.limit ?? 20
        const wanted = args.categories?.map((c) => c.toLowerCase())
        const filtered = wanted === undefined ? all : all.filter((entity) => wanted.includes(entity.category.toLowerCase()))
        const radius = args.radius_tiles ?? 16
        const within = filtered.filter((entity) => entity.distance === null || entity.distance <= radius)
        const shown = within.slice(0, limit)
        const counts: Record<string, number> = {}
        for (const entity of all) counts[entity.category] = (counts[entity.category] ?? 0) + 1
        const lines = [
          freshnessLine(freshness),
          `附近 ${meta.radius_tiles ?? '?'} 格内扫到 ${meta.scanned ?? '?'} 个实体，返回 ${meta.returned ?? '?'} 个${meta.truncated === true ? '（已裁剪）' : ''}`,
          `类别统计：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
          ...shown.map((entity) => {
            const where = entity.tile_x === null ? '' : ` @(${entity.tile_x},${entity.tile_z})`
            const extra = entity.hp !== null ? ` hp=${entity.hp}` : entity.work_left !== null ? ` work_left=${entity.work_left}` : ''
            return `  · [${entity.category}] ${entity.name ?? entity.prefab}${where} 距离 ${entity.distance ?? '?'}${extra}`
          }),
        ]
        return textResult(lines, {
          ok: true,
          freshness,
          nearby_meta: meta,
          counts,
          total_before_filter: all.length,
          returned: shown.length,
          entities: shown,
        })
      },
    },

    {
      name: 'get_nearby_resources',
      title: '附近资源',
      description: '附近可获取的资源：可采集（草/浆果/花/树苗）、可砍（树）、可开采（石头）、可挖（蘑菇/兔洞）、地面掉落物。',
      schema: z.object({
        radius_tiles: radiusSchema,
        limit: limitSchema,
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius_tiles?: number; limit?: number; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const meta = nearbyMeta(snapshot)
        if (!meta.available) {
          throw new ToolError('NOT_IMPLEMENTED', '这份快照里没有附近数据', { hint: '等一下再试，或先 refresh_game_state' })
        }
        const resourceCategories = new Set(['harvestable', 'tree', 'rock', 'diggable', 'item'])
        const all = parseNearbyEntities(snapshot).filter((entity) => resourceCategories.has(entity.category))
        const radius = args.radius_tiles ?? 16
        const within = all.filter((entity) => entity.distance === null || entity.distance <= radius)
        const shown = within.slice(0, args.limit ?? 20)
        const byCategory: Record<string, NearbyEntity[]> = {}
        for (const entity of within) (byCategory[entity.category] ??= []).push(entity)
        const lines = [
          freshnessLine(freshness),
          `附近 ${radius} 格内资源：${within.length} 个（共 ${meta.scanned ?? '?'} 个实体被扫描）`,
          ...Object.entries(byCategory).map(([category, list]) => `  ${category}（${list.length}）：${list.slice(0, 5).map((e) => e.name ?? e.prefab).join('、')}`),
        ]
        if (within.length === 0) lines.push('  （附近没有可获取的资源）')
        return textResult(lines, {
          ok: true,
          freshness,
          nearby_meta: meta,
          radius_tiles: radius,
          total: within.length,
          returned: shown.length,
          by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
          resources: shown,
        })
      },
    },

    {
      name: 'get_nearby_threats',
      title: '附近威胁',
      description: '附近敌对生物（hostile）与有攻击性的生物（creature 中带 hp 的），按距离排序，用于判断危险程度。',
      schema: z.object({
        radius_tiles: radiusSchema,
        limit: limitSchema,
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius_tiles?: number; limit?: number; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const meta = nearbyMeta(snapshot)
        if (!meta.available) {
          throw new ToolError('NOT_IMPLEMENTED', '这份快照里没有附近数据', { hint: '等一下再试，或先 refresh_game_state' })
        }
        const all = parseNearbyEntities(snapshot)
        const hostiles = all.filter((entity) => entity.category === 'hostile')
        const creatures = all.filter((entity) => entity.category === 'creature' && entity.hp !== null)
        const radius = args.radius_tiles ?? 16
        const inRange = (entity: NearbyEntity) => entity.distance === null || entity.distance <= radius
        const threatHostiles = hostiles.filter(inRange)
        const threatCreatures = creatures.filter(inRange)
        const shown = [...threatHostiles, ...threatCreatures]
          .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
          .slice(0, args.limit ?? 20)
        const nearest = shown[0] ?? null
        const level = threatHostiles.length > 0 ? 'high' : threatCreatures.length > 0 ? 'medium' : 'low'
        const lines = [
          freshnessLine(freshness),
          `威胁等级：${level === 'high' ? '高（附近有敌对生物）' : level === 'medium' ? '中（附近有生物，可能中立）' : '低'}`,
          `敌对 ${threatHostiles.length} 个，带血量的生物 ${threatCreatures.length} 个（半径 ${radius} 格）`,
          nearest === null ? '  最近的威胁：无' : `  最近：${nearest.name ?? nearest.prefab} 距离 ${nearest.distance ?? '?'}${nearest.hp !== null ? ` hp=${nearest.hp}` : ''}`,
          ...shown.slice(1, 8).map((entity) => `  · ${entity.name ?? entity.prefab} 距离 ${entity.distance ?? '?'}${entity.hp !== null ? ` hp=${entity.hp}` : ''}`),
        ]
        return textResult(lines, {
          ok: true,
          freshness,
          nearby_meta: meta,
          radius_tiles: radius,
          threat_level: level,
          hostile_count: threatHostiles.length,
          creature_count: threatCreatures.length,
          nearest,
          threats: shown,
        })
      },
    },

    {
      name: 'get_base_status',
      title: '基地概况',
      description:
        '统计玩家附近的结构物与容器（structure）、光源、可破坏物，用于评估"这里像不像一个基地"。注意：这是基于附近实体扫描的启发式判断，不是游戏内的基地概念。',
      schema: z.object({
        radius_tiles: radiusSchema,
        limit: limitSchema,
        shard: z.string().min(1).max(32).optional(),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { radius_tiles?: number; limit?: number; shard?: string }
        const { snapshot, freshness } = await readState(ctx, { shard: args.shard })
        const meta = nearbyMeta(snapshot)
        if (!meta.available) {
          throw new ToolError('NOT_IMPLEMENTED', '这份快照里没有附近数据', { hint: '等一下再试，或先 refresh_game_state' })
        }
        const all = parseNearbyEntities(snapshot)
        const radius = args.radius_tiles ?? 16
        const within = all.filter((entity) => entity.distance === null || entity.distance <= radius)
        const structures = within.filter((entity) => entity.category === 'structure')
        const damageables = within.filter((entity) => entity.category === 'damageable')
        const lights = within.filter((entity) => (entity.name ?? '').includes('灯') || entity.prefab.includes('lantern') || entity.prefab.includes('light'))
        const containers = structures.filter((entity) => ['chest', 'icebox', 'saltbox', 'treasurechest'].some((k) => entity.prefab.includes(k)))
        // 启发式：结构 + 容器 + 光源 都有才算"像基地"
        const score = (structures.length > 0 ? 1 : 0) + (containers.length > 0 ? 1 : 0) + (lights.length > 0 ? 1 : 0)
        const verdict = score >= 2 ? 'looks_like_base' : score === 1 ? 'sparse' : 'no_structure'
        const lines = [
          freshnessLine(freshness),
          `基地判断（启发式，半径 ${radius} 格）：${verdict === 'looks_like_base' ? '像是有基地' : verdict === 'sparse' ? '只有零星结构' : '附近没有结构物'}`,
          `结构物 ${structures.length} 个，其中容器 ${containers.length} 个；光源 ${lights.length} 个；可破坏物 ${damageables.length} 个`,
          ...structures.slice(0, args.limit ?? 20).map((entity) => `  · ${entity.name ?? entity.prefab} @(${entity.tile_x ?? '?'},${entity.tile_z ?? '?'}) 距离 ${entity.distance ?? '?'}`),
        ]
        return textResult(lines, {
          ok: true,
          freshness,
          nearby_meta: meta,
          radius_tiles: radius,
          verdict,
          heuristic_score: score,
          structures: structures.slice(0, args.limit ?? 20),
          containers: containers.length,
          lights: lights.length,
          damageables: damageables.length,
        })
      },
    },

    // ─────────────────────────── 诊断与管理 ───────────────────────────

    {
      name: 'refresh_game_state',
      title: '刷新状态',
      description:
        '让游戏立刻重新采集一次状态并返回结果（通过 Bridge 下发 refresh_state 命令）。会等命令执行完成，超时会明确报错。',
      schema: z.object({
        include_nearby: z.boolean().default(true).describe('是否同时重扫附近实体'),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { include_nearby?: boolean }
        const command = await ctx.client.runCommand('refresh_state', { include_nearby: args.include_nearby !== false }, { timeoutMs: ctx.config.toolTimeoutMs })
        const status = String(command.status)
        if (status !== 'SUCCEEDED') {
          throw new ToolError('INTERNAL_ERROR', `刷新命令没有成功：${status}`, {
            detail: { command_id: command.id, error: command.error ?? null },
          })
        }
        // 命令成功后 Bridge 侧快照也会更新；强制读一次新的
        const { snapshot, freshness } = await readState(ctx, { force: true })
        const player = playerView(snapshot)
        const result = command.result as Dict | null
        const lines = [
          freshnessLine(freshness),
          `刷新完成：tick ${asNum(result?.tick) ?? '?'}，附近实体 ${asNum(result?.nearby_returned) ?? 0} 个`,
          player === null ? '玩家：无' : `玩家：${player.name ?? player.prefab} 生命 ${player.health?.percent ?? '?'}% 饥饿 ${player.hunger?.percent ?? '?'}%`,
          `耗时：${asNum(command.execution_time) ?? 0} 秒`,
        ]
        return textResult(lines, {
          ok: true,
          freshness,
          command: { id: command.id, status, execution_time: asNum(command.execution_time), result: command.result ?? null },
        })
      },
    },

    {
      name: 'get_command_result',
      title: '命令结果',
      description: '按 command_id 查询某条命令的执行状态与结果（含是否成功、耗时、错误、迟到标记）。',
      schema: z.object({
        command_id: z.string().min(1).max(128),
      }),
      readOnly: true,
      milestone: 'M3',
      handler: async (rawArgs, ctx) => {
        const args = rawArgs as { command_id: string }
        if (!args.command_id.startsWith('cmd_')) {
          throw new ToolError('INVALID_ARGUMENT', `command_id 格式不对：${args.command_id}`, {
            hint: 'Bridge 的命令 id 形如 cmd_xxxxx_1',
          })
        }
        const command = await ctx.client.getCommand(args.command_id)
        const status = String(command.status)
        const lines = [
          `命令 ${args.command_id}：${status}`,
          `类型：${String(command.type ?? '?')}，投递次数 ${String(command.deliveries ?? '?')}`,
          command.execution_time === null || command.execution_time === undefined ? '耗时：未执行完' : `耗时：${String(command.execution_time)} 秒`,
          command.error === null || command.error === undefined ? '错误：无' : `错误：${String(command.error)}`,
          command.late === true ? '注意：这是会话丢失后才收到的迟到结果' : '',
        ].filter((line) => line.length > 0)
        return textResult(lines, {
          ok: true,
          command: {
            id: command.id,
            type: command.type,
            status,
            deliveries: command.deliveries ?? null,
            execution_time: command.execution_time ?? null,
            error: command.error ?? null,
            late: command.late === true,
            result: command.result ?? null,
            session_id: command.session_id ?? null,
          },
        })
      },
    },

    {
      name: 'get_recent_events',
      title: '最近事件',
      description:
        '最近发生的游戏事件（受伤、饥饿变化、昼夜切换、天气变化、发现威胁等）。本阶段尚未实现事件流缓存，会明确返回 NOT_IMPLEMENTED。',
      schema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
      readOnly: true,
      milestone: 'M4',
      handler: async () => {
        throw new ToolError('NOT_IMPLEMENTED', '事件流还没实现（计划在 M4）', {
          hint: '当前可以用 get_player_status / get_world_status 对比两次调用的差异来推断变化',
        })
      },
    },
  ]
}

/** 供测试/文档用：把快照里的关键字段抽出来（不依赖 MCP 协议） */
export function summarizeSnapshot(snapshot: Dict) {
  return {
    player: playerView(snapshot),
    world_day: asNum(asDict(snapshot.world)?.day),
    items: parseItems(asDict(snapshot.inventory)).length,
    entities: asList(asDict(snapshot.nearby)?.entities).length,
  }
}
