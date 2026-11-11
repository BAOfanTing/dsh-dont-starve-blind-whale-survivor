-- Blind Whale Survivor · Phase 1 · JSON 编码器
--
-- 为什么自己写：饥荒自带的 scripts/json.lua 的 encode() 自己注释里就写着"不符合 JSON 规范"
-- （换行/引号转义不全），打到日志里会被 Bridge 解析坏。这里只实现编码（本阶段只输出，不读取）。
--
-- 沙箱注意：mod 环境没有 pcall / tonumber / error / os / io，只有 pairs/ipairs/print/math/table/
-- type/string/tostring/require/Class。需要什么就从 GLOBAL 里拿（GLOBAL 就是引擎的 _G）。

local GLOBAL = GLOBAL
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber

BWS = BWS or {}

local J = {}

local ESCAPES = {
    ['"'] = '\\"',
    ['\\'] = '\\\\',
    ['\b'] = '\\b',
    ['\f'] = '\\f',
    ['\n'] = '\\n',
    ['\r'] = '\\r',
    ['\t'] = '\\t',
}

local function encode_string(s)
    s = s:gsub('[%c\\"]', function(c)
        return ESCAPES[c] or string.format('\\u%04x', string.byte(c))
    end)
    return '"' .. s .. '"'
end

-- 只有“键是 1..n 连续整数”才当数组；其余当对象。空表当对象（协议里不依赖空数组）。
local function array_size(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= 'number' or k < 1 or k ~= math.floor(k) then return 0 end
        n = n + 1
    end
    if n == 0 then return 0 end
    for i = 1, n do
        if t[i] == nil then return 0 end
    end
    return n
end

local encode_value

local function encode_table(t, out)
    local n = array_size(t)
    if n > 0 then
        out[#out + 1] = '['
        for i = 1, n do
            if i > 1 then out[#out + 1] = ',' end
            encode_value(t[i], out)
        end
        out[#out + 1] = ']'
        return
    end
    out[#out + 1] = '{'
    local first = true
    for k, v in pairs(t) do
        local kind = type(k)
        if kind == 'string' or kind == 'number' then
            if not first then out[#out + 1] = ',' end
            first = false
            out[#out + 1] = encode_string(tostring(k))
            out[#out + 1] = ':'
            encode_value(v, out)
        end
    end
    out[#out + 1] = '}'
end

encode_value = function(v, out)
    local kind = type(v)
    if v == nil then
        out[#out + 1] = 'null'
    elseif kind == 'boolean' then
        out[#out + 1] = v and 'true' or 'false'
    elseif kind == 'number' then
        if v ~= v or v == math.huge or v == -math.huge then
            out[#out + 1] = 'null'
        elseif v == math.floor(v) and math.abs(v) < 1e15 then
            out[#out + 1] = string.format('%d', math.floor(v))
        else
            local text = string.format('%.4f', v)
            text = text:gsub('0+$', ''):gsub('%.$', '')
            out[#out + 1] = text
        end
    elseif kind == 'string' then
        out[#out + 1] = encode_string(v)
    elseif kind == 'table' then
        encode_table(v, out)
    else
        -- function / userdata / thread：丢掉，别把整条数据搞坏
        out[#out + 1] = 'null'
    end
end

function J.encode(value)
    local out = {}
    encode_value(value, out)
    return table.concat(out)
end

--- 数字兜底：API 偶尔给 nil 或非数字，别让整条 JSON 变成 null 或者报错
function J.number(value, fallback)
    local n = tonumber(value)
    if n == nil then return fallback end
    return n
end

--- 浮点保留一位小数（坐标、温度这类），并保证是数字
function J.round(value, digits)
    local n = tonumber(value)
    if n == nil then return nil end
    local scale = 10 ^ (digits or 1)
    return math.floor(n * scale + 0.5) / scale
end

BWS.json = J
