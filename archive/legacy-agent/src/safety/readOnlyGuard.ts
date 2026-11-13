// Read Only Guard（M5）：程序层的最后一道闸
//
// 任务书 §13 明确要求：**不要仅依赖模型提示词实现安全性，必须在程序层执行权限验证**。
//
// M3 的 ToolAdapter 已经在"工具定义 + 参数"层面做了白名单与校验。
// 这里再加一层"意图检测"：即使模型绕过工具直接说出要执行的动作，
// 或用户用自然语言要求写操作，Agent 也要能识别并明确拒绝（而不是含糊答应）。
//
// 注意：这一层是**兜底与提示**，真正的安全边界仍是"根本没有写操作工具可调"。

import { READ_ONLY_ALLOWLIST, FORBIDDEN_TOOL_PATTERNS } from '../mcp/toolAdapter.js'

/** 写操作意图的关键词（中英文都要覆盖） */
const WRITE_INTENT_PATTERNS: Array<{ pattern: RegExp; action: string }> = [
  // 中文动词后面常跟「了/掉/它/那/这/点/个」，所以正则要匹配动词本身而不是固定短语
  { pattern: /移动|走过去|走到|跑过去|传送|挪|walk to|go to|teleport/i, action: '移动角色' },
  { pattern: /攻击|去打|打它|打他|打那|打这|揍|杀死|杀掉|砍它|砍他|砍那|砍这|attack|hit|kill|fight/i, action: '攻击/战斗' },
  { pattern: /砍树|伐木|砍掉|砍了|砍倒|chop|cut down/i, action: '砍树' },
  { pattern: /挖矿|采矿|挖石|挖点|挖它|挖那|mine|dig/i, action: '采矿/挖掘' },
  { pattern: /吃了|吃掉|吃它|吃点|吃些|进食|喝了|喝掉|eat|drink|consume/i, action: '进食' },
  { pattern: /制作|合成|做个|做一个|造个|造一个|craft|make a|make me/i, action: '制作物品' },
  { pattern: /建造|建个|建一个|盖个|盖一个|建基地|build|construct/i, action: '建造' },
  { pattern: /丢弃|扔掉|丢掉|丢了|放下|drop|discard/i, action: '丢弃物品' },
  { pattern: /采集|摘下|摘掉|摘了|采下|采集|pick|harvest|gather/i, action: '采集' },
  { pattern: /执行.*(lua|脚本|命令)|run script|exec/i, action: '执行代码/命令' },
]

export interface GuardVerdict {
  allowed: boolean
  /** 被拒时：这是哪种写操作意图 */
  intent?: string
  /** 给用户看的中文说明 */
  message: string
  /** 命中的工具名（如果是因为工具越权） */
  toolName?: string
}

/** 检查一个工具名是否只读且在白名单内 */
export function guardToolName(name: string): GuardVerdict {
  if (!(READ_ONLY_ALLOWLIST as readonly string[]).includes(name)) {
    return {
      allowed: false,
      toolName: name,
      message: `工具 ${name} 不在只读白名单内，已拒绝执行。`,
    }
  }
  for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
    if (pattern.test(name)) {
      return { allowed: false, toolName: name, message: `工具 ${name} 命中危险动作模式（${pattern.source}），已拒绝执行。` }
    }
  }
  return { allowed: true, message: 'ok' }
}

/**
 * 检查用户输入里是否包含写操作请求。
 * **注意**：这不是"拒绝回答"，而是让 Agent 明确说明"我只能看不能动"，
 * 然后仍然给出有用的建议（例如"你可以自己去砍这棵树，它在你左边 2 格"）。
 */
export function guardUserIntent(text: string): GuardVerdict {
  for (const { pattern, action } of WRITE_INTENT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        intent: action,
        message: `当前阶段我只能只读查询，不能${action}。我可以告诉你在哪、需要什么、以及建议你怎么做。`,
      }
    }
  }
  return { allowed: true, message: 'ok' }
}

/** 系统提示词里对"只读"的强调（拼进 System Prompt） */
export const READ_ONLY_REMINDER = [
  '【能力边界】',
  '你只有只读工具：能查玩家/背包/世界/附近/事件，**不能**移动、攻击、砍树、采矿、进食、制作、建造、丢弃。',
  '如果用户要求你做这些，明确说"当前阶段只支持只读查询，我还不能操作游戏"，然后给出建议让他自己做。',
  '不要假装已经执行了任何操作。',
].join('\n')
