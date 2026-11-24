import { offerRemaining } from '../engine/engine'
import { ITEMS } from '../engine/items'
import type { GameState, Offer, Stall } from '../engine/types'
import { QtyChips } from './QtyChips'

function OfferCard({
  offer,
  state,
  onAdd,
}: {
  offer: Offer
  state: GameState
  onAdd: (offerId: string) => void
}) {
  const remaining = offerRemaining(offer, state.quotaUsed)
  const soldOut = remaining <= 0
  return (
    <div className={`offer-card ${offer.kind === 'set' ? 'is-set' : 'is-loose'}`}>
      <div className="offer-head">
        <span className={`offer-kind kind-${offer.kind}`}>
          {offer.kind === 'set' ? '套装 · 一次成锅' : '散装'}
        </span>
        <span className="offer-title">{offer.title}</span>
        <span className="offer-version">v{offer.version}</span>
      </div>
      <div className="offer-lines">
        <div className="offer-line">
          <span className="line-label">收</span>
          <QtyChips q={offer.inputs} tone="in" />
        </div>
        <div className="offer-arrow" aria-hidden>
          ↓
        </div>
        <div className="offer-line">
          <span className="line-label">给</span>
          <QtyChips q={offer.outputs} tone="out" />
        </div>
      </div>
      <div className="offer-foot">
        <span className={`quota ${soldOut ? 'sold-out' : ''}`}>
          本日剩 {remaining}/{offer.dailyLimit} 次
        </span>
        <button
          type="button"
          className="btn btn-small"
          disabled={soldOut}
          onClick={() => onAdd(offer.id)}
        >
          排入换物队列
        </button>
      </div>
    </div>
  )
}

export function Stalls({
  state,
  onAdd,
}: {
  state: GameState
  onAdd: (offerId: string) => void
}) {
  return (
    <section className="panel stalls-panel">
      <h2>集市摊位（收什么 · 给什么 · 本日剩几次）</h2>
      {state.stalls.map((stall: Stall) => {
        const offers = state.offers.filter((o) => o.stallId === stall.id)
        return (
          <div key={stall.id} className="stall-block">
            <div className="stall-head">
              <h3>
                {stall.name}
                <span className="keeper">摊主：{stall.keeper}</span>
              </h3>
              <p className="stall-blurb">{stall.blurb}</p>
            </div>
            <div className="offer-grid">
              {offers.map((offer) => (
                <OfferCard key={offer.id} offer={offer} state={state} onAdd={onAdd} />
              ))}
            </div>
          </div>
        )
      })}
      <p className="legend">
        图标速查：
        {Object.values(ITEMS)
          .filter((m) => m.category !== '券')
          .map((m) => `${m.icon}${m.name}`)
          .join(' · ')}
      </p>
    </section>
  )
}
