/**
 * EnvelopeEditor —— ADSR 模板包络的可拖拽编辑。
 *
 * 横坐标按段角色分区（起音/衰减/保持/释放），不是线性时间轴：
 * 拖动 A/D 拐点改段时长，S 拐点改保持电平，R 拐点改释放时长；
 * 按住 Shift 拖拐点调该段曲线形状。所有数值同时有右侧数字输入兜底。
 */
import { useRef, useState, useCallback } from 'react';
import type { EnvelopeParams } from '../audio/types';
import { shapedProgress } from '../audio/VoiceEngine';

const W = 520;
const H = 260;
const PAD_L = 38;
const PAD_R = 16;
const PAD_T = 18;
const PAD_B = 30;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/** 模板横轴：各段占的相对宽度，sustain 给最小可视宽度。 */
const X_FRAC = { attack: 0.3, decay: 0.3, sustain: 0.16, release: 0.24 } as const;
const X0 = PAD_L;
const X_A = X0 + PLOT_W * X_FRAC.attack;
const X_D = X_A + PLOT_W * X_FRAC.decay;
const X_S = X_D + PLOT_W * X_FRAC.sustain;
const X_R = X_S + PLOT_W * X_FRAC.release;
/** 时长→像素的缩放只用于 A/D/R 三段各自的局部映射，限制最大可编辑时长 */
const MAX_SEG_SECONDS = 2;

const yToLevel = (y: number) => 1 - (y - PAD_T) / PLOT_H;
const levelToY = (v: number) => PAD_T + (1 - v) * PLOT_H;
const secToPx = (s: number) => Math.min(1, s / MAX_SEG_SECONDS) * PLOT_W;
const pxToSec = (px: number) => (Math.max(0, px) / PLOT_W) * MAX_SEG_SECONDS;

type HandleId = 'A' | 'D' | 'S' | 'R';

interface Props {
  envelope: EnvelopeParams;
  onChange: (next: EnvelopeParams) => void;
}

export function EnvelopeEditor({ envelope, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<HandleId | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H,
    };
  }, []);

  const clampLevel = (v: number) => Math.min(1, Math.max(0, v));

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const p = toSvgPoint(e.clientX, e.clientY);
      const level = clampLevel(yToLevel(p.y));
      const next = { ...envelope };
      if (e.shiftKey) {
        // Shift 拖动：纵向调形状 -1..1（上凸下凹）
        const shape = Math.min(1, Math.max(-1, (0.5 - (p.y - PAD_T) / PLOT_H) * 2));
        if (drag === 'A') next.attackShape = shape;
        if (drag === 'D') next.decayShape = shape;
        if (drag === 'R') next.releaseShape = shape;
      } else if (drag === 'A') {
        next.attack = pxToSec(p.x - X0);
      } else if (drag === 'D') {
        next.decay = pxToSec(p.x - X_A);
      } else if (drag === 'S') {
        next.sustain = level;
      } else if (drag === 'R') {
        next.release = pxToSec(X_R - p.x);
      }
      onChange(next);
    },
    [drag, envelope, onChange, toSvgPoint],
  );

  const stop = useCallback(() => {
    setDrag(null);
    setTooltip(null);
  }, []);

  // 拐点坐标
  const y0 = levelToY(0);
  const yPeak = levelToY(1);
  const ySus = levelToY(envelope.sustain);
  const aEndX = X0 + secToPx(envelope.attack);
  const dEndX = X_A + secToPx(envelope.decay);
  const rEndX = X_R - secToPx(envelope.release);

  /** 生成一段带形状的曲线路径（采样 24 段折线，视觉足够平滑）。 */
  function curve(x1: number, y1: number, x2: number, y2: number, shape: number): string {
    const N = 24;
    let d = `M ${x1} ${y1}`;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const p = shapedProgress(t, shape);
      d += ` L ${x1 + (x2 - x1) * t} ${y1 + (y2 - y1) * p}`;
    }
    return d;
  }

  const attackPath = curve(X0, y0, aEndX, yPeak, envelope.attackShape);
  const decayPath = curve(aEndX, yPeak, dEndX, ySus, envelope.decayShape);
  const sustainPath = `M ${dEndX} ${ySus} L ${X_S} ${ySus}`;
  const releasePath = curve(X_S, ySus, rEndX, y0, envelope.releaseShape);
  const areaPath =
    `${attackPath} L ${dEndX} ${ySus} L ${X_S} ${ySus} L ${rEndX} ${y0} ` +
    `L ${X0} ${y0} Z`;

  const handles: { id: HandleId; x: number; y: number; label: string; tip: string }[] = [
    { id: 'A', x: aEndX, y: yPeak, label: 'A', tip: `起音 ${envelope.attack.toFixed(3)}s` },
    { id: 'D', x: dEndX, y: ySus, label: 'D', tip: `衰减 ${envelope.decay.toFixed(3)}s` },
    { id: 'S', x: X_S, y: ySus, label: 'S', tip: `保持 ${envelope.sustain.toFixed(2)}` },
    { id: 'R', x: rEndX, y: y0, label: 'R', tip: `释放 ${envelope.release.toFixed(3)}s` },
  ];

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <svg
        ref={svgRef}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="ADSR 包络编辑器"
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerLeave={stop}
      >
        {/* 网格与 Y 轴刻度 */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              className="grid-line"
              x1={X0}
              x2={X_R}
              y1={levelToY(t)}
              y2={levelToY(t)}
            />
            <text x={X0 - 6} y={levelToY(t) + 4} textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={X0} x2={X_R} y1={y0} y2={y0} />

        {/* 分区竖线与段名 */}
        {[X_A, X_D, X_S, X_R].map((x) => (
          <line key={x} className="grid-line" x1={x} x2={x} y1={PAD_T} y2={y0} />
        ))}
        <text x={(X0 + X_A) / 2} y={H - 10} textAnchor="middle">
          起音 A
        </text>
        <text x={(X_A + X_D) / 2} y={H - 10} textAnchor="middle">
          衰减 D
        </text>
        <text x={(X_D + X_S) / 2} y={H - 10} textAnchor="middle">
          保持 S
        </text>
        <text x={(X_S + X_R) / 2} y={H - 10} textAnchor="middle">
          释放 R
        </text>

        <path className="env-area" d={areaPath} />
        <path className="env-line" d={attackPath} />
        <path className="env-line" d={decayPath} />
        <path className="env-line" d={sustainPath} />
        <path className="env-line" d={releasePath} />

        {handles.map((h) => (
          <g key={h.id}>
            <circle
              className={`handle ${drag === h.id ? 'dragging' : ''}`}
              cx={h.x}
              cy={h.y}
              r={7}
              onPointerDown={(e) => {
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* 无活动指针（如合成事件）时忽略，拖拽逻辑仍可用 */
                }
                setDrag(h.id);
              }}
              onPointerEnter={(e) =>
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  text: `${h.tip} · Shift 拖改曲线形状`,
                })
              }
              onPointerMove={(e) =>
                drag === h.id && setTooltip({ x: e.clientX, y: e.clientY, text: h.tip })
              }
              onPointerLeave={() => !drag && setTooltip(null)}
            />
            <text x={h.x} y={h.y - 12} textAnchor="middle" style={{ fontWeight: 700 }}>
              {h.label}
            </text>
          </g>
        ))}
      </svg>
      {tooltip && (
        <div className="tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
          {tooltip.text}
        </div>
      )}
      <p className="hint" style={{ margin: '6px 0 0' }}>
        横向拖 A/D/R 调段时长，纵向拖 S 调保持电平；按住 <span className="kbd">Shift</span> 拖
        A/D/R 调曲线凹凸。零时长段会画出垂直边并在声音里如实呈现。
      </p>
    </div>
  );
}
