import { clock, kindLabel, reasonLabel, verdictLabel, windowLabel } from '../lib/format';
import type { AuditRecord, CaptionState, ReplaySnapshot } from '../lib/types';
import { CheckIcon, FlagIcon, LayersIcon } from './Icons';

interface InspectorProps {
  snapshot: ReplaySnapshot;
  selected: AuditRecord | null;
}

function CaptionRow({ caption }: { caption: CaptionState }) {
  const revision = caption.accepted;
  return (
    <li className={`caption-row is-${caption.window}`}>
      <div className="caption-row__top">
        <span className="caption-row__id">{caption.captionId}</span>
        <span className={`chip chip--${caption.window}`}>{windowLabel[caption.window]}</span>
        {caption.final && (
          <span className="chip chip--final">
            <FlagIcon size={12} /> 已确认
          </span>
        )}
      </div>
      <p className={`caption-row__text ${revision ? '' : 'is-empty'}`}>
        {revision ? revision.text : '尚未收到任何版本'}
      </p>
      <div className="caption-row__meta">
        {revision ? (
          <>
            <span>seq {revision.seq}</span>
            <span>{clock(revision.mediaStart, 1)}–{clock(revision.mediaEnd, 1)}</span>
            <span>生效于 {clock(revision.arrival, 2)}</span>
          </>
        ) : (
          <span>等待投递</span>
        )}
        <span className="caption-row__counts">
          <em>收 {caption.acceptedCount}</em>
          {caption.rejectedCount > 0 && <em className="is-reject">拒 {caption.rejectedCount}</em>}
          {caption.pendingCount > 0 && <em>待 {caption.pendingCount}</em>}
        </span>
      </div>
    </li>
  );
}

export function Inspector({ snapshot, selected }: InspectorProps) {
  const rejected = snapshot.audit.filter((record) => record.verdict === 'rejected');
  const reasonCounts = rejected.reduce<Record<string, number>>((acc, record) => {
    if (record.reason) acc[record.reason] = (acc[record.reason] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="inspector" aria-label="状态详情">
      <header className="panel-head">
        <div>
          <h2 className="section-title">字幕状态</h2>
          <p className="panel-sub">
            截至接收时刻 {clock(snapshot.time, 2)}，画面时钟 {clock(snapshot.presentationTime, 2)}。
          </p>
        </div>
        <span className="count-pill">
          <LayersIcon size={14} /> {snapshot.captions.length} 条字幕
        </span>
      </header>

      {snapshot.captions.length === 0 ? (
        <p className="inspector__empty">还没有任何投递，台账与画面均为空。</p>
      ) : (
        <ul className="caption-list">
          {snapshot.captions.map((caption) => (
            <CaptionRow key={caption.captionId} caption={caption} />
          ))}
        </ul>
      )}

      <div className="inspector__summary">
        <div className="summary-item">
          <span className="summary-item__label">已接收</span>
          <strong>{snapshot.stats.receivedCount}</strong>
        </div>
        <div className="summary-item">
          <span className="summary-item__label">生效接收</span>
          <strong>{snapshot.stats.acceptedCount}</strong>
        </div>
        <div className="summary-item">
          <span className="summary-item__label">拦截</span>
          <strong>{snapshot.stats.rejectedCount}</strong>
        </div>
        <div className="summary-item">
          <span className="summary-item__label">待到达</span>
          <strong>{snapshot.stats.pendingCount}</strong>
        </div>
      </div>

      {Object.keys(reasonCounts).length > 0 && (
        <div className="reason-breakdown">
          {Object.entries(reasonCounts).map(([reason, count]) => (
            <span key={reason} className="reason-chip">
              {reasonLabel[reason as keyof typeof reasonLabel]}
              <b>{count}</b>
            </span>
          ))}
        </div>
      )}

      <div className="inspect-card">
        <h3 className="inspect-card__title">
          <CheckIcon size={15} /> 选中投递
        </h3>
        {selected ? (
          <dl className="inspect-grid">
            <div>
              <dt>事件</dt>
              <dd>
                <code>{selected.event.id}</code>
              </dd>
            </div>
            <div>
              <dt>字幕 / 序号</dt>
              <dd>
                {selected.event.captionId} · seq{selected.event.seq} · {kindLabel(selected.event.kind)}
              </dd>
            </div>
            <div>
              <dt>到达 / 媒体区间</dt>
              <dd>
                {clock(selected.event.arrival, 2)} · {clock(selected.event.mediaStart, 1)}–
                {clock(selected.event.mediaEnd, 1)}
              </dd>
            </div>
            <div>
              <dt>判定</dt>
              <dd>
                {verdictLabel[selected.verdict]}
                {selected.reason ? `（${reasonLabel[selected.reason]}）` : ''}
              </dd>
            </div>
            <div>
              <dt>生效序号</dt>
              <dd>
                {selected.acceptedSeqBefore ?? '—'} → {selected.acceptedSeqAfter ?? '—'}
              </dd>
            </div>
            <div>
              <dt>该刻生效文本</dt>
              <dd className="inspect-grid__text">
                {selected.effectiveText ?? '（尚未收到）'}
                {selected.effectiveFinal ? '（已确认）' : ''}
              </dd>
            </div>
            {selected.event.note && (
              <div className="inspect-grid__full">
                <dt>样例说明</dt>
                <dd>{selected.event.note}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="inspect-card__empty">在台账或时间轴上选择一次投递，查看判定依据。</p>
        )}
      </div>
    </section>
  );
}
