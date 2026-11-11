-- 迷你 JSON 编解码
-- 为什么不直接用游戏自带的 scripts/json.lua：它自己的注释就写着 encode() 不符合 JSON 规范
-- （字符串里的换行、引号转义不全），写到文件里给外面读会坏掉。这里自己写一份，够用、可预测。

local GLOBAL = GLOBAL
-- 饥荒的模组沙箱只给了 pairs/ipairs/print/math/table/type/string/tostring/require/Class，
-- pcall / tonumber / error / os / io 这些得从 GLOBAL（就是 _G）里拿，直接用会报 nil（0.1.0 就是这么崩的）。
local pcall = GLOBAL.pcall
local tonumber = GLOBAL.tonumber
local error = GLOBAL.error
local os = GLOBAL.os or { time = function() return 0 end }
local io = GLOBAL.io

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
    -- %c 是控制字符，5.1（饥荒用的）和 5.3 都认；不用 %z（5.3 里已经删掉了）
    s = s:gsub('[%c\\"]', function(c)
        return ESCAPES[c] or string.format('\\u%04x', string.byte(c))
    end)
    return '"' .. s .. '"'
end

-- 只有“键是 1..n 的连续整数”才当数组，其余都当对象
local function array_size(v)
    local n = 0
    for k in pairs(v) do
        if type(k) ~= 'number' or k < 1 or k ~= math.floor(k) then return 0 end
        n = n + 1
    end
    if n == 0 then return 0 end
    for i = 1, n do
        if v[i] == nil then return 0 end
    end
    return n
end

local encode_value

local function encode_table(v, out)
    local n = array_size(v)
    if n > 0 then
        out[#out + 1] = '['
        for i = 1, n do
            if i > 1 then out[#out + 1] = ',' end
            encode_value(v[i], out)
        end
        out[#out + 1] = ']'
    else
        out[#out + 1] = '{'
        local first = true
        for k, val in pairs(v) do
            local t = type(k)
            if t == 'string' or t == 'number' then
                if not first then out[#out + 1] = ',' end
                first = false
                out[#out + 1] = encode_string(tostring(k))
                out[#out + 1] = ':'
                encode_value(val, out)
            end
        end
        out[#out + 1] = '}'
    end
end

encode_value = function(v, out)
    local t = type(v)
    if v == nil then
        out[#out + 1] = 'null'
    elseif t == 'boolean' then
        out[#out + 1] = v and 'true' or 'false'
    elseif t == 'number' then
        if v ~= v or v == math.huge or v == -math.huge then
            out[#out + 1] = 'null'
        elseif v == math.floor(v) and math.abs(v) < 1e15 then
            out[#out + 1] = string.format('%d', math.floor(v))
        else
            local s = string.format('%.4f', v)
            s = s:gsub('0+$', ''):gsub('%.$', '')
            out[#out + 1] = s
        end
    elseif t == 'string' then
        out[#out + 1] = encode_string(v)
    elseif t == 'table' then
        encode_table(v, out)
    else
        -- 函数、userdata 这些直接丢掉，别把整份状态搞坏
        out[#out + 1] = 'null'
    end
end

function J.encode(v)
    local out = {}
    encode_value(v, out)
    return table.concat(out)
end

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

function J.decode(str)
    local pos = 1
    local len = #str

    local function err(msg)
        error(msg .. '（位置 ' .. tostring(pos) .. '）', 0)
    end

    local function skip_ws()
        while pos <= len do
            local c = str:sub(pos, pos)
            if c == ' ' or c == '\t' or c == '\r' or c == '\n' then
                pos = pos + 1
            else
                return
            end
        end
    end

    local parse_value

    local function parse_string()
        pos = pos + 1 -- 跳过开头的引号
        local buf = {}
        while pos <= len do
            local c = str:sub(pos, pos)
            if c == '"' then
                pos = pos + 1
                return table.concat(buf)
            elseif c == '\\' then
                local e = str:sub(pos + 1, pos + 1)
                pos = pos + 2
                if e == 'n' then
                    buf[#buf + 1] = '\n'
                elseif e == 't' then
                    buf[#buf + 1] = '\t'
                elseif e == 'r' then
                    buf[#buf + 1] = '\r'
                elseif e == 'b' then
                    buf[#buf + 1] = '\b'
                elseif e == 'f' then
                    buf[#buf + 1] = '\f'
                elseif e == 'u' then
                    local cp = tonumber(str:sub(pos, pos + 3), 16) or 63
                    pos = pos + 4
                    if cp >= 0xD800 and cp <= 0xDBFF and str:sub(pos, pos + 1) == '\\u' then
                        local low = tonumber(str:sub(pos + 2, pos + 5), 16)
                        if low and low >= 0xDC00 and low <= 0xDFFF then
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
        local s, e = str:find('^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
        if not s then err('数字格式不对') end
        local text = str:sub(s, e)
        pos = e + 1
        local n = tonumber(text)
        if n == nil then err('数字解析失败：' .. text) end
        return n
    end

    parse_value = function()
        skip_ws()
        if pos > len then err('内容突然结束') end
        local c = str:sub(pos, pos)
        if c == '{' then
            pos = pos + 1
            local obj = {}
            skip_ws()
            if str:sub(pos, pos) == '}' then
                pos = pos + 1
                return obj
            end
            while true do
                skip_ws()
                if str:sub(pos, pos) ~= '"' then err('对象的键必须是字符串') end
                local key = parse_string()
                skip_ws()
                if str:sub(pos, pos) ~= ':' then err('缺少冒号') end
                pos = pos + 1
                obj[key] = parse_value()
                skip_ws()
                local sep = str:sub(pos, pos)
                if sep == ',' then
                    pos = pos + 1
                elseif sep == '}' then
                    pos = pos + 1
                    return obj
                else
                    err('对象没有正常结束')
                end
            end
        elseif c == '[' then
            pos = pos + 1
            local arr = {}
            skip_ws()
            if str:sub(pos, pos) == ']' then
                pos = pos + 1
                return arr
            end
            while true do
                arr[#arr + 1] = parse_value()
                skip_ws()
                local sep = str:sub(pos, pos)
                if sep == ',' then
                    pos = pos + 1
                elseif sep == ']' then
                    pos = pos + 1
                    return arr
                else
                    err('数组没有正常结束')
                end
            end
        elseif c == '"' then
            return parse_string()
        elseif c == 't' then
            if str:sub(pos, pos + 3) == 'true' then
                pos = pos + 4
                return true
            end
            err('看不懂的 true')
        elseif c == 'f' then
            if str:sub(pos, pos + 4) == 'false' then
                pos = pos + 5
                return false
            end
            err('看不懂的 false')
        elseif c == 'n' then
            if str:sub(pos, pos + 3) == 'null' then
                pos = pos + 4
                return nil
            end
            err('看不懂的 null')
        else
            return parse_number()
        end
    end

    return parse_value()
end

Whale = Whale or {}
Whale.json = J
