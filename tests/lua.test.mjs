// 饥荒 Lua 模组：语法检查 + 在真正的 Lua 虚拟机里跑 json.lua
//
// 这一步比看起来重要：模组跑在游戏里，语法错一个字符就是「模组加载失败」，
// 而本地没有饥荒的 Lua 环境，所以用 luaparse 检查语法、用 fengari（Lua 5.3 的 JS 实现）跑纯 Lua 的 json 模块。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

function luaFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...luaFiles(path))
    else if (entry.name.endsWith('.lua')) out.push(path)
  }
  return out
}

test('所有 Lua 文件语法正确', async () => {
  const luaparse = await import('luaparse')
  const files = luaFiles(MOD)
  assert.ok(files.length >= 6, `只找到 ${files.length} 个 lua 文件`)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    try {
      luaparse.parse(text, { luaVersion: '5.1' })
    } catch (error) {
      throw new Error(`${file} 语法错误：${error.message}`)
    }
  }
})

test('modinfo.lua 有关键字段', () => {
  const text = readFileSync(join(MOD, 'modinfo.lua'), 'utf8')
  for (const field of ['name =', 'version =', 'api_version =', 'dst_compatible = true']) {
    assert.ok(text.includes(field), `modinfo.lua 缺少 ${field}`)
  }
})

test('modinfo.lua 的配置项结构完整（default 不能悬空在选项外）', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const source = readFileSync(join(MOD, 'modinfo.lua'), 'utf8')
  const status = lauxlib.luaL_dostring(L, to_luastring(source))
  if (status !== lua.LUA_OK) {
    throw new Error('modinfo.lua 加载失败：' + lua.lua_tojsstring(L, -1))
  }

  lua.lua_getglobal(L, to_luastring('configuration_options'))
  assert.equal(lua.lua_type(L, -1), lua.LUA_TTABLE, 'configuration_options 应该是一张表')
  const count = lua.lua_rawlen(L, -1)
  assert.ok(count >= 8, `配置项只有 ${count} 个，看起来没加载全`)

  for (let index = 1; index <= count; index++) {
    lua.lua_rawgeti(L, -1, index)
    assert.equal(lua.lua_type(L, -1), lua.LUA_TTABLE, `第 ${index} 个配置项不是表`)
    lua.lua_getfield(L, -1, to_luastring('name'))
    const name = lua.lua_tojsstring(L, -1)
    assert.ok(name && name.length > 0, `第 ${index} 个配置项没有 name`)
    lua.lua_pop(L, 1)

    // ★ 0.28.0 之前这里真的坏过：default 落在了选项表外面，
    //   于是这个配置项没有 default，游戏读取时拿到 nil。
    lua.lua_getfield(L, -1, to_luastring('default'))
    assert.notEqual(lua.lua_type(L, -1), lua.LUA_TNIL, `配置项 ${name} 缺 default`)
    const defaultType = lua.lua_type(L, -1)
    const defaultNumber = defaultType === lua.LUA_TNUMBER ? lua.lua_tonumber(L, -1) : null
    const defaultString = defaultType === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : null
    const defaultBoolean = defaultType === lua.LUA_TBOOLEAN ? lua.lua_toboolean(L, -1) : null
    lua.lua_pop(L, 1)

    lua.lua_getfield(L, -1, to_luastring('options'))
    assert.equal(lua.lua_type(L, -1), lua.LUA_TTABLE, `配置项 ${name} 的 options 不是表`)
    const optionCount = lua.lua_rawlen(L, -1)
    assert.ok(optionCount > 0, `配置项 ${name} 没有可选值`)
    let matched = false
    for (let optionIndex = 1; optionIndex <= optionCount; optionIndex++) {
      lua.lua_rawgeti(L, -1, optionIndex)
      lua.lua_getfield(L, -1, to_luastring('data'))
      const dataType = lua.lua_type(L, -1)
      if (defaultType === dataType) {
        if (defaultNumber !== null && lua.lua_tonumber(L, -1) === defaultNumber) matched = true
        if (defaultString !== null && lua.lua_tojsstring(L, -1) === defaultString) matched = true
        if (defaultBoolean !== null && lua.lua_toboolean(L, -1) === defaultBoolean) matched = true
      }
      lua.lua_pop(L, 2)
    }
    assert.ok(matched, `配置项 ${name} 的 default 不在 options 里`)
    lua.lua_pop(L, 2)
  }
})

test('json.lua 能和外面的 JSON 互相转（真 Lua 虚拟机里跑）', async () => {
  const fengari = await import('fengari')
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari

  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const lastError = () => {
    try {
      return lua.lua_tojsstring(L, -1)
    } catch {
      return '(读不到错误信息)'
    }
  }

  const source = readFileSync(join(MOD, 'scripts', 'whale', 'json.lua'), 'utf8')
  // json.lua 从 GLOBAL 里取 pcall/tonumber（饥荒的模组沙箱只给了一部分基础函数，别的都要从 GLOBAL 拿）
  const preludeStatus = lauxlib.luaL_dostring(L, to_luastring(
    'GLOBAL = { pcall = pcall, tonumber = tonumber, error = error, os = os, io = io }\nWhale = {}',
  ))
  if (preludeStatus !== lua.LUA_OK) throw new Error('前置环境出错：' + lastError())
  const status = lauxlib.luaL_dostring(L, to_luastring(source))
  if (status !== lua.LUA_OK) throw new Error('json.lua 加载失败：' + lastError())

  // 让 Lua 侧读一段外面（Node）产生的 JSON，再把它 encode 回去
  const input = JSON.stringify({
    id: 'c-17',
    action: 'say',
    args: { text: '天要黑了，我去生火\n别忘了带上"火把"' },
    list: [1, 2, 3, 0.5],
    ok: true,
    nothing: null,
  })
  lua.lua_pushstring(L, to_luastring(input))
  lua.lua_setglobal(L, to_luastring('INPUT'))
  lauxlib.luaL_loadstring(L, to_luastring(`
    local decoded = Whale.json.decode(INPUT)
    assert(decoded.id == "c-17", "id 读错了")
    assert(decoded.action == "say", "action 读错了")
    assert(decoded.args.text == '天要黑了，我去生火\\n别忘了带上"火把"', "中文/换行/引号读错了：" .. tostring(decoded.args.text))
    assert(#decoded.list == 4 and decoded.list[1] == 1 and decoded.list[4] == 0.5, "数组读错了（长度 " .. #decoded.list .. "，第4个 " .. tostring(decoded.list[4]) .. "）")
    assert(decoded.ok == true, "布尔读错了")
    assert(decoded.nothing == nil, "null 应该变成 nil")
    -- 再编码回去，外面要能 parse
    OUT = Whale.json.encode(decoded)
    -- 编码要能处理奇怪的东西
    OUT2 = Whale.json.encode({ text = "带\\1控制字符", num = 12, flag = false, arr = {} })
    RESULT = "ok"
  `))
  assert.equal(lua.lua_pcall(L, 0, 0, 0), lua.LUA_OK, 'Lua 侧断言失败：' + lastError())
  lua.lua_getglobal(L, to_luastring('OUT'))
  const out = to_jsstring(lua.lua_tostring(L, -1))
  const parsed = JSON.parse(out)
  assert.equal(parsed.action, 'say')
  assert.equal(parsed.args.text, '天要黑了，我去生火\n别忘了带上"火把"')
  assert.deepEqual(parsed.list, [1, 2, 3, 0.5])

  lua.lua_getglobal(L, to_luastring('OUT2'))
  const out2 = JSON.parse(to_jsstring(lua.lua_tostring(L, -1)))
  assert.equal(out2.num, 12)
  assert.equal(out2.flag, false)
  // 空的 Lua 表分不清数组还是对象，编码成 {} 就好（协议里我们不依赖空数组）
  assert.deepEqual(out2.arr, {})
})

test('状态和结果的文件名在 modmain 里定义好了', () => {
  const text = readFileSync(join(MOD, 'modmain.lua'), 'utf8')
  for (const name of ['whale_state.json', 'whale_cmd.json', 'whale_result.json', 'whale_settings.json', 'whale_pause.json']) {
    assert.ok(text.includes(name), `modmain.lua 里没有 ${name}`)
  }
})
