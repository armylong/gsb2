import { Grid } from './core/Grid';
import { World, type WorldSnapshot } from './core/World';
import { SCENES, buildScene } from './core/scenes';
import { generateTerrain } from './core/generator';
import { circleCells, rectCells } from './core/shapes';
import { Renderer, type Preview, type ViewMode } from './render/renderer';
import type { Cell } from './core/types';

const STORAGE_KEY = 'terrain-sandbox-layout-v1';
const CELL_SIZE = 20;

type Tool = 'dig' | 'fill';

export class App {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private world: World;
  private initialGrid: Grid;

  private tool: Tool = 'dig';
  private viewMode: ViewMode = 'component';
  private radius = 2;
  private running = false;
  private speed = 6; // 格/秒
  private lastFrame = 0;
  private stepAccumulator = 0;

  private hoverCell: Cell | null = null;
  private dragRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private selectedFragmentId: number | null = null;
  private genSeed = 42;

  constructor() {
    this.canvas = document.getElementById('terrain') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.initialGrid = buildScene('bridge');
    this.world = new World(this.initialGrid.clone());
    this.renderer.resize(CELL_SIZE, this.world.width, this.world.height);
    this.bindUi();
    this.bindCanvas();
    this.refreshSceneButtons();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------- UI 绑定

  private bindUi(): void {
    document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((el) => {
      el.addEventListener('change', () => {
        this.tool = el.value as Tool;
        this.selectedFragmentId = null;
        this.draw();
      });
    });
    document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((el) => {
      el.addEventListener('change', () => {
        this.viewMode = el.value as ViewMode;
        this.draw();
      });
    });

    const radiusInput = document.getElementById('brush-radius') as HTMLInputElement;
    radiusInput.addEventListener('input', () => {
      this.radius = Math.max(0, Number(radiusInput.value) || 0);
      this.draw();
    });

    const speed = document.getElementById('speed') as HTMLInputElement;
    const speedVal = document.getElementById('speed-val') as HTMLSpanElement;
    speed.addEventListener('input', () => {
      this.speed = Number(speed.value);
      speedVal.textContent = String(this.speed);
    });

    document.getElementById('btn-run')!.addEventListener('click', () => this.setRunning(true));
    document.getElementById('btn-pause')!.addEventListener('click', () => this.setRunning(false));
    document.getElementById('btn-step')!.addEventListener('click', () => {
      this.setRunning(false);
      this.world.step();
      this.afterChange();
    });
    document.getElementById('btn-settle')!.addEventListener('click', () => {
      this.setRunning(false);
      this.world.settle();
      this.afterChange();
    });
    document.getElementById('btn-reset')!.addEventListener('click', () => this.reset());
    document.getElementById('btn-generate')!.addEventListener('click', () => {
      this.genSeed = (this.genSeed + 7) % 100000;
      this.loadGrid(generateTerrain({ width: 60, height: 36, seed: this.genSeed }));
    });

    document.getElementById('btn-save')!.addEventListener('click', () => this.saveLayout());
    document.getElementById('btn-load')!.addEventListener('click', () => this.loadLayout());
    document.getElementById('btn-export')!.addEventListener('click', () => this.exportJson());
    document.getElementById('btn-import')!.addEventListener('click', () => {
      document.getElementById('import-file')!.click();
    });
    document.getElementById('import-file')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.importJson(file);
      input.value = '';
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setRunning(!this.running);
      } else if (e.key === 's' || e.key === 'S') {
        this.setRunning(false);
        this.world.step();
        this.afterChange();
      } else if (e.key === 'r' || e.key === 'R') {
        this.reset();
      }
    });
  }

  private refreshSceneButtons(): void {
    const host = document.getElementById('scene-buttons')!;
    host.innerHTML = '';
    for (const scene of SCENES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = scene.name;
      btn.title = scene.description;
      btn.addEventListener('click', () => this.loadGrid(buildScene(scene.id)));
      host.appendChild(btn);
    }
  }

  private bindCanvas(): void {
    const toCell = (e: MouseEvent): Cell => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: Math.floor((e.clientX - rect.left) / CELL_SIZE),
        y: Math.floor((e.clientY - rect.top) / CELL_SIZE),
      };
    };

    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverCell = toCell(e);
      if (this.dragRect) {
        this.dragRect.x1 = this.hoverCell.x;
        this.dragRect.y1 = this.hoverCell.y;
      }
      this.updateInspect();
      this.draw();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverCell = null;
      this.dragRect = null;
      this.updateInspect();
      this.draw();
    });
    this.canvas.addEventListener('mousedown', (e) => {
      const cell = toCell(e);
      // 碎片命中优先：选中查看，不触发挖补（编辑仅作用于静态地形）
      const fragId = this.world.fragmentAt(cell.x, cell.y);
      if (fragId !== null) {
        this.selectedFragmentId = fragId;
        this.draw();
        this.updatePanel();
        return;
      }
      this.selectedFragmentId = null;
      if (this.tool === 'fill') {
        // 矩形补土：按下拖出矩形，松开执行
        this.dragRect = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
      } else {
        this.applyCircle(cell);
      }
    });
    window.addEventListener('mouseup', () => {
      if (this.dragRect) {
        const r = this.dragRect;
        this.dragRect = null;
        this.applyRect(r);
      }
    });
  }

  // ------------------------------------------------------------- 编辑操作

  private applyCircle(center: Cell): void {
    // 圆心用格中心表示，保证半径 0 恰好挖 1 格
    const raw = circleCells({ cx: center.x + 0.5, cy: center.y + 0.5, radius: this.radius });
    const result = this.world.edit(raw, 'dig');
    this.afterChange();
    if (result.removed === 0 && result.added === 0) {
      this.flashHint('该范围内没有可挖除的静态实心格');    }
  }

  private applyRect(r: { x0: number; y0: number; x1: number; y1: number }): void {
    const raw = rectCells(r);
    this.world.edit(raw, 'fill');
    this.afterChange();
  }

  private flashHint(msg: string): void {
    const el = document.getElementById('inspect')!;
    const original = el.dataset.original ?? el.textContent ?? '';
    el.dataset.original = original;
    el.textContent = msg;
    window.setTimeout(() => {
      el.textContent = original;
    }, 1500);
  }

  // ------------------------------------------------------------- 仿真循环

  private setRunning(run: boolean): void {
    this.running = run;
    this.lastFrame = performance.now();
    this.stepAccumulator = 0;
    this.updatePanel();
  }

  private loop(now: number): void {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.running) {
      this.stepAccumulator += dt * this.speed;
      let changed = false;
      while (this.stepAccumulator >= 1) {
        this.stepAccumulator -= 1;
        this.world.step();
        changed = true;
        if (this.world.fragments.length === 0) {
          this.stepAccumulator = 0;
          break;
        }
      }
      if (changed) this.afterChange();
    }
    this.draw();
  }

  // ------------------------------------------------------------- 存档

  private saveLayout(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.world.serialize()));
    this.flashHint('已保存当前静态布局到浏览器本地存储');
  }

  private loadLayout(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      this.flashHint('本地没有已保存的布局');
      return;
    }
    try {
      const snap = JSON.parse(raw) as WorldSnapshot;
      this.loadGrid(World.fromSnapshot(snap).grid);
      this.flashHint('已载入布局并重新标注连通块');
    } catch (err) {
      this.flashHint(`载入失败: ${(err as Error).message}`);
    }
  }

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.world.serialize(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'terrain-layout.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  private importJson(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const snap = JSON.parse(String(reader.result)) as WorldSnapshot;
        this.loadGrid(World.fromSnapshot(snap).grid);
        this.flashHint('导入成功');
      } catch (err) {
        this.flashHint(`导入失败: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------- 状态切换

  private loadGrid(grid: Grid): void {
    this.setRunning(false);
    this.initialGrid = grid;
    this.world = new World(grid.clone());
    this.selectedFragmentId = null;
    this.renderer.resize(CELL_SIZE, this.world.width, this.world.height);
    this.afterChange();
  }

  private reset(): void {
    this.setRunning(false);
    this.world.resetTo(this.initialGrid.clone());
    this.selectedFragmentId = null;
    this.afterChange();
  }

  /** 每次编辑/推进后的统一刷新入口（连通性已在 World 内部重判）。 */
  private afterChange(): void {
    this.draw();
    this.updatePanel();
    this.updateInspect();
  }

  // ------------------------------------------------------------- 渲染与面板

  private currentPreview(): Preview | null {
    if (this.tool === 'fill') {
      if (!this.dragRect || !this.hoverCell) return null;
      const raw = rectCells(this.dragRect);
      const valid = raw.filter((c) => this.world.grid.inBounds(c.x, c.y));
      const oob = raw.filter((c) => !this.world.grid.inBounds(c.x, c.y));
      return { cells: valid, outOfBounds: oob, mode: 'fill' };
    }
    if (!this.hoverCell) return null;
    const raw = circleCells({
      cx: this.hoverCell.x + 0.5,
      cy: this.hoverCell.y + 0.5,
      radius: this.radius,
    });
    const valid = raw.filter((c) => this.world.grid.inBounds(c.x, c.y));
    const oob = raw.filter((c) => !this.world.grid.inBounds(c.x, c.y));
    return { cells: valid, outOfBounds: oob, mode: 'dig' };
  }

  private draw(): void {
    this.renderer.render(this.world, {
      cellSize: CELL_SIZE,
      viewMode: this.viewMode,
      preview: this.currentPreview(),
      selectedFragmentId: this.selectedFragmentId,
    });
  }

  private updatePanel(): void {
    document.getElementById('stat-removed')!.textContent = String(this.world.removedCount);
    document.getElementById('stat-added')!.textContent = String(this.world.addedCount);
    document.getElementById('stat-static')!.textContent = String(this.world.staticCount);
    document.getElementById('stat-fragment')!.textContent = String(this.world.fragmentCount);
    document.getElementById('stat-total')!.textContent = String(this.world.totalCells);
    document.getElementById('stat-tick')!.textContent = String(this.world.tick);
    document.getElementById('stat-state')!.textContent = this.running ? '运行中' : '暂停';

    const compHost = document.getElementById('component-list')!;
    compHost.innerHTML = '';
    for (const [id, size] of [...this.world.labeling.sizes.entries()].sort((a, b) => a[0] - b[0])) {
      const grounded = this.world.labeling.grounded.has(id);
      const div = document.createElement('div');
      div.className = `chip ${grounded ? 'grounded' : 'floating'}`;
      div.textContent = `#${id} · ${size} 格 · ${grounded ? '接地' : '未接地'}`;
      compHost.appendChild(div);
    }

    const fragHost = document.getElementById('fragment-list')!;
    fragHost.innerHTML = '';
    if (this.world.fragments.length === 0) {
      fragHost.innerHTML = '<span class="muted">（无）</span>';
    }
    for (const f of this.world.fragments) {
      const div = document.createElement('div');
      div.className = 'chip frag';
      if (f.id === this.selectedFragmentId) div.classList.add('selected');
      div.textContent = `F${f.id} · ${f.size} 格 · 下落 ${f.drop.toFixed(1)} 格`;
      fragHost.appendChild(div);
    }

    const logHost = document.getElementById('transition-log')!;
    logHost.innerHTML = '';
    const recent = this.world.transitions.slice(-20).reverse();
    for (const t of recent) {
      const div = document.createElement('div');
      div.textContent =
        `步${t.tick} ${t.kind === 'detach' ? '转出' : '并入'} ` +
        `F${t.fragmentId}（${t.size} 格）`;
      logHost.appendChild(div);
    }
  }

  private updateInspect(): void {
    const el = document.getElementById('inspect')!;
    if (!this.hoverCell || !this.world.grid.inBounds(this.hoverCell.x, this.hoverCell.y)) {
      el.textContent = '在画布上悬停查看该格归属。';
      delete el.dataset.original;
      return;
    }
    const { x, y } = this.hoverCell;
    const owner = this.world.ownerAt(x, y);
    let text: string;
    if (owner.kind === 'empty') {
      text = `格 (${x}, ${y})：空（空洞）`;
    } else if (owner.kind === 'static') {
      const grounded = this.world.labeling.grounded.has(owner.componentId);
      text =
        `格 (${x}, ${y})：静态 · 连通块 #${owner.componentId} · ` +
        (grounded ? '接地静止' : '未接地');
    } else {
      text = `格 (${x}, ${y})：碎片 F${owner.fragmentId}（只读，不参与挖补）`;
    }
    el.textContent = text;
    el.dataset.original = text;
  }
}
