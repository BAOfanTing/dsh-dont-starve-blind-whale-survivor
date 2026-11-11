// 命令行装模组：node tools/install-mod.mjs ["游戏目录"]
// 平时不用手动跑：DSH 插件会自动装。
import { installMod, modStatus } from '../lib/mod-install.js'

const gameDir = process.argv[2] ?? ''
const only = Boolean(gameDir)
const result = installMod({ gameDir, onlyGameDir: only })
console.log(`${result.state}：${result.message}`)
const status = modStatus({ gameDir, onlyGameDir: only })
console.log(JSON.stringify(status, null, 2))
process.exit(result.state === 'error' || result.state === 'notfound' ? 1 : 0)
