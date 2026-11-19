import type { Engine } from '../engine/engine';
import type { NodeStatus } from '../engine/types';
import { distance } from '../engine/world';

const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: '未执行',
  running: '执行中',
  success: '成功',
  failure: '失败',
  interrupted: '被中断',
};

const KIND_LABEL: Record<string, string> = {
  selector: '优先选择',
  guard: '守卫',
  sequence: '顺序',
  condition: '条件',
  action: '持续动作',
};

interface TreeRow {
  id: number;
  depth: number;
}

/** 按固定结构生成带缩进的行(顺序即 tree.ts 中 flatten 的顺序) */
const TREE_LAYOUT: TreeRow[] = [
  { id: 1, depth: 0 },
  { id: 2, depth: 1 },
  { id: 3, depth: 2 },
  { id: 4, depth: 2 },
  { id: 5, depth: 3 },
  { id: 6, depth: 3 },
  { id: 7, depth: 1 },
  { id: 8, depth: 2 },
  { id: 9, depth: 2 },
  { id: 10, depth: 1 },
  { id: 11, depth: 2 },
  { id: 12, depth: 2 },
  { id: 13, depth: 3 },
  { id: 14, depth: 3 },
  { id: 15, depth: 1 },
];

export function renderTree(engine: Engine, el: HTMLElement): void {
  el.innerHTML = TREE_LAYOUT.map(({ id, depth }) => {
    const node = engine.getNode(id);
    if (!node) return '';
    return `
      <div class="tree-row s-${node.status}" data-node-id="${id}">
        <span class="badge">${STATUS_LABEL[node.status]}</span>
        <span class="kind-tag">${KIND_LABEL[node.kind]}</span>
        <span class="node-name" style="margin-left:${depth * 14}px">${node.name}</span>
        <span class="node-reason" title="${escapeHtml(node.reason)}">${escapeHtml(node.reason)}</span>
      </div>`;
  }).join('');
}

export function renderHud(engine: Engine, el: HTMLElement): void {
  const w = engine.world;
  const mt = w.npc.moveTarget;
  const targetText = mt
    ? `${mt.ref.kind === 'target' ? '可拖动目标' : mt.ref.index === -1 ? '休息点' : `巡逻点#${mt.ref.index}`} (${mt.pos.x.toFixed(0)}, ${mt.pos.y.toFixed(0)})`
    : '无';
  el.innerHTML = `
    <div><span class="k">模拟时间:</span> <span class="v">${w.simTime.toFixed(1)}s</span></div>
    <div><span class="k">决策周期:</span> <span class="v">#${w.tick}</span></div>
    <div><span class="k">NPC 位置:</span> <span class="v">(${w.npc.pos.x.toFixed(0)}, ${w.npc.pos.y.toFixed(0)})</span></div>
    <div><span class="k">NPC 生命:</span> <span class="v">${w.npc.hp.toFixed(0)}</span></div>
    <div><span class="k">移动目标:</span> <span class="v">${targetText}</span></div>
    <div><span class="k">当前行为:</span> <span class="v">${engine.activeActionName()}</span></div>
  `;
}

export function renderContext(engine: Engine, el: HTMLElement): void {
  const w = engine.world;
  const d = w.target.exists ? distance(w.npc.pos, w.target.pos) : null;
  const lowHp = w.npc.hp < w.config.lowHpThreshold;
  const inAlert = d !== null && d <= w.config.alertRange;
  el.innerHTML = `
    <div class="ctx-grid">
      <span class="k">生命 HP</span><span>${w.npc.hp.toFixed(0)} (撤退阈值 ${w.config.lowHpThreshold}) → <b style="color:${lowHp ? 'var(--interrupted)' : 'var(--success)'}">${lowHp ? '低生命, 撤退条件成立' : '正常'}</b></span>
      <span class="k">目标距离</span><span>${d === null ? '目标不存在' : `${d.toFixed(1)} (警戒 ${w.config.alertRange})`} → <b style="color:${inAlert ? 'var(--running)' : 'var(--muted)'}">${inAlert ? '在警戒内' : '在警戒外'}</b></span>
      <span class="k">巡逻开关</span><span>${w.config.patrolEnabled ? '开' : '关'}</span>
      <span class="k">巡逻点编号</span><span>#${w.npc.patrolIndex}(仅等待成功时推进)</span>
    </div>
    <p class="hint">每个周期根选择节点按优先级 <b>${w.config.branchOrder.join(' > ')}</b> 重检; 行动中的守卫条件也会重新判断。</p>
  `;
}

export function renderLogs(engine: Engine, el: HTMLElement): void {
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.innerHTML = engine.logs
    .map((l) => {
      const tag =
        l.kind === 'enter' ? '进入' : l.kind === 'exit' ? '退出' : l.kind === 'interrupt' ? '中断' : '信息';
      return `
        <div class="log-line ${l.kind}">
          <span class="t">t=${l.simTime.toFixed(1)} #${l.tick}</span>
          <span class="tag">${tag}</span>
          <span><b>[${l.nodeName}]</b> ${escapeHtml(l.detail)}</span>
        </div>`;
    })
    .join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
