// 增量 tail 游戏日志
//
// 为什么是轮询而不是 fs.watch：
//   日志在 OneDrive 目录下（可能被同步、被重写），watch 事件不可靠；轮询 + 自己记 offset 更稳。
//
// 必须处理的几种情况（都有测试）：
//   1. 文件持续增长 → 只读新增部分；
//   2. **半截行** → 保留在 buffer 里，等下一行到了再拼（按字节切 0x0A，避免多字节字符被切坏）；
//   3. 文件被清空/轮转（size < offset）→ offset 归零重读；
//   4. 文件暂时不存在（游戏没开/正在启动）→ 标记 missing，等它出现；
//   5. 启动时文件里已经有内容 → 回填最后 N 字节（默认 1MB），并丢掉回填造成的首半行。

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractRecord, type WireRecord } from './record.js'

export interface TailerFileStatus {
  name: string
  path: string
  missing: boolean
  size: number
  offset: number
  pendingBytes: number
  lines: number
  records: number
  parseFails: number
  rotations: number
  lastRecordAt: number | null
}

export interface TailerOptions {
  logDir: string
  files: string[]
  pollMs: number
  backfillBytes?: number
  onRecord: (record: WireRecord, meta: { file: string }) => void
  onParseFail?: (info: { file: string; reason: string; detail?: string }) => void
  log?: (message: string) => void
  /** 注入时钟，方便测试 */
  now?: () => number
}

interface FileState {
  name: string
  path: string
  offset: number
  buffer: Buffer
  lines: number
  records: number
  parseFails: number
  rotations: number
  missing: boolean
  size: number
  lastRecordAt: number | null
  started: boolean
}

export class LogTailer {
  private readonly states: FileState[]
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private running = false

  constructor(private readonly opts: TailerOptions) {
    this.now = opts.now ?? Date.now
    this.states = opts.files.map((name) => ({
      name,
      path: join(opts.logDir, name),
      offset: 0,
      buffer: Buffer.alloc(0),
      lines: 0,
      records: 0,
      parseFails: 0,
      rotations: 0,
      missing: true,
      size: 0,
      lastRecordAt: null,
      started: false,
    }))
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.pollOnce()
    this.timer = setInterval(() => this.pollOnce(), this.opts.pollMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 读一轮（测试里直接调它，不用等定时器） */
  pollOnce(): void {
    for (const state of this.states) this.readFile(state)
  }

  status(): TailerFileStatus[] {
    return this.states.map((state) => ({
      name: state.name,
      path: state.path,
      missing: state.missing,
      size: state.size,
      offset: state.offset,
      pendingBytes: state.buffer.length,
      lines: state.lines,
      records: state.records,
      parseFails: state.parseFails,
      rotations: state.rotations,
      lastRecordAt: state.lastRecordAt,
    }))
  }

  private readFile(state: FileState): void {
    let size: number
    try {
      size = statSync(state.path).size
    } catch {
      state.missing = true
      return
    }
    state.missing = false
    state.size = size

    let skipFirstPartial = false
    if (!state.started) {
      state.started = true
      const backfill = Math.max(0, this.opts.backfillBytes ?? 1024 * 1024)
      if (backfill > 0 && size > backfill) {
        state.offset = size - backfill
        skipFirstPartial = true
      } else {
        state.offset = 0
      }
    }

    // 被清空 / 轮转
    if (size < state.offset) {
      state.rotations += 1
      state.offset = 0
      state.buffer = Buffer.alloc(0)
    }
    if (size === state.offset) return

    const length = size - state.offset
    const chunk = Buffer.alloc(length)
    let fd = -1
    try {
      fd = openSync(state.path, 'r')
      let read = 0
      while (read < length) {
        const n = readSync(fd, chunk, read, length - read, state.offset + read)
        if (n <= 0) break
        read += n
      }
    } catch {
      return
    } finally {
      if (fd >= 0) closeSync(fd)
    }
    state.offset = size

    let data = state.buffer.length > 0 ? Buffer.concat([state.buffer, chunk]) : chunk
    state.buffer = Buffer.alloc(0)

    if (skipFirstPartial) {
      const firstNewline = data.indexOf(0x0a)
      if (firstNewline < 0) {
        // 回填的一段里连一个换行都没有：整段留着等下一次
        state.buffer = Buffer.from(data)
        return
      }
      data = data.subarray(firstNewline + 1)
    }

    let from = 0
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== 0x0a) continue
      const line = data.subarray(from, i).toString('utf8')
      from = i + 1
      this.handleLine(state, line)
    }
    if (from < data.length) state.buffer = Buffer.from(data.subarray(from))
  }

  private handleLine(state: FileState, line: string): void {
    state.lines += 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const parsed = extractRecord(line)
    if (!parsed.ok) {
      // 没有 [BWS] 标记的行（其它模组/引擎输出）很常见，不算错误
      if (parsed.reason !== 'no_marker') {
        state.parseFails += 1
        this.opts.onParseFail?.({ file: state.name, reason: parsed.reason, detail: parsed.detail })
      }
      return
    }
    state.records += 1
    state.lastRecordAt = this.now()
    this.opts.onRecord(parsed.record, { file: state.name })
  }
}
