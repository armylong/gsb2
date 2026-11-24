import type { TradeRecord } from '../engine/types'
import { QtyChips } from './QtyChips'

/** 成交历史：永久保留成交当时的价格快照与报价版本 */
export function HistoryPanel({ history }: { history: TradeRecord[] }) {
  return (
    <section className="panel history-panel">
      <h2>成交历史（保留当时价格）</h2>
      {history.length === 0 ? (
        <p className="empty-hint">今天还没有成交。确认换物后，每笔都会按当时的报价记在这里。</p>
      ) : (
        <ol className="history-list">
          {history.map((r) => (
            <li key={r.id} className="history-row">
              <div className="history-head">
                <span className="history-day">第 {r.day} 日</span>
                <span className="history-stall">{r.stallName}</span>
                <span className={`step-kind kind-${r.kind}`}>
                  {r.kind === 'set' ? '套装' : '散装'}
                </span>
                <span className="history-title">{r.offerTitle}</span>
                <span className="history-version">成交于 v{r.version}</span>
              </div>
              <div className="history-lines">
                <QtyChips q={r.inputs} tone="in" />
                <span className="cart-arrow">→</span>
                <QtyChips q={r.outputs} tone="out" />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="legend">
        次日摊主改价后，这里的旧记录仍是成交当时的价格；新排队则按今日报价并标记旧预览过时。
        目标物：🗺️ 藏宝图
      </p>
    </section>
  )
}
