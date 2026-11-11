// Phase 2 · M2 回归：三个新 Lua 模块必须在「饥荒沙箱规则」下能加载并工作
//
// 这个测试是补上一课的：probe.lua 一开始用了裸 tonumber，游戏里直接
// "attempt to call global 'tonumber' (a nil value)" → 模组被判定出错并禁用 → 世界起不来。
// 所以这里把 pcall / tonumber / os / io 全部置 nil，模拟真实沙箱再跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(ROOT, 'DontStarveWhaleSurvivor')

const PRELUDE = `
CAPTURED = {}
QUERIES = {}          -- 记录每次 QueryServer 调用
REPLIES = {}          -- 由测试注入的应答策略结果
DOCTASK = {}          -- DoTaskInTime 攒下来的回调

GLOBAL = {}
GLOBAL.pcall = pcall
GLOBAL.tonumber = tonumber
GLOBAL.error = error
GLOBAL.next = next
GLOBAL.io = nil
GLOBAL.os = { time = function() return 1794410000 end }

BWS = {}
BWS.json = nil        -- 下面用真的 json_encoder 覆盖

GLOBAL.TheSim = {
    QueryServer = function(self, url, cb, method, body)
        QUERIES[#QUERIES + 1] = { url = url, method = method, body = body }
        local reply = REPLY
        if method == "GET" then
            reply = { text = '{"success":true}', ok = true, code = 200 }
        else
            local has_token = type(body) == "string" and string.find(body, 'TOKEN_OK', 1, true) ~= nil
            local has_pad = type(body) == "string" and string.find(body, '"pad"', 1, true) ~= nil
            if not has_token then
                reply = { text = '{"success":false}', ok = false, code = 401 }
            elseif has_pad then
                reply = { text = '{"success":false}', ok = false, code = 413 }
            else
                reply = { text = '{"success":true,"received":{"echo":"大肥鱼 M2 探测"}}', ok = true, code = 200 }
            end
        end
        cb(reply.text, reply.ok, reply.code)
    end,
}

GLOBAL.TheWorld = {
    ismastersim = true,
    HasTag = function(self, tag) return false end,
    DoTaskInTime = function(self, seconds, fn)
        DOCTASK[#DOCTASK + 1] = fn
        local task = {}
        function task:Cancel() end
        return task
    end,
}

BWS_CONFIG = {
    baseUrl = "http://127.0.0.1:18788/",
    token = "TOKEN_OK",
    probe = true,
    probeDelaySeconds = 0,
    probeRepeatSeconds = nil,
}

print = function(text) CAPTURED[#CAPTURED + 1] = text end

-- 模拟沙箱：裸的这些是 nil
pcall = nil
tonumber = nil
error = nil
next = nil
os = nil
io = nil
`

const FILES = [
  'scripts/main/json_encoder.lua',
  'scripts/main/config.lua',
  'scripts/main/http_client.lua',
  'scripts/main/probe.lua',
]

function load(fengari) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  const fail = () => {
    try {
      return to_jsstring(lua.lua_tostring(L, -1))
    } catch {
      return ''
    }
  }
  let status = lauxlib.luaL_dostring(L, to_luastring(PRELUDE))
  assert.equal(status, lua.LUA_OK, '前置环境出错：' + fail())
  for (const file of FILES) {
    status = lauxlib.luaL_dostring(L, to_luastring(readFileSync(join(MOD, file), 'utf8')))
    assert.equal(status, lua.LUA_OK, `${file} 在沙箱里加载失败（游戏里就是 MOD ERROR）：` + fail())
  }
  const run = (code) => {
    status = lauxlib.luaL_dostring(L, to_luastring(code))
    assert.equal(status, lua.LUA_OK, '运行出错：' + fail())
  }
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name))
    const top = lua.lua_gettop(L)
    try {
      return lua.lua_tojsstring(L, -1) ?? ''
    } catch {
      return ''
    } finally {
      lua.lua_settop(L, top - 1)
    }
  }
  const lines = () => {
    run('CAPN = #CAPTURED')
    const total = Number(global('CAPN')) || 0
    const out = []
    for (let i = 1; i <= total; i += 1) {
      run(`CAPITEM = CAPTURED[${i}]`)
      const line = global('CAPITEM')
      if (!line.startsWith('[BWS2] ')) continue
      try {
        out.push(JSON.parse(line.slice('[BWS2] '.length)))
      } catch {
        out.push({ _unparsed: line })
      }
    }
    return out
  }
  return { run, global, lines }
}

test('三个新模块在沙箱里能加载（不含裸 tonumber/pcall）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('assert(type(BWS2) == "table" and type(BWS2.config) == "table" and type(BWS2.http) == "table" and type(BWS2.probe) == "table")')
})

test('config：合并生成的配置，baseUrl 去掉末尾斜杠', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('CFG = BWS2.config.get()')
  t.run('OUTS = CFG.baseUrl .. "|" .. CFG.token .. "|" .. tostring(CFG.probe) .. "|" .. tostring(CFG.heartbeatSeconds)')
  assert.equal(t.global('OUTS'), 'http://127.0.0.1:18788|TOKEN_OK|true|3')
})

test('http：GET 走 QueryServer，回调带 ok/status/body', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    RESULT = nil
    BWS2.http.get("/health", function(r) RESULT = r end)
  `)
  t.run('Q = QUERIES[1]; OUTS = Q.url .. "|" .. tostring(Q.method) .. "|" .. tostring(Q.body)')
  assert.equal(t.global('OUTS'), 'http://127.0.0.1:18788/health|GET|nil')
  t.run('R = RESULT; OUTS2 = tostring(R.ok) .. "|" .. tostring(R.status) .. "|" .. tostring(R.body ~= nil)')
  assert.equal(t.global('OUTS2'), 'true|200|true')
})

test('http：POST 把 JSON 文本当请求体；串行队列不会并发', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run(`
    BWS2.http.post("/api/v1/probe", { token = "TOKEN_OK", echo = "hi" }, function(r) A = r end)
    BWS2.http.post("/api/v1/probe", { token = "TOKEN_OK", echo = "second" }, function(r) B = r end)
  `)
  // 第一个请求是同步回调完成的，所以第二个会被立刻接着发；关键是 body 都在
  t.run('OUTS = tostring(#QUERIES) .. "|" .. QUERIES[1].method .. "|" .. (string.find(QUERIES[1].body, "TOKEN_OK", 1, true) and "has_token" or "no_token")')
  assert.equal(t.global('OUTS'), '2|POST|has_token')
})

test('probe：完整跑一遍 A~E 五项，全部 pass（用桩模拟 Bridge 的应答）', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  t.run('BWS2.probe.start()')
  // start 用 DoTaskInTime 延迟开始：把攒下来的任务都执行掉
  t.run('for i = 1, #DOCTASK do DOCTASK[i]() end')

  const steps = t.lines()
  const byStep = Object.fromEntries(steps.map((s) => [s.step, s]))
  assert.equal(byStep.api_query_server?.pass, true, 'API 检测应通过')
  assert.equal(byStep.get_health?.status, 200)
  assert.equal(byStep.get_health?.pass, true)
  assert.equal(byStep.post_no_token?.status, 401)
  assert.equal(byStep.post_bad_token?.status, 401)
  assert.equal(byStep.post_probe?.status, 200)
  assert.equal(byStep.post_probe?.pass, true, 'POST + token + 中文 echo 应通过')
  assert.equal(byStep.post_big_body?.status, 413)
  assert.equal(byStep.post_big_body?.pass, true)
  assert.ok(byStep.summary, '应该有 summary')
  // 5 次请求：health(200) + probe(200) 算成功；401/401/413 三次是预期失败
  assert.equal(byStep.summary.http.sent, 5, 'summary 应记到 5 次请求')
  assert.equal(byStep.summary.http.ok, 2, 'summary：2 次成功')
  assert.equal(byStep.summary.http.failed >= 3, true, 'summary：失败计数应包含 3 次预期失败')
})

test('probe：没有 token 时老实报错，不抛异常', async () => {
  const fengari = await import('fengari')
  const t = load(fengari)
  // config 有缓存：直接改缓存，模拟“没配置 token”
  t.run('BWS2.config.get().token = ""')
  t.run('BWS2.probe.start(); for i = 1, #DOCTASK do DOCTASK[i]() end')
  const steps = t.lines()
  const abort = steps.find((s) => s.step === 'abort')
  assert.ok(abort, '应该有一条 abort')
  assert.equal(abort.pass, false)
  assert.match(String(abort.reason), /token/)
})
