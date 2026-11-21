import {
  cellKey,
  cloneLevel,
  gateLabel,
  gateSymbol,
  makeNode,
  nodeById,
  occupiedNodeAt,
  resetLevelState,
  sameCell,
  type GateOp,
  type GridPos,
  type Level,
  type LogicNode,
  type NodeKind,
} from '../model';
import {
  canConnect,
  tick,
  type Direction,
  type MoveOutcome,
  type TickReport,
} from '../sim';
import {
  EMPTY_OP_INTENT,
  operationFromIntent,
  replayOperations,
  resetOpIdCounter,
  type OpIntent,
  type Operation,
} from '../ops';
import { SCENARIOS, buildScenario, uid, type ScenarioId } from '../scenarios';
import {
  cellCenter,
  describeHit,
  draw,
  hitTest,
  pointToCell,
  sceneSize,
  type Hit,
  type Point,
  type Viewport,
} from './scene';
import {
  renderEdgeInspector,
  renderEmptyInspector,
  renderNodeInspector,
  renderTickLog,
} from './inspector';

interface DragState {
  nodeId: string;
  origin: GridPos;
  pointerMoved: boolean;
}

interface WireState {
  fromId: string;
  pointer: Point | null;
  hover: Hit | null;
}

interface PanState {
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

const LIBRARY: Array<{ kind: NodeKind; label: string; hint: string; op?: GateOp }> = [
  { kind: 'switch', label: '开关', hint: '拨动输出 ON/OFF' },
  { kind: 'plate', label: '压力板', hint: '角色踩住时为 ON' },
  { kind: 'delay', label: '单步延时', hint: 'N 步缓冲队列' },
  { kind: 'gate', label: '与门', hint: '双输入 AND', op: 'and' },
  { kind: 'gate', label: '或门', hint: '双输入 OR', op: 'or' },
  { kind: 'gate', label: '异或门', hint: '双输入 XOR', op: 'xor' },
  { kind: 'gate', label: '与非门', hint: '双输入 NAND', op: 'nand' },
  { kind: 'gate', label: '或非门', hint: '双输入 NOR', op: 'nor' },
  { kind: 'door', label: '门', hint: 'ON 时可通行' },
  { kind: 'lamp', label: '指示灯', hint: '显示结算值' },
];

const ARROW_KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

export class App {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private base: Level;
  private level: Level;
  private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  private pendingIntent: OpIntent = { ...EMPTY_OP_INTENT, toggles: [] };
  private operations: Operation[] = [];
  private reports: TickReport[] = [];
  private liveReport: TickReport | null = null;
  private selectedLogIndex: number | null = null;
  private paused = true;
  private selectedNodeId: string | null = null;
  private selectedEdgeId: string | null = null;
  private hover: Hit | null = null;
  private drag: DragState | null = null;
  private wire: WireState | null = null;
  private pan: PanState | null = null;
  private dragLibrary: { kind: NodeKind; op: GateOp | undefined; label: string } | null = null;
  private ghostPos: GridPos | null = null;
  private lastReportKey = '';
  private status = '';
  private runToken = 0;
  private reviewing = false;
  private toastTimer = 0;
  private scenarioId: ScenarioId = 'cross-step';

  constructor(private root: HTMLElement) {
    this.base = buildScenario(this.scenarioId);
    this.level = resetLevelState(this.base);
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };

    this.buildUi();
    this.canvas = root.querySelector<HTMLCanvasElement>('#scene')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.bindCanvas();
    this.bindKeyboard();
    this.selectScenario(this.scenarioId);
    this.resize();
    this.loop();
    window.addEventListener('resize', () => this.resize());
  }

  // ---------- UI 骨架 ----------
  private buildUi(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand">
            <span class="logo">◈</span>
            <div>
              <h1>信号结算台</h1>
              <p>开关 · 压力板 · 单步延时 · 双输入门</p>
            </div>
          </div>
          <div class="scenario-tabs" id="scenario-tabs"></div>
          <div class="transport">
            <button id="btn-step" class="primary" title="F / Enter">结算一步</button>
            <button id="btn-toggle-pause" class="secondary" title="空格">已暂停 · 继续</button>
            <button id="btn-reset" class="danger-ghost">重置</button>
            <button id="btn-replay" class="secondary">重放</button>
          </div>
        </header>
        <aside class="library" id="library"></aside>
        <main class="stage">
          <canvas id="scene"></canvas>
          <div class="hud" id="hud"></div>
          <div class="toast" id="toast"></div>
        </main>
        <aside class="sidepanel">
          <section class="panel inspector" id="inspector"></section>
          <section class="panel intent" id="intent"></section>
          <section class="panel log" id="log"></section>
        </aside>
      </div>
    `;

    const tabs = this.root.querySelector<HTMLElement>('#scenario-tabs')!;
    tabs.innerHTML = SCENARIOS.map(
      (scenario) =>
        `<button type="button" class="tab" data-scenario="${scenario.id}">${scenario.title.split(':')[0]}</button>`,
    ).join('');
    tabs.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-scenario]');
      if (!target) return;
      const id = target.dataset.scenario as ScenarioId | undefined;
      if (id) this.selectScenario(id);
    });

    const library = this.root.querySelector<HTMLElement>('#library')!;
    library.innerHTML = `
      <h2>元件库</h2>
      <p class="library-hint">把元件拖到场景空格子里放置 (按住标尺拖拽可平移, 滚轮缩放).</p>
      <div class="library-list">
        ${LIBRARY.map(
          (item) =>
            `<button type="button" class="lib-item" draggable="true" data-kind="${item.kind}" data-op="${item.op ?? ''}">
              <span class="lib-swatch ${item.kind}">${
                item.kind === 'gate' ? gateSymbol(item.op ?? 'and') : item.kind === 'delay' ? '▦' : item.kind === 'plate' ? '▤' : item.kind === 'door' ? '▥' : item.kind === 'lamp' ? '◉' : '⇄'
              }</span>
              <span class="lib-text"><strong>${item.kind === 'gate' ? gateLabel(item.op ?? 'and') : item.label}</strong><small>${item.hint}</small></span>
            </button>`,
        ).join('')}
      </div>
      <div class="library-foot">
        <label>延时步数 <input id="delay-steps" type="number" min="1" max="8" value="2" /></label>
        <p>拖动节点可改位置; 从 OUT 端口拖到 IN 端口建立/改写接线.</p>
      </div>
    `;

    library.addEventListener('dragstart', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.lib-item');
      if (!target) return;
      const kind = target.dataset.kind as NodeKind;
      const op = target.dataset.op ? (target.dataset.op as GateOp) : undefined;
      this.dragLibrary = { kind, op, label: target.textContent ?? '' };
      event.dataTransfer?.setData('text/plain', kind);
    });

    this.root.querySelector('#btn-step')!.addEventListener('click', () => this.commitStep());
    this.root.querySelector('#btn-toggle-pause')!.addEventListener('click', () => this.togglePause());
    this.root.querySelector('#btn-reset')!.addEventListener('click', () => this.resetAndKeepOperations());
    this.root.querySelector('#btn-replay')!.addEventListener('click', () => this.replaySaved());

    this.root.querySelector<HTMLElement>('#log')!.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-log-index]');
      if (!row) return;
      const index = Number(row.dataset.logIndex);
      this.jumpToReport(index);
    });
    this.root.querySelector<HTMLElement>('#inspector')!.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'delete-node') this.deleteSelectedNode();
      if (action.dataset.action === 'delete-edge') this.deleteSelectedEdge();
      if (action.dataset.action === 'cycle-gate') this.cycleGateOp();
    });
  }

  private selectScenario(id: ScenarioId): void {
    this.scenarioId = id;
    this.base = buildScenario(id);
    this.level = resetLevelState(this.base);
    this.operations = [];
    this.reports = [];
    this.liveReport = null;
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this.selectedLogIndex = null;
    resetOpIdCounter();
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.paused = true;
    for (const tab of this.root.querySelectorAll<HTMLElement>('[data-scenario]')) {
      tab.classList.toggle('active', tab.dataset.scenario === id);
    }
    this.fitView();
    this.renderAll();
    const meta = SCENARIOS.find((scenario) => scenario.id === id);
    this.toast(meta?.blurb ?? '');
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    canvas.addEventListener('dragover', (event) => {
      event.preventDefault();
      const point = this.toScene(event);
      const cell = pointToCell(point, this.level);
      this.ghostPos = cell;
      if (cell) this.hover = hitTest(this.level, point);
    });
    canvas.addEventListener('dragleave', () => {
      this.ghostPos = null;
      this.hover = null;
    });
    canvas.addEventListener('drop', (event) => {
      event.preventDefault();
      const cell = this.ghostPos ?? pointToCell(this.toScene(event), this.level);
      this.ghostPos = null;
      if (!cell || !this.dragLibrary) return;
      this.placeNode(this.dragLibrary.kind, cell, this.dragLibrary.op);
      this.dragLibrary = null;
    });

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      const point = this.toScene(event);
      const hit = hitTest(this.level, point);
      this.hover = hit;

      if (event.button === 1 || (event.altKey && event.button === 0)) {
        this.pan = { startX: event.clientX, startY: event.clientY, offsetX: this.viewport.offsetX, offsetY: this.viewport.offsetY };
        return;
      }

      if (!hit) {
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.pan = { startX: event.clientX, startY: event.clientY, offsetX: this.viewport.offsetX, offsetY: this.viewport.offsetY };
        this.renderAll();
        return;
      }

      if (hit.type === 'port') {
        if (hit.side === 'out') {
          this.wire = { fromId: hit.nodeId, pointer: point, hover: null };
          this.root.dataset.wiring = '1';
          return;
        }
        if (hit.side === 'in') {
          this.completeWireTo(hit.nodeId, hit.index);
          return;
        }
      }

      if (hit.type === 'node') {
        this.selectedNodeId = hit.nodeId;
        this.selectedEdgeId = null;
        const node = nodeById(this.level, hit.nodeId);
        if (node) this.drag = { nodeId: node.id, origin: { ...node.pos }, pointerMoved: false };
        this.renderAll();
        return;
      }

      if (hit.type === 'edge') {
        this.selectedEdgeId = hit.edgeId;
        this.selectedNodeId = null;
        this.renderAll();
        return;
      }

      if (hit.type === 'character' || hit.type === 'cell') {
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.renderAll();
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = this.toScene(event);
      if (this.wire) {
        this.wire.pointer = point;
        this.wire.hover = hitTest(this.level, point);
        this.renderHud();
        return;
      }
      if (this.pan) {
        this.viewport.offsetX = this.pan.offsetX + (event.clientX - this.pan.startX);
        this.viewport.offsetY = this.pan.offsetY + (event.clientY - this.pan.startY);
        return;
      }
      if (this.drag) {
        const cell = pointToCell(point, this.level);
        if (cell && !sameCell(cell, this.level.character) && cell.x >= 0 && cell.y >= 0) {
          const node = nodeById(this.level, this.drag.nodeId);
          if (node && sameCell(node.pos, cell)) {
            this.ghostPos = null;
          } else {
            this.ghostPos = occupiedNodeAt(this.level, cell) ? null : cell;
          }
          this.drag.pointerMoved = this.drag.pointerMoved || !sameCell(cell, this.drag.origin);
        }
      }
      const hit = hitTest(this.level, point);
      if (JSON.stringify(hit) !== JSON.stringify(this.hover)) {
        this.hover = hit;
        this.renderHud();
      }
    });

    const endInteraction = (event: PointerEvent): void => {
      if (this.wire) {
        const point = this.toScene(event);
        const hit = hitTest(this.level, point);
        if (hit?.type === 'port' && hit.side === 'in') {
          this.completeWireTo(hit.nodeId, hit.index);
        } else if (hit?.type === 'node') {
          const node = nodeById(this.level, hit.nodeId);
          if (node?.kind === 'gate') this.completeWireTo(node.id, indexForGate(node, point));
        }
        this.wire = null;
        this.root.dataset.wiring = '';
        this.renderAll();
      }
      if (this.drag) {
        if (this.drag.pointerMoved && this.ghostPos) {
          this.moveNode(this.drag.nodeId, this.ghostPos);
        }
        this.drag = null;
        this.ghostPos = null;
        this.renderAll();
      }
      if (this.pan) {
        this.pan = null;
      }
      this.renderHud();
    };
    canvas.addEventListener('pointerup', endInteraction);
    canvas.addEventListener('pointercancel', endInteraction);
    canvas.addEventListener('pointerleave', () => {
      if (!this.wire && !this.drag) this.hover = null;
      this.renderHud();
    });
    canvas.addEventListener('dblclick', (event) => {
      const point = this.toScene(event);
      const hit = hitTest(this.level, point);
      if (hit?.type === 'node') {
        const node = nodeById(this.level, hit.nodeId);
        if (node?.kind === 'switch') this.stageToggle(node.id);
        if (node?.kind === 'door') this.toast(`门: ${node.value === 'on' ? '可通行' : '关闭'}${node.openedAt ? ` (自第 ${node.openedAt} 步)` : ''}`);
      }
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = this.toScene(event);
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextScale = Math.max(0.55, Math.min(1.8, this.viewport.scale * factor));
      this.viewport.offsetX = point.x - (point.x - this.viewport.offsetX) * (nextScale / this.viewport.scale);
      this.viewport.offsetY = point.y - (point.y - this.viewport.offsetY) * (nextScale / this.viewport.scale);
      this.viewport.scale = nextScale;
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key in ARROW_KEYS) {
        event.preventDefault();
        const direction = ARROW_KEYS[event.key]!;
        this.pendingIntent.move = direction;
        this.renderAll();
        return;
      }
      switch (event.key) {
        case 'f':
        case 'F':
        case 'Enter':
          event.preventDefault();
          this.commitStep();
          break;
        case ' ':
          event.preventDefault();
          this.togglePause();
          break;
        case 'r':
        case 'R':
          this.resetAndKeepOperations();
          break;
        case 't':
        case 'T': {
          const selected = this.selectedNodeId ? nodeById(this.level, this.selectedNodeId) : null;
          if (selected?.kind === 'switch') this.stageToggle(selected.id);
          else this.toast('先选中一个开关, 再按 T 加入本步翻转');
          break;
        }
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          if (this.selectedEdgeId) this.deleteSelectedEdge();
          else if (this.selectedNodeId) this.deleteSelectedNode();
          break;
        case 'Escape':
          this.wire = null;
          this.drag = null;
          this.ghostPos = null;
          this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
          this.renderAll();
          break;
        default:
          break;
      }
    });
  }

  // ---------- 编辑动作 ----------
  private placeNode(kind: NodeKind, pos: GridPos, op?: GateOp): void {
    const occupied = occupiedNodeAt(this.level, pos);
    if (occupied) {
      this.toast(`格子 ${cellKey(pos)} 已被 ${occupied.name} 占用`);
      return;
    }
    if (sameCell(pos, this.level.character)) {
      this.toast('不能放在角色脚下');
      return;
    }
    const id = uid(kind);
    const stepsInput = this.root.querySelector<HTMLInputElement>('#delay-steps');
    const steps = stepsInput ? Number(stepsInput.value) : 2;
    const node = makeNode(kind, id, pos, op ? { op, steps } : { steps });
    this.applyEdit((level) => {
      level.nodes.push(node);
    });
    this.selectedNodeId = id;
    this.selectedEdgeId = null;
    this.toast(`已放置 ${node.name}`);
  }

  private moveNode(nodeId: string, pos: GridPos): void {
    const node = nodeById(this.level, nodeId);
    if (!node) return;
    if (sameCell(pos, this.level.character)) {
      this.toast('角色正在这一格');
      return;
    }
    if (occupiedNodeAt(this.level, pos)) {
      this.toast('目标格已被占用');
      return;
    }
    this.applyEdit((level) => {
      const target = nodeById(level, nodeId);
      if (target) target.pos = { ...pos };
    });
  }

  private completeWireTo(toNodeId: string, toPort: number): void {
    if (!this.wire) return;
    const from = this.wire.fromId;
    const error = canConnect(this.level, from, toNodeId, toPort);
    if (error) {
      this.toast(error);
      return;
    }
    this.applyEdit((level) => {
      const existing = level.edges.find((edge) => edge.to === toNodeId && edge.toPort === toPort);
      if (existing) {
        existing.from = from;
        existing.id = existing.id;
      } else {
        level.edges.push({ id: uid('edge'), from, to: toNodeId, toPort });
      }
    });
    const source = nodeById(this.base, from)?.name ?? from;
    const target = nodeById(this.base, toNodeId)?.name ?? toNodeId;
    this.toast(`接线: ${source} → ${target} ${toPort === 1 ? 'IN B' : 'IN A'}`);
  }

  private deleteSelectedEdge(): void {
    if (!this.selectedEdgeId) return;
    const id = this.selectedEdgeId;
    this.applyEdit((level) => {
      level.edges = level.edges.filter((edge) => edge.id !== id);
    });
    this.selectedEdgeId = null;
    this.toast('已删除接线');
  }

  private deleteSelectedNode(): void {
    if (!this.selectedNodeId) return;
    const id = this.selectedNodeId;
    const node = nodeById(this.level, id);
    this.applyEdit((level) => {
      level.nodes = level.nodes.filter((candidate) => candidate.id !== id);
      level.edges = level.edges.filter((edge) => edge.from !== id && edge.to !== id);
    });
    this.selectedNodeId = null;
    this.toast(`已删除 ${node?.name ?? id}`);
  }

  private cycleGateOp(): void {
    if (!this.selectedNodeId) return;
    const ops: GateOp[] = ['and', 'or', 'xor', 'nand', 'nor', 'not'];
    this.applyEdit((level) => {
      const node = nodeById(level, this.selectedNodeId!);
      if (node?.kind !== 'gate') return;
      const next = ops[(ops.indexOf(node.op) + 1) % ops.length]!;
      node.op = next;
      node.name = gateLabel(next);
      if (next === 'not') {
        level.edges = level.edges.filter((edge) => !(edge.to === node.id && edge.toPort === 1));
      }
    });
    this.toast('已切换门类型');
  }

  /**
   * 结构性编辑 (节点/接线/属性) 一律:
   * 更新静态基线 → 把运行态重置到第 0 步 → 保留操作记录, 等用户显式重放.
   */
  private applyEdit(mutate: (level: Level) => void): void {
    const draft = cloneLevel(this.base);
    mutate(draft);
    this.base = draft;
    this.level = resetLevelState(draft);
    this.reports = [];
    this.liveReport = null;
    this.selectedLogIndex = null;
    this.reviewing = false;
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.paused = true;
    this.renderAll();
    if (this.operations.length > 0) {
      this.toast(`连接或元件已变更, 运行态已重置; ${this.operations.length} 条操作可点"重放"重新执行.`);
    }
  }

  // ---------- 运行时动作 ----------
  private stageToggle(nodeId: string): void {
    const toggles = this.pendingIntent.toggles;
    const index = toggles.indexOf(nodeId);
    if (index >= 0) toggles.splice(index, 1);
    else toggles.push(nodeId);
    this.renderAll();
  }

  private commitStep(): void {
    if (!this.paused) {
      this.toast('请先暂停再单步结算');
      return;
    }
    this.syncHistoryToReviewPoint();
    const intent: OpIntent = {
      toggles: [...this.pendingIntent.toggles],
      move: this.pendingIntent.move,
    };
    if (intent.toggles.length === 0 && !intent.move) {
      this.toast('本步没有输入. 添加一个开关翻转或选择移动方向; 空推进也可继续.');
    }
    const operation = operationFromIntent(this.level, intent);
    const result = tick(this.level, { toggleSwitchIds: intent.toggles, move: intent.move });
    this.level = result.level;
    this.reports.push(result.report);
    this.liveReport = result.report;
    this.selectedLogIndex = this.reports.length - 1;
    this.operations.push(operation);
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.flashReport(result.report);
    this.renderAll();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.runToken += 1;
    this.renderAll();
    this.toast(this.paused ? '已暂停: 不做任何隐式结算' : '已继续: 每 900ms 自动结算一步 (输入为空时视为空推进)');
    if (!this.paused) this.autoTickLoop();
  }

  private autoTickLoop(): void {
    if (this.paused) return;
    const token = this.runToken;
    window.setTimeout(() => {
      if (this.paused || token !== this.runToken) return;
      const intent = { toggles: [...this.pendingIntent.toggles], move: this.pendingIntent.move };
      this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
      const operation = operationFromIntent(this.level, intent);
      const result = tick(this.level, { toggleSwitchIds: intent.toggles, move: intent.move });
      this.level = result.level;
      this.reports.push(result.report);
      this.liveReport = result.report;
      this.selectedLogIndex = this.reports.length - 1;
      this.operations.push(operation);
      this.flashReport(result.report);
      this.renderAll();
      this.autoTickLoop();
    }, 900);
  }

  /** 从回看位置继续提交时, 丢弃之后的旧记录, 保持记录与操作列表一致. */
  private syncHistoryToReviewPoint(): void {
    if (!this.reviewing) return;
    const keep = (this.selectedLogIndex ?? -1) + 1;
    this.operations = this.operations.slice(0, keep);
    this.reports = this.reports.slice(0, keep);
    this.reviewing = false;
  }

  private resetAndKeepOperations(): void {
    this.level = resetLevelState(this.base);
    this.reports = [];
    this.liveReport = null;
    this.selectedLogIndex = null;
    this.reviewing = false;
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.paused = true;
    this.toast(`已重置到第 0 步; ${this.operations.length} 条已保存操作保留.`);
    this.renderAll();
  }

  private replaySaved(): void {
    if (this.operations.length === 0) {
      this.toast('还没有保存的操作');
      return;
    }
    const replayed = replayOperations(this.base, this.operations);
    this.level = replayed.level;
    this.reports = replayed.reports;
    this.liveReport = replayed.reports[replayed.reports.length - 1] ?? null;
    this.selectedLogIndex = this.reports.length - 1;
    this.reviewing = false;
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.paused = true;
    this.toast(`从基线重放了 ${replayed.reports.length} 步; 结果应与原运行一致.`);
    this.renderAll();
  }

  /** 回看第 index 步的结算报告与当时的状态; 不改变保存的操作与基线. */
  private jumpToReport(index: number): void {
    if (index < 0 || index >= this.reports.length) return;
    this.paused = true;
    const preview = replayOperations(this.base, this.operations, index + 1);
    this.level = preview.level;
    this.liveReport = preview.reports[index] ?? null;
    this.selectedLogIndex = index;
    this.reviewing = index < this.operations.length - 1;
    this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
    this.renderAll();
    if (this.reviewing) {
      this.toast(`回看第 ${index + 1} 步; 在这里继续提交会丢弃其后的 ${this.operations.length - index - 1} 条操作.`);
    }
  }

  private toast(message: string, duration = 3400): void {
    this.status = message;
    const toast = this.root.querySelector<HTMLElement>('#toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('visible');
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), duration);
    }
    this.renderLog();
  }

  private flashReport(report: TickReport): void {
    const key = `${report.step}:${report.deltas.length}`;
    if (key !== this.lastReportKey) {
      this.lastReportKey = key;
      this.renderAll();
    }
  }

  // ---------- 渲染 ----------
  private resize(): void {
    const stage = this.canvas.parentElement!;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.fitView();
  }

  private fitView(): void {
    const size = sceneSize(this.level);
    const stage = this.canvas.parentElement;
    const width = stage?.clientWidth ?? size.width;
    const height = stage?.clientHeight ?? size.height;
    const scale = Math.min((width - 24) / size.width, (height - 24) / size.height, 1.25);
    this.viewport.scale = Math.max(0.45, scale);
    this.viewport.offsetX = (width - size.width * this.viewport.scale) / 2;
    this.viewport.offsetY = (height - size.height * this.viewport.scale) / 2;
  }

  private toScene(event: { clientX: number; clientY: number }): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.viewport.offsetX) / this.viewport.scale,
      y: (event.clientY - rect.top - this.viewport.offsetY) / this.viewport.scale,
    };
  }

  private loop(): void {
    window.requestAnimationFrame(() => {
      this.draw();
      this.loop();
    });
  }

  private draw(): void {
    const conflictNodeIds = new Set<string>();
    for (const feedback of this.liveReport?.feedbacks ?? []) {
      if (feedback.conflict) feedback.nodes.forEach((id) => conflictNodeIds.add(id));
    }
    draw(
      this.ctx,
      {
        level: this.level,
        viewport: this.viewport,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(2, window.devicePixelRatio || 1),
        selectedNodeId: this.selectedNodeId,
        selectedEdgeId: this.selectedEdgeId,
        wiringFrom: this.wire?.fromId ?? null,
        hover: this.wire?.hover ?? this.hover,
        pending: { toggleSwitchIds: this.pendingIntent.toggles, move: this.pendingIntent.move },
        conflictNodeIds,
        dragPreview: this.ghostPos,
        time: performance.now(),
      },
      this.wire?.pointer ?? null,
    );
  }

  private renderAll(): void {
    this.root.querySelector('#btn-toggle-pause')!.textContent = this.paused ? '已暂停 · 继续' : '运行中 · 暂停';
    this.renderHud();
    this.renderInspector();
    this.renderIntent();
    this.renderLog();
  }

  private renderHud(): void {
    const hud = this.root.querySelector<HTMLElement>('#hud')!;
    const hoverText = describeHit(this.level, this.wire?.hover ?? this.hover);
    const moveHint = this.liveReport?.move;
    const lastFeedback = this.liveReport?.feedbacks.find((feedback) => feedback.conflict);
    hud.innerHTML = `
      <span class="hud-cell">步骤 <strong>${this.level.step}</strong></span>
      <span class="hud-cell">角色 (${this.level.character.x}, ${this.level.character.y})</span>
      <span class="hud-cell">${this.paused ? '<span class="dot paused"></span>暂停' : '<span class="dot running"></span>运行'}</span>
      ${hoverText ? `<span class="hud-cell dim">${hoverText}</span>` : ''}
      ${moveHint ? renderMoveHint(moveHint) : ''}
      ${lastFeedback ? `<span class="hud-cell danger">反馈冲突 ${lastFeedback.nodes.join(', ')}</span>` : ''}
    `;
  }

  private renderInspector(): void {
    const inspector = this.root.querySelector<HTMLElement>('#inspector')!;
    if (this.selectedEdgeId) {
      inspector.innerHTML = renderEdgeInspector(this.level, this.selectedEdgeId);
      return;
    }
    if (this.selectedNodeId) {
      const node = nodeById(this.level, this.selectedNodeId);
      if (node) {
        inspector.innerHTML = `
          ${renderNodeInspector(this.level, node, this.liveReport)}
          <div class="inspector-actions">
            <button type="button" data-action="delete-node">删除节点</button>
            ${node.kind === 'gate' ? '<button type="button" data-action="cycle-gate">切换门类型</button>' : ''}
            ${node.kind === 'switch' ? '<p class="hint">双击开关可加入"本步翻转"列表, 再次双击取消.</p>' : ''}
          </div>
        `;
        return;
      }
    }
    inspector.innerHTML = renderEmptyInspector(this.level, this.paused, this.liveReport);
  }

  private renderIntent(): void {
    const intent = this.root.querySelector<HTMLElement>('#intent')!;
    const toggles = this.pendingIntent.toggles
      .map((id) => nodeById(this.level, id)?.name ?? id)
      .join(', ');
    const move = this.pendingIntent.move;
    const moveLabel = move ? { up: '↑ 上', down: '↓ 下', left: '← 左', right: '→ 右' }[move] : '无';
    const lastReport = this.liveReport;
    const doorLine = lastReport
      ? lastReport.doors.map((door) => `${door.name}: ${door.passable ? 'OPEN' : 'CLOSED'}${door.openedAt ? ` @${door.openedAt}` : ''}`).join(' · ') || '—'
      : '—';
    intent.innerHTML = `
      <h2>本步待提交输入</h2>
      <div class="intent-line"><span class="intent-label">开关翻转</span><span class="intent-value">${toggles || '无'}</span></div>
      <div class="intent-line"><span class="intent-label">角色移动</span><span class="intent-value">${moveLabel}</span></div>
      <p class="hint">两项在同一次结算中同时生效. 方向键设置移动, 双击开关加入翻转; 按 F 或 Enter 提交.</p>
      <div class="settle-summary">
        <div class="settle-row"><span>门状态</span><strong>${doorLine}</strong></div>
        <div class="settle-row"><span>变化节点</span><strong>${lastReport ? summarizeDeltas(lastReport) : '—'}</strong></div>
        <div class="settle-row"><span>反馈环</span><strong>${lastReport ? lastReport.feedbacks.map((feedback) => `${feedback.id}:${feedback.conflict ? '冲突' : '稳定'}`).join(', ') || '无' : '—'}</strong></div>
      </div>
      <div class="intent-actions">
        <button type="button" id="btn-commit-intent" class="primary">提交并结算</button>
        <button type="button" id="btn-clear-intent" class="secondary">清空输入</button>
      </div>
    `;
    intent.querySelector('#btn-commit-intent')?.addEventListener('click', () => this.commitStep());
    intent.querySelector('#btn-clear-intent')?.addEventListener('click', () => {
      this.pendingIntent = { ...EMPTY_OP_INTENT, toggles: [] };
      this.renderAll();
    });
  }

  private renderLog(): void {
    const log = this.root.querySelector<HTMLElement>('#log')!;
    const opList = this.operations
      .map(
        (operation, index) =>
          `<div class="op-row"><span class="op-index">${index + 1}</span><span class="op-label">${operation.label}</span></div>`,
      )
      .join('');
    log.innerHTML = `
      <h2>结算记录</h2>
      <div class="log-list">${renderTickLog(this.reports, this.selectedLogIndex)}</div>
      <h2>已保存的操作 (${this.operations.length})</h2>
      <div class="op-list">${opList || '<p class="empty">尚无操作. 每提交一步会记录一条, 供重放.</p>'}</div>
      <p class="hint">接线/元件变更后运行态重置, 操作列表保留; 点顶部"重放"从基线重新执行.</p>
      <div class="status-line">${this.status || ''}</div>
    `;
  }

}

/** 拖线落到门格内部时, 按指针相对门中心的高度选择 IN A / IN B. */
function indexForGate(node: LogicNode, point: Point): number {
  if (node.kind !== 'gate') return 0;
  const center = cellCenter(node.pos);
  return point.y >= center.y ? 1 : 0;
}

function summarizeDeltas(report: TickReport): string {
  if (report.deltas.length === 0) return '无';
  const names = report.deltas.slice(0, 4).map((delta) => delta.name);
  const rest = report.deltas.length - names.length;
  return `${names.join(', ')}${rest > 0 ? ` 等 ${report.deltas.length} 个` : ''}`;
}

function renderMoveHint(move: MoveOutcome): string {
  if (move.moved) {
    return `<span class="hud-cell good">移动 ${move.direction} → (${move.to.x}, ${move.to.y})</span>`;
  }
  return `<span class="hud-cell danger">移动受阻${move.blockedBy ? `: ${move.blockedBy.name}` : ''}${move.reason ? ` (${move.reason})` : ''}</span>`;
}
