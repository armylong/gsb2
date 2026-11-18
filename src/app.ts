/**
 * App：连接物理引擎、Canvas 渲染与 DOM 控件。
 *
 * 时间模型：
 * - 物理始终以 FIXED_DT 固定步长推进，requestAnimationFrame 只负责显示节奏；
 * - 30/60Hz 显示切换只限制渲染频率，累积器按真实流逝时间取步，模拟时间一致；
 * - 页面隐藏时停止累积，恢复后不补跑积压步。
 */
import { Vec2 } from 'planck';
import { ChainEngine } from './engine';
import { Renderer } from './renderer';
import {
  DEFAULT_PARAMS,
  FIXED_DT,
  PARAM_LIMITS,
  RECONNECT_THRESHOLD,
  SCENARIOS,
  SCENARIO_LABELS,
} from './config';
import type { ScenarioId, SimParams } from './types';

type PlayMode = 'running' | 'paused';
type DisplayRate = 30 | 60;

export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private engine: ChainEngine;
  private scenarioId: ScenarioId = 'short';
  private params: SimParams = { ...DEFAULT_PARAMS };

  private mode: PlayMode = 'running';
  private displayRate: DisplayRate = 60;
  private timeScale = 1;
  private selectedJoint: number | null = 0;

  private rafId = 0;
  private lastTimestamp: number | null = null;
  private frameToggle = 0;

  // DOM 引用
  private readonly el: Record<string, HTMLElement> = {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.engine = new ChainEngine(SCENARIOS[this.scenarioId], this.params);
    this.cacheElements();
    this.bindControls();
    this.bindPointer();
    this.bindVisibility();
    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();
    this.refreshScenarioUI();
    this.refreshHud();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ DOM 绑定

  private cacheElements(): void {
    const ids = [
      'btn-run', 'btn-pause', 'btn-step', 'btn-reset',
      'speed-1', 'speed-05', 'speed-025',
      'rate-30', 'rate-60',
      'scenario-select',
      'gravity', 'gravity-val',
      'limit-angle', 'limit-angle-val', 'limit-enabled',
      'weight-mass', 'weight-mass-val', 'weight-row',
      'adjacent-filter',
      'joint-select', 'btn-break', 'btn-restore',
      'hud-angle', 'hud-limit', 'hud-deviation', 'hud-status', 'hud-simtime', 'hud-steps',
      'toast',
    ];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) this.el[id] = node;
    }
  }

  private bindControls(): void {
    this.el['btn-run']?.addEventListener('click', () => this.setMode('running'));
    this.el['btn-pause']?.addEventListener('click', () => this.setMode('paused'));
    this.el['btn-step']?.addEventListener('click', () => this.singleStep());
    this.el['btn-reset']?.addEventListener('click', () => this.reset());

    this.el['speed-1']?.addEventListener('click', () => this.setSpeed(1));
    this.el['speed-05']?.addEventListener('click', () => this.setSpeed(0.5));
    this.el['speed-025']?.addEventListener('click', () => this.setSpeed(0.25));

    this.el['rate-30']?.addEventListener('click', () => this.setDisplayRate(30));
    this.el['rate-60']?.addEventListener('click', () => this.setDisplayRate(60));

    this.el['scenario-select']?.addEventListener('change', (e) => {
      this.scenarioId = (e.target as HTMLSelectElement).value as ScenarioId;
      this.reset();
    });

    this.el['gravity']?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.engine.setGravity(v);
      this.updateParamLabels();
    });
    this.el['limit-angle']?.addEventListener('input', () => this.applyLimitFromUI());
    this.el['limit-enabled']?.addEventListener('change', () => this.applyLimitFromUI());
    this.el['weight-mass']?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.engine.setWeightMass(v);
      this.updateParamLabels();
    });
    this.el['adjacent-filter']?.addEventListener('change', (e) => {
      this.engine.setAdjacentFilter((e.target as HTMLInputElement).checked);
    });

    this.el['joint-select']?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      this.selectedJoint = v === '' ? null : Number(v);
      this.refreshHud();
    });
    this.el['btn-break']?.addEventListener('click', () => this.breakSelected());
    this.el['btn-restore']?.addEventListener('click', () => this.restoreSelected());
  }

  private bindPointer(): void {
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => this.onPointerUp());
  }

  private bindVisibility(): void {
    document.addEventListener('visibilitychange', () => {
      // 隐藏与恢复都重置帧计时与累积器，回来后不补跑隐藏期间的步
      this.lastTimestamp = null;
      this.engine.resetAccumulator();
      if (document.hidden) {
        // 隐藏中松手也不会漏事件，确保拖拽约束被释放
        this.engine.endDrag();
      }
    });
  }

  // ------------------------------------------------------------ 交互处理

  private eventWorldPoint(e: PointerEvent | MouseEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return this.renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.eventWorldPoint(e);
    // 优先：点中关节圆点时做关节选择（运行/暂停均可）
    const jointIdx = this.engine.pickJoint(p);
    if (jointIdx !== null) {
      this.selectedJoint = jointIdx;
      (this.el['joint-select'] as HTMLSelectElement).value = String(jointIdx);
      this.refreshHud();
      return;
    }
    // 否则尝试在动态刚体上建立临时拖拽约束（运行与暂停均可建立；
    // 暂停期间物理不推进，恢复运行后该约束才开始施力）
    const ok = this.engine.beginDrag(p);
    if (ok) {
      this.canvas.setPointerCapture?.(e.pointerId);
      this.renderer.mouseWorld = p;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.eventWorldPoint(e);
    this.renderer.mouseWorld = p;
    if (!this.engine.isDragging()) return;
    this.engine.updateDrag(p);
    if (this.mode === 'paused') {
      // 暂停态拖拽：临时推进真实物理步，让 mouse joint 通过施力移动刚体，
      // 而不是直接改体位。松手后回到暂停态，HUD 步数如实反映这些推进。
      this.engine.stepOnce();
      this.refreshHud();
    }
  }

  private onPointerUp(): void {
    // 松手即销毁约束，链条不再受鼠标牵引
    this.engine.endDrag();
  }

  private breakSelected(): void {
    if (this.mode !== 'paused') {
      this.showToast('请先暂停再拆开关节');
      return;
    }
    if (this.selectedJoint === null) return;
    const rec = this.engine.joints[this.selectedJoint];
    if (!rec || rec.broken) return;
    this.engine.breakJoint(this.selectedJoint);
    this.showToast(`关节 J${this.selectedJoint} 已拆开，下游成为自由物体`);
    this.refreshHud();
  }

  private restoreSelected(): void {
    if (this.mode !== 'paused') {
      this.showToast('请先暂停再恢复关节');
      return;
    }
    if (this.selectedJoint === null) return;
    const rec = this.engine.joints[this.selectedJoint];
    if (!rec || !rec.broken) return;
    const deviation = this.engine.anchorDeviation(this.selectedJoint);
    const ok = this.engine.restoreJoint(this.selectedJoint);
    if (ok) {
      this.showToast(`关节 J${this.selectedJoint} 已在当前姿态恢复`);
    } else {
      this.showToast(
        `连接点距离 ${deviation.toFixed(2)}m > 阈值 ${RECONNECT_THRESHOLD}m，拒绝重连（不瞬移）`,
      );
    }
    this.refreshHud();
  }

  // ------------------------------------------------------------ 播放控制

  private setMode(mode: PlayMode): void {
    this.mode = mode;
    this.lastTimestamp = null;
    this.updateModeButtons();
  }

  private setSpeed(scale: number): void {
    this.timeScale = scale;
    document.querySelectorAll('[data-speed]').forEach((b) => {
      b.classList.toggle('active', Number((b as HTMLElement).dataset.speed) === scale);
    });
  }

  private setDisplayRate(rate: DisplayRate): void {
    this.displayRate = rate;
    this.el['rate-30']?.classList.toggle('active', rate === 30);
    this.el['rate-60']?.classList.toggle('active', rate === 60);
    this.frameToggle = 0;
  }

  private singleStep(): void {
    // 单步：只推进一个固定模拟步，不改变模式之外的任何状态
    this.setMode('paused');
    this.engine.stepOnce();
    this.refreshHud();
  }

  private reset(): void {
    // 重置：按当前样例与参数重建整个世界，恢复全部连接与初始位姿
    this.engine.endDrag();
    this.engine.dispose();
    const scenario = SCENARIOS[this.scenarioId];
    this.params = this.readParamsFromUI();
    this.engine = new ChainEngine(scenario, this.params);
    this.engine.resetAccumulator();
    this.selectedJoint = 0;
    this.mode = 'running';
    this.lastTimestamp = null;
    this.refreshScenarioUI();
    this.updateModeButtons();
    this.refreshHud();
  }

  // ------------------------------------------------------------ 主循环

  private loop(now: number): void {
    this.rafId = requestAnimationFrame(this.loop);

    if (this.lastTimestamp === null) {
      this.lastTimestamp = now;
    }
    const elapsed = Math.min((now - this.lastTimestamp) / 1000, 0.25);
    this.lastTimestamp = now;

    // 物理推进与显示节奏解耦：无论本帧是否渲染，运行模式都按真实时间取固定步
    if (this.mode === 'running') {
      this.engine.advance(elapsed * this.timeScale);
    }
    // 暂停时不调用 step，速度/位姿原样保留

    // 30Hz 显示节奏：隔帧跳过渲染（模拟时间推进不受影响）
    this.frameToggle ^= 1;
    if (this.displayRate === 30 && this.frameToggle === 1) {
      return;
    }

    this.renderer.render(this.engine, this.selectedJoint, this.mode === 'paused');
    this.refreshHud();
  }

  // ------------------------------------------------------------ UI 刷新

  private applyLimitFromUI(): void {
    const angle = Number((this.el['limit-angle'] as HTMLInputElement).value);
    const enabled = (this.el['limit-enabled'] as HTMLInputElement).checked;
    this.engine.setJointLimit(angle, enabled);
    this.updateParamLabels();
    this.refreshHud();
  }

  private readParamsFromUI(): SimParams {
    return {
      gravity: Number((this.el['gravity'] as HTMLInputElement).value),
      limitAngle: Number((this.el['limit-angle'] as HTMLInputElement).value),
      limitEnabled: (this.el['limit-enabled'] as HTMLInputElement).checked,
      weightMass: Number((this.el['weight-mass'] as HTMLInputElement).value),
      adjacentFilter: (this.el['adjacent-filter'] as HTMLInputElement).checked,
    };
  }

  private refreshScenarioUI(): void {
    const scenario = SCENARIOS[this.scenarioId];
    (this.el['scenario-select'] as HTMLSelectElement).value = this.scenarioId;
    if (this.el['weight-row']) {
      this.el['weight-row'].style.opacity = scenario.hasWeight ? '1' : '0.45';
      const w0 = this.el['weight-mass'] as HTMLInputElement | undefined;
      if (w0) w0.disabled = !scenario.hasWeight;
    }
    // 关节下拉
    const select = this.el['joint-select'] as HTMLSelectElement;
    select.innerHTML = '';
    this.engine.joints.forEach((rec) => {
      const opt = document.createElement('option');
      opt.value = String(rec.index);
      opt.textContent = `J${rec.index}${rec.isWeightJoint ? '（重物关节）' : ''}`;
      select.appendChild(opt);
    });
    select.value = String(this.selectedJoint ?? 0);

    // 滑块范围与当前值
    const g = this.el['gravity'] as HTMLInputElement;
    g.min = String(PARAM_LIMITS.gravity.min);
    g.max = String(PARAM_LIMITS.gravity.max);
    g.step = String(PARAM_LIMITS.gravity.step);
    g.value = String(this.params.gravity);

    const l = this.el['limit-angle'] as HTMLInputElement;
    l.min = String(PARAM_LIMITS.limitAngle.min);
    l.max = String(PARAM_LIMITS.limitAngle.max);
    l.step = String(PARAM_LIMITS.limitAngle.step);
    l.value = String(this.params.limitAngle);
    (this.el['limit-enabled'] as HTMLInputElement).checked = this.params.limitEnabled;

    const w = this.el['weight-mass'] as HTMLInputElement;
    w.min = String(PARAM_LIMITS.weightMass.min);
    w.max = String(PARAM_LIMITS.weightMass.max);
    w.step = String(PARAM_LIMITS.weightMass.step);
    w.value = String(this.params.weightMass);

    (this.el['adjacent-filter'] as HTMLInputElement).checked = this.params.adjacentFilter;
    this.updateParamLabels();
  }

  private updateParamLabels(): void {
    const g = Number((this.el['gravity'] as HTMLInputElement).value);
    const l = Number((this.el['limit-angle'] as HTMLInputElement).value);
    const w = Number((this.el['weight-mass'] as HTMLInputElement).value);
    if (this.el['gravity-val']) this.el['gravity-val'].textContent = `${g.toFixed(1)} m/s²`;
    if (this.el['limit-angle-val']) {
      this.el['limit-angle-val'].textContent = `±${((l * 180) / Math.PI).toFixed(0)}°`;
    }
    if (this.el['weight-mass-val']) this.el['weight-mass-val'].textContent = `${w.toFixed(1)} kg`;
  }

  private updateModeButtons(): void {
    this.el['btn-run']?.classList.toggle('active', this.mode === 'running');
    this.el['btn-pause']?.classList.toggle('active', this.mode === 'paused');
  }

  private refreshHud(): void {
    this.updateModeButtons();
    const simTime = this.engine.getSimTime();
    const steps = this.engine.getStepCount();
    if (this.el['hud-simtime']) {
      this.el['hud-simtime'].textContent = `${simTime.toFixed(3)} s`;
    }
    if (this.el['hud-steps']) {
      this.el['hud-steps'].textContent = `${steps} 步（每步 ${FIXED_DT.toFixed(3)}s）`;
    }

    if (this.selectedJoint === null) return;
    const r = this.engine.getJointReadout(this.selectedJoint);
    if (!r) return;
    const deg = (rad: number) => `${(((rad * 180) / Math.PI) % 360).toFixed(1)}°`;
    if (this.el['hud-angle']) {
      this.el['hud-angle'].textContent = r.broken
        ? `${deg(r.angle)}（断开，按当前姿态计算）`
        : deg(r.angle);
    }
    if (this.el['hud-limit']) {
      this.el['hud-limit'].textContent = r.limitEnabled
        ? `${deg(r.lower)} ~ ${deg(r.upper)}`
        : '未启用';
    }
    if (this.el['hud-deviation']) {
      this.el['hud-deviation'].textContent =
        `${(r.anchorDeviation * 1000).toFixed(1)} mm` +
        (r.broken ? `（重连阈值 ${(RECONNECT_THRESHOLD * 1000).toFixed(0)} mm）` : '');
    }
    if (this.el['hud-status']) {
      if (!r.broken) {
        this.el['hud-status'].textContent = '已连接';
        this.el['hud-status'].className = 'status ok';
      } else if (r.canReconnect) {
        this.el['hud-status'].textContent = '已拆开 · 距离满足，可恢复';
        this.el['hud-status'].className = 'status warn';
      } else {
        this.el['hud-status'].textContent = '已拆开 · 距离过远，拒绝重连';
        this.el['hud-status'].className = 'status bad';
      }
    }
  }

  private showToast(message: string): void {
    const toast = this.el['toast'];
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout((toast as any)._timer);
    (toast as any)._timer = window.setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // ------------------------------------------------------------ 测试/销毁辅助

  getEngine(): ChainEngine {
    return this.engine;
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.engine.dispose();
  }
}

export { SCENARIO_LABELS };
