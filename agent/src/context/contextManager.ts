// Context Manager（M5）：短期上下文
//
// 任务书 §12 要求：session_id / conversation_id / 消息历史 / 上下文裁剪 / 会话重置 / 最大上下文长度。
// **不做长期记忆**（地图/基地/经验持久化留给 Phase 7）。
//
// 裁剪策略（重要：不能把 assistant 的 reasoning_content 与 tool_calls 拆散）：
//   1. 永远保留 system prompt（如果调用方给的是独立参数，就不在 messages 里）；
//   2. 从最老的消息开始丢，但**成对丢**：assistant(tool_calls) 与对应的 tool 消息必须一起保留或一起丢；
//   3. 保留最近 N 轮用户提问及其之后的所有消息（"最近窗口"）；
//   4. 超长单条消息会被截断（避免一条巨型工具结果把窗口吃光）。

import type { LLMMessage } from '../llm/types.js'

export interface ContextLimits {
  /** 最多保留多少条消息（不含 system） */
  maxMessages: number
  /** 最多保留多少"用户提问轮次" */
  maxTurns: number
  /** 单条消息最大字符数（超了截断） */
  maxMessageChars: number
  /** 总字符预算（粗略控制 token） */
  maxTotalChars: number
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxMessages: 40,
  maxTurns: 12,
  maxMessageChars: 4000,
  maxTotalChars: 40000,
}

export interface Conversation {
  conversationId: string
  sessionId: string
  messages: LLMMessage[]
  createdAt: number
  updatedAt: number
  /** 累计轮次（用户提问次数） */
  turns: number
  /** 被裁剪掉的消息数（可观测） */
  trimmedCount: number
}

export interface ContextManagerOptions {
  limits?: Partial<ContextLimits>
  now?: () => number
}

export class ContextManager {
  private readonly conversations = new Map<string, Conversation>()
  private readonly limits: ContextLimits
  private readonly now: () => number
  /** 最多同时保留多少个会话（防内存无限增长） */
  private readonly maxConversations = 32

  constructor(options: ContextManagerOptions = {}) {
    this.limits = { ...DEFAULT_CONTEXT_LIMITS, ...(options.limits ?? {}) }
    this.now = options.now ?? Date.now
  }

  getLimits(): ContextLimits {
    return { ...this.limits }
  }

  /** 取或建一个会话（sessionId + conversationId 都参与定位） */
  getOrCreate(sessionId: string, conversationId?: string): Conversation {
    const cid = conversationId ?? `${sessionId}:default`
    let conversation = this.conversations.get(cid)
    if (conversation === undefined) {
      conversation = {
        conversationId: cid,
        sessionId,
        messages: [],
        createdAt: this.now(),
        updatedAt: this.now(),
        turns: 0,
        trimmedCount: 0,
      }
      this.conversations.set(cid, conversation)
      this.pruneConversations()
    }
    return conversation
  }

  /** 追加消息（自动裁剪 + 截断超长单条） */
  append(sessionId: string, conversationId: string | undefined, messages: LLMMessage[]): Conversation {
    const conversation = this.getOrCreate(sessionId, conversationId)
    for (const message of messages) {
      conversation.messages.push(this.truncateMessage(message))
      if (message.role === 'user') conversation.turns += 1
    }
    conversation.updatedAt = this.now()
    this.trim(conversation)
    return conversation
  }

  /** 读历史（返回副本，调用方改了不影响内部） */
  history(sessionId: string, conversationId?: string): LLMMessage[] {
    const conversation = this.getOrCreate(sessionId, conversationId)
    return conversation.messages.map((message) => ({ ...message }))
  }

  /** 会话重置（保留会话对象，清空消息） */
  reset(sessionId: string, conversationId?: string): Conversation {
    const conversation = this.getOrCreate(sessionId, conversationId)
    conversation.messages = []
    conversation.turns = 0
    conversation.trimmedCount = 0
    conversation.updatedAt = this.now()
    return conversation
  }

  /** 彻底删掉会话 */
  drop(sessionId: string, conversationId?: string): boolean {
    const cid = conversationId ?? `${sessionId}:default`
    return this.conversations.delete(cid)
  }

  /** 列出所有会话（给 /api/agent/status 用） */
  list(): Array<{ conversationId: string; sessionId: string; messages: number; turns: number; updatedAt: number }> {
    return [...this.conversations.values()].map((conversation) => ({
      conversationId: conversation.conversationId,
      sessionId: conversation.sessionId,
      messages: conversation.messages.length,
      turns: conversation.turns,
      updatedAt: conversation.updatedAt,
    }))
  }

  stats(): { conversations: number; totalMessages: number; limits: ContextLimits } {
    let totalMessages = 0
    for (const conversation of this.conversations.values()) totalMessages += conversation.messages.length
    return { conversations: this.conversations.size, totalMessages, limits: { ...this.limits } }
  }

  private truncateMessage(message: LLMMessage): LLMMessage {
    if (message.content === null || message.content.length <= this.limits.maxMessageChars) return message
    return {
      ...message,
      content: `${message.content.slice(0, this.limits.maxMessageChars)}…（已截断，原长 ${message.content.length} 字符）`,
    }
  }

  /**
   * 裁剪：从最老的消息开始丢，但保证
   *   · assistant(tool_calls) 与其后的 tool 消息成组保留；
   *   · 保留最近 maxTurns 个用户提问及其之后的消息；
   *   · 条数与总字符都不超限。
   */
  private trim(conversation: Conversation): void {
    const before = conversation.messages.length

    // 1) 找"最近 maxTurns 轮"的起点（从后往前数 user 消息）
    let keepFrom = 0
    let userSeen = 0
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      if (conversation.messages[index]?.role === 'user') {
        userSeen += 1
        if (userSeen >= this.limits.maxTurns) {
          keepFrom = index
          break
        }
      }
    }

    // 2) 从 keepFrom 起算，再按条数上限往前收缩
    let start = keepFrom
    const maxMessages = this.limits.maxMessages
    if (conversation.messages.length - start > maxMessages) {
      start = conversation.messages.length - maxMessages
    }

    // 3) 对齐到安全边界：如果 start 落在 tool 消息上，往前找到它的 assistant(tool_calls)
    start = this.alignToSafeBoundary(conversation.messages, start)

    let messages = conversation.messages.slice(start)

    // 4) 总字符预算：还是超就从最老开始丢（同样对齐边界）
    let totalChars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)
    while (totalChars > this.limits.maxTotalChars && messages.length > 2) {
      const dropCount = 1
      let nextStart = dropCount
      // 跳过被丢消息后面紧跟的 tool 消息（避免孤立 tool 消息）
      while (nextStart < messages.length && messages[nextStart]?.role === 'tool') nextStart += 1
      const removed = messages.slice(0, nextStart)
      totalChars -= removed.reduce((sum, message) => sum + (message.content?.length ?? 0), 0)
      messages = messages.slice(nextStart)
    }

    conversation.messages = messages
    const trimmed = before - messages.length
    if (trimmed > 0) {
      conversation.trimmedCount += trimmed
      conversation.updatedAt = this.now()
    }
  }

  /**
   * 把起点对齐到安全边界：
   * 如果起点是 tool 消息，说明它的 assistant(tool_calls) 被切掉了 → 往前挪到那条 assistant；
   * 如果往前找不到，就跳过这些孤立的 tool 消息。
   */
  private alignToSafeBoundary(messages: LLMMessage[], start: number): number {
    if (start <= 0) return 0
    let index = start
    // 跳过开头连续的 tool 消息（它们失去了对应的 assistant）
    while (index < messages.length && messages[index]?.role === 'tool') index += 1
    return index
  }

  private pruneConversations(): void {
    if (this.conversations.size <= this.maxConversations) return
    const sorted = [...this.conversations.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    for (const conversation of sorted.slice(0, this.conversations.size - this.maxConversations)) {
      this.conversations.delete(conversation.conversationId)
    }
  }
}
