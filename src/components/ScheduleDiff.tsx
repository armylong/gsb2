import type { SimulationResult } from '../engine/types';
import { formatMs } from '../engine/simulator';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../ui';

/**
 * 时间轴下方的“差异说明”面板：把实际发生的结算与跳过的结算并列，
 * 让重施、到期边界、护盾耗尽这些规则一眼可见。
 */
export function ScheduleDiff({ result }: { result: SimulationResult }) {
  const happened = result.records.filter((record) => record.kind !== 'skipped');
  const skipped = result.records.filter((record) => record.kind === 'skipped');

  const boundarySkips = skipped.filter((record) => record.delta.reason === '到期边界');
  const deathSkips = skipped.filter((record) => record.delta.reason === '目标已死亡');
  const sourceSkips = skipped.filter((record) => record.delta.reason === '来源无生效效果');

  const expiries = result.records.filter((record) => record.kind === 'expire');
  const refreshes = result.records.filter((record) => record.kind === 'refresh');
  const shieldExpiry = expiries.filter((record) => record.delta.remaining !== undefined);

  return (
    <div className="card diff-card">
      <div className="card-head">
        <h2>本次时间线结果</h2>
        <span className="muted tiny">实际发生 {happened.length} 条 · 跳过 {skipped.length} 条</span>
      </div>
      <div className="diff-grid">
        <DiffStat label="到期结算" value={expiries.length} hint="先移除，再处理该时刻事件" />
        <DiffStat label="刷新" value={refreshes.length} hint="保留原有触发节奏" highlight />
        <DiffStat label="边界跳过" value={boundarySkips.length} hint="到期时刻不再触发周期伤害" warn={boundarySkips.length > 0} />
        <DiffStat label="护盾到期移除" value={shieldExpiry.length} hint="不计入生命损失" />
        <DiffStat label="死亡后跳过" value={deathSkips.length} hint="伤害与施加不再发生" />
        <DiffStat label="无效来源驱散" value={sourceSkips.length} hint="来源隔离" />
      </div>
      {skipped.length > 0 && (
        <details className="diff-details">
          <summary>查看被跳过的结算（{skipped.length} 条）</summary>
          <table className="kv compact">
            <thead>
              <tr>
                <th>时刻</th>
                <th>类型</th>
                <th>原因</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {skipped.map((record) => (
                <tr key={record.seq}>
                  <td>{formatMs(record.time)}</td>
                  <td>{CATEGORY_ICON[record.kind]} {CATEGORY_LABEL[record.kind]}</td>
                  <td>{String(record.delta.reason ?? '—')}</td>
                  <td>{record.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function DiffStat({ label, value, hint, highlight, warn }: { label: string; value: number; hint: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className={`diff-stat ${highlight ? 'highlight' : ''} ${warn ? 'warn' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{hint}</small>
    </div>
  );
}
