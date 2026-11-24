import type { ItemId, Quantities } from './types'

export type ItemCategory = '券' | '材料' | '加工品' | '目标物'

export interface ItemMeta {
  id: ItemId
  name: string
  category: ItemCategory
  icon: string
}

/** 物品图鉴：纸券、摊主认可的原材料、加工产物与最终目标物 */
export const ITEMS: Record<ItemId, ItemMeta> = {
  voucher: { id: 'voucher', name: '纸券', category: '券', icon: '🎫' },
  herb: { id: 'herb', name: '香草', category: '材料', icon: '🌿' },
  hide: { id: 'hide', name: '兽皮', category: '材料', icon: '🟫' },
  shell: { id: 'shell', name: '贝壳', category: '材料', icon: '🐚' },
  potion: { id: 'potion', name: '草药露', category: '加工品', icon: '🧪' },
  rope: { id: 'rope', name: '猎人绳', category: '加工品', icon: '🪢' },
  map: { id: 'map', name: '藏宝图', category: '目标物', icon: '🗺️' },
  charm: { id: 'charm', name: '旅行护符', category: '加工品', icon: '🧿' },
}

export const ITEM_ORDER: ItemId[] = [
  'voucher',
  'herb',
  'hide',
  'shell',
  'potion',
  'rope',
  'map',
  'charm',
]

export function itemName(id: ItemId): string {
  return ITEMS[id].name
}

/** 把一组数量渲染成 “3 纸券 + 2 香草” 的形式 */
export function describeQuantities(q: Quantities): string {
  const parts = ITEM_ORDER.filter((id) => (q[id] ?? 0) > 0).map(
    (id) => `${q[id]} ${ITEMS[id].name}`,
  )
  return parts.length > 0 ? parts.join(' + ') : '（无）'
}
