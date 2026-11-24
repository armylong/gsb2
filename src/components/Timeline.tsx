import { useMemo, useRef, useState } from 'react';
import { useElementWidth } from '../hooks/useElementWidth';
import { clock, reasonLabel } from '../lib/format';
import type { AuditRecord, CaptionState, CaptionEvent } from '../lib/types';

interface TimelineProps {
  events: readonly CaptionEvent[];
  audit: readonly AuditRecord[];
  captions: readonly CaptionState[];
  time: number;
  presentationTime: number;
  delay: number;
  end: number;
  onSeek: (value: number) => void;
}

const ROW_HEIGHT = 26;
const LANE_HEIGHT = 18;
const PANEL = { left: 78, right: 18, top: 38, bottom: 26 };
const MAX_LANES = 6;

const verdictTone: Record<string, string> = {
  accepted: 'is-accepted',
  rejected: 'is-rejected',
  pending: 'is-pending',
};

export function Timeline({
  events,
  audit,
  captions,
  time,
  presentationTime,
  delay,
  end,
  onSeek,
}: TimelineProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{
    label: string;
    detail: string;
    left: number;
  } | null>(null);

  const lanes = useMemo(() => (captions.length > 0 ? captions.slice(0, MAX_LANES) : []), [captions]);
  const extraLanes = Math.max(0, captions.length - MAX_LANES);

  const plotWidth = Math.max(0, width - PANEL.left - PANEL.right);
  const x = (value: number) =>
    PANEL.left + (end <= 0 ? 0 : Math.min(1, Math.max(0, value / end)) * plotWidth);

  const height = PANEL.top + PANEL.bottom + Math.max(1, lanes.length) * ROW_HEIGHT;
  const ticks = useMemo(() => {
    if (end <= 0) return [];
    const raw = end / Math.max(2, Math.floor(plotWidth / 78));
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((candidate) => candidate >= raw) ?? 60;
    const values: number[] = [];
    for (let value = 0; value <= end + 1e-9; value += step) values.push(Math.round(value * 100) / 100);
    return values;
  }, [end, plotWidth]);

  // 只画已接收过的投递所带的媒体区间：时间轴也不预支未来的事件。
  const receivedIds = useMemo(
    () => new Set(audit.filter((record) => record.received).map((record) => record.event.id)),
    [audit],
  );
  const sceneSegments = useMemo(
    () =>
      lanes.map((caption) => {
        const segments: { key: string; start: number; end: number; tone: string; label: string }[] = [];
        for (const event of events.filter(
          (item) => item.captionId === caption.captionId && receivedIds.has(item.id),
        )) {
          segments.push({
            key: `${event.id}-${event.seq}`,
            start: event.mediaStart,
            end: event.mediaEnd,
            tone: 'is-track',
            label: `${event.captionId} seq${event.seq}`,
          });
        }
        // 以 captionId 合并同一时间区间，避免重叠修订把轨道涂满。
        const merged: typeof segments = [];
        for (const segment of segments.sort((a, b) => a.start - b.start || a.end - b.end)) {
          const last = merged[merged.length - 1];
          if (last && Math.abs(last.start - segment.start) < 1e-9 && Math.abs(last.end - segment.end) < 1e-9) {
            continue;
          }
          merged.push(segment);
        }
        return { caption, segments: merged };
      }),
    [lanes, events, receivedIds],
  );

  const playhead = x(time);
  const presentationPlayhead = x(presentationTime);
  const showPresentationPlayhead = delay > 0 && Math.abs(time - presentationTime) > 1e-9;

  const dragging = useRef(false);

  const seekFromClientX = (clientX: number, rect: DOMRect) => {
    const ratio = (clientX - rect.left - PANEL.left) / Math.max(1, plotWidth);
    onSeek(Math.min(1, Math.max(0, ratio)) * end);
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX, event.currentTarget.getBoundingClientRect());
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    seekFromClientX(event.clientX, event.currentTarget.getBoundingClientRect());
  };

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section className="timeline" aria-label="时间轴">
      <header className="timeline__head">
        <div>
          <h2 className="section-title">时间轴</h2>
          <p className="timeline__hint">
            横轴是媒体时间，可点击或拖动定位。方块是已接收投递的媒体区间，圆点是到达时刻，菱形是未采用的投递。
          </p>
        </div>
        <div className="timeline__legend" aria-hidden="true">
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--track" /> 媒体区间
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--accepted" /> 已生效
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--rejected" /> 未采用
          </span>
          <span className="legend-item">
            <span className="legend-swatch legend-swatch--pending" /> 未到达
          </span>
          <span className="legend-item">
            <span className="legend-line legend-line--playhead" /> 接收时钟
          </span>
          {showPresentationPlayhead && (
            <span className="legend-item">
              <span className="legend-line legend-line--presentation" /> 画面时钟
            </span>
          )}
        </div>
      </header>

      <div className="timeline__canvas" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`时间轴，当前 ${clock(time)}，共 ${clock(end)}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onMouseLeave={() => setHover(null)}
          >
            {/* 网格与刻度 */}
            <g>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={x(tick)}
                    x2={x(tick)}
                    y1={PANEL.top}
                    y2={height - PANEL.bottom}
                    className="timeline__grid"
                  />
                  <text x={x(tick)} y={height - 8} className="timeline__tick" textAnchor="middle">
                    {clock(tick, tick % 1 === 0 ? 0 : 1)}
                  </text>
                </g>
              ))}
            </g>

            {/* 每句一条轨道 */}
            {sceneSegments.map(({ caption, segments }, laneIndex) => {
              const y = PANEL.top + laneIndex * ROW_HEIGHT + 4;
              return (
                <g key={caption.captionId}>
                  <text
                    x={PANEL.left - 10}
                    y={y + LANE_HEIGHT / 2 + 4}
                    className="timeline__lane-label"
                    textAnchor="end"
                  >
                    {caption.captionId}
                  </text>
                  {segments.map((segment) => {
                    const startX = x(segment.start);
                    const endX = Math.max(startX + 2, x(segment.end));
                    const active =
                      presentationTime >= segment.start - 1e-9 &&
                      presentationTime < segment.end - 1e-9;
                    return (
                      <g key={segment.key}>
                        <rect
                          x={startX}
                          y={y}
                          width={endX - startX}
                          height={LANE_HEIGHT}
                          rx={4}
                          className={`timeline__track ${active ? 'is-active' : ''}`}
                        />
                        {active && (
                          <rect
                            x={startX + 1}
                            y={y + LANE_HEIGHT - 3}
                            width={Math.max(0, Math.min(endX, presentationPlayhead) - startX - 1)}
                            height={2}
                            rx={1}
                            className="timeline__track-progress"
                          />
                        )}
                      </g>
                    );
                  })}
                  {audit
                    .filter((record) => record.event.captionId === caption.captionId)
                    .map((record) => (
                      <g key={`${record.event.id}-${record.index}-d`}>
                        {record.verdict === 'rejected' ? (
                          <rect
                            x={x(record.event.arrival) - 4}
                            y={y + LANE_HEIGHT / 2 - 4}
                            width={8}
                            height={8}
                            transform={`rotate(45 ${x(record.event.arrival)} ${y + LANE_HEIGHT / 2})`}
                            className="timeline__dot is-rejected"
                          />
                        ) : (
                          <circle
                            cx={x(record.event.arrival)}
                            cy={y + LANE_HEIGHT / 2}
                            r={4.5}
                            className={`timeline__dot ${verdictTone[record.verdict]}`}
                          />
                        )}
                        <circle
                          cx={x(record.event.arrival)}
                          cy={y + LANE_HEIGHT / 2}
                          r={10}
                          className="timeline__hit"
                          onMouseLeave={() => setHover(null)}
                          onMouseEnter={() =>
                            setHover({
                              left: Math.min(
                                Math.max(x(record.event.arrival), 100),
                                Math.max(100, width - 100),
                              ),
                              label: `${record.event.captionId} · seq${record.event.seq} · 到达 ${clock(record.event.arrival, 2)}`,
                              detail: record.received
                                ? `${
                                    record.verdict === 'accepted'
                                      ? '已生效'
                                      : record.verdict === 'rejected'
                                        ? '未采用'
                                        : '未到达'
                                  }${record.reason ? ` · ${reasonLabel[record.reason]}` : ''}`
                                : '未到达',
                            })
                          }
                        />
                      </g>
                    ))}
                </g>
              );
            })}

            {/* 播放头 */}
            {showPresentationPlayhead && (
              <line
                x1={presentationPlayhead}
                x2={presentationPlayhead}
                y1={PANEL.top}
                y2={height - PANEL.bottom}
                className="timeline__presentation"
              />
            )}
            <line
              x1={playhead}
              x2={playhead}
              y1={PANEL.top - 5}
              y2={height - PANEL.bottom}
              className="timeline__playhead"
            />
            <circle cx={playhead} cy={PANEL.top - 5} r={4} className="timeline__playhead-dot" />
          </svg>
        )}

        {hover && (
          <div className="timeline__tooltip" style={{ left: hover.left, top: 5 }} role="status">
            <strong>{hover.label}</strong>
            <span className="timeline__tooltip-detail">{hover.detail}</span>
          </div>
        )}
      </div>

      {extraLanes > 0 && (
        <p className="timeline__more">另有 {extraLanes} 条字幕未绘制，台账中仍可核对。</p>
      )}
    </section>
  );
}
