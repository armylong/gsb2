import { useMemo, useState } from 'react';
import type { SimulationResult } from '../engine/types';
import { formatMs } from '../engine/simulator';
import { CATEGORY_ICON, CATEGORY_LABEL, deltaRows } from '../ui';

type Filter = 'all' | 'damage' | 'effect' | 'skipped';

export function SettlementLog({
  result,
  cursor,
  selectedSeq,
  onSelect,
  computedAt,
  computeMs,
}: {
  result: SimulationResult;
  cursor: number;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  computedAt: Date;
  computeMs: number;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [showFuture, setShowFuture] = useState(true);

  const rows = useMemo(() => {
    return result.records.filter((record) => {
      if (!showFuture && record.seq > cursor) return false;
      if (filter === 'damage') return ['damage', 'tick', 'death'].includes(record.kind);
      if (filter === 'effect') return ['apply', 'refresh', 'stack', 'dispel', 'expire', 'shieldAbsorb', 'shieldBreak'].includes(record.kind);
      if (filter === 'skipped') return record.kind === 'skipped';
      return true;
    });
  }, [result.records, filter, showFuture, cursor]);

  const active = result.records[cursor];

  return (
    <div className="card log-card">
      <div className="card-head">
        <h2>结算日志</h2>
        <div className="filters">
          {(
            [
              ['all', '全部'],
              ['damage', '伤害'],
              ['effect', '效果'],
              ['skipped', '跳过'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button key={id} className={filter === id ? 'chip active' : 'chip'} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
          <label className="toggle">
            <input type="checkbox" checked={showFuture} onChange={() => setShowFuture((value) => !value)} />
            显示未来
          </label>
        </div>
      </div>
      <div className="recompute-bar">
        <span className="dot-live" aria-hidden="true" />
        按当前时间表重算 · 指纹 <code>{result.scheduleHash.split(':').pop()}</code> ·{' '}
        {computedAt.toLocaleTimeString('zh-CN', { hour12: false })}（{computeMs}ms）
        <span className="muted">时间表改变会立即重算，旧记录不会沿用</span>
      </div>
      <div className="log-scroll">
        <table className="log">
          <thead>
            <tr>
              <th>#</th>
              <th>时刻</th>
              <th>类型</th>
              <th>结算</th>
              <th>生命</th>
              <th>护盾</th>
              <th>攻击</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => {
              const isCurrent = record.seq === cursor;
              const isSelected = record.seq === selectedSeq;
              return (
                <tr
                  key={record.seq}
                  className={[
                    isCurrent ? 'current' : '',
                    isSelected ? 'selected' : '',
                    record.seq > cursor ? 'future' : '',
                    `cat-${record.kind}`,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onSelect(record.seq)}
                >
                  <td className="num">{record.seq + 1}</td>
                  <td className="num">{formatMs(record.time)}</td>
                  <td>
                    <span className={`cat-badge cat-${record.kind}`}>{CATEGORY_ICON[record.kind]}</span>{' '}
                    {CATEGORY_LABEL[record.kind]}
                  </td>
                  <td className="text">{record.text}</td>
                  <td className="num">{record.after.hp}</td>
                  <td className="num">{record.after.shieldTotal}</td>
                  <td className="num">{record.after.attack.effectiveAttack}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted empty">没有符合筛选条件的结算记录。</p>}
      </div>
      {active && (
        <div className="log-foot">
          <span className="muted">当前：</span>#{active.seq + 1} {active.text}
          {Object.keys(active.delta).length > 0 && (
            <span className="foot-deltas">
              {deltaRows(active.delta).slice(0, 4).map((row) => (
                <span key={row.label} className="mini-kv">
                  {row.label} {row.value}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
