import { LEVELS } from './levels';
import { GameState, type Mode } from './engine/state';
import { requestHint, buildConstraints } from './engine/hints';
import { Solver } from './engine/solver';
import { Renderer } from './ui/renderer';
import type { Cell, Direction, ProbeType } from './types';

const MODE_TIPS: Record<Mode, string> = {
  line: '在非墙格上点击放置方向探头：数该方向连续格（撞墙即停）中的实地数。可用方向键改方向。',
  adjacency: '在非墙格上点击放置邻域探头：只判断正交邻格（不越墙）里是否至少有一个空洞。',
  'mark-safe': '点击格子标记“已知安全（实地）”，再点一次取消，不消耗探头。',
  'mark-void': '点击格子标记“已知为空（空洞）”，再点一次取消，不消耗探头。',
  'mark-unknown': '点击格子标记“不确定”，再点一次取消，不消耗探头。',
  path: '从入口格开始依次点击相邻格连成通路；点已在路上的格会回退到该格。',
};

const DIR_NAME: Record<Direction, string> = { up: '上', down: '下', left: '左', right: '右' };

export class Game {
  private canvas = document.getElementById('board') as HTMLCanvasElement;
  private renderer = new Renderer(this.canvas);
  private state: GameState;
  private levelIndex = 0;
  private mode: Mode = 'line';
  private hover: Cell | null = null;
  private hintCell: Cell | null = null;
  private toastTimer: number | undefined;

  constructor() {
    this.state = new GameState(LEVELS[0]);
    this.bindStatic();
    this.bindCanvas();
    this.selectLevel(0);
  }

  // ---------------- 绑定 ----------------
  private bindStatic(): void {
    document.querySelectorAll<HTMLButtonElement>('#tools button').forEach((b) => {
      b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode));
    });
    document.querySelectorAll<HTMLButtonElement>('.dir-row button').forEach((b) => {
      b.addEventListener('click', () => this.setDirection(b.dataset.dir as Direction));
    });
    document.getElementById('btn-hint')!.addEventListener('click', () => this.showHint());
    document.getElementById('btn-clear-path')!.addEventListener('click', () => {
      this.state.clearPath();
      this.renderAll();
    });
    document.getElementById('btn-submit')!.addEventListener('click', () => this.submit());
    document.getElementById('btn-restart')!.addEventListener('click', () => {
      this.state.restart();
      this.hintCell = null;
      this.hideBox('hint-box');
      this.hideBox('result-box');
      this.renderAll();
    });
    window.addEventListener('keydown', (e) => {
      const map: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      if (map[e.key]) {
        e.preventDefault();
        this.setDirection(map[e.key]);
      }
    });
  }

  private bindCanvas(): void {
    this.canvas.addEventListener('mousemove', (e) => {
      this.hover = this.renderer.pick(e.clientX, e.clientY);
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    this.canvas.addEventListener('click', (e) => {
      const cell = this.renderer.pick(e.clientX, e.clientY);
      if (cell) this.onCellClick(cell);
    });
  }

  // ---------------- 关卡 / 模式 ----------------
  private selectLevel(index: number): void {
    this.levelIndex = index;
    this.state = new GameState(LEVELS[index]);
    this.hintCell = null;
    this.setMode('line');
    this.hideBox('hint-box');
    this.hideBox('result-box');
    this.buildTabs();
    this.renderAll();
  }

  private buildTabs(): void {
    const wrap = document.getElementById('level-tabs')!;
    wrap.innerHTML = '';
    LEVELS.forEach((lv, i) => {
      const b = document.createElement('button');
      b.textContent = `第 ${i + 1} 关`;
      b.dataset.level = String(i);
      if (i === this.levelIndex) b.classList.add('active');
      wrap.appendChild(b);
      b.addEventListener('click', () => this.selectLevel(i));
    });
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    document.querySelectorAll('#tools button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLButtonElement).dataset.mode === mode);
    });
    document.getElementById('mode-tip')!.textContent = MODE_TIPS[mode];
    document.getElementById('dir-row')!.style.opacity = mode === 'line' ? '1' : '0.4';
    this.draw();
  }

  private setDirection(dir: Direction): void {
    this.state.direction = dir;
    document.querySelectorAll('.dir-row button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLButtonElement).dataset.dir === dir);
    });
    this.draw();
  }

  // ---------------- 棋盘点击 ----------------
  private onCellClick(cell: Cell): void {
    const { board } = this.state;
    if (!board.inside(cell.r, cell.c) || board.isWall(cell.r, cell.c)) {
      this.toast('这里是固定墙，不能操作');
      return;
    }
    if (this.state.revealed) {
      this.toast('已交卷：点击“重开本关”再来一次（底图不变）');
      return;
    }

    switch (this.mode) {
      case 'line':
        this.placeProbe('line', cell);
        break;
      case 'adjacency':
        this.placeProbe('adjacency', cell);
        break;
      case 'mark-safe':
        this.state.setMarker(cell.r, cell.c, 'safe');
        break;
      case 'mark-void':
        this.state.setMarker(cell.r, cell.c, 'void');
        break;
      case 'mark-unknown':
        this.state.setMarker(cell.r, cell.c, 'unknown');
        break;
      case 'path':
        if (this.state.path.length === 0) {
          const e = this.state.level.entry;
          if (cell.r !== e.r || cell.c !== e.c) {
            this.toast('通路要从入口格（蓝色“入”）开始，请先点入口');
            return;
          }
        }
        this.state.togglePathCell(cell.r, cell.c);
        break;
    }
    this.renderAll();
  }

  private placeProbe(type: ProbeType, cell: Cell): void {
    const check = this.state.canPlace({
      type,
      r: cell.r,
      c: cell.c,
      dir: type === 'line' ? this.state.direction : undefined,
    });
    if (!check.ok) {
      this.toast(check.reason ?? '不能在这里放探头');
      return;
    }
    const rec = this.state.place({
      type,
      r: cell.r,
      c: cell.c,
      dir: type === 'line' ? this.state.direction : undefined,
    });
    this.toast(
      type === 'line'
        ? `方向探头读数：连续 ${rec.cells.length} 格中有 ${rec.reading} 格实地`
        : rec.reading === 1
          ? '邻域探头读数：正交邻格里至少有一个空洞'
          : '邻域探头读数：正交邻格全是实地',
    );
  }

  // ---------------- 提示 ----------------
  private showHint(): void {
    const outcome = requestHint(this.state.board, this.state.records, this.state.markers);
    const box = document.getElementById('hint-box')!;
    box.className = 'hint-box';
    if (outcome.kind === 'unknown') {
      box.classList.add('unknown');
      box.innerHTML = `<b>信息不够：</b>${outcome.reason}`;
      this.hintCell = null;
    } else {
      this.hintCell = outcome.cell;
      box.classList.add(outcome.solid === 1 ? 'safe' : 'void');
      const refs = outcome.recordIds
        .map((id) => `<span class="ref" data-record="${id}">#${id}</span>`)
        .join('');
      box.innerHTML =
        `<b>必然${outcome.solid === 1 ? '安全（实地）' : '为空（空洞）'}：</b>` +
        `第 ${outcome.cell.r + 1} 行、第 ${outcome.cell.c + 1} 列<br>` +
        `用到的读数：${refs}`;
      box.querySelectorAll<HTMLElement>('.ref').forEach((el) => {
        el.addEventListener('click', () => {
          this.state.selectedRecordId = Number(el.dataset.record);
          this.renderAll();
        });
      });
    }
    this.draw();
  }

  // ---------------- 交卷 ----------------
  private submit(): void {
    if (this.state.path.length === 0) {
      this.toast('先用“画通路”模式提交一条相邻格连成的路');
      return;
    }
    const result = this.state.submit();
    const box = document.getElementById('result-box')!;
    box.className = 'hint-box ' + (result.ok ? 'win' : 'fail');
    if (result.ok) {
      box.innerHTML =
        '<b>过关！</b>提交的通路每一格都是实地，并且从指定入口走到了终点。底图已揭开，可对照读数回顾推断。';
    } else {
      // 失败后可回顾：找出第一个踩空/撞墙格标红
      const bad = this.firstBadCell();
      if (bad) this.renderer.drawFailureCell(bad);
      box.innerHTML =
        `<b>失败：</b>${result.reason}<br>` +
        '底图已揭开，可点击右侧读数历史重看每次探测覆盖区；重开本关会保留同一张底图。';
    }
    this.renderAll();
  }

  private firstBadCell(): Cell | null {
    const { board, path } = this.state;
    for (const p of path) {
      if (board.isWall(p.r, p.c) || board.kind(p.r, p.c) === 'empty') return p;
    }
    return null;
  }

  // ---------------- 渲染汇总 ----------------
  private renderAll(): void {
    this.draw();
    this.renderPanel();
    this.renderHistory();
  }

  private draw(): void {
    this.renderer.render(this.state, this.state.board, this.mode, this.hover, this.hintCell);
    if (this.state.revealed && !this.submitOk()) {
      const bad = this.firstBadCell();
      if (bad) this.renderer.drawFailureCell(bad);
    }
  }

  private submitOk(): boolean {
    return this.state.board.checkPath(
      this.state.path,
      this.state.level.entry,
      this.state.level.exit,
    ).ok;
  }

  private renderPanel(): void {
    const lv = this.state.level;
    document.getElementById('level-name')!.textContent = lv.name;
    document.getElementById('level-brief')!.textContent = lv.brief;

    const budgets = document.getElementById('budgets')!;
    const lineLeft = this.state.remaining('line');
    const adjLeft = this.state.remaining('adjacency');
    budgets.innerHTML = `
      <div class="budget-pill ${lineLeft <= 0 ? 'exhausted' : ''}">
        方向探头 <b>${lineLeft}</b> / ${lv.lineBudget}
      </div>
      <div class="budget-pill ${adjLeft <= 0 ? 'exhausted' : ''}">
        邻域探头 <b>${adjLeft}</b> / ${lv.adjacencyBudget}
      </div>`;

    document.querySelectorAll('.dir-row button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLButtonElement).dataset.dir === this.state.direction);
    });
  }

  private renderHistory(): void {
    const ol = document.getElementById('history')!;
    ol.innerHTML = '';
    if (this.state.records.length === 0) {
      ol.innerHTML = '<li style="list-style:none;cursor:default;color:#8fa0b8">暂无读数</li>';
      return;
    }
    for (const rec of this.state.records) {
      const li = document.createElement('li');
      li.dataset.record = String(rec.id);
      if (rec.id === this.state.selectedRecordId) li.classList.add('selected');
      const tag = rec.type === 'line' ? '方向' : '邻域';
      const reading =
        rec.type === 'line'
          ? `${rec.reading} 实地 / ${rec.cells.length} 格（向${DIR_NAME[rec.dir!]}）`
          : rec.reading === 1
            ? '邻格至少一个空洞'
            : '邻格全是实地';
      li.innerHTML = `<span class="tag ${rec.type === 'adjacency' ? 'adj' : ''}">#${rec.id}</span>` +
        `${tag}探头 @(${rec.r + 1},${rec.c + 1}) → ${reading}`;
      li.addEventListener('click', () => {
        this.state.selectedRecordId =
          this.state.selectedRecordId === rec.id ? -1 : rec.id;
        this.renderHistory();
        this.draw();
      });
      ol.appendChild(li);
    }
  }

  // ---------------- 杂项 ----------------
  private hideBox(id: string): void {
    document.getElementById(id)!.classList.add('hidden');
  }

  private toast(msg: string): void {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.remove('hidden');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.add('hidden'), 2600);
  }

  /** 供校验脚本/控制台检查当前读数下还有多少相容底图 */
  debugCompatibleCount(limit = 100): { count: number; capped: boolean } {
    const solver = new Solver(this.state.board, buildConstraints(this.state.board, this.state.records));
    const result = solver.solve({ maxSolutions: limit });
    return { count: result.solutions.length, capped: result.capped };
  }
}
