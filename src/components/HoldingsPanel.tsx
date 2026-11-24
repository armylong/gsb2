import { ITEMS, ITEM_ORDER } from '../engine/items'
import type { Quantities } from '../engine/types'

/** 玩家持有量面板；delta 用来在数字旁显示预演增减 */
export function HoldingsPanel({
  holdings,
  delta,
}: {
  holdings: Quantities
  delta?: Quantities
}) {
  return (
    <section className="panel holdings-panel">
      <h2>玩家持有</h2>
      <div className="holdings-grid">
        {ITEM_ORDER.map((id) => {
          const n = holdings[id] ?? 0
          const d = delta?.[id] ?? 0
          const meta = ITEMS[id]
          return (
            <div
              key={id}
              className={`holding-cell ${n > 0 ? '' : 'empty'} ${
                meta.category === '目标物' ? 'is-target' : ''
              }`}
            >
              <span className="holding-icon" aria-hidden>
                {meta.icon}
              </span>
              <span className="holding-name">{meta.name}</span>
              <span className="holding-qty">{n}</span>
              {d !== 0 && (
                <span className={`holding-delta ${d > 0 ? 'up' : 'down'}`}>
                  {d > 0 ? `+${d}` : d}
                </span>
              )}
              {meta.category === '目标物' && <span className="target-tag">目标物</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
