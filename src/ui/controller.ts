import {
  computeGeometry,
  pixelToEdge,
  pixelToVertex,
  renderBoard,
  type BoardGeometry,
} from '../render/renderer';
import { colorDef } from '../render/palette';
import { diagnose, diagnoseCell } from '../game/diagnosis';
import {
  clearAll,
  clearRibbon,
  drawEdge,
  removeEdge,
  reroute,
  setTop,
} from '../game/operations';
import { defaultState, PUZZLES, getPuzzle } from '../game/levels';
import {
  hasSave,
  loadLayout,
  restart,
  saveLayout,
  validateAllPuzzles,
} from '../game/persistence';
import { edgeKey, sameVertex, vKey } from '../game/geometry';
import type { GameState, Puzzle, Vertex } from '../game/types';

export type Mode = 'draw' | 'erase' | 'flip' | 'reroute';

const MODE_META: Record<Mode, { name: string; tip: string }> = {
  draw: {
    name: '画带',
    tip: '选好颜色后，点击与同色带相邻的格边即可延伸；从入口起头。再点一次同一条边无效。',
  },
  erase: {
    name: '收带',
    tip: '点击带子末端或入口/出口处的格边收回；中间段请切换到「改道」。',
  },
  flip: {
    name: '翻转上下',
    tip: '点击合法交叉点，翻转谁压谁；非法交叉（非对边穿过）不能指定上下。',
  },
  reroute: {
    name: '改道',
    tip: '依次点击格点，圈出要替换的旧段（回车确认），再点出一条新路线（回车提交）。两侧接不上、撞孔或撞别的带都会被拒绝。',
  },
};

interface RerouteSession {
  phase: 'pick-old' | 'pick-new';
  oldPath: Vertex[];
  newPath: Vertex[];
}

export class GameController {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private puzzle: Puzzle;
  private state: GameState;
  private geo: BoardGeometry;
  private mode: Mode = 'draw';
  private activeColor: string;
  private hoverVertex: Vertex | null = null;
  private selectedVertices: Vertex[] = [];
  private reroute: RerouteSession | null = null;
  private showDiagnosis = true;
  private toastTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    validateAllPuzzles(PUZZLES);
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 Canvas 2D');
    this.ctx = ctx;
    this.puzzle = PUZZLES[0];
    this.state = defaultState(this.puzzle);
    this.activeColor = this.puzzle.ports[0].color;
    this.geo = computeGeometry(canvas.width, canvas.height, this.puzzle);
    this.bindEvents();
    this.buildStaticPanels();
    this.refresh();
  }

  // ---------- 对外按钮 ----------

  switchPuzzle(id: string): void {
    this.puzzle = getPuzzle(id);
    this.state = defaultState(this.puzzle);
    this.activeColor = this.puzzle.ports[0].color;
    this.geo = computeGeometry(this.canvas.width, this.canvas.height, this.puzzle);
    this.mode = 'draw';
    this.reroute = null;
    this.selectedVertices = [];
    this.buildStaticPanels();
    this.refresh();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.reroute = null;
    this.selectedVertices = [];
    this.updateModePanel();
    this.refresh();
  }

  setColor(color: string): void {
    this.activeColor = color;
    this.updateModePanel();
    this.refresh();
  }

  checkNow(): void {
    this.showDiagnosis = true;
    this.refresh();
    const d = diagnose(this.puzzle, this.state);
    if (d.solved) {
      this.toast('🎉 全部花纹与上下相间规则都满足，通关！');
    } else if (d.problems.length === 0) {
      this.toast('当前没有规则冲突，但还有目标或路线未完成。');
    } else {
      this.toast(`发现 ${d.problems.length} 个问题，见右侧清单与画布标红。`);
    }
  }

  save(): void {
    try {
      saveLayout(this.puzzle, this.state);
      this.toast('布局已保存到浏览器本地。');
    } catch (e) {
      this.toast(`保存失败：${(e as Error).message}`);
    }
    this.updateActionPanel();
  }

  load(): void {
    try {
      const loaded = loadLayout(this.puzzle);
      if (!loaded) {
        this.toast('本题面还没有存档。');
        return;
      }
      this.state = loaded;
      this.mode = 'draw';
      this.reroute = null;
      this.selectedVertices = [];
      this.updateModePanel();
      this.toast('存档已读取，验证结果与保存时一致。');
      this.refresh();
    } catch (e) {
      this.toast(`读档失败：${(e as Error).message}`);
    }
  }

  restartLevel(): void {
    this.state = restart(this.puzzle);
    this.mode = 'draw';
    this.reroute = null;
    this.selectedVertices = [];
    this.updateModePanel();
    this.toast('已回到题面初始布局。');
    this.refresh();
  }

  clearActiveColor(): void {
    this.state = clearRibbon(this.puzzle, this.state, this.activeColor);
    this.reroute = null;
    this.selectedVertices = [];
    this.refresh();
  }

  clearBoard(): void {
    this.state = clearAll(this.puzzle);
    this.refresh();
  }

  undoReroutePick(): void {
    if (!this.reroute) return;
    if (this.reroute.phase === 'pick-old') {
      this.reroute.oldPath.pop();
      this.selectedVertices = [...this.reroute.oldPath];
    } else {
      this.reroute.newPath.pop();
      this.selectedVertices = [...this.reroute.newPath];
    }
    this.refresh();
  }

  // ---------- 画布事件 ----------

  private bindEvents(): void {
    this.canvas.addEventListener('mousemove', (e) => {
      const { x, y } = this.canvasPoint(e);
      this.hoverVertex = pixelToVertex(x, y, this.geo);
      this.canvas.style.cursor = this.hoverVertex ? 'pointer' : 'default';
      this.refresh();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverVertex = null;
      this.refresh();
    });
    this.canvas.addEventListener('click', (e) => {
      const { x, y } = this.canvasPoint(e);
      const vertex = pixelToVertex(x, y, this.geo);
      const edge = pixelToEdge(x, y, this.geo);
      this.handleClick(vertex, edge);
    });
    window.addEventListener('keydown', (e) => {
      if (this.mode !== 'reroute' || !this.reroute) return;
      if (e.key === 'Enter') this.confirmReroutePhase();
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.undoReroutePick();
      }
      if (e.key === 'Escape') {
        this.reroute = null;
        this.selectedVertices = [];
        this.refresh();
      }
    });
  }

  private canvasPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  private handleClick(
    vertex: Vertex | null,
    edge: [Vertex, Vertex] | null,
  ): void {
    // 点击即更新格点判断，不依赖鼠标移动事件
    if (vertex) this.updateCellInfo(vertex);
    if (this.mode === 'flip') {
      if (!vertex) return;
      const res = setTop(this.puzzle, this.state, vertex);
      this.applyOp(res, '已翻转该交叉点的上下关系。');
      return;
    }
    if (this.mode === 'reroute') {
      if (vertex) this.handleRerouteClick(vertex);
      return;
    }
    if (!edge) return;
    if (this.mode === 'draw') {
      const res = drawEdge(
        this.puzzle,
        this.state,
        edge[0],
        edge[1],
        this.activeColor,
      );
      this.applyOp(res, '彩带已延伸。');
    } else if (this.mode === 'erase') {
      const res = removeEdge(this.puzzle, this.state, edge[0], edge[1]);
      this.applyOp(res, '格边已收回。');
    }
  }

  private handleRerouteClick(v: Vertex): void {
    if (!this.reroute) {
      this.reroute = { phase: 'pick-old', oldPath: [v], newPath: [] };
      this.selectedVertices = [v];
      this.refresh();
      return;
    }
    const session = this.reroute;
    const path = session.phase === 'pick-old' ? session.oldPath : session.newPath;
    const last = path[path.length - 1];
    if (sameVertex(last, v)) {
      // 重复点击终点 = 尝试确认本阶段
      this.confirmReroutePhase();
      return;
    }
    // 不允许立刻回头路之外的重复点
    if (path.some((p) => sameVertex(p, v))) {
      this.toast('改道路线不能重复经过同一格点，按 Backspace 可撤销上一个点。');
      return;
    }
    if (Math.abs(last.x - v.x) + Math.abs(last.y - v.y) !== 1) {
      this.toast('改道路线必须沿相邻格点逐格点击。');
      return;
    }
    path.push(v);
    this.selectedVertices = [...path];
    this.refresh();
  }

  private confirmReroutePhase(): void {
    if (!this.reroute) return;
    const session = this.reroute;
    if (session.phase === 'pick-old') {
      if (session.oldPath.length < 2) {
        this.toast('旧段至少要选一条格边。');
        return;
      }
      // 校验旧段确实属于当前颜色
      for (let i = 0; i < session.oldPath.length - 1; i++) {
        const owner = this.state.edges[
          edgeKey(session.oldPath[i], session.oldPath[i + 1])
        ];
        if (owner !== this.activeColor) {
          this.toast(
            `旧段必须全部属于当前颜色（${this.activeColor}），请重新选择。`,
          );
          this.reroute = null;
          this.selectedVertices = [];
          this.refresh();
          return;
        }
      }
      session.phase = 'pick-new';
      session.newPath = [session.oldPath[0]];
      this.selectedVertices = [session.oldPath[0]];
      this.toast('旧段已确认，现在点击格点画新路线，回车提交。');
      this.refresh();
      return;
    }
    if (session.newPath.length < 2) {
      this.toast('新路线至少要包含一条格边。');
      return;
    }
    const res = reroute(
      this.puzzle,
      this.state,
      this.activeColor,
      session.oldPath,
      session.newPath,
    );
    this.reroute = null;
    this.selectedVertices = [];
    this.applyOp(res, '改道完成，两侧走法已保留。');
  }

  private applyOp(
    res: ReturnType<typeof drawEdge>,
    successMessage: string,
  ): void {
    if (!res.ok || !res.state) {
      this.toast(res.error ?? '操作被规则拒绝。');
      return;
    }
    this.state = res.state;
    this.toast(successMessage);
    this.refresh();
  }

  // ---------- 渲染与侧栏 ----------

  private refresh(): void {
    const candidateEdges = this.computeCandidateEdges();
    renderBoard(this.ctx, this.puzzle, this.state, this.geo, {
      selectedVertices: this.selectedVertices,
      candidateEdges,
      hoverVertex: this.hoverVertex,
      activeColor: this.activeColor,
      showDiagnosis: this.showDiagnosis,
    });
    this.updateDiagnosisPanel();
    this.updateActionPanel();
    if (this.hoverVertex) this.updateCellInfo(this.hoverVertex);
  }

  private computeCandidateEdges(): Array<[Vertex, Vertex]> {
    if (this.mode !== 'draw' && this.mode !== 'erase') return [];
    if (!this.hoverVertex) return [];
    const result: Array<[Vertex, Vertex]> = [];
    const v = this.hoverVertex;
    const dirs: Vertex[] = [
      { x: v.x + 1, y: v.y },
      { x: v.x - 1, y: v.y },
      { x: v.x, y: v.y + 1 },
      { x: v.x, y: v.y - 1 },
    ];
    for (const n of dirs) {
      if (
        n.x < 0 ||
        n.x > this.puzzle.width ||
        n.y < 0 ||
        n.y > this.puzzle.height
      ) {
        continue;
      }
      if (this.puzzle.holes.some((h) => sameVertex(h, n))) continue;
      const key = edgeKey(v, n);
      if (this.mode === 'draw') {
        if (this.state.edges[key] === undefined) result.push([v, n]);
      } else if (this.state.edges[key] !== undefined) {
        result.push([v, n]);
      }
    }
    return result;
  }

  private buildStaticPanels(): void {
    // 题面切换
    const switchEl = document.getElementById('levelSwitch')!;
    switchEl.innerHTML = '';
    for (const p of PUZZLES) {
      const btn = document.createElement('button');
      btn.textContent = p.name;
      btn.className = p.id === this.puzzle.id ? 'active' : '';
      btn.addEventListener('click', () => this.switchPuzzle(p.id));
      switchEl.appendChild(btn);
    }
    document.getElementById('puzzleName')!.textContent = this.puzzle.name;
    document.getElementById('puzzleHint')!.textContent = this.puzzle.hint;

    // 颜色按钮
    const toolbar = document.getElementById('toolbar')!;
    toolbar.innerHTML = '';
    const colors = [
      ...new Set(this.puzzle.ports.map((p) => p.color)),
    ];
    for (const color of colors) {
      const btn = document.createElement('button');
      const def = colorDef(color);
      btn.className = 'color-btn';
      btn.dataset.color = color;
      btn.innerHTML = `<span class="swatch" style="background:${def.main}"></span>${def.name}`;
      btn.addEventListener('click', () => this.setColor(color));
      toolbar.appendChild(btn);
    }
    this.updateModePanel();
  }

  private updateModePanel(): void {
    const list = document.getElementById('modeList')!;
    list.innerHTML = '';
    for (const mode of ['draw', 'erase', 'flip', 'reroute'] as Mode[]) {
      const btn = document.createElement('button');
      btn.textContent = MODE_META[mode].name;
      btn.className = this.mode === mode ? 'active' : '';
      btn.addEventListener('click', () => this.setMode(mode));
      list.appendChild(btn);
    }
    const colorLine = `当前颜色：${colorDef(this.activeColor).name}`;
    document.getElementById('modeTip')!.textContent =
      `${colorLine}。${MODE_META[this.mode].tip}` +
      (this.mode === 'reroute' && this.reroute
        ? this.reroute.phase === 'pick-old'
          ? '（正在选旧段，回车确认）'
          : '（正在画新路线，回车提交，Esc 取消）'
        : '');

    // 颜色按钮高亮
    document.querySelectorAll<HTMLButtonElement>('.color-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.color === this.activeColor);
    });
  }

  private updateCellInfo(v: Vertex): void {
    const cell = diagnoseCell(this.puzzle, this.state, v);
    const el = document.getElementById('cellInfo')!;
    const targetText = cell.target
      ? ` 目标色：${colorDef(cell.target).name}；`
      : '';
    el.textContent = `[${vKey(v)}] ${cell.message}${targetText}`;
    el.className = `cell-info status-${cell.status.replace('-', '_')}${
      cell.conflict ? ' conflict' : ''
    }`;
  }

  private updateDiagnosisPanel(): void {
    const d = diagnose(this.puzzle, this.state);
    const summary = document.getElementById('summary')!;
    const completeCount = d.ribbons.filter((r) => r.complete).length;
    const targetOk = d.targets.filter((t) => t.state === 'ok').length;
    summary.innerHTML = `
      <div class="stat-row"><span>完整彩带</span><b>${completeCount}/${d.ribbons.length}</b></div>
      <div class="stat-row"><span>相间冲突</span><b class="${d.conflicts.length ? 'bad' : 'good'}">${d.conflicts.length}</b></div>
      <div class="stat-row"><span>目标达成</span><b class="${targetOk === d.targets.length ? 'good' : 'bad'}">${targetOk}/${d.targets.length}</b></div>
      <div class="stat-row"><span>总体状态</span><b class="${d.solved ? 'good' : 'bad'}">${d.solved ? '已通关' : '未完成'}</b></div>
    `;
    const list = document.getElementById('problemList')!;
    list.innerHTML = '';
    if (d.problems.length === 0) {
      const li = document.createElement('li');
      li.className = 'ok';
      li.textContent = '暂无问题。';
      list.appendChild(li);
    } else {
      for (const problem of d.problems) {
        const li = document.createElement('li');
        li.textContent = problem;
        list.appendChild(li);
      }
    }

    const targetList = document.getElementById('targetList')!;
    targetList.innerHTML = '';
    for (const t of d.targets) {
      const row = document.createElement('div');
      row.className = `target-row state-${t.state}`;
      const def = colorDef(t.expected);
      const stateText =
        t.state === 'ok'
          ? '✓ 已满足'
          : t.state === 'mismatch'
            ? `✗ 当前顶层 ${t.actual ?? '空'}`
            : '… 待织出';
      row.innerHTML = `<span class="swatch small" style="background:${def.main}"></span>
        <span class="target-pos">(${t.vertex.x}, ${t.vertex.y})</span>
        <span class="target-state">${stateText}</span>`;
      targetList.appendChild(row);
    }
  }

  private updateActionPanel(): void {
    const saved = hasSave(this.puzzle.id);
    const loadBtn = document.getElementById('btnLoad') as HTMLButtonElement;
    loadBtn.textContent = saved ? '读取存档（有）' : '读取存档（无）';
  }

  private toast(message: string): void {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el?.classList.remove('show');
    }, 2600);
  }
}

// 供 main.ts 绑定按钮
export function bootstrap(): void {
  const canvas = document.getElementById('board') as HTMLCanvasElement;
  const controller = new GameController(canvas);
  document.getElementById('btnCheck')!.addEventListener('click', () => controller.checkNow());
  document.getElementById('btnSave')!.addEventListener('click', () => controller.save());
  document.getElementById('btnLoad')!.addEventListener('click', () => controller.load());
  document.getElementById('btnRestart')!.addEventListener('click', () => controller.restartLevel());
  document.getElementById('btnClear')!.addEventListener('click', () => controller.clearActiveColor());
}
