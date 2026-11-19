import { useMemo } from 'react';
import type { EffectLifetime, SimulationResult } from '../engine/types';
import { formatMs } from '../engine/simulator';
import { axisTicks, clampEnd, pctOf } from '../timelineLayout';

const COLORS: Record<'attackBuff' | 'periodicDamage' | 'shield', string> = {
  attackBuff: 'var(--series-1)',
  periodicDamage: 'var(--series-2)',
  shield: 'var(--series-3)',
};

const KIND_NAME = {
  attackBuff: '攻击加成',
  periodicDamage: '周期伤害',
  shield: '护盾',
} as const;

export function EffectTimeline({
  result,
  rows,
  cursorTime,
  selectedKey,
  onSelect,
  onSeek,
  onSelectRecord,
}: {
  result: SimulationResult;
  rows: EffectLifetime[];
  cursorTime: number;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onSeek: (time: number) => void;
  onSelectRecord: (seq: number) => void;
}) {
  const ticks = useMemo(() => axisTicks(result.horizonMs), [result.horizonMs]);
  const eventTimes = useMemo(() => [...new Set(result.schedule.map((e) => e.time))].sort((a, b) => a - b), [result.schedule]);
  const goalRows = rows.filter((row) => row.kind !== 'attackBuff');
  const stackRows = rows.filter((row) => row.kind === 'attackBuff');

  return (
    <div className="card timeline-card">
      <div className="card-head">
        <h2>效果时间线</h2>
        <div className="legend">
          {(Object.keys(COLORS) as (keyof typeof COLORS)[]).map((kind) => (
            <span key={kind} className="legend-item">
              <span className="legend-swatch" style={{ background: COLORS[kind] }} />
              {KIND_NAME[kind]}
            </span>
          ))}
          <span className="legend-item">
            <span className="legend-marker event" />
            用户事件
          </span>
          <span className="legend-item">
            <span className="legend-marker skipped" />✕
            跳过
          </span>
        </div>
      </div>

      <div className="timeline-scroll">
        <div className="timeline" style={{ ['--horizon' as string]: result.horizonMs }}>
          <div className="timeline-axis">
            <span className="row-label axis-label">时间</span>
            <div className="axis-track">
              {ticks.map((tick) => {
                const major = tick % 5000 === 0;
                const edge = tick === 0 ? ' first' : tick === result.horizonMs ? ' last' : '';
                return (
                  <span
                    key={tick}
                    className={major ? `axis-tick major${edge}` : 'axis-tick'}
                    style={{ left: `${pctOf(tick, result.horizonMs)}%` }}
                    data-label={major ? `${tick / 1000}s` : undefined}
                  />
                );
              })}
              {eventTimes.map((time) => (
                <button
                  key={time}
                  className="event-notch"
                  style={{ left: `${pctOf(time, result.horizonMs)}%` }}
                  onClick={() => onSeek(time)}
                  title={`事件时刻 ${formatMs(time)}`}
                  aria-label={`跳转到 ${formatMs(time)}`}
                />
              ))}
            </div>
          </div>

          <div
            className="timeline-cursor"
            style={{ ['--pct' as string]: pctOf(cursorTime, result.horizonMs) / 100 }}
          >
            <span className="cursor-flag">{Math.round(cursorTime)}ms</span>
          </div>

          {goalRows.map((row) => (
            <TimelineRow
              key={row.key}
              row={row}
              horizon={result.horizonMs}
              selected={selectedKey === row.key}
              onSelect={() => onSelect(selectedKey === row.key ? null : row.key)}
              onSeek={onSeek}
              onSelectRecord={onSelectRecord}
            />
          ))}

          {stackRows.length > 0 && (
            <>
              <div className="timeline-divider">攻击加成 · 各层独立到期</div>
              {stackRows.map((row) => (
                <TimelineRow
                  key={row.key}
                  row={row}
                  horizon={result.horizonMs}
                  selected={selectedKey === row.key}
                  onSelect={() => onSelect(selectedKey === row.key ? null : row.key)}
                  onSeek={onSeek}
                  onSelectRecord={onSelectRecord}
                />
              ))}
            </>
          )}
        </div>
      </div>

      <div className="timeline-footer">
        <div className="footer-group">
          <span className="footer-title">实际发生</span>
          <span className="footer-chip">
            <span className="mini-dot tick" /> 周期伤害跳数
          </span>
          <span className="footer-chip">
            <span className="mini-dot absorb" /> 护盾吸收
          </span>
        </div>
        <div className="footer-group">
          <span className="footer-title">到期/跳过</span>
          <span className="footer-chip">
            <span className="mini-dot end" />⏱ 定时到期
          </span>
          <span className="footer-chip">
            <span className="mini-dot depleted" />✕ 耗尽/驱散
          </span>
          <span className="footer-chip">
            <span className="mini-dot skip" /> ✕ 跳过结算
          </span>
          <span className="footer-chip">
            <span className="mini-dot refresh" /> 重施刷新
          </span>
        </div>
        <p className="muted tiny">点击色条跳到该效果起点；点击标记选中；点击顶部事件刻度跳转到事件时刻。</p>
      </div>
    </div>
  );
}

function TimelineRow({
  row,
  horizon,
  selected,
  onSelect,
  onSeek,
  onSelectRecord,
}: {
  row: EffectLifetime;
  horizon: number;
  selected: boolean;
  onSelect: () => void;
  onSeek: (time: number) => void;
  onSelectRecord: (seq: number) => void;
}) {
  const start = pctOf(row.start, horizon);
  const end = pctOf(clampEnd(row.end, horizon), horizon);
  const width = Math.max(end - start, 0.6);
  const tint = COLORS[row.kind as keyof typeof COLORS];
  const isDispelled = row.endReason === 'dispelled';
  const isDepleted = row.endReason === 'depleted';

  return (
    <div className={`timeline-row ${selected ? 'selected' : ''}`}>
      <button className="row-label" onClick={onSelect} title={`${row.label}（${formatMs(row.start)} → ${formatMs(clampEnd(row.end, horizon))}）`}>
        <span className="row-kind" style={{ background: tint }} />
        <span className="row-text">{row.label}</span>
      </button>
      <div className="row-track" onClick={onSelect}>
        <div
          className={`effect-bar ${isDispelled ? 'dispelled' : ''} ${isDepleted ? 'depleted' : ''}`}
          style={{
            left: `${start}%`,
            width: `${width}%`,
            background: `color-mix(in oklab, ${tint} 26%, var(--surface-1))`,
            borderColor: tint,
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSeek(row.start);
            onSelect();
          }}
          title={`${row.label} · ${formatMs(row.start)} → ${formatMs(clampEnd(row.end, horizon))}`}
        >
          {width >= 10 && (
            <span className="effect-bar-label" style={{ color: tint }}>
              {formatMs(row.start)}
            </span>
          )}
        </div>
        {row.kind !== 'attackBuff' && (
          <span className="endpoint" style={{ left: `${end}%`, borderColor: tint }}>
            {row.endReason === 'horizon' ? '…' : row.endReason === 'expired' ? '⏱' : row.endReason === 'depleted' || row.endReason === 'dispelled' ? '✕' : '◆'}
          </span>
        )}
        {row.markers.map((marker, index) => (
          <button
            key={`${marker.recordSeq}-${index}`}
            className={`marker marker-${marker.kind}`}
            style={{ left: `${pctOf(marker.time, horizon)}%` }}
            title={`${formatMs(marker.time)} · ${marker.label}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectRecord(marker.recordSeq);
              onSelect();
            }}
            aria-label={marker.label}
          >
            {marker.kind === 'skipped' ? '✕' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 供概览使用的紧凑行（示例库页）。 */
export { COLORS as TIMELINE_COLORS, KIND_NAME as TIMELINE_KIND_NAME };
