import { CHOICE_EDGE_ID } from '../engine/layout';
import type { DialogueConfig, DialogueNode } from '../engine/types';
import type { ValidationReport } from '../engine/types';

interface DialogueGraphProps {
  config: DialogueConfig;
  currentNodeId: string;
  validation: ValidationReport;
  visitedNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
}

const COL_WIDTH = 196;
const ROW_HEIGHT = 96;
const PAD_X = 22;
const PAD_Y = 22;
const NODE_WIDTH = 158;
const NODE_HEIGHT = 54;

export function graphMetrics(config: DialogueConfig) {
  const cols = Math.max(0, ...config.nodes.map((node) => node.position?.col ?? 0));
  const rows = Math.max(0, ...config.nodes.map((node) => node.position?.row ?? 0));
  return {
    width: PAD_X * 2 + cols * COL_WIDTH + NODE_WIDTH,
    height: PAD_Y * 2 + rows * ROW_HEIGHT + NODE_HEIGHT,
  };
}

export function nodeCenter(node: DialogueNode) {
  const col = node.position?.col ?? 0;
  const row = node.position?.row ?? 0;
  return {
    x: PAD_X + col * COL_WIDTH + NODE_WIDTH / 2,
    y: PAD_Y + row * ROW_HEIGHT + NODE_HEIGHT / 2,
    left: PAD_X + col * COL_WIDTH,
    top: PAD_Y + row * ROW_HEIGHT,
  };
}

export function DialogueGraph({
  config,
  currentNodeId,
  validation,
  visitedNodeIds,
  onSelectNode,
}: DialogueGraphProps) {
  const metrics = graphMetrics(config);
  const nodes = config.nodes.filter((node) => node.position);
  const byId = new Map(config.nodes.map((node) => [node.id, node]));
  const missingTargets = new Set(
    validation.missingTargets.map((entry) => `${entry.nodeId}::${entry.choiceId}`),
  );
  const noExit = new Set(validation.noUnconditionalExitNodeIds);
  const unreachable = new Set(validation.unreachableNodeIds);
  const deadEnds = new Set(validation.deadEnds);

  return (
    <div className="graph-scroll" data-testid="dialogue-graph">
      <svg
        className="graph"
        viewBox={`0 0 ${metrics.width} ${metrics.height}`}
        width={metrics.width}
        height={metrics.height}
        role="img"
        aria-label="节点关系图"
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
          <marker id="arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#d8a657" />
          </marker>
        </defs>

        {nodes.flatMap((node) =>
          node.choices.map((choice) => {
            const target = byId.get(choice.target);
            if (!target?.position || !node.position) return null;
            const from = nodeCenter(node);
            const to = nodeCenter(target);
            const selfLoop = target.id === node.id;
            const missing = missingTargets.has(`${node.id}::${choice.id}`);
            const isCurrentOut = node.id === currentNodeId;
            const key = `${node.id}-${choice.id}`;
            let path: string;
            if (selfLoop) {
              const r = 34;
              path = `M ${from.left + NODE_WIDTH - 26} ${from.top + NODE_HEIGHT / 2 - 8} C ${from.left + NODE_WIDTH + r} ${from.top - 26}, ${from.left + NODE_WIDTH + r} ${from.top + NODE_HEIGHT + 26}, ${from.left + NODE_WIDTH - 40} ${from.top + NODE_HEIGHT - 6}`;
            } else if (choice.target === node.id) {
              path = '';
            } else {
              const midX = (from.x + to.x) / 2;
              path = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
            }
            const edgeId = CHOICE_EDGE_ID(node.id, choice.id);
            return (
              <g
                key={key}
                data-edge-id={edgeId}
                className={[
                  'edge',
                  isCurrentOut ? 'edge--current' : '',
                  selfLoop ? 'edge--loop' : '',
                  missing ? 'edge--broken' : '',
                  choice.when ? 'edge--conditional' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <path d={path} fill="none" markerEnd="url(#arrow)" />
                <title>{`${node.title} → ${target.title}${choice.when ? '（有条件）' : ''}`}</title>
              </g>
            );
          }),
        )}

        {nodes.map((node) => {
          const center = nodeCenter(node);
          const isCurrent = node.id === currentNodeId;
          const isEntry = node.id === config.entryNodeId;
          const inLoop = validation.loopNodeIds.includes(node.id);
          const classes = [
            'node',
            isCurrent ? 'node--current' : '',
            isEntry ? 'node--entry' : '',
            node.terminal ? 'node--terminal' : '',
            visitedNodeIds.has(node.id) ? 'node--visited' : '',
            unreachable.has(node.id) ? 'node--unreachable' : '',
            deadEnds.has(node.id) ? 'node--dead' : '',
            inLoop ? 'node--loop' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <g
              key={node.id}
              className={classes}
              transform={`translate(${center.left} ${center.top})`}
              data-node-id={node.id}
              onClick={() => onSelectNode(node.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectNode(node.id);
                }
              }}
            >
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
              <text x={10} y={21} className="node-title">
                {node.title}
              </text>
              <text x={10} y={39} className="node-sub">
                {node.id}
                {noExit.has(node.id) ? ' · 无无条件出口' : ''}
              </text>
              {isCurrent ? <circle cx={NODE_WIDTH - 12} cy={12} r={4} className="node-pulse" /> : null}
              <title>{`${node.title}（${node.id}）${node.terminal ? ' · 结局' : ''}${inLoop ? ' · 位于循环内（非错误）' : ''}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="graph-legend">
        <span className="legend legend--current">当前节点</span>
        <span className="legend legend--visited">本次走过</span>
        <span className="legend legend--loop">循环边（非错误）</span>
        <span className="legend legend--conditional">条件出口</span>
        <span className="legend legend--broken">目标缺失</span>
        <span className="legend legend--unreachable">不可达</span>
      </div>
    </div>
  );
}
