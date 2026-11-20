// 统一 Prefab 规范化与别名映射模块 (bws.prefab-utils)
//
// 统一解决科技建筑与基础容器在逻辑名 (配方名) 与原生实体 prefab 之间的不一致问题：
//   - sciencemachine <-> researchlab
//   - alchemyengine  <-> researchlab2
//   - chest          <-> treasurechest

/** 原生实体与逻辑配方的标准规范化映射表 */
export const PREFAB_CANONICAL_MAP = Object.freeze({
  sciencemachine: 'researchlab',
  researchlab: 'researchlab',
  alchemyengine: 'researchlab2',
  researchlab2: 'researchlab2',
  chest: 'treasurechest',
  treasurechest: 'treasurechest',
  campfire: 'campfire',
  firepit: 'firepit',
  cookpot: 'cookpot',
  tent: 'tent',
})

/**
 * 规范化 prefab 名称（转换为原生标准 prefab 名称）。
 * @param {string} [name]
 * @returns {string}
 */
export function normalizePrefab(name) {
  if (typeof name !== 'string') return ''
  const trimmed = name.trim().toLowerCase()
  return PREFAB_CANONICAL_MAP[trimmed] || trimmed
}

/**
 * 判断两个 prefab 标识是否指向同一种实体或配方。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSamePrefab(a, b) {
  const normA = normalizePrefab(a)
  const normB = normalizePrefab(b)
  return Boolean(normA && normB && normA === normB)
}

/**
 * 获取某个 prefab 对应的所有等价别名列表。
 * @param {string} name
 * @returns {string[]}
 */
export function prefabAliases(name) {
  const canonical = normalizePrefab(name)
  if (!canonical) return []
  const aliases = new Set([canonical])
  for (const [alias, target] of Object.entries(PREFAB_CANONICAL_MAP)) {
    if (target === canonical) aliases.add(alias)
  }
  return [...aliases]
}

/**
 * 检查实体对象是否匹配指定的 prefab（支持别名匹配）。
 * @param {object} entity - 快照中的实体或已知建筑记录
 * @param {string} expectedPrefab - 目标 prefab（逻辑名或原生名）
 * @returns {boolean}
 */
export function matchStructure(entity, expectedPrefab) {
  if (!entity || !expectedPrefab) return false
  return isSamePrefab(entity.prefab, expectedPrefab)
}
