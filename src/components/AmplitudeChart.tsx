/**
 * AmplitudeChart —— 序列实际生成声音的振幅曲线。
 *
 * 数据直接来自 OfflineRenderer 的逐采样 amplitude 数组，
 * 与试听 PCM、导出 WAV 是同一次渲染的产物，所以曲线即所听。
 * 支持：事件标记、播放头、十字线 hover 取值、点击移动播放头。
 */
import { useMemo, useRef, useState, useCallback } from 'react';
import type { RenderResult } from '../audio/OfflineRenderer';
import type { SequenceEvent } from '../audio/sequence';

const W = 760;
const H = 300;
const PAD_L = 44;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 34;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
/** 曲线最多取的折线点数，远超屏幕像素但控制 SVG 节点规模 */
const MAX_POINTS = 1600;

interface Props {
  render: RenderResult;
  playhead: number; // 秒
  onSeek?: (time: number) => void;
  liveAmp?: number | null; // 手动按键时的实时振幅（0..1）
}

const EVENT_COLOR: Record<SequenceEvent['type'], string> = {
  noteOn: 'var(--orange)',
  noteOff: 'var(--muted)',
  paramChange: 'var(--magenta)',
};

export function AmplitudeChart({ render, playhead, onSeek, liveAmp }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; t: number; amp: number } | null>(
    null,
  );

  const { linePath, areaPath, xOf, xToTime } = useMemo(() => {
    const n = render.amplitude.length;
    const step = Math.max(1, Math.floor(n / MAX_POINTS));
    const xOf = (sample: number) => PAD_L + (sample / (n - 1)) * PLOT_W;
    const yOf = (amp: number) => PAD_T + (1 - Math.min(1, Math.max(0, amp))) * PLOT_H;
    let line = '';
    for (let i = 0; i < n; i += step) {
      const cmd = i === 0 ? 'M' : 'L';
      line += `${cmd} ${xOf(i).toFixed(2)} ${yOf(render.amplitude[i]).toFixed(2)} `;
    }
    // 确保最后一个点（应为 0）落进路径
    line += `L ${xOf(n - 1).toFixed(2)} ${yOf(render.amplitude[n - 1]).toFixed(2)}`;
    const area = `${line} L ${xOf(n - 1)} ${PAD_T + PLOT_H} L ${xOf(0)} ${PAD_T + PLOT_H} Z`;
    const xToTime = (x: number) => ((x - PAD_L) / PLOT_W) * render.duration;
    return { linePath: line, areaPath: area, xOf, xToTime };
  }, [render]);

  const handlePointer = useCallback(
    (e: React.PointerEvent) => {
      const rect = svgRef.current!.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const y = ((e.clientY - rect.top) / rect.height) * H;
      if (x < PAD_L || x > PAD_L + PLOT_W) {
        setHover(null);
        return;
      }
      const t = xToTime(x);
      const idx = Math.min(render.amplitude.length - 1, Math.round(t * render.sampleRate));
      setHover({ x, y, t, amp: render.amplitude[idx] });
    },
    [render, xToTime],
  );

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const timeTicks = useMemo(() => {
    const count = 6;
    return Array.from({ length: count + 1 }, (_, i) => (render.duration * i) / count);
  }, [render.duration]);

  const playheadX = PAD_L + (Math.min(playhead, render.duration) / render.duration) * PLOT_W;

  return (
    <div>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="序列振幅曲线"
        onPointerMove={handlePointer}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          if (!onSeek) return;
          const rect = svgRef.current!.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          if (x >= PAD_L && x <= PAD_L + PLOT_W) onSeek(xToTime(x));
        }}
        style={{ cursor: onSeek ? 'pointer' : 'default' }}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              className="grid-line"
              x1={PAD_L}
              x2={PAD_L + PLOT_W}
              y1={PAD_T + (1 - t) * PLOT_H}
              y2={PAD_T + (1 - t) * PLOT_H}
            />
            <text x={PAD_L - 6} y={PAD_T + (1 - t) * PLOT_H + 4} textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {timeTicks.map((t) => (
          <g key={t}>
            <line
              className="grid-line"
              x1={xOf(Math.round(t * render.sampleRate))}
              x2={xOf(Math.round(t * render.sampleRate))}
              y1={PAD_T}
              y2={PAD_T + PLOT_H}
            />
            <text x={xOf(Math.round(t * render.sampleRate))} y={H - 12} textAnchor="middle">
              {t.toFixed(2)}s
            </text>
          </g>
        ))}
        <line
          className="axis-line"
          x1={PAD_L}
          x2={PAD_L + PLOT_W}
          y1={PAD_T + PLOT_H}
          y2={PAD_T + PLOT_H}
        />

        <path className="env-area" d={areaPath} />
        <path className="env-line" d={linePath} />

        {/* 事件标记 */}
        {render.eventSamples.map(({ event, sample }) => {
          const x = xOf(sample);
          const isOn = event.type === 'noteOn';
          return (
            <g key={event.id}>
              {isOn ? (
                <polygon
                  points={`${x},${PAD_T + PLOT_H - 2} ${x - 5},${PAD_T + PLOT_H - 12} ${x + 5},${PAD_T + PLOT_H - 12}`}
                  fill={EVENT_COLOR[event.type]}
                />
              ) : (
                <line
                  x1={x}
                  x2={x}
                  y1={PAD_T + PLOT_H - 12}
                  y2={PAD_T + PLOT_H - 2}
                  stroke={EVENT_COLOR[event.type]}
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}

        {/* 播放头 */}
        <line className="playhead" x1={playheadX} x2={playheadX} y1={PAD_T} y2={PAD_T + PLOT_H} />

        {/* 实时手动按键振幅指示点（黄点，与事件标记形状/颜色双重区分） */}
        {liveAmp != null && (
          <circle
            cx={PAD_L + PLOT_W - 10}
            cy={PAD_T + (1 - Math.min(1, liveAmp)) * PLOT_H}
            r={5}
            fill="var(--yellow)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
        )}

        {hover && (
          <g>
            <line
              className="crosshair"
              x1={hover.x}
              x2={hover.x}
              y1={PAD_T}
              y2={PAD_T + PLOT_H}
            />
          </g>
        )}
      </svg>
      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${(hover.x / W) * (svgRef.current?.clientWidth ?? W) + 12}px`,
            top: 12,
          }}
        >
          t={hover.t.toFixed(3)}s · 振幅 {hover.amp.toFixed(3)}
        </div>
      )}
    </div>
  );
}
