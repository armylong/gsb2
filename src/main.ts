/**
 * 页面控制器:固定步长模拟 + requestAnimationFrame 渲染解耦。
 * 所有数值与统计都直接来自 Simulation 实际步进结果。
 */
import { Simulation } from './sim/sim';
import { buildPresets, makeOverlapDemo } from './sim/presets';
import { Renderer } from './ui/renderer';
import { DT, WORLD_W, WORLD_H, NEIGHBOR_DIST, PresetDef } from './sim/types';
import { Vec, dist } from './sim/math';

type DragMode =
  | { kind: 'pending'; id: number; start: Vec; isGoal: boolean }
  | { kind: 'agent'; id: number }
  | { kind: 'goal'; id: number }
  | null;

const DRAG_THRESHOLD_PX = 5;

class App {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private presets: PresetDef[] = [];
  private sim!: Simulation;
  private presetIndex = 0;
  private seed = 20261119;
  private running = false;
  private selectedId: number | null = null;
  private hoverId: number | null = null;
  private drag: DragMode = null;
  private accumulator = 0;
  private lastFrame = 0;
  private el!: Record<string, HTMLElement>;
  private input!: Record<string, HTMLInputElement | HTMLSelectElement | HTMLButtonElement>;

  constructor() {
    this.canvas = document.getElementById('stage') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.grabElements();
    this.bindControls();
    this.bindPointer();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault();
        this.toggleRun();
      }
    });
    this.loadPreset(0);
    this.resize();
    requestAnimationFrame((t) => this.loop(t));
  }

  private grabElements(): void {
    const ids = [
      'btn-play', 'btn-step', 'btn-reset', 'preset-select', 'seed-input',
      'strength', 'strength-val', 'btn-overlap', 'btn-trails',
      'banner', 'stats', 'selected-panel', 'preset-desc', 'time-limit-note',
    ];
    this.el = {};
    this.input = {};
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) this.el[id] = node;
    }
    this.input.presetSelect = this.el['preset-select'] as HTMLSelectElement;
    this.input.seedInput = this.el['seed-input'] as HTMLInputElement;
    this.input.strength = this.el['strength'] as HTMLInputElement;
  }

  private bindControls(): void {
    (this.el['btn-play'] as HTMLButtonElement).addEventListener('click', () => this.toggleRun());
    (this.el['btn-step'] as HTMLButtonElement).addEventListener('click', () => {
      this.running = false;
      this.sim.step();
      this.syncButtons();
    });
    (this.el['btn-reset'] as HTMLButtonElement).addEventListener('click', () => this.resetSim());
    this.input.presetSelect.addEventListener('change', () => {
      this.loadPreset(Number(this.input.presetSelect.value));
    });
    this.input.seedInput.value = String(this.seed);
    this.input.seedInput.addEventListener('change', () => {
      const n = Number(this.input.seedInput.value);
      if (Number.isFinite(n)) {
        this.seed = Math.trunc(n);
        this.rebuild();
      }
    });
    this.input.strength.addEventListener('input', () => {
      const s = Number(this.input.strength.value) / 100;
      this.sim.avoidanceStrength = s;
      this.el['strength-val'].textContent = `${Math.round(s * 100)}%`;
    });
    (this.el['btn-overlap'] as HTMLButtonElement).addEventListener('click', () => {
      this.loadOverlapDemo();
    });
    (this.el['btn-trails'] as HTMLButtonElement).addEventListener('click', (e) => {
      this.renderer.showTrails = !this.renderer.showTrails;
      (e.target as HTMLButtonElement).textContent =
        `轨迹:${this.renderer.showTrails ? '开' : '关'}`;
    });
  }

  private bindPointer(): void {
    const pos = (e: PointerEvent): Vec => {
      const rect = this.canvas.getBoundingClientRect();
      return this.renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      const w = pos(e);
      // 先做目标叉命中:目标可在远离身体的位置,必须独立命中测试
      const goalHit = this.pickGoal(w);
      if (goalHit !== null) {
        this.selectedId = goalHit;
        this.drag = { kind: 'pending', id: goalHit, start: w, isGoal: true };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      const hit = this.pickAgent(w);
      if (hit !== null) {
        this.selectedId = hit;
        // 先登记为 pending,移动超过阈值才真正开始拖拽,纯点击只做选中
        this.drag = { kind: 'pending', id: hit, start: w, isGoal: false };
        this.canvas.setPointerCapture(e.pointerId);
      } else {
        this.selectedId = null;
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const w = pos(e);
      this.hoverId = this.pickAgent(w);
      const goalHover = this.pickGoal(w);
      this.canvas.style.cursor =
        this.hoverId !== null || goalHover !== null ? 'pointer' : 'default';
      if (!this.drag) return;

      if (this.drag.kind === 'pending') {
        const movedPx = Math.hypot(
          (w.x - this.drag.start.x) * this.renderer.scale,
          (w.y - this.drag.start.y) * this.renderer.scale,
        );
        if (movedPx < DRAG_THRESHOLD_PX) return;
        if (this.drag.isGoal) {
          this.drag = { kind: 'goal', id: this.drag.id };
        } else {
          if (this.running) {
            // 运行中只能拖目标;拖身体自动暂停
            this.running = false;
            this.syncButtons();
          }
          this.drag = { kind: 'agent', id: this.drag.id };
          this.sim.dragAgent(this.drag.id, w);
          return;
        }
      }

      if (this.drag.kind === 'goal') this.sim.dragGoal(this.drag.id, w);
      else if (this.drag.kind === 'agent') this.sim.dragAgent(this.drag.id, w);
    });

    const release = (): void => {
      // pending(未移动的纯点击)不产生任何位移,仅保留选中
      this.drag = null;
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
  }

  private pickGoal(w: Vec): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    const HIT = 0.55; // 世界单位,目标叉的命中半径
    for (const a of this.sim.agents) {
      if (a.arrived) continue;
      const d = dist(w, a.goal);
      if (d < HIT && d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return best;
  }

  private pickAgent(w: Vec): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (const a of this.sim.agents) {
      const d = dist(w, a.pos) - a.radius;
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    return bestD <= 0.25 ? best : null;
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(parent.clientWidth, parent.clientHeight, dpr);
  }

  private loadPreset(index: number): void {
    this.presetIndex = index;
    this.presets = buildPresets(this.seed);
    const p = this.presets[index];
    this.sim = new Simulation(
      p.agents, p.rects, p.key, p.timeLimit, this.seed,
      Number(this.input.strength?.value ?? 70) / 100,
    );
    this.afterLoad(p);
  }

  private loadOverlapDemo(): void {
    const p = makeOverlapDemo();
    this.sim = new Simulation(p.agents, p.rects, p.key, p.timeLimit, this.seed);
    this.afterLoad(p);
  }

  private afterLoad(p: PresetDef): void {
    this.running = false;
    this.accumulator = 0;
    this.selectedId = null;
    this.el['preset-desc'].textContent =
      `${p.name} —— ${p.desc}(场景 ${WORLD_W}×${WORLD_H},代理 ${p.agents.length},矩形 ${p.rects.length},限时 ${p.timeLimit}s)`;
    this.el['time-limit-note'].textContent =
      p.stress
        ? '拥堵对照布局:不保证所有代理都能到达,停滞会如实统计'
        : `正常预设应在公布的 ${p.timeLimit}s 模拟时间内全部到达`;
    this.syncButtons();
  }

  private rebuild(): void {
    this.presets = buildPresets(this.seed);
    this.input.seedInput.value = String(this.seed);
    this.loadPreset(this.presetIndex);
  }

  private resetSim(): void {
    this.sim.reset();
    this.running = false;
    this.accumulator = 0;
    this.syncButtons();
  }

  private toggleRun(): void {
    if (this.sim.layoutBlocked || this.sim.finished) return;
    this.running = !this.running;
    this.syncButtons();
  }

  private syncButtons(): void {
    const btn = this.el['btn-play'] as HTMLButtonElement;
    btn.textContent = this.running ? '暂停' : '播放';
    btn.disabled = this.sim.layoutBlocked || this.sim.finished;
  }

  private loop(t: number): void {
    if (!this.lastFrame) this.lastFrame = t;
    const frameDt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;

    if (this.running && !this.sim.layoutBlocked && !this.sim.finished) {
      this.accumulator += frameDt;
      let guard = 0;
      while (this.accumulator >= DT && guard < 8) {
        this.sim.step();
        this.accumulator -= DT;
        guard++;
      }
      if (this.sim.finished) {
        this.running = false;
        this.syncButtons();
      }
    }

    this.renderer.draw(this.sim, this.selectedId, this.hoverId);
    this.updatePanels();
    requestAnimationFrame((tt) => this.loop(tt));
  }

  private updatePanels(): void {
    const s = this.sim.stats();
    const gapColor = s.minSurfaceGap < -1e-6 ? '#ff6b6b' : '#9be29b';
    this.el['stats'].innerHTML = `
      <div class="stat"><span>模拟时间</span><b>${s.time.toFixed(2)} s</b></div>
      <div class="stat"><span>到达 / 总数</span><b>${s.arrived} / ${s.total}</b></div>
      <div class="stat"><span>持续停滞(≥3s 低速)</span><b class="${s.stalled ? 'warn' : ''}">${s.stalled}</b></div>
      <div class="stat"><span>暂时等候</span><b>${s.waiting}</b></div>
      <div class="stat"><span>最小表面间距(全程)</span><b style="color:${gapColor}">${s.minSurfaceGap.toFixed(3)}</b></div>
      <div class="stat"><span>当前最小间距</span><b>${s.currentMinGap.toFixed(3)}</b></div>
      <div class="stat"><span>实测最大速度</span><b>${s.maxSpeedObserved.toFixed(3)}</b></div>
      <div class="stat"><span>避障强度</span><b>${Math.round(this.sim.avoidanceStrength * 100)}%</b></div>
    `;

    const banner = this.el['banner'];
    if (this.sim.layoutBlocked) {
      const lines = s.layoutOverlaps
        .map((o) =>
          o.kind === 'agent'
            ? `代理 ${o.aId} ↔ ${o.bId} 重叠 ${o.penetration.toFixed(2)}`
            : `代理 ${o.aId} 侵入矩形 ${o.bId} 深度 ${o.penetration.toFixed(2)}`,
        )
        .join('<br>');
      banner.className = 'banner show danger';
      banner.innerHTML = `布局存在重叠,已暂停该布局(未计入避障成功)。请拖动修正:<br>${lines}`;
    } else if (this.sim.finished) {
      const allArrived = s.arrived === s.total;
      banner.className = `banner show ${allArrived ? 'ok' : 'warn'}`;
      banner.innerHTML = allArrived
        ? `限时 ${this.sim.timeLimit}s 内全部 ${s.total} 个代理到达目标。`
        : `到达模拟时限:仅 ${s.arrived}/${s.total} 到达,其余按停滞/未到达如实报告,不伪报成功。`;
    } else {
      banner.className = 'banner';
      banner.textContent = '';
    }

    const panel = this.el['selected-panel'];
    if (this.selectedId === null) {
      panel.innerHTML = '<div class="muted">点击圆形角色查看详情;运行中可拖目标叉,暂停后可拖身体。</div>';
      return;
    }
    const a = this.sim.agents.find((x) => x.id === this.selectedId);
    if (!a) return;
    const neighbors = this.sim.neighborsOf(a.id);
    const nbText = neighbors.length
      ? neighbors
          .map((n) => `#${n.id}:${n.surfaceGap.toFixed(2)}`)
          .join('，')
      : '感知半径内无邻近角色';
    const status = a.arrived ? '已到达' : a.waiting ? '停滞等候' : '行进中';
    panel.innerHTML = `
      <div class="sel-title"><span class="dot" style="background:${a.spec.color}"></span>代理 #${a.id} <span class="muted">[${status}]</span></div>
      <div class="sel-grid">
        <span>位置</span><b>(${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)})</b>
        <span>目标</span><b>(${a.goal.x.toFixed(2)}, ${a.goal.y.toFixed(2)})</b>
        <span>实际速度</span><b>(${a.vel.x.toFixed(2)}, ${a.vel.y.toFixed(2)}) 模长 ${a.speed.toFixed(2)}</b>
        <span>目标方向</span><b>${(() => {
          const dx = a.goal.x - a.pos.x;
          const dy = a.goal.y - a.pos.y;
          const d = Math.hypot(dx, dy);
          return d < 1e-9 ? '—' : `(${ (dx / d).toFixed(2)}, ${(dy / d).toFixed(2)})`;
        })()}</b>
        <span>速度/加速度上限</span><b>${a.maxSpeed.toFixed(1)} / ${a.maxAccel.toFixed(1)}</b>
        <span>半径</span><b>${a.radius.toFixed(2)}</span>
      </div>
      <div class="sel-neighbors">邻近范围 ${NEIGHBOR_DIST} 单位:${nbText}</div>
    `;
  }
}

new App();
