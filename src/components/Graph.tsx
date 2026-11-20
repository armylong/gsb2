import type { AnimState, EventKind, MachineConfig, TransitionStatus } from '../engine/types';
import {
  BLOCK_REASON_LABEL,
  EVENT_KIND_LABEL,
  POSE_KIND_LABEL,
} from '../engine/types';

const KIND_COLOR: Record<EventKind, string> = {
  footstep: '#86efac',
  'window-open': '#f87171',
  'window-close': '#fb923c',
  marker: '#94a3b8',
};

interface TimelineProps {
  state: AnimState;
  elapsedMs: number;
  loopIndex: number;
  highlightEventIds?: string[];
  passedEventIds?: string[];
}

export function StateTimeline({
  state,
  elapsedMs,
  loopIndex,
  highlightEventIds = [],
  passedEventIds = [],
}: TimelineProps) {
  const pct = (value: number) =>
    state.durationMs > 0 ? `${Math.min(100, Math.max(0, (value / state.durationMs) * 100))}%` : '0%';
  return (
    <div className="timeline" role="img" aria-label={`${state.name} 时间轴`}>
      <div className="timeline-track">
        <div className="timeline-fill" style={{ width: pct(elapsedMs) }} />
        {state.events.map((event) => (
          <div
            key={event.id}
            className={`timeline-event kind-${event.kind} ${
              highlightEventIds.includes(event.id) ? 'flash' : ''
            } ${passedEventIds.includes(event.id) ? 'passed' : ''}`}
            style={{ left: pct(event.timeMs) }}
            title={`${EVENT_KIND_LABEL[event.kind]} ${event.name} @ ${event.timeMs}ms`}
          >
            <span className="timeline-dot" />
          </div>
        ))}
        <div className="timeline-head" style={{ left: pct(elapsedMs) }} />
      </div>
      <div className="timeline-ticks">
        <span>0</span>
        <span>{(state.durationMs / 2).toFixed(0)}</span>
        <span>{state.durationMs}ms</span>
      </div>
      <div className="timeline-caption">
        {state.loop
          ? `循环 · 第 ${loopIndex + 1} 圈 · 局部 ${Math.round(elapsedMs)}ms`
          : `单次 · ${Math.round(elapsedMs)} / ${state.durationMs}ms`}
      </div>
    </div>
  );
}

interface GraphProps {
  config: MachineConfig;
  currentStateId: string;
  /** 当前状态已运行时间与该状态时长(毫秒) */
  currentElapsedMs: number;
  currentDurationMs: number;
  statuses: TransitionStatus[];
  selectedStateId: string;
  selectedTransitionId: string | null;
  onSelectState: (id: string) => void;
  onSelectTransition: (id: string) => void;
  mode: 'runtime' | 'preview';
}

const NODE_RADIUS = 34;

/**
 * 关系图: 布局用确定性算法(按状态在数组中的顺序排成环)。
 * 当前状态高亮; 可用过渡(满足条件)以实线加粗, 不可用为虚线灰色。
 */
export function RelationGraph({
  config,
  currentStateId,
  currentElapsedMs,
  currentDurationMs,
  statuses,
  selectedStateId,
  selectedTransitionId,
  onSelectState,
  onSelectTransition,
  mode,
}: GraphProps) {
  const width = 560;
  const height = 460;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - NODE_RADIUS - 74;

  const positions = new Map<string, { x: number; y: number }>();
  config.states.forEach((state, index) => {
    const angle = (-Math.PI / 2) + (index / config.states.length) * Math.PI * 2;
    positions.set(state.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  });

  const available = new Set(
    statuses.filter((s) => s.eligible).map((s) => s.transition.id),
  );
  const winning = statuses.find((s) => s.selectionRank === 0)?.transition.id ?? null;

  const edges = config.transitions
    .map((transition, index) => {
      const from = positions.get(transition.from);
      const to = positions.get(transition.to);
      if (!from || !to) return null;
      const selected = transition.id === selectedTransitionId;
      const isAvailable = available.has(transition.id);
      const isWinner = winning === transition.id;
      const arc = arcPath(from, to, transition.from === transition.to, index, {
        x: cx,
        y: cy,
      });
      const label = placeLabel(
        arc.mid,
        arc.normal,
        positions,
        config.states,
        transition.from,
        transition.to,
        width,
        height,
      );
      return {
        transition,
        path: arc.path,
        label,
        isAvailable,
        isWinner,
        selected,
        labelled: isAvailable || selected,
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => edge !== null);

  return (
    <svg
      className="graph"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="状态关系图"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
        </marker>
        <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#38bdf8" />
        </marker>
      </defs>

      {edges.map((edge) =>
        edge ? (
          <g
            key={edge.transition.id}
            className={`edge ${edge.isAvailable ? 'available' : 'blocked'} ${
              edge.isWinner ? 'winner' : ''
            } ${edge.selected ? 'selected' : ''}`}
            onClick={() => onSelectTransition(edge.transition.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelectTransition(edge.transition.id);
            }}
          >
            <title>{`${edge.transition.id} · P${edge.transition.priority} · ${describeConditions(edge.transition)}${
              edge.isAvailable ? ' · 可用' : ''
            }${edge.isWinner ? ' · 首选' : ''}`}</title>
            <path
              d={edge.path}
              fill="none"
              strokeWidth={edge.selected ? 3 : edge.isAvailable ? 2.4 : 1.3}
              strokeDasharray={edge.isAvailable ? undefined : '5 4'}
              markerEnd={edge.isAvailable ? 'url(#arrow-hot)' : 'url(#arrow)'}
            />
            {edge.isAvailable || edge.selected ? (
              <circle
                cx={edge.label.x}
                cy={edge.label.y}
                r={3.2}
                className="edge-anchor"
              />
            ) : null}
          </g>
        ) : null,
      )}

      {config.states.map((state) => {
        const pos = positions.get(state.id);
        if (!pos) return null;
        const isCurrent = state.id === currentStateId;
        const isSelected = state.id === selectedStateId;
        return (
          <g
            key={state.id}
            className={`node ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}`}
            transform={`translate(${pos.x}, ${pos.y})`}
            onClick={() => onSelectState(state.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelectState(state.id);
            }}
          >
            <circle className="node-base" r={NODE_RADIUS} />
            <text className="node-name" y={-2}>
              {state.name}
            </text>
            <text className="node-meta" y={13}>
              {isCurrent
                ? `${Math.round(currentElapsedMs)} / ${state.durationMs}ms`
                : `${state.durationMs}ms${state.loop ? ' · 循环' : ''}`}
            </text>
            {isCurrent ? (
              <>
                <text className="node-here" y={-NODE_RADIUS - 10}>
                  {mode === 'preview' ? '预览' : '当前'}
                </text>
                <circle
                  className="node-progress-bg"
                  r={NODE_RADIUS + 6}
                  fill="none"
                  strokeWidth={3}
                />
                <circle
                  className="node-progress"
                  r={NODE_RADIUS + 6}
                  fill="none"
                  strokeWidth={3}
                  strokeDasharray={`${Math.max(0.001, currentDurationMs > 0 ? Math.min(1, currentElapsedMs / currentDurationMs) : 1) * 2 * Math.PI * (NODE_RADIUS + 6)} ${2 * Math.PI * (NODE_RADIUS + 6)}`}
                  transform="rotate(-90)"
                  strokeLinecap="round"
                />
              </>
            ) : null}
          </g>
        );
      })}

      {edges
        .filter((edge) => edge.labelled)
        .map((edge) => {
          const lines = edge.isWinner || edge.selected;
          const w = lines ? 96 : 74;
          const h = lines ? 30 : 18;
          return (
            <g
              key={`label-${edge.transition.id}`}
              className={`edge-label-group ${edge.isWinner ? 'winner' : ''} ${
                edge.selected ? 'selected' : ''
              }`}
              onClick={() => onSelectTransition(edge.transition.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelectTransition(edge.transition.id);
              }}
            >
              <title>{`${edge.transition.id} · P${edge.transition.priority} · ${describeConditions(
                edge.transition,
              )}${edge.isWinner ? ' · 首选' : ''}`}</title>
              <rect
                x={edge.label.x - w / 2}
                y={edge.label.y - h / 2}
                width={w}
                height={h}
                rx={6}
              />
              <text x={edge.label.x} y={edge.label.y - (lines ? 4 : 0) + 3} className="edge-label">
                {shortId(edge.transition.id)}
              </text>
              {lines ? (
                <text x={edge.label.x} y={edge.label.y + 9} className="edge-label small">
                  P{edge.transition.priority} · {describeConditions(edge.transition)}
                </text>
              ) : null}
            </g>
          );
        })}
    </svg>
  );
}

interface LabelPlacement {
  x: number;
  y: number;
}

function arcPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  self: boolean,
  index: number,
  center: { x: number; y: number },
): { path: string; mid: LabelPlacement; normal: LabelPlacement } {
  if (self) {
    const r = 24 + (index % 3) * 5;
    return {
      path: `M ${a.x - 9} ${a.y - NODE_RADIUS} C ${a.x - r - 34} ${a.y - NODE_RADIUS - 56}, ${
        a.x + r + 34
      } ${a.y - NODE_RADIUS - 56}, ${a.x + 9} ${a.y - NODE_RADIUS}`,
      mid: { x: a.x, y: a.y - NODE_RADIUS - 52 },
      normal: { x: 0, y: -1 },
    };
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const startX = a.x + ux * (NODE_RADIUS + 2);
  const startY = a.y + uy * (NODE_RADIUS + 2);
  const endX = b.x - ux * (NODE_RADIUS + 10);
  const endY = b.y - uy * (NODE_RADIUS + 10);
  const mx = (startX + endX) / 2;
  const my = (startY + endY) / 2;
  // 控制点向圆环外侧偏移, 弧线绕开图心
  const outwardX = mx - center.x;
  const outwardY = my - center.y;
  const outwardLen = Math.hypot(outwardX, outwardY) || 1;
  const bow = 26 + (index % 4) * 8;
  const controlX = mx + (outwardX / outwardLen) * bow;
  const controlY = my + (outwardY / outwardLen) * bow;
  // 二次贝塞尔 t=0.5 处
  const midX = (startX + 2 * controlX + endX) / 4;
  const midY = (startY + 2 * controlY + endY) / 4;
  return {
    path: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`,
    mid: { x: midX, y: midY },
    normal: { x: (outwardX / outwardLen), y: (outwardY / outwardLen) },
  };
}

/** 把标签推到弧线外侧, 并避开节点圆, 保证不遮挡状态名。 */
/**
 * 标签贴着弧线中点向外偏移少量距离, 避免压住状态节点与状态名。
 * 若与外圈的节点圆冲突, 则继续沿同一方向外推。
 */
function placeLabel(
  mid: LabelPlacement,
  normal: LabelPlacement,
  positions: Map<string, LabelPlacement>,
  states: Array<{ id: string }>,
  fromId: string,
  toId: string,
  width: number,
  height: number,
): LabelPlacement {
  const nodes = states
    .map((s) => ({ id: s.id, pos: positions.get(s.id) }))
    .filter((n): n is { id: string; pos: LabelPlacement } => Boolean(n.pos))
    .filter((n) => n.id !== fromId && n.id !== toId);

  let push = 26;
  let x = mid.x + normal.x * push;
  let y = mid.y + normal.y * push;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const collides = nodes.some(
      (n) => Math.hypot(n.pos.x - x, n.pos.y - y) < NODE_RADIUS + 24,
    );
    if (!collides) break;
    push += 16;
    x = mid.x + normal.x * push;
    y = mid.y + normal.y * push;
  }
  return {
    x: Math.min(width - 54, Math.max(54, x)),
    y: Math.min(height - 24, Math.max(24, y)),
  };
}

function shortId(id: string): string {
  if (id.length <= 20) return id;
  const parts = id.split('-');
  return parts.slice(0, 3).join('-');
}

function describeConditions(transition: MachineConfig['transitions'][number]): string {
  const parts: string[] = [];
  if (transition.conditions.attackTrigger) parts.push('攻击');
  if (transition.conditions.hurt !== null) {
    parts.push(transition.conditions.hurt ? '受击' : '非受击');
  }
  if (transition.conditions.speed) {
    const { op, value } = transition.conditions.speed;
    parts.push(`速度${op === 'gte' ? '≥' : '≤'}${value}`);
  }
  if (transition.waitForProgress) parts.push(`等${Math.round(transition.progress * 100)}%`);
  return parts.length ? parts.join(' ') : '无条件';
}

export function EventKindLegend() {
  return (
    <div className="legend">
      {(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((kind) => (
        <span key={kind} className="legend-item">
          <i style={{ background: KIND_COLOR[kind] }} />
          {EVENT_KIND_LABEL[kind]}
        </span>
      ))}
    </div>
  );
}

export function PoseKindSelect({
  value,
  onChange,
}: {
  value: AnimState['visual'];
  onChange: (value: AnimState['visual']) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AnimState['visual'])}
    >
      {(Object.keys(POSE_KIND_LABEL) as Array<keyof typeof POSE_KIND_LABEL>).map((kind) => (
        <option key={kind} value={kind}>
          {POSE_KIND_LABEL[kind]}
        </option>
      ))}
    </select>
  );
}

export function EventKindSelect({
  value,
  onChange,
}: {
  value: EventKind;
  onChange: (value: EventKind) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as EventKind)}>
      {(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((kind) => (
        <option key={kind} value={kind}>
          {EVENT_KIND_LABEL[kind]}
        </option>
      ))}
    </select>
  );
}

export function BlockReasonTags({ status }: { status: TransitionStatus }) {
  if (status.eligible) {
    return <span className="tag ok">可用{status.selectionRank === 0 ? ' · 首选' : ''}</span>;
  }
  return (
    <>
      {status.reasons.map((reason) => (
        <span key={reason} className="tag bad">
          {BLOCK_REASON_LABEL[reason]}
        </span>
      ))}
    </>
  );
}
