import { cartStaleEntryIds, isEntryStale, simulateCart } from '../engine/engine'
import { describeQuantities } from '../engine/items'
import type { AppState } from '../state/reducer'
import type { StepResult } from '../engine/types'
import { QtyChips } from './QtyChips'

function StepRow({
  index,
  step,
  stale,
}: {
  index: number
  step: StepResult
  stale: boolean
}) {
  return (
    <li className={`step-row ${step.ok ? 'step-ok' : 'step-fail'}`}>
      <div className="step-head">
        <span className="step-index">{index + 1}</span>
        <span className="step-stall">{step.stallName}</span>
        <span className={`step-kind kind-${step.kind}`}>
          {step.kind === 'set' ? '套装' : '散装'}
        </span>
        <span className="step-title">{step.offerTitle}</span>
        <span className={`step-status ${stale ? 'stale' : ''}`}>
          {stale ? '已过时' : step.ok ? '可行' : '失败'}
        </span>
      </div>
      {step.ok ? (
        <div className="step-body">
          <div className="step-line">
            本步后持有：<QtyChips q={step.projected} />
          </div>
        </div>
      ) : (
        <div className="step-body step-reason">⛔ {step.reason}</div>
      )}
    </li>
  )
}

export function CartPanel({
  app,
  onRemove,
  onClear,
  onCommit,
}: {
  app: AppState
  onRemove: (entryId: string) => void
  onClear: () => void
  onCommit: () => void
}) {
  const { game } = app
  const result = simulateCart(game)
  const staleIds = cartStaleEntryIds(game)

  return (
    <section className="panel cart-panel">
      <h2>换物队列与逐笔预演</h2>
      {game.cart.length === 0 ? (
        <p className="empty-hint">
          队列为空。从下方摊位把报价排进来 —— 预演会按顺序模拟，前一笔的产物可以给后一笔用。
        </p>
      ) : (
        <>
          <ol className="cart-list">
            {game.cart.map((entry, index) => {
              const step = result.steps[index]
              const stale = isEntryStale(
                entry,
                game.offers.find((o) => o.id === entry.offerId),
              )
              const offer = entry.offerSnapshot
              return (
                <li
                  key={entry.id}
                  className={`cart-entry ${stale ? 'is-stale' : ''} ${
                    step && !step.ok && !stale ? 'is-failed' : ''
                  }`}
                >
                  <div className="cart-entry-head">
                    <span className="step-index">{index + 1}</span>
                    <span className="cart-entry-title">{offer.title}</span>
                    {stale && <span className="stale-badge">报价已过时</span>}
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => onRemove(entry.id)}
                    >
                      移除
                    </button>
                  </div>
                  <div className="cart-entry-lines">
                    <span>
                      付 <QtyChips q={offer.inputs} tone="in" />
                    </span>
                    <span className="cart-arrow">→</span>
                    <span>
                      得 <QtyChips q={offer.outputs} tone="out" />
                    </span>
                    {stale && (
                      <span className="stale-note">
                        （排队时 v{offer.version} 的旧价，今日报价已变更）
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>

          <h3 className="preview-title">逐笔预演（前一笔产物进入后一笔的料池）</h3>
          <ol className="step-list">
            {result.steps.map((step, index) => (
              <StepRow
                key={step.entryId}
                index={index}
                step={step}
                stale={staleIds.has(step.entryId)}
              />
            ))}
            {game.cart.slice(result.steps.length).map((entry, offset) => (
              <li key={entry.id} className="step-row step-skipped">
                <div className="step-head">
                  <span className="step-index">{result.steps.length + offset + 1}</span>
                  <span className="step-title">{entry.offerSnapshot.title}</span>
                  <span className="step-status">未执行</span>
                </div>
                <div className="step-body step-reason">
                  ⏭️ 前面的步骤失败，本步未模拟；修正队列后才会继续
                </div>
              </li>
            ))}
          </ol>
          {!result.ok && (
            <p className="preview-blocked">
              预演未通过，确认按钮已禁用 —— 失败步骤之前的预演结果仅供核对，不会真正扣料。
            </p>
          )}

          <div className="cart-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!result.ok}
              onClick={onCommit}
            >
              确认整队换物（套装一次完成）
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClear}>
              全部取消（持有与额度回位）
            </button>
          </div>
          <p className="cart-note">
            排队与预演都不动账本：只有全部步骤通过后确认，才一次性扣料、发货并占用摊主额度；
            取消时持有量和本日剩余次数原样不变。
          </p>
        </>
      )}
    </section>
  )
}

/** 供其他组件复用：预演结束后的持有量摘要 */
export function projectedSummary(app: AppState): string {
  return describeQuantities(simulateCart(app.game).projected)
}
