import {
  evaluateGate,
  gateLabel,
  nodeById,
  nodeKindLabel,
  type Level,
  type LogicNode,
  type Signal,
} from '../model';
import {
  describeNode,
  nodeSources,
  staticFeedbackLoops,
  type FeedbackReport,
  type NodeProvenance,
  type TickReport,
} from '../sim';

const SIGNAL_TEXT: Record<Signal, string> = { on: 'ON / 1', off: 'OFF / 0' };

function signalShort(signal: Signal): string {
  return signal === 'on' ? '1' : '0';
}

export interface InspectorModel {
  level: Level;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  liveReport: TickReport | null;
  /** 暂停状态下只显示静态反馈预检, 不触发结算 */
  paused: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderSettlementOrder(): string {
  return `
    <div class="order-legend">
      <h4>一次结算的固定次序</h4>
      <ol>
        <li>延时输出前进一格 (只读上一步已采样的队列)</li>
        <li>同时施加输入: 开关翻转 + 角色移动 + 压力板接触</li>
        <li>门电路按 SCC 拓扑序结算; 反馈环迭代到不动点或判冲突</li>
        <li>门 / 灯读取已稳定的信号, 得出可通行状态</li>
        <li>延时节点在结算末尾采样输入入队, 下一步才输出</li>
      </ol>
      <p class="hint">所有输入只读结算开始时的快照; 写回是整步一次的原子操作.</p>
    </div>`;
}

export function renderNodeInspector(level: Level, node: LogicNode, liveReport: TickReport | null): string {
  const feedback = liveReport?.feedbacks.find((entry) => entry.nodes.includes(node.id)) ?? null;
  const provenance = describeNode(level, node.id);
  if (!provenance) return '<p class="empty">节点不存在.</p>';
  const rows = provenance.inputs
    .map(
      (input) => `
      <div class="source-row ${input.unconnected ? 'unconnected' : ''}">
        <span class="port-badge">${input.port === 1 ? 'B' : 'A'}</span>
        <span class="source-name">${escapeHtml(input.nodeName)}</span>
        <span class="signal ${input.value}">${SIGNAL_TEXT[input.value]}</span>
        <span class="edge-note">${input.edgeId ? escapeHtml(input.edgeId) : '未接线 (按 OFF)'}</span>
      </div>`,
    )
    .join('');
  const lastDelta = liveReport?.deltas.find((delta) => delta.nodeId === node.id);
  const note = provenance && feedback && node.kind === 'gate'
    ? `${gateLabel(node.op)}: 位于无延时反馈环内 (${feedback.id}); 输入 ${provenance.inputs
        .map((input) => signalShort(input.value))
        .join('/')}. 结算结果见下方反馈卡片.`
    : provenance?.note ?? '';

  return `
    <div class="inspector-head">
      <span class="kind-chip">${nodeKindLabel(node)}</span>
      <h3>${escapeHtml(node.name)}</h3>
      <span class="signal ${node.value}">${SIGNAL_TEXT[node.value]}</span>
    </div>
    <p class="inspector-note">${escapeHtml(note)}</p>
    ${node.kind === 'delay' ? renderDelay(node, liveReport) : ''}
    ${rows ? `<div class="source-list"><h4>信号来源</h4>${rows}</div>` : '<p class="empty">没有输入端口 (源节点).</p>'}
    ${lastDelta ? `<div class="last-delta">本步: ${SIGNAL_TEXT[lastDelta.from]} → ${SIGNAL_TEXT[lastDelta.to]} · ${causeText(lastDelta.cause)}</div>` : ''}
    ${feedback ? renderFeedbackCard(feedback) : ''}
    ${node.kind === 'gate' ? renderGateTable(node, level) : ''}
  `;
}

function causeText(cause: NodeProvenance['cause']): string {
  switch (cause) {
    case 'action':
      return '玩家动作';
    case 'contact':
      return '角色接触';
    case 'logic':
      return '逻辑结算';
    case 'buffer':
      return '延时队列';
    case 'latched':
      return '保持值';
  }
}

function renderDelay(node: LogicNode, liveReport: TickReport | null): string {
  if (node.kind !== 'delay') return '';
  const snapshot = liveReport?.delays.find((item) => item.nodeId === node.id);
  const queue = snapshot?.queue ?? node.queue;
  const pips = queue
    .map((value, index) => `<span class="delay-pip ${value}" title="队列 ${index}">${value === 'on' ? '1' : '0'}</span>`)
    .join('') || '<span class="empty">队空</span>';
  return `
    <div class="delay-box">
      <h4>延时队列 (${node.steps} 步 · 先入先出)</h4>
      <div class="delay-pips">${pips}</div>
      <p class="delay-hint">${
        snapshot
          ? `本轮采样 ${snapshot.sampled === 'on' ? '1' : '0'} 入队, 输出${snapshot.advanced ? '前进了 1 格' : '尚未前进'}.`
          : '暂停中: 队列不会自行前进.'
      }</p>
    </div>`;
}

function renderGateTable(node: LogicNode, level: Level): string {
  if (node.kind !== 'gate') return '';
  const current = level.nodes.find((candidate) => candidate.id === node.id);
  if (current?.kind !== 'gate') return '';
  const a = nodeSources(level, current)[0]?.value ?? 'off';
  const b = nodeSources(level, current)[1]?.value ?? 'off';
  const rows: Array<[Signal, Signal]> =
    current.op === 'not'
      ? [['off', 'off'], ['on', 'off']]
      : [['off', 'off'], ['off', 'on'], ['on', 'off'], ['on', 'on']];
  const highlighted = current.op === 'not' ? a : null;
  const cells = rows
    .map(([x, y]) => {
      const out = evaluateGate(current.op, x, y);
      const isCurrent =
        current.op === 'not' ? x === highlighted : x === a && y === b;
      return `<div class="truth-row ${isCurrent ? 'current' : ''}">
        <span>${x === 'on' ? '1' : '0'}</span>${current.op === 'not' ? '' : `<span>${y === 'on' ? '1' : '0'}</span>`}
        <span class="truth-out ${out}">${out === 'on' ? '1' : '0'}</span>
      </div>`;
    })
    .join('');
  return `
    <div class="gate-table">
      <h4>${escapeHtml(node.name)} 真值检查</h4>
      <div class="truth-table">
        <div class="truth-head">${current.op === 'not' ? '<span>A</span>' : '<span>A</span><span>B</span>'}<span class="truth-out">OUT</span></div>
        ${cells}
      </div>
      <p class="hint">高亮行 = 当前输入 (${signalShort(a)}${current.op === 'not' ? '' : `, ${signalShort(b)}`}); 门的结果在本次结算内一次性给出.</p>
    </div>`;
}

export function renderFeedbackCard(feedback: FeedbackReport): string {
  const nodeList = feedback.nodes
    .map((id) => `<code>${escapeHtml(id)}</code>`)
    .join(' ↔ ');
  const settled = Object.entries(feedback.result)
    .map(([id, value]) => `<span class="settled-value ${value}">${escapeHtml(id)} = ${value === 'on' ? '1' : '0'}</span>`)
    .join(' ');
  const history = feedback.history
    .slice(0, 6)
    .map((record, index) => {
      const cells = Object.entries(record)
        .map(([id, value]) => `${escapeHtml(id)}=${value === 'on' ? '1' : '0'}`)
        .join(' ');
      return `<div class="history-row"><span class="round">R${index + 1}</span>${cells}</div>`;
    })
    .join('');
  const status = feedback.conflict
    ? '<span class="status conflict">冲突</span>'
    : feedback.iterations === 0
      ? '<span class="status pending">未结算</span>'
      : feedback.stable
        ? '<span class="status stable">稳定</span>'
        : '<span class="status pending">未结算</span>';
  return `
    <div class="feedback-card ${feedback.conflict ? 'conflict' : ''}">
      <div class="feedback-head">
        <h4>无延时反馈 ${escapeHtml(feedback.id)}</h4>
        ${status}
      </div>
      <p class="nodes">${nodeList}</p>
      ${settled ? `<div class="settled-row"><span class="settled-label">${feedback.conflict ? '冻结值' : '稳定结果'}</span>${settled}</div>` : ''}
      <p class="feedback-message">${escapeHtml(feedback.message)}</p>
      ${history ? `<div class="history"><h5>迭代轨迹</h5>${history}</div>` : ''}
      ${
        feedback.conflict
          ? '<p class="conflict-note">冲突期间, 环内节点整体保持结算前的值; 下游不会拿到猜测值.</p>'
          : ''
      }
    </div>`;
}

export function renderEdgeInspector(level: Level, edgeId: string): string {
  const edge = level.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return '<p class="empty">接线不存在.</p>';
  const source = nodeById(level, edge.from);
  const target = nodeById(level, edge.to);
  return `
    <div class="inspector-head"><span class="kind-chip">接线</span><h3>${escapeHtml(edge.id)}</h3></div>
    <div class="source-list">
      <h4>连接</h4>
      <div class="source-row">
        <span class="port-badge">${edge.toPort === 1 ? 'B' : edge.toPort === 0 ? 'A' : 'IN'}</span>
        <span class="source-name">${escapeHtml(source?.name ?? edge.from)} → ${escapeHtml(target?.name ?? edge.to)}</span>
        <span class="signal ${source?.value ?? 'off'}">${SIGNAL_TEXT[source?.value ?? 'off']}</span>
      </div>
    </div>
    <p class="inspector-note">选中后按 Delete 删除这条接线; 关系变更会自动重置运行态.</p>
  `;
}

export function renderEmptyInspector(level: Level, paused: boolean, liveReport: TickReport | null): string {
  const loops = paused || !liveReport ? staticFeedbackLoops(level) : liveReport.feedbacks;
  const loopSection =
    loops.length > 0
      ? `<div class="loop-preview">
          <h4>静态反馈环预检 ${paused ? '(暂停时只读)' : ''}</h4>
          ${loops.map((loop) => renderFeedbackCard(loop)).join('')}
        </div>`
      : '<p class="empty">当前场景没有无延时反馈环.</p>';
  const lastSummary = liveReport
    ? `<div class="last-tick">
        <h4>本步结算</h4>
        <p>${liveReport.deltas.length} 个节点发生变化 · ${liveReport.feedbacks.length} 个反馈环 · 迭代上限 64</p>
      </div>`
    : '<p class="empty">尚未结算. 按"结算一步"或方向键推进.</p>';
  return `
    <p class="inspector-note">点选节点查看每个输入信号的来源; 拖线建立或改写连接. 停止状态下不做任何隐式结算.</p>
    ${lastSummary}
    ${loopSection}
    ${renderSettlementOrder()}
  `;
}

export function renderTickLog(reports: TickReport[], selectedIndex: number | null): string {
  if (reports.length === 0) return '<p class="empty">还没有结算记录.</p>';
  return reports
    .map((report, index) => {
      const active = selectedIndex === index ? 'active' : '';
      const feedbackBadge = report.feedbacks.some((feedback) => feedback.conflict)
        ? '<span class="log-badge conflict">冲突</span>'
        : report.feedbacks.length > 0
          ? '<span class="log-badge feedback">反馈</span>'
          : '';
      const moveBadge = report.move
        ? report.move.moved
          ? `<span class="log-badge move">移动到 ${report.move.to.x},${report.move.to.y}</span>`
          : '<span class="log-badge blocked">移动受阻</span>'
        : '';
      return `
        <button class="log-row ${active}" data-log-index="${index}" type="button">
          <span class="log-step">#${report.step}</span>
          <span class="log-summary">${report.deltas.length} 变化 · ${report.feedbacks.length} 反馈</span>
          ${feedbackBadge}${moveBadge}
        </button>`;
    })
    .join('');
}
