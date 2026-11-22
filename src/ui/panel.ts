import { DEFAULT_PARAMS, type SimState, type TunableParams } from '../engine/types';
import type { CheckResult } from '../engine/selfcheck';
import type { DemoDef } from '../engine/demos';

interface SliderSpec {
  key: keyof TunableParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'moveSpeed', label: '移动速度', min: 80, max: 500, step: 5, unit: 'px/s' },
  { key: 'groundAccel', label: '地面加速度', min: 400, max: 5000, step: 50, unit: 'px/s²' },
  { key: 'groundDecel', label: '地面减速度', min: 400, max: 5000, step: 50, unit: 'px/s²' },
  { key: 'airAccel', label: '空中加速度', min: 200, max: 3000, step: 50, unit: 'px/s²' },
  { key: 'airDecel', label: '空中减速度', min: 100, max: 3000, step: 50, unit: 'px/s²' },
  { key: 'gravity', label: '重力', min: 400, max: 3000, step: 25, unit: 'px/s²' },
  { key: 'jumpSpeed', label: '跳跃强度', min: 240, max: 900, step: 10, unit: 'px/s' },
  { key: 'coyoteTime', label: '离地宽限(土狼)时间', min: 0, max: 0.3, step: 0.005, unit: 's' },
  { key: 'jumpBufferTime', label: '跳跃预输入时间', min: 0, max: 0.3, step: 0.005, unit: 's' },
];

export interface PanelCallbacks {
  onParamsChange: (params: TunableParams) => void;
  onResetParams: () => void;
  onPauseToggle: () => void;
  onStepOnce: () => void;
  onResetWorld: () => void;
  onDisplayFps: (fps: 30 | 60) => void;
  onDemo: (demo: DemoDef) => void;
  onSelfCheck: () => void;
}

export class Panel {
  readonly element: HTMLElement;
  private valueLabels = new Map<string, HTMLElement>();
  private readoutEl!: HTMLElement;
  private eventLogEl!: HTMLElement;
  private checkEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private inheritEl!: HTMLInputElement;
  private renderedEventCount = 0;

  constructor(
    private params: TunableParams,
    private demos: DemoDef[],
    private cb: PanelCallbacks,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'panel';
    this.element.innerHTML = this.template();
    this.bind();
  }

  private template(): string {
    const sliderHtml = SLIDERS.map((s) => {
      const v = this.params[s.key];
      return `
        <label class="slider-row">
          <span class="slider-label">${s.label}</span>
          <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}">
          <span class="slider-value" data-value="${s.key}">${v}${s.unit}</span>
        </label>`;
    }).join('');

    const demoHtml = this.demos
      .map((d) => `<button class="demo-btn" data-demo="${d.id}">${d.name}</button>`)
      .join('');

    return `
      <section class="card">
        <h2>手感参数</h2>
        ${sliderHtml}
        <label class="switch-row">
          <input type="checkbox" id="inherit-toggle" ${this.params.inheritPlatformVelocity ? 'checked' : ''}>
          <span>继承移动平台速度</span>
        </label>
        <p class="hint">开启：站在水平移动平台上起跳/移动时，起跳瞬间把平台速度<b>一次性</b>并入角色速度，之后平台继续运动不再叠加；关闭：起跳只取角色自身速度，平台从脚下滑走。垂直平台的带动（站立随动）始终生效，与此开关无关。</p>
        <button id="reset-params" class="secondary">恢复默认参数</button>
      </section>

      <section class="card">
        <h2>模拟控制</h2>
        <div class="btn-row">
          <button id="pause-btn">暂停</button>
          <button id="step-btn">单步</button>
          <button id="reset-btn" class="secondary">重置场地</button>
        </div>
        <div class="btn-row">
          <span class="seg-label">显示节奏</span>
          <button class="seg" data-fps="30">30 fps</button>
          <button class="seg active" data-fps="60">60 fps</button>
        </div>
        <p class="hint">物理恒为 60Hz 固定步长；这里只切换<b>渲染</b>节奏。暂停恢复不补算时间，单步时平台与角色同步推进一个步帧。</p>
      </section>

      <section class="card">
        <h2>固定输入演示</h2>
        <div class="btn-row demo-row">${demoHtml}</div>
        <p class="hint" id="demo-desc">演示与手动操作共用同一套移动规则，播放固定脚本输入并记录接触变化。</p>
      </section>

      <section class="card">
        <h2>实时读数</h2>
        <div id="readout" class="readout monospace"></div>
      </section>

      <section class="card">
        <h2>接触变化记录</h2>
        <div id="event-log" class="event-log monospace"></div>
      </section>

      <section class="card">
        <h2>自动化自检</h2>
        <button id="selfcheck-btn">运行全部检查</button>
        <div id="check-results" class="check-results"></div>
      </section>
    `;
  }

  private bind(): void {
    const root = this.element;
    root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((input) => {
      const key = input.dataset.key as keyof TunableParams;
      const spec = SLIDERS.find((s) => s.key === key)!;
      this.valueLabels.set(key, root.querySelector(`[data-value="${key}"]`)!);
      input.addEventListener('input', () => {
        const value = Number(input.value);
        (this.params[key] as number) = value;
        this.valueLabels.get(key)!.textContent = `${value}${spec.unit}`;
        this.cb.onParamsChange({ ...this.params });
      });
    });

    this.inheritEl = root.querySelector('#inherit-toggle')!;
    this.inheritEl.addEventListener('change', () => {
      this.params.inheritPlatformVelocity = this.inheritEl.checked;
      this.cb.onParamsChange({ ...this.params });
    });

    root.querySelector('#reset-params')!.addEventListener('click', () => {
      this.params = { ...DEFAULT_PARAMS };
      this.syncSliders();
      this.cb.onResetParams();
      this.cb.onParamsChange({ ...this.params });
    });

    this.pauseBtn = root.querySelector('#pause-btn')!;
    this.pauseBtn.addEventListener('click', () => this.cb.onPauseToggle());
    root.querySelector('#step-btn')!.addEventListener('click', () => this.cb.onStepOnce());
    root.querySelector('#reset-btn')!.addEventListener('click', () => this.cb.onResetWorld());

    root.querySelectorAll<HTMLButtonElement>('.seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.cb.onDisplayFps(Number(btn.dataset.fps) === 30 ? 30 : 60);
      });
    });

    root.querySelectorAll<HTMLButtonElement>('.demo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const demo = this.demos.find((d) => d.id === btn.dataset.demo)!;
        root.querySelector('#demo-desc')!.textContent = demo.description;
        this.cb.onDemo(demo);
      });
    });

    root.querySelector('#selfcheck-btn')!.addEventListener('click', () => this.cb.onSelfCheck());

    this.readoutEl = root.querySelector('#readout')!;
    this.eventLogEl = root.querySelector('#event-log')!;
    this.checkEl = root.querySelector('#check-results')!;
  }

  private syncSliders(): void {
    for (const spec of SLIDERS) {
      const input = this.element.querySelector<HTMLInputElement>(`input[data-key="${spec.key}"]`);
      if (input) input.value = String(this.params[spec.key]);
      this.valueLabels.get(spec.key)!.textContent = `${this.params[spec.key]}${spec.unit}`;
    }
    this.inheritEl.checked = this.params.inheritPlatformVelocity;
  }

  setPaused(paused: boolean): void {
    this.pauseBtn.textContent = paused ? '继续' : '暂停';
  }

  updateReadout(state: SimState, supportLabel: string | null): void {
    const p = state.player;
    const contactText = (Object.entries(p.contacts) as [string, boolean][])
      .filter(([, v]) => v)
      .map(([k]) => ({ left: '左', right: '右', up: '上', down: '下' })[k] as string)
      .join(' ') || '无';
    this.readoutEl.innerHTML = `
      <div>位置 x=<b>${p.x.toFixed(1)}</b> y=<b>${p.y.toFixed(1)}</b></div>
      <div>速度 vx=<b>${p.vx.toFixed(1)}</b> vy=<b>${p.vy.toFixed(1)}</b> px/s</div>
      <div>接地=<b>${p.grounded ? '是' : '否'}</b> 支撑=<b>${supportLabel ?? '无'}</b></div>
      <div>接触方向=<b>${contactText}</b></div>
      <div>碰撞框 x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} w=${p.w} h=${p.h}</div>
      <div>土狼计时=${p.coyoteTimer.toFixed(3)}s 缓冲计时=${p.jumpBufferTimer.toFixed(3)}s</div>
      <div>跳跃已消耗=${p.jumpConsumed ? '是' : '否'}</div>
    `;

    // 只增量渲染新事件，避免每帧重建 DOM；环形缓冲裁剪后整体重建
    const all = state.events;
    if (all.length < this.renderedEventCount) {
      this.eventLogEl.innerHTML = '';
      this.renderedEventCount = 0;
    }
    if (all.length > this.renderedEventCount) {
      const frag = document.createDocumentFragment();
      for (let i = this.renderedEventCount; i < all.length; i++) {
        const e = all[i];
        const row = document.createElement('div');
        row.className = `event-row event-${e.type}`;
        row.textContent = `[${e.t.toFixed(3)}s #${e.step}] ${e.detail}`;
        frag.appendChild(row);
      }
      this.eventLogEl.appendChild(frag);
      this.eventLogEl.scrollTop = this.eventLogEl.scrollHeight;
      this.renderedEventCount = all.length;
    }
  }

  clearEventLog(): void {
    this.eventLogEl.innerHTML = '';
    this.renderedEventCount = 0;
  }

  renderChecks(results: CheckResult[]): void {
    const passed = results.filter((r) => r.pass).length;
    this.checkEl.innerHTML =
      `<div class="check-summary ${passed === results.length ? 'ok' : 'fail'}">${passed}/${results.length} 通过</div>` +
      results
        .map(
          (r) => `
        <div class="check-row ${r.pass ? 'ok' : 'fail'}">
          <span class="check-mark">${r.pass ? '✓' : '✗'}</span>
          <div><div class="check-name">${r.name}</div><div class="check-detail">${r.detail}</div></div>
        </div>`,
        )
        .join('');
  }
}
