// MCP Prompts（M4）
//
// 4 个分析指导 Prompt。只提供分析框架，不执行任何游戏操作。
// 每个 Prompt 会把取数步骤与分析要点写进消息里，让 AI 有据可依地分析。
//
// 设计原则：
//   · 不假设 AI 已经知道游戏规则 —— 把关键机制写进提示；
//   · 明确要求 AI 先读数据再下结论，且必须检查数据新鲜度；
//   · 明确禁止 AI 提出需要写操作的"建议动作"，只能给出观察与判断。

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { GameToolService } from '../server/createServer.js'

export interface PromptSpec {
  name: string
  title: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

export const PROMPT_SPECS: PromptSpec[] = [
  {
    name: 'survival_report',
    title: '生存报告',
    description: '基于当前只读数据生成生存状态报告：生命/饥饿/理智/装备/威胁/风险',
    arguments: [{ name: 'focus', description: '分析重点，例如 hunger 或 safety，可留空', required: false }],
  },
  {
    name: 'resource_assessment',
    title: '资源评估',
    description: '评估附近可获取资源是否够用：食物、木材、石头、草、燃料',
    arguments: [{ name: 'goal', description: '目标，例如 过冬 或 建基地，可留空', required: false }],
  },
  {
    name: 'night_preparation',
    title: '夜晚准备',
    description: '检查距离天黑还有多久、有没有光源、有没有保暖/防雨，给出应对建议',
    arguments: [],
  },
  {
    name: 'season_preparation',
    title: '季节准备',
    description: '根据当前季节与剩余天数，评估需要提前准备什么（保暖/降温/食物储备）',
    arguments: [{ name: 'next_season', description: '下一个季节，例如 winter，可留空让 AI 推断', required: false }],
  },
]

const DATA_RULES = [
  '重要规则（必须遵守）：',
  '1. 所有数据都必须来自工具调用（get_player_status / get_inventory / get_world_status / get_nearby_* / get_recent_events）。',
  '2. 每次读数据后先看 freshness.stale：如果为 true，说明数据已过期，必须明确标注"以下基于过期数据"，不得当作当前状态。',
  '3. 不要编造工具没返回的字段。缺失就写"未知"。',
  '4. 你只能做只读观察与分析，不能执行任何游戏动作（不能移动、攻击、采集、制作、建造）。',
  '   请把结论写成"建议由玩家决定"，而不是"我已经做了"。',
].join('\n')

function buildPrompt(name: string, args: Record<string, string | undefined>): string {
  const focus = args.focus ?? ''
  const goal = args.goal ?? ''
  const nextSeason = args.next_season ?? ''

  if (name === 'survival_report') {
    return [
      `请生成一份《饥荒》生存状态报告${focus ? `，重点看 ${focus}` : ''}。`,
      '',
      '步骤：',
      '1. 调 get_game_status 拿到总览（含数据新鲜度）。',
      '2. 调 get_player_status 看生命/饥饿/理智的百分比。',
      '3. 调 get_inventory 看有没有食物、光源、工具。',
      '4. 调 get_nearby_threats 看附近危险。',
      '5. 调 get_recent_events（refresh=true）看最近发生了什么。',
      '',
      '报告结构：',
      '- 当前状态摘要（三项数值 + 世界天数/时段）',
      '- 主要风险（按严重程度排序，例如饥饿过低、夜晚无光源、附近有敌对生物）',
      '- 数据可靠性（是否 stale，最后采集时间）',
      '- 建议（只写"建议玩家做什么"，不要假装执行）',
      '',
      DATA_RULES,
    ].join('\n')
  }

  if (name === 'resource_assessment') {
    return [
      `请评估当前附近资源是否够用${goal ? `（目标：${goal}）` : ''}。`,
      '',
      '步骤：',
      '1. 调 get_nearby_resources（radius_tiles 可设 16~20）看可获取资源。',
      '2. 调 get_inventory 看已有储备。',
      '3. 调 get_world_status 看季节与剩余天数（决定资源需求的紧迫性）。',
      '',
      '评估要点：',
      '- 食物：附近有浆果丛/胡萝卜/蘑菇吗？背包里有存货吗？',
      '- 木材：附近树的数量与 work_left（要砍几下）。',
      '- 石头/燧石：附近 rock 与 item 类别。',
      '- 草/树枝：harvestable 类别数量。',
      '- 如果某类资源为 0，明确说"附近没有"，不要编造。',
      '',
      '输出：分资源类别列出"附近有多少 / 背包有多少 / 够不够 / 建议去哪找"。',
      '',
      DATA_RULES,
    ].join('\n')
  }

  if (name === 'night_preparation') {
    return [
      '请判断当前是否快要天黑，并给出夜晚准备建议。',
      '',
      '步骤：',
      '1. 调 get_world_status 看 phase（day/dusk/night）、time.of_day、time.in_phase。',
      '   - phase=day 且 of_day 接近 0.75 说明快黄昏；phase=dusk 说明马上天黑。',
      '2. 调 get_inventory 检查是否有光源（torch / lantern / 营火材料：草+木头）。',
      '3. 调 get_nearby_threats 看夜晚可能更危险的东西。',
      '4. 调 get_nearby_entities 看附近有没有现成的营火/光源结构。',
      '',
      '输出：',
      '- 距离天黑还有多久（基于 of_day 估算，并说明这是估算）',
      '- 有没有光源：有/没有，够不够撑过夜晚',
      '- 没有光源时的建议（只给建议，不执行）',
      '- 夜晚特有的风险提醒（黑暗伤害）',
      '',
      DATA_RULES,
    ].join('\n')
  }

  return [
    `请根据当前季节评估需要提前准备什么${nextSeason ? `（下一个季节是 ${nextSeason}）` : ''}。`,
    '',
    '步骤：',
    '1. 调 get_world_status 看 season、elapsed_days_in_season、remaining_days_in_season、temperature。',
    '2. 调 get_inventory 看有没有对应季节的装备（保暖衣物/降温物/雨具）。',
    '3. 调 get_nearby_resources 看附近能否获取所需材料。',
    '',
    '季节要点（供参考）：',
    '- 秋季：最舒服，重点是囤食物与准备过冬物资。',
    '- 冬季：需要保暖（winter hat / 保暖石），食物会变少，注意体温过低。',
    '- 春季：多雨，需要雨具（雨伞/雨衣），注意潮湿导致理智下降。',
    '- 夏季：过热，需要降温（冰块/遮阳），注意自燃。',
    '',
    '输出：',
    '- 距离季节结束还有几天',
    '- 已有装备与缺口（明确列出缺什么）',
    '- 按优先级排序的准备清单（只给建议）',
    '',
    DATA_RULES,
  ].join('\n')
}

export function registerPrompts(server: McpServer, service: GameToolService): void {
  for (const spec of PROMPT_SPECS) {
    // 参数表用 zod object（zod 4 原生满足 StandardSchemaWithJSON）；SDK 回调签名是 (args, ctx)
    const fields: Record<string, z.ZodTypeAny> = {}
    for (const argument of spec.arguments) {
      const base = z.string().describe(argument.description)
      fields[argument.name] = argument.required ? base : base.optional()
    }
    const argsSchema = z.object(fields as never)

    const promptConfig = {
      title: spec.title,
      description: spec.description,
      argsSchema,
    }
    const callback = async (args: Record<string, string | undefined>) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: buildPrompt(spec.name, args ?? {}) },
        },
      ],
    })

    // SDK 的 overload 需要 argsSchema 是 StandardSchemaWithJSON；zod 对象满足，但 TS 需要一次显式转换
    server.registerPrompt(spec.name, promptConfig as never, callback as never)
  }
  void service
}
