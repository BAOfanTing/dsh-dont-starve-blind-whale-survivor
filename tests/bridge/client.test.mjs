// 配置卡片：lib/client.js 必须和 lib/index.js 的 Config 一致（不然插件页里的设置会少一项或者对不上）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildClient, buildFields } from '../../tools/build-client.mjs'

test('lib/client.js 是最新的（改过 Config 就重新生成）', async () => {
  const generated = await buildClient()
  const current = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.equal(current, generated, 'lib/client.js 过期了：运行 node tools/build-client.mjs')
})

test('每个设置项都有短标题、分组和说明', async () => {
  const fields = await buildFields()
  assert.ok(fields.length >= 15, `只有 ${fields.length} 个设置项`)
  for (const field of fields) {
    assert.ok(field.label, `${field.key} 没有短标题`)
    assert.ok(field.description, `${field.key} 没有说明`)
    assert.ok(['play', 'ai', 'guide', 'session', 'install'].includes(field.group), `${field.key} 的分组不认识`)
  }
  const keys = fields.map((f) => f.key)
  for (const want of ['port', 'gameDir', 'freezeTime', 'extraInstructions', 'presetEnabled', 'gatewayEnabled', 'autoInstallMod']) {
    assert.ok(keys.includes(want), `少了 ${want}`)
  }
})
