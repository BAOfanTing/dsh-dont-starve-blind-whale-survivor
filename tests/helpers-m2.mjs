// M2.0.2 测试公用：权威租约文件（Node 侧结构）与 Lua io.open 假实现
//
// Lua guard 只通过 GLOBAL.io.open 读权威文件；这里把文件放进内存表，
// 路径/解析/校验全走真实 guard.lua 逻辑（不算 Mock 掉 guard）。
export const LEASE_SCHEMA = 'bws.control-lease/1'

export function authority(over = {}) {
  return {
    schema: LEASE_SCHEMA,
    status: 'active',
    authority_epoch: 'epoch-A',
    generation: 12,
    owner_type: 'f8_agent',
    owner_instance_id: 'instance-A',
    lease_id: 'lease-A',
    runtime_id: 'r1794500000-0001',
    session_id: 'sess-R',
    shard_id: '1',
    actor_id: 'player:KU_r',
    acquired_at: 1794500000000,
    expires_at: 1794500060000,
    previous_owner_type: null,
    previous_owner_instance_id: null,
    ...over,
  }
}

/** 生成一段 Lua：把权威 JSON 挂到 GLOBAL.io.open 可读的虚拟文件里。传 null = 文件不存在 */
export function luaIoFiles(files) {
  const entries = Object.entries(files)
    .map(([name, value]) => {
      if (value === null || value === undefined) return ''
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      // 用 Lua 长字符串避免转义问题（内容里没有 ]] 即可）
      return `IO_FILES[${JSON.stringify(name)}] = ${JSON.stringify(text)}`
    })
    .join('\n')
  return `
IO_FILES = {}
${entries}
GLOBAL.io = {
    open = function(name, mode)
        local text = IO_FILES[name]
        if text == nil or mode ~= "r" then return nil end
        return {
            read = function(self, how) return text end,
            close = function(self) return true end,
        }
    end
}
`
}

/** 命令信封（与 dispatcher 生成的字段一致） */
export function command(authorityRecord, over = {}) {
  const a = authorityRecord ?? authority()
  return {
    protocol_version: 1,
    command_id: 'cmd-1',
    action: 'move_to',
    args: { x: 3, z: 4 },
    requested_by: a.owner_type,
    owner_type: a.owner_type,
    owner_instance_id: a.owner_instance_id,
    authority_epoch: a.authority_epoch,
    lease_id: a.lease_id,
    lease_generation: a.generation,
    lease_expires_at: a.expires_at,
    runtime_id: a.runtime_id,
    session_id: a.session_id,
    shard_id: a.shard_id,
    actor_id: a.actor_id,
    created_at: 1794500000000,
    expires_at: 1794500008000,
    ...over,
  }
}
