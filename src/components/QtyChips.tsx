import { ITEMS, ITEM_ORDER } from '../engine/items'
import type { Quantities } from '../engine/types'

/** 一组物品的小标签：🎫 纸券 ×2 */
export function QtyChips({ q, tone }: { q: Quantities; tone?: 'in' | 'out' | 'plain' }) {
  const entries = ITEM_ORDER.filter((id) => (q[id] ?? 0) > 0)
  if (entries.length === 0) return <span className="qty-empty">（无）</span>
  return (
    <span className={`qty-chips qty-${tone ?? 'plain'}`}>
      {entries.map((id) => (
        <span key={id} className="chip">
          <span aria-hidden>{ITEMS[id].icon}</span>
          {ITEMS[id].name}
          <b>×{q[id]}</b>
        </span>
      ))}
    </span>
  )
}
