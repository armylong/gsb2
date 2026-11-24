import { FAILURE_ROUTE, SUCCESS_ROUTE, TARGET_ITEM } from '../engine/scenario'
import { ITEMS } from '../engine/items'

/** 两条试验路线：一条两笔连换成功，一条看似便宜但材料重复计数而失败 */
export function RoutePresets({
  onLoad,
  disabled,
}: {
  onLoad: (offerIds: readonly string[]) => void
  disabled: boolean
}) {
  return (
    <section className="panel routes-panel">
      <h2>试验路线（一键排队，再到队列里核对库存）</h2>
      <div className="route-grid">
        <div className="route-card route-good">
          <h3>✅ 成功路线：两笔连换拿到目标物</h3>
          <ol>
            <li>猎人铺子「兽皮搓绳」：2 兽皮 → 1 猎人绳</li>
            <li>猎人铺子「藏宝图套装」：1 猎人绳 + 2 纸券 → 1 {ITEMS[TARGET_ITEM].name}</li>
          </ol>
          <p className="route-note">
            第一笔产出的绳子进入预演料池，正好作为第二笔套装的材料 —— 注意预演里每一步的持有变化。
          </p>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => onLoad(SUCCESS_ROUTE)}
          >
            载入成功路线
          </button>
        </div>
        <div className="route-card route-bad">
          <h3>⚠️ 失败路线：看着便宜，材料却不够两份</h3>
          <ol>
            <li>贝壳匠「纸券换贝壳」：1 纸券 → 2 贝壳（确实便宜）</li>
            <li>贝壳匠「护符套装」：2 贝壳 + 2 香草 → 1 旅行护符</li>
          </ol>
          <p className="route-note">
            开局香草只有 1 份，今日又没有能补香草的额度外来源。
            同一份香草不能在套装里算两次 —— 第二步会明确报出 “herb 差 1”，第一步的贝壳保留在预演结果中可核对。
          </p>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => onLoad(FAILURE_ROUTE)}
          >
            载入失败路线
          </button>
        </div>
      </div>
    </section>
  )
}
