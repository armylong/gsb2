import { useMemo, useReducer } from 'react'
import { CartPanel } from './components/CartPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { HoldingsPanel } from './components/HoldingsPanel'
import { RoutePresets } from './components/RoutePresets'
import { Stalls } from './components/Stalls'
import { DAY_TWO_CHANGES, TARGET_ITEM } from './engine/scenario'
import { simulateCart } from './engine/engine'
import { ITEMS } from './engine/items'
import type { ItemId, Quantities } from './engine/types'
import { initAppState, reducer } from './state/reducer'

function diffQuantities(after: Quantities, before: Quantities): Quantities {
  const ids = new Set([...Object.keys(after), ...Object.keys(before)]) as Set<ItemId>
  const delta: Quantities = {}
  for (const id of ids) {
    const d = (after[id] ?? 0) - (before[id] ?? 0)
    if (d !== 0) delta[id] = d
  }
  return delta
}

export default function App() {
  const [app, dispatch] = useReducer(reducer, undefined, initAppState)
  const { game } = app

  const simulation = useMemo(() => simulateCart(game), [game])
  const delta = useMemo(
    () => diffQuantities(simulation.projected, game.holdings),
    [simulation.projected, game.holdings],
  )

  const dayTwoNotes = Object.values(DAY_TWO_CHANGES).map((c) => c.note)

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>旅行集市 · 换物规则试验台</h1>
          <p className="subtitle">
            纸券与摊主认可的材料 · 套装必须一次成套 · 验证拆开排队会不会让摊主多付东西
          </p>
        </div>
        <div className="header-actions">
          <div className="day-badge">第 {game.day} 日</div>
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'NEXT_DAY' })}
            title="进入次日：部分摊位改价 / 改限额，额度重置"
          >
            进入次日 →
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => dispatch({ type: 'RESET' })}>
            重置试验
          </button>
        </div>
      </header>

      {app.notice && <div className="banner banner-info">{app.notice}</div>}
        {app.lastCommit &&
        (app.lastCommit.result.ok ? (
          <div className="banner banner-ok">
            ✅ 整队 {app.lastCommit.records.length} 笔换物已一次性成交，当前目标物持有：
            {game.holdings[TARGET_ITEM] ?? 0} 份 {ITEMS[TARGET_ITEM].name}
          </div>
        ) : (
          <div className="banner banner-fail">
            ⛔ 确认被拒绝：{app.lastCommit.result.steps.find((s) => !s.ok)?.reason}
            —— 任何持有量与额度都没有变动
          </div>
        ))}

      {game.day >= 2 && (
        <div className="banner banner-day">
          <b>次日报价变化：</b>
          <ul>
            {dayTwoNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <HoldingsPanel holdings={game.holdings} delta={delta} />

      <RoutePresets
        disabled={game.cart.length > 0}
        onLoad={(offerIds) => dispatch({ type: 'LOAD_ROUTE', offerIds })}
      />

      <div className="two-col">
        <Stalls state={game} onAdd={(offerId) => dispatch({ type: 'ADD', offerId })} />
        <CartPanel
          app={app}
          onRemove={(entryId) => dispatch({ type: 'REMOVE', entryId })}
          onClear={() => dispatch({ type: 'CLEAR' })}
          onCommit={() => dispatch({ type: 'COMMIT' })}
        />
      </div>

      <HistoryPanel history={game.history} />

      <footer className="app-footer">
        规则要点：排队只做预演不扣料；套装原子成交；暂放材料在同一料池内扣减，无法同时算给两家；
        取消即回位；次日改价后旧预览标记过时，历史保留成交价。
      </footer>
    </div>
  )
}
