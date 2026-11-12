-- Blind Whale Survivor · Phase 2 · 通信配置（M2）
--
-- 真实配置由外面生成的 bws_config.lua 提供（含 token，不进仓库）：
--   BWS_CONFIG = { baseUrl = "http://127.0.0.1:18788", token = "…", probe = true, ... }
-- 生成方式：node tools/write-bws-config.mjs
--
-- 这样做是因为 mod 沙箱没有 io，读不了任意文件；但 modimport 能加载 MODROOT 下的 .lua，
-- 所以在游戏目录里放一个 Lua 配置文件是唯一干净的路子（不碰 sandbox、不搞 socket）。

local GLOBAL = GLOBAL
-- 饥荒的 mod 沙箱只给 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / next / os / io 都得从 GLOBAL 取（这一条是踩过的坑，见 docs/phase1/01）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS2 = BWS2 or {}

local C = {}

local DEFAULTS = {
    baseUrl = 'http://127.0.0.1:18788',
    token = '',
    probe = false,          -- 是否启动 M2 通信探针
    probeDelaySeconds = 6,  -- 进世界后等多久再开始探（等 Bridge 就绪）
    httpTimeoutSeconds = 10,
    telemetryRetrySeconds = 2, -- 瞬时失败后的重试间隔（再乘连接退避倍数）
    maxPayloadBytes = 64 * 1024, -- telemetry 单包上限，超了先削 nearby 再丢 nearby
    heartbeatSeconds = 3,
    stateSeconds = 2,
    pollSeconds = 1,
    verbose = false,
}

local cached = nil

--- 合并默认值 + 生成配置
function C.get()
    if cached ~= nil then return cached end
    local merged = {}
    for key, value in pairs(DEFAULTS) do merged[key] = value end
    local generated = BWS_CONFIG  -- 由 bws_config.lua 赋值
    if type(generated) == 'table' then
        for key, value in pairs(generated) do
            if value ~= nil then merged[key] = value end
        end
    end
    -- baseUrl 末尾去掉斜杠，拼路径时省心
    merged.baseUrl = tostring(merged.baseUrl or ''):gsub('/+$', '')
    cached = merged
    return merged
end

function C.hasToken()
    local token = C.get().token
    return type(token) == 'string' and #token > 0
end

BWS2.config = C
