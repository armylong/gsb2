// 试验场主入口：固定步长物理 + 可变帧率渲染，UI 控件只改配置不影响物理确定性
import './style.css';
import {
  DEFAULT_PARAMS,
  FIXED_DT,
  SCENARIOS,
  Simulation,
  SimParams,
  LogEvent,
  TrailPoint,
} from './physics/sim';
import { DEFAULT_CROSSWIND, DEFAULT_THERMAL, CrosswindConfig, ThermalConfig } from './physics/wind';
import { Renderer } from './render';

interface RunRecord {
  label: string;
  color: string;
  trail: TrailPoint[];
  endPos: { x: number; y: number };
}

class App {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private sim!: Simulation;
  private raf = 0;
  private lastFrame = 0;
  private accumulator = 0;
  private running = false;
  private fps = 60;
  private speedMul = 1;
  private frameInterval = 1000 / 60;
  private overlayTrails: RunRecord[] = [];
  private runCounter = 0;

  private params: SimParams = { ...DEFAULT_PARAMS };
  private thermal: ThermalConfig = { ...DEFAULT_THERMAL };
  private crosswind: CrosswindConfig = { ...DEFAULT_CROSSWIND };

  constructor() {
    this.canvas = document.getElementById('stage') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.bindStaticControls();
    this.buildParamControls();
    this.reset();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    window.addEventListener('resize', () => this.renderer.resize());
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  private bindStaticControls() {
    const scenarioSel = this.el<HTMLSelectElement>('scenario');
    SCENARIOS.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      scenarioSel.appendChild(opt);
    });
    scenarioSel.addEventListener('change', () => this.reset());

    this.el('btn-play').addEventListener('click', () => this.togglePlay());
    this.el('btn-reset').addEventListener('click', () => this.reset());
    this.el('btn-rerun').addEventListener('click', () => this.rerunWithOverlay());
    this.el('btn-clear-overlay').addEventListener('click', () => {
      this.overlayTrails = [];
      this.renderOverlayList();
    });

    this.el<HTMLSelectElement>('fps').addEventListener('change', (e) => {
      this.fps = Number((e.target as HTMLSelectElement).value);
      this.frameInterval = 1000 / this.fps;
      this.el('fps-readout').textContent = `${this.fps} FPS（物理固定 ${FIXED_DT}s/步）`;
    });
    this.el<HTMLSelectElement>('speed').addEventListener('change', (e) => {
      this.speedMul = Number((e.target as HTMLSelectElement).value);
    });

    for (const id of ['show-wind', 'show-trail', 'show-vectors']) {
      this.el(id).addEventListener('change', () => this.draw());
    }
  }

  /** 参数控件：数值修改后写入配置，点“重跑”生效，保证同一次运行内参数不变 */
  private buildParamControls() {
    const groups: { key: keyof SimParams; label: string; step: number }[] = [
      { key: 'alphaCriticalDeg', label: '失速临界迎角(°)', step: 1 },
      { key: 'stallHoldTime', label: '失速判定保持(s)', step: 0.05 },
      { key: 'recoveryAirspeed', label: '改出空速阈值(m/s)', step: 0.5 },
      { key: 'hardLandingSpeed', label: '硬着陆法向速度(m/s)', step: 0.5 },
      { key: 'pitchRate', label: '俯仰角速度(°/s)', step: 5 },
    ];
    const host = this.el('sim-params');
    host.innerHTML = groups
      .map(
        (g) => `
      <label class="param">
        <span>${g.label}</span>
        <input type="number" id="p-${g.key}" step="${g.step}" value="${this.params[g.key]}">
      </label>`,
      )
      .join('');
    groups.forEach((g) => {
      this.el(`p-${g.key}`).addEventListener('change', (e) => {
        (this.params[g.key] as number) = Number((e.target as HTMLInputElement).value);
      });
    });

    const windGroups: { id: string; label: string; step: number; get: () => number; set: (v: number) => void }[] = [
      { id: 't-strength', label: '暖气团强度(m/s)', step: 0.5, get: () => this.thermal.strength, set: (v) => (this.thermal.strength = v) },
      { id: 't-edge', label: '暖气团过渡带宽(m)', step: 1, get: () => this.thermal.edge, set: (v) => (this.thermal.edge = v) },
      { id: 'c-strength', label: '侧风强度(m/s, 负=迎风)', step: 0.5, get: () => this.crosswind.strength, set: (v) => (this.crosswind.strength = v) },
      { id: 'c-edge', label: '侧风过渡带宽(m)', step: 1, get: () => this.crosswind.edge, set: (v) => (this.crosswind.edge = v) },
    ];
    const whost = this.el('wind-params');
    whost.innerHTML = windGroups
      .map(
        (g) => `
      <label class="param">
        <span>${g.label}</span>
        <input type="number" id="${g.id}" step="${g.step}" value="${g.get()}">
      </label>`,
      )
      .join('');
    windGroups.forEach((g) => {
      this.el(g.id).addEventListener('change', (e) => {
        g.set(Number((e.target as HTMLInputElement).value));
      });
    });
  }

  private currentScenario() {
    const id = this.el<HTMLSelectElement>('scenario').value;
    return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  }

  private makeSim() {
    return new Simulation(this.currentScenario(), this.params, this.thermal, this.crosswind);
  }

  private reset() {
    this.running = false;
    this.accumulator = 0;
    this.sim = this.makeSim();
    this.el('btn-play').textContent = '播放';
    this.renderLog();
    this.draw();
  }

  /** 同一套参数重跑，并把上一条轨迹作为半透明叠加，便于比较落点 */
  private rerunWithOverlay() {
    const colors = ['#8ecae6', '#f4a261', '#e9c46a', '#2a9d8f', '#b5179e'];
    this.overlayTrails.push({
      label: `第${++this.runCounter}次 - ${this.currentScenario().label}`,
      color: colors[(this.runCounter - 1) % colors.length],
      trail: this.sim.trail.map((p) => ({ ...p })),
      endPos: { ...this.sim.pos },
    });
    if (this.overlayTrails.length > 6) this.overlayTrails.shift();
    this.renderOverlayList();
    this.reset();
    this.running = true;
    this.el('btn-play').textContent = '暂停';
  }

  private togglePlay() {
    this.running = !this.running;
    this.el('btn-play').textContent = this.running ? '暂停' : '播放';
    this.lastFrame = performance.now();
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.lastFrame) this.lastFrame = now;
    let elapsed = now - this.lastFrame;
    this.lastFrame = now;
    // 帧率限制：FPS 下拉框通过“跳帧”模拟低绘制帧率，物理步长不变
    if (elapsed < this.frameInterval - 0.5) return;
    // 切后台等造成的大间隔封顶，避免一次性追太多步
    elapsed = Math.min(elapsed, 100);
    if (this.running && !this.sim.stopped) {
      // 标准 accumulator：advance 消费掉整数个 FIXED_DT，把零头原样留到下一帧
      this.accumulator += (elapsed / 1000) * this.speedMul;
      this.accumulator = this.sim.advance(this.accumulator);
      this.renderLog();
      if (this.sim.stopped) {
        this.running = false;
        this.el('btn-play').textContent = '播放';
      }
    }
    this.draw();
  }

  private draw() {
    this.renderer.render(this.sim, {
      showWindGrid: (this.el('show-wind') as HTMLInputElement).checked,
      showTrail: (this.el('show-trail') as HTMLInputElement).checked,
      showVectors: (this.el('show-vectors') as HTMLInputElement).checked,
      overlayTrails: this.overlayTrails.map((r) => r.trail),
    });
  }

  private renderLog() {
    const box = this.el('log');
    const fmt = (e: LogEvent) => {
      const readings = Object.entries(e.readings)
        .map(([k, val]) => `${k}=${typeof val === 'number' ? val.toFixed(2) : val}`)
        .join(' ');
      return `<div class="log-line log-${e.type}"><b>[${e.t.toFixed(2)}s]</b> ${e.message}<span class="readings">${readings}</span></div>`;
    };
    box.innerHTML = this.sim.events.map(fmt).join('') || '<div class="log-empty">暂无事件：失速转换、接触、硬着陆、停住都会记录在此</div>';
    box.scrollTop = box.scrollHeight;
  }

  private renderOverlayList() {
    const host = this.el('overlay-list');
    host.innerHTML = this.overlayTrails
      .map(
        (r) =>
          `<div class="overlay-item"><span style="color:${r.color}">●</span> ${r.label} 落点=(${r.endPos.x.toFixed(1)}, ${r.endPos.y.toFixed(1)})</div>`,
      )
      .join('');
  }
}

new App();
