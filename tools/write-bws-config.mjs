// 生成游戏端的通信配置：DontStarveWhaleSurvivor/bws_config.lua
//
// 为什么要生成到模组目录里：
//   mod 沙箱没有 io，读不了任意路径的文件；但 modimport 能加载 MODROOT 下的 .lua。
//   所以在模组目录里放一份"赋值全局变量的 Lua 文件"是唯一干净的做法（不碰 sandbox、不搞 socket）。
//
// 文件里含 token → 不进仓库（.gitignore 已拦），也不打印到控制台（只打印掩码）。
//
// 用法：
//   node tools/write-bws-config.mjs                     # 用 .runtime/token.txt 里的 token，端口 18788
//   node tools/write-bws-config.mjs --port 18788 --repeat 10 --repeat-count 30
//   node tools/write-bws-config.mjs --no-probe           # 关掉 M2 探针

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN_FILE = join(REPO, '.runtime', 'token.txt')
const MOD_DIR = join(REPO, 'DontStarveWhaleSurvivor')
const OUT_FILE = join(MOD_DIR, 'bws_config.lua')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) return true // 布尔开关
  return value
}

const port = Number(arg('port', 18788))
const probe = arg('no-probe', false) !== true
const probeDelay = Number(arg('probe-delay', 6))
const repeatSeconds = Number(arg('repeat', 10))
const repeatCount = Number(arg('repeat-count', 30))
const verbose = arg('verbose', false) === true

function loadOrCreateToken() {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[0-9a-fA-F]{16,128}$/.test(existing)) return { token: existing, created: false }
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(TOKEN_FILE, token + '\n', { encoding: 'utf8', mode: 0o600 })
  return { token, created: true }
}

const { token, created } = loadOrCreateToken()

const lua = `-- 由 tools/write-bws-config.mjs 生成，**含 token，不要提交到仓库**
-- 重新生成：node tools/write-bws-config.mjs
BWS_CONFIG = {
    baseUrl = "http://127.0.0.1:${port}",
    token = "${token}",
    probe = ${probe ? 'true' : 'false'},
    probeDelaySeconds = ${probeDelay},
    probeRepeatSeconds = ${repeatSeconds},
    probeRepeatCount = ${repeatCount},
    httpTimeoutSeconds = 10,
    heartbeatSeconds = 3,
    stateSeconds = 2,
    pollSeconds = 1,
    verbose = ${verbose ? 'true' : 'false'},
}
`

writeFileSync(OUT_FILE, lua, 'utf8')

const masked = token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-2)}` : '****'
console.log(`写入 ${OUT_FILE}`)
console.log(`  baseUrl = http://127.0.0.1:${port}`)
console.log(`  token   = ${masked}（${token.length} 字符，${created ? '新生成' : '复用 .runtime/token.txt'}）`)
console.log(`  probe   = ${probe}（延迟 ${probeDelay}s；之后每 ${repeatSeconds}s 重试 ${repeatCount} 次）`)
