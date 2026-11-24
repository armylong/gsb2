import { useMemo, useState } from 'react';
import { clock, kindLabel, reasonLabel, verdictLabel } from '../lib/format';
import type { AuditRecord } from '../lib/types';
import { CheckIcon, ClockIcon } from './Icons';

interface EventLedgerProps {
  audit: readonly AuditRecord[];
  selectedIndex: number | null;
  onSelect: (record: AuditRecord) => void;
  onFocusTime: (record: AuditRecord) => void;
}

type Filter = 'all' | 'accepted' | 'rejected' | 'pending';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'accepted', label: '已生效' },
  { id: 'rejected', label: '未采用' },
  { id: 'pending', label: '未到达' },
];

export function EventLedger({ audit, selectedIndex, onSelect, onFocusTime }: EventLedgerProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(
    () => ({
      all: audit.length,
      accepted: audit.filter((record) => record.verdict === 'accepted').length,
      rejected: audit.filter((record) => record.verdict === 'rejected').length,
      pending: audit.filter((record) => record.verdict === 'pending').length,
    }),
    [audit],
  );

  const visible = useMemo(
    () => (filter === 'all' ? audit : audit.filter((record) => record.verdict === filter)),
    [audit, filter],
  );

  return (
    <section className="ledger" aria-label="接收台账">
      <header className="panel-head">
        <div>
          <h2 className="section-title">接收台账</h2>
          <p className="panel-sub">按到达顺序记录每一次接收；点一行跳到该次投递。</p>
        </div>
        <div className="segmented" role="group" aria-label="按接收结果筛选">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              className={`segmented__item ${filter === option.id ? 'is-active' : ''}`}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              <span className="segmented__count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
      </header>

      <ol className="ledger__list">
        <li className="ledger__row ledger__row--head" aria-hidden="true">
          <span>状态</span>
          <span>到达</span>
          <span>事件 / 字幕</span>
          <span>内容与处理结果</span>
        </li>
        {visible.length === 0 && (
          <li className="ledger__empty">当前筛选下没有记录。</li>
        )}
        {visible.map((record) => {
          const isSelected = selectedIndex === record.index;
          return (
            <li key={`${record.event.id}-${record.index}`}>
              <button
                type="button"
                className={`ledger__row is-${record.verdict} ${isSelected ? 'is-selected' : ''}`}
                onClick={() => {
                  onSelect(record);
                  onFocusTime(record);
                }}
                aria-current={isSelected ? 'true' : undefined}
              >
                <span className="ledger__status">
                  <span className={`status-dot is-${record.verdict}`} aria-hidden="true" />
                  <span className="ledger__status-text">
                    {verdictLabel[record.verdict]}
                    {record.reason && <em>{reasonLabel[record.reason]}</em>}
                  </span>
                </span>
                <span className="ledger__arrival">
                  {clock(record.event.arrival, 2)}
                  <em>seq{record.event.seq}</em>
                </span>
                <span className="ledger__ids">
                  <code>{record.event.id}</code>
                  <span>
                    {record.event.captionId} · {kindLabel(record.event.kind)}
                  </span>
                </span>
                <span className="ledger__text">
                  <span className="ledger__text-line">
                    {record.event.text.trim() === '' ? '（空正文）' : record.event.text}
                  </span>
                  {record.event.note && <span className="ledger__note">{record.event.note}</span>}
                  {record.verdict === 'rejected' && record.effectiveText && (
                    <span className="ledger__keep">
                      <CheckIcon size={13} /> 保留：{record.effectiveText}
                    </span>
                  )}
                  {record.verdict === 'pending' && (
                    <span className="ledger__keep ledger__keep--muted">
                      <ClockIcon size={13} /> 回放时钟尚未到达
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
