import './style.css';
import { ClothSimulation } from './sim/cloth';
import { SimulationDriver } from './sim/driver';
import { SCENARIOS, getScenario, type Scenario } from './sim/scenarios';
import { ClothRenderer } from './render/scene';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** 按预设构造一份全新的模拟实例 (同一组初始条件) */
function createSim(scenario: Scenario, fixedDt: number): ClothSimulation {
  const sim = new ClothSimulation(
    structuredClone(scenario.config),
    fixedDt,
    { ...scenario.sphere },
  );
  sim.sphereActive = scenario.sphereActive;
  return sim;
}

class App {
  private scenario: Scenario = getScenario('hanging');
  private fixedDt = 1 / 120;
  private sim: ClothSimulation;
  private driver: SimulationDriver;
  private view: ClothRenderer;
  private metricsTimer = 0;

  constructor() {
    this.sim = createSim(this.scenario, this.fixedDt);
    this.driver = new SimulationDriver(this.sim, this.fixedDt);
    this.view = new ClothRenderer($('canvas-host'), this.sim);
    this.view.setScenario(this.scenario, this.sim);
    this.view.sync();

    this.buildScenarioButtons();
    this.buildPinGrid();
    this.bindControls();
    this.syncSphereControls();
    this.refreshPinGrid();
    this.updateStatus();

    const loop = (): void => {
      const wall = performance.now() / 1000;
      this.driver.frame(wall);
      this.view.sync();
      this.view.render();
      this.updateStatus();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---- 场景 --------------------------------------------------------------

  private buildScenarioButtons(): void {
    const host = $('scenario-btns');
    host.innerHTML = '';
    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.textContent = s.label;
      btn.dataset.id = s.id;
      btn.addEventListener('click', () => this.loadScenario(s.id));
      host.appendChild(btn);
    }
    this.highlightScenarioButton();
    $('scenario-desc').textContent = this.scenario.description;
  }

  private highlightScenarioButton(): void {
    document.querySelectorAll<HTMLButtonElement>('#scenario-btns button').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === this.scenario.id);
    });
  }

  private loadScenario(id: string): void {
    this.scenario = getScenario(id);
    this.sim = createSim(this.scenario, this.fixedDt);
    this.driver.replaceSim(this.sim);
    this.view.setScenario(this.scenario, this.sim);
    this.syncSphereControls();
    this.refreshPinGrid();
    $('scenario-desc').textContent = this.scenario.description;
    this.highlightScenarioButton();
    this.updateStatus();
  }

  /** 重置: 用同一预设、同一初始条件重建, 当前重力/刚度参数保留 */
  private reset(): void {
    const gravity = this.sim.cfg.gravity;
    const stiffness = this.sim.cfg.stiffness;
    const sphere = { ...this.sim.sphere };
    const sphereActive = this.sim.sphereActive;
    this.sim = createSim(this.scenario, this.fixedDt);
    this.sim.setGravity(gravity);
    this.sim.setStiffness(stiffness);
    this.sim.sphere = sphere;
    this.sim.sphereActive = sphereActive;
    this.driver.replaceSim(this.sim);
    this.view.setScenario(this.scenario, this.sim);
    this.refreshPinGrid();
    this.updateStatus();
  }

  // ---- 固定点网格 --------------------------------------------------------

  private buildPinGrid(): void {
    const host = $('pin-area');
    host.innerHTML = '';
    const { cols, rows } = this.sim;
    for (let r = 0; r < rows; r++) {
      const row = document.createElement('div');
      row.className = 'pin-row';
      const label = document.createElement('span');
      label.className = 'row-label';
      label.textContent = `r${r}`;
      const cells = document.createElement('div');
      cells.className = 'pin-cells';
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const btn = document.createElement('button');
        btn.className = 'pin-btn';
        btn.dataset.idx = String(idx);
        btn.textContent = `${c}`;
        btn.title = `顶点 (r${r}, c${c})`;
        btn.addEventListener('click', () => this.togglePin(idx));
        cells.appendChild(btn);
      }
      row.append(label, cells);
      host.appendChild(row);
    }
  }

  private refreshPinGrid(): void {
    const running = this.driver.state === 'running';
    const grid = $('pin-area');
    // 拓扑变化 (换场景/重置) 时重建
    if (grid.children.length !== this.sim.rows) {
      this.buildPinGrid();
    }
    const pinnedCount = this.sim.pinnedCount;
    grid.querySelectorAll<HTMLButtonElement>('.pin-btn').forEach((btn) => {
      const idx = Number(btn.dataset.idx);
      const isPinned = this.sim.pinned[idx];
      btn.classList.toggle('pinned', isPinned);
      btn.textContent = isPinned ? '●' : String(idx % this.sim.cols);
      // 运行中全部禁用; 暂停时只剩 1 个固定点则不允许取消它
      btn.disabled = running || (!isPinned ? false : pinnedCount <= 1);
    });
  }

  private togglePin(idx: number): void {
    if (this.driver.state === 'running') return;
    if (this.sim.pinned[idx] && this.sim.pinnedCount <= 1) return;
    this.sim.setPinned(idx, !this.sim.pinned[idx]);
    this.view.sync();
    this.refreshPinGrid();
    this.updateStatus();
  }

  // ---- 控件绑定 ----------------------------------------------------------

  private bindControls(): void {
    $('btn-play').addEventListener('click', () => this.driver.play());
    $('btn-pause').addEventListener('click', () => this.driver.pause());
    $('btn-step').addEventListener('click', () => {
      this.driver.stepOnce();
      this.view.sync();
      this.refreshPinGrid();
    });
    $('btn-reset').addEventListener('click', () => this.reset());

    $('chk-wire').addEventListener('change', (e) => {
      this.view.setWireframe((e.target as HTMLInputElement).checked);
    });

    $('btn-fps30').addEventListener('click', () => this.setFps(30));
    $('btn-fps60').addEventListener('click', () => this.setFps(60));

    $('sld-gravity').addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.sim.setGravity(v);
      $('val-gravity').textContent = v.toFixed(2);
    });

    $('sld-stiffness').addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.sim.setStiffness(v);
      $('val-stiffness').textContent = v.toFixed(2);
    });

    $('sld-step').addEventListener('input', (e) => {
      const hz = Number((e.target as HTMLInputElement).value);
      this.fixedDt = 1 / hz;
      this.driver.setFixedDt(this.fixedDt);
      $('val-step').textContent = String(hz);
    });

    $('chk-sphere').addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      this.sim.sphereActive = on;
      this.view.setSphereActive(on);
    });

    $('sld-radius').addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.sim.sphere.radius = v;
      this.view.setSphereRadius(v);
      $('val-radius').textContent = v.toFixed(2);
    });

    for (const axis of ['x', 'y', 'z'] as const) {
      $(`sld-s${axis}`).addEventListener('input', (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        this.sim.sphere[axis] = v;
        $(`val-s${axis}`).textContent = v.toFixed(2);
      });
    }

    // 键盘快捷键: 空格运行/暂停, S 单步, R 重置
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.driver.toggle();
      } else if (e.key === 's' || e.key === 'S') {
        this.driver.stepOnce();
      } else if (e.key === 'r' || e.key === 'R') {
        this.reset();
      }
    });

    // 暂停/运行切换后刷新固定点按钮可用性
    window.addEventListener('blur', () => this.refreshPinGrid());
  }

  private setFps(fps: 30 | 60): void {
    this.driver.setDisplayFps(fps);
    $('btn-fps30').classList.toggle('active', fps === 30);
    $('btn-fps60').classList.toggle('active', fps === 60);
  }

  private syncSphereControls(): void {
    const s = this.sim.sphere;
    const chk = $('chk-sphere') as HTMLInputElement;
    chk.checked = this.sim.sphereActive;
    this.view.setSphereActive(this.sim.sphereActive);
    const sldRadius = $('sld-radius') as HTMLInputElement;
    sldRadius.value = String(s.radius);
    $('val-radius').textContent = s.radius.toFixed(2);
    (['x', 'y', 'z'] as const).forEach((axis) => {
      ($(`sld-s${axis}`) as HTMLInputElement).value = String(s[axis]);
      $(`val-s${axis}`).textContent = s[axis].toFixed(2);
    });
    ($('sld-gravity') as HTMLInputElement).value = String(this.sim.cfg.gravity);
    $('val-gravity').textContent = this.sim.cfg.gravity.toFixed(2);
    ($('sld-stiffness') as HTMLInputElement).value = String(this.sim.cfg.stiffness);
    $('val-stiffness').textContent = this.sim.cfg.stiffness.toFixed(2);
  }

  // ---- 状态与指标 --------------------------------------------------------

  private updateStatus(): void {
    const running = this.driver.state === 'running';
    const badge = $('stat-state');
    badge.textContent = running ? '运行中' : '已暂停';
    badge.classList.toggle('running', running);
    $('stat-time').textContent = `${this.sim.simTime.toFixed(3)} s`;
    $('stat-dt').textContent = `${this.fixedDt.toFixed(5)} s (1/${Math.round(1 / this.fixedDt)})`;
    $('stat-fps').textContent = `${this.driver.displayFps} fps`;

    // 指标每 ~120ms 刷新一次, 减少 DOM 开销
    const now = performance.now();
    if (now - this.metricsTimer < 120) return;
    this.metricsTimer = now;
    const m = this.sim.metrics();
    $('m-pin').textContent = `${m.pinOffset.toExponential(2)} m`;
    $('m-strain').textContent = `${(m.maxEdgeStrain * 100).toFixed(2)} %`;
    $('m-edge').textContent = `${m.maxEdgeLength.toFixed(4)} m`;
    if (this.sim.sphereActive) {
      $('m-pen').textContent = `${m.maxPenetration.toExponential(2)} m / ${m.penetratingCount} 个`;
    } else {
      $('m-pen').textContent = '球未激活';
    }
  }
}

new App();
