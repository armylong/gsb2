import { SequenceStep } from '../audio/engine';

interface Props {
  sequence: SequenceStep[];
  counters: Record<string, number>;
  zoneLabels: Record<string, string>;
  onReset: () => void;
  onReplay: () => void;
}

/** 力度序列与轮转计数：重置后重放相同力度序列，变体选择必然相同 */
export function SequencePanel({ sequence, counters, zoneLabels, onReset, onReplay }: Props) {
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>力度序列与轮转</h2>
        <span className="spacer" />
        <button className="tiny" onClick={onReplay} disabled={sequence.length === 0}>
          按原时间间隔重放
        </button>
        <button className="tiny" onClick={onReset}>
          重置轮转/序列
        </button>
      </div>

      <div className="row wrap" style={{ marginBottom: 8 }}>
        {Object.entries(counters).map(([zoneId, n]) => (
          <span key={zoneId} className="chip-layer">
            {zoneLabels[zoneId] ?? zoneId}：已触发 {n} 次
          </span>
        ))}
        {Object.keys(counters).length === 0 && <span className="muted">重置后计数归零，等待触发</span>}
      </div>

      <div className="log-scroll" style={{ maxHeight: 150 }}>
        <table className="log">
          <thead>
            <tr>
              <th>#</th>
              <th>力度</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {[...sequence].reverse().map((s, i) => (
              <tr key={i}>
                <td className="mono">{sequence.length - i}</td>
                <td className="mono">{s.velocity}</td>
                <td>
                  {s.played ? <span className="badge ready">已播出</span> : <span className="badge error">被拦下</span>}
                </td>
              </tr>
            ))}
            {sequence.length === 0 && (
              <tr><td colSpan={3} className="muted">暂无</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
