/** 图形与数据全部程序生成, 配色为深色战术面板 */
export const C = {
  page: '#0d0d0d',
  surface: '#1a1a19',
  surfaceRaised: '#222220',
  surfaceSunken: '#141413',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  hairline: 'rgba(255,255,255,0.10)',

  ally: '#3987e5',
  enemy: '#d95926',

  hp: '#0ca30c',
  hpWarn: '#fab219',
  hpCrit: '#d03b3b',
  shield: '#3987e5',
  ap: '#fab219',
  attack: '#e66767',
  delay: '#c98500',
  gain: '#199e70',
  skip: '#898781',
} as const

export function hpColor(hp: number, maxHp: number): string {
  const ratio = maxHp > 0 ? hp / maxHp : 0
  if (ratio > 0.5) return C.hp
  if (ratio > 0.25) return C.hpWarn
  return C.hpCrit
}

export function factionColor(side: 'ally' | 'enemy'): string {
  return side === 'ally' ? C.ally : C.enemy
}

/** 生成头像纹样: 由角色 id 决定的确定性线条, 不依赖外部素材 */
export function sigilSeed(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}
