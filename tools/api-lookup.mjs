// 查《饥荒联机版》自带的 Lua 源码（scripts.zip）里某个 API 到底存不存在。
//
//   node tools/api-lookup.mjs "Tool:CanDoAction"
//   node tools/api-lookup.mjs "GetWorldPosition" --context=2
//   node tools/api-lookup.mjs "^function Inventory:" --regex
//   node tools/api-lookup.mjs --methods Inventory        # 列出 Inventory 组件的全部方法
//   node tools/api-lookup.mjs --file=scripts/components/tool.lua
//   node tools/api-lookup.mjs "CanDoAction" --game="D:\SteamLibrary\steamapps\common\Don't Starve Together"
//
// 为什么要有它：饥荒各版本之间 API 差异很大（单机版有 GetClock，联机版没有；
// Inventory:GetItems 在联机版根本不存在…），凭记忆写必然踩坑，查一下最省事。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { findGameDirs } from '../lib/bridge.js'

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (const arg of argv) {
  const match = arg.match(/^--([a-z]+)(?:=(.*))?$/)
  if (match) flags[match[1]] = match[2] ?? true
  else positional.push(arg)
}

// --methods Inventory / --file scripts/xxx.lua 这种"空格给值"的写法也认
let methods = flags.methods
let onlyFile = flags.file
if (methods === true && positional.length > 0) methods = positional.shift()
if (onlyFile === true && positional.length > 0) onlyFile = positional.shift()
if (methods === true) methods = undefined
if (onlyFile === true) onlyFile = undefined

const query = positional.join(' ')
const useRegex = Boolean(flags.regex)
const contextLines = Number(flags.context ?? 1)
const limit = Number(flags.limit ?? 25)

if (!query && !methods && !onlyFile) {
  console.log('用法: node tools/api-lookup.mjs "要查的符号" [--regex] [--context=1] [--limit=25]')
  console.log('      node tools/api-lookup.mjs --methods Inventory   # 列出某个组件的全部方法')
  console.log('      node tools/api-lookup.mjs --file=scripts/components/tool.lua')
  process.exit(1)
}

// ─────────────────────────── 找 scripts.zip ───────────────────────────

function findScriptsZip(explicit) {
  const games = findGameDirs(explicit ?? '')
  for (const game of games) {
    for (const candidate of [
      join(game, 'data', 'databundles', 'scripts.zip'),
      join(game, 'data', 'scripts.zip'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const zipPath = findScriptsZip(flags.game)
if (!zipPath) {
  console.error('找不到游戏的 scripts.zip。用 --game= 指定游戏安装目录，或者确认游戏装好了。')
  process.exit(1)
}

// ─────────────────────────── 最小 zip 读取（只依赖 node:zlib） ───────────────────────────

function readCentralDirectory(buffer) {
  // 从尾部往前找 EOCD（0x06054b50）
  let eocd = -1
  const min = Math.max(0, buffer.length - 66000)
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip：找不到 EOCD')
  const count = buffer.readUInt16LE(eocd + 10)
  const offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break
    const method = buffer.readUInt16LE(p + 10)
    const compressedSize = buffer.readUInt32LE(p + 20)
    const nameLength = buffer.readUInt16LE(p + 28)
    const extraLength = buffer.readUInt16LE(p + 30)
    const commentLength = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength)
    entries.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(buffer, entry) {
  const p = entry.localOffset
  const nameLength = buffer.readUInt16LE(p + 26)
  const extraLength = buffer.readUInt16LE(p + 28)
  const start = p + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw.toString('utf8')
  return inflateRawSync(raw).toString('utf8')
}

// ─────────────────────────── 查 ───────────────────────────

const zip = readFileSync(zipPath)
const entries = readCentralDirectory(zip).filter((entry) => entry.name.startsWith('scripts/') && entry.name.endsWith('.lua'))
console.log(`# ${zipPath}`)
console.log(`# ${entries.length} 个 lua 文件\n`)

const wanted = onlyFile ? entries.filter((entry) => entry.name === onlyFile || entry.name.endsWith('/' + onlyFile)) : entries
if (wanted.length === 0) {
  console.error(`没有这个文件：${onlyFile}`)
  process.exit(1)
}

let hits = 0
for (const entry of wanted) {
  if (hits >= limit) break
  let text
  try {
    text = readEntry(zip, entry)
  } catch {
    continue
  }
  const lines = text.split('\n')

  if (methods) {
    // --methods X：列出 X 的所有方法
    const prefix = `function ${methods}:`
    const found = lines.map((line, index) => ({ line: line.trim(), index })).filter((item) => item.line.startsWith(prefix))
    if (found.length === 0) continue
    console.log(`── ${entry.name}`)
    for (const item of found) {
      console.log(`  ${item.line}`)
      hits++
    }
    console.log()
    continue
  }

  if (!query) {
    // 只指定了 --file：把整个文件打出来
    console.log(`── ${entry.name}（${lines.length} 行）`)
    console.log(text)
    hits++
    continue
  }

  const matcher = useRegex ? new RegExp(query) : null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const matched = matcher ? matcher.test(line) : line.includes(query)
    if (!matched) continue
    console.log(`── ${entry.name}:${i + 1}`)
    const from = Math.max(0, i - contextLines)
    const to = Math.min(lines.length - 1, i + contextLines)
    for (let k = from; k <= to; k++) {
      console.log(`${k === i ? '>' : ' '} ${String(k + 1).padStart(5)} | ${lines[k].trimEnd()}`)
    }
    console.log()
    hits++
    if (hits >= limit) break
  }
}

if (hits === 0) {
  console.log(`没有找到「${query || methods || onlyFile}」。`)
  console.log('提示：')
  console.log('  · 组件方法这样查：--methods Inventory（不带冒号）')
  console.log('  · 只想看某个文件：--file=scripts/components/container.lua')
  console.log('  · 正则：--regex "function Inventory:(Has|GetItemByName)"')
  process.exit(1)
}
console.log(`共 ${hits} 处匹配`)
