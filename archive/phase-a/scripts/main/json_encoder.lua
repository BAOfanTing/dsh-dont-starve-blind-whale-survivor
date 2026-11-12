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

-- ─────────────────── 解码（M3 起用：要读 Bridge 回来的 acknowledged_sequence）───────────────────
--
-- 只需要处理我们自己发出去的、以及 Bridge 回的 JSON（都是标准 JSON），所以实现够用即可：
-- 对象 / 数组 / 字符串（含 \\u 转义）/ 数字 / true / false / null。

local function utf8_char(cp)
    if cp < 0x80 then
        return string.char(cp)
    elseif cp < 0x800 then
        return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40)
    elseif cp < 0x10000 then
        return string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
    end
    return string.char(
        0xF0 + math.floor(cp / 0x40000),
        0x80 + math.floor(cp / 0x1000) % 0x40,
        0x80 + math.floor(cp / 0x40) % 0x40,
        0x80 + cp % 0x40
    )
end

function J.decode(text)
    if type(text) ~= 'string' then return nil, 'not_a_string' end
    local pos = 1
    local len = #text

    local function err(message) error(message .. '（位置 ' .. tostring(pos) .. '）', 0) end

    local function skip_ws()
        while pos <= len do
            local c = string.sub(text, pos, pos)
            if c == ' ' or c == '\t' or c == '\r' or c == '\n' then pos = pos + 1 else return end
        end
    end

    local parse_value

    local function parse_string()
        pos = pos + 1
        local buf = {}
        while pos <= len do
            local c = string.sub(text, pos, pos)
            if c == '"' then
                pos = pos + 1
                return table.concat(buf)
            elseif c == '\\' then
                local e = string.sub(text, pos + 1, pos + 1)
                pos = pos + 2
                if e == 'n' then buf[#buf + 1] = '\n'
                elseif e == 't' then buf[#buf + 1] = '\t'
                elseif e == 'r' then buf[#buf + 1] = '\r'
                elseif e == 'b' then buf[#buf + 1] = '\b'
                elseif e == 'f' then buf[#buf + 1] = '\f'
                elseif e == 'u' then
                    local cp = tonumber(string.sub(text, pos, pos + 3), 16) or 63
                    pos = pos + 4
                    if cp >= 0xD800 and cp <= 0xDBFF and string.sub(text, pos, pos + 1) == '\\u' then
                        local low = tonumber(string.sub(text, pos + 2, pos + 5), 16)
                        if low ~= nil and low >= 0xDC00 and low <= 0xDFFF then
                            pos = pos + 6
                            cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00)
                        end
                    end
                    buf[#buf + 1] = utf8_char(cp)
                else
                    buf[#buf + 1] = e or ''
                end
            else
                buf[#buf + 1] = c
                pos = pos + 1
            end
        end
        err('字符串没有结束')
    end

    local function parse_number()
        local s, e = string.find(text, '^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
        if s == nil then err('数字格式不对') end
        local chunk = string.sub(text, s, e)
        pos = e + 1
        local n = tonumber(chunk)
        if n == nil then err('数字解析失败：' .. chunk) end
        return n
    end

    parse_value = function()
        skip_ws()
        if pos > len then err('内容突然结束') end
        local c = string.sub(text, pos, pos)
        if c == '{' then
            pos = pos + 1
            local obj = {}
            skip_ws()
            if string.sub(text, pos, pos) == '}' then pos = pos + 1; return obj end
            while true do
                skip_ws()
                if string.sub(text, pos, pos) ~= '"' then err('对象的键必须是字符串') end
                local key = parse_string()
                skip_ws()
                if string.sub(text, pos, pos) ~= ':' then err('缺少冒号') end
                pos = pos + 1
                obj[key] = parse_value()
                skip_ws()
                local sep = string.sub(text, pos, pos)
                if sep == ',' then pos = pos + 1
                elseif sep == '}' then pos = pos + 1; return obj
                else err('对象没有正常结束') end
            end
        elseif c == '[' then
            pos = pos + 1
            local arr = {}
            skip_ws()
            if string.sub(text, pos, pos) == ']' then pos = pos + 1; return arr end
            while true do
                arr[#arr + 1] = parse_value()
                skip_ws()
                local sep = string.sub(text, pos, pos)
                if sep == ',' then pos = pos + 1
                elseif sep == ']' then pos = pos + 1; return arr
                else err('数组没有正常结束') end
            end
        elseif c == '"' then
            return parse_string()
        elseif c == 't' then
            if string.sub(text, pos, pos + 3) == 'true' then pos = pos + 4; return true end
            err('看不懂的 true')
        elseif c == 'f' then
            if string.sub(text, pos, pos + 4) == 'false' then pos = pos + 5; return false end
            err('看不懂的 false')
        elseif c == 'n' then
            if string.sub(text, pos, pos + 3) == 'null' then pos = pos + 4; return nil end
            err('看不懂的 null')
        else
            return parse_number()
        end
    end

    local ok, value = pcall(parse_value)
    if not ok then return nil, tostring(value) end
    return value
end

BWS.json = J
