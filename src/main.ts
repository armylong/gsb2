import './styles.css';
import { KeyboardInput } from './engine/input';
import { createSim, stepSim } from './engine/simulation';
import { WORLD } from './engine/world';
import { DEFAULT_PARAMS, FIXED_DT, type InputState, type SimState, type TunableParams, type WorldPreset } from './engine/types';
import { DEMOS, type DemoDef, type InputSpan } from './engine/demos';
import { runAllChecks } from './engine/selfcheck';
import { Renderer } from './ui/renderer';
import { Panel } from './ui/panel';

function buildDemoInput(spans: InputSpan[], step: number): InputState {
  let move = 0;
  let jumpPressed = false;
  for (const s of spans) {
    if (step >= s.startStep && step < s.endStep) {
      move = s.move ?? 0;
      if (s.jumpAtStart && step === s.startStep) jumpPressed = true;
    }
  }
  return { move, jumpPressed };
}

class App {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private panel: Panel;
  private input: KeyboardInput;
  private params: TunableParams = { ...DEFAULT_PARAMS };
  private preset: WorldPreset = WORLD;
  private state: SimState;

  private paused = false;
  private displayFps: 30 | 60 = 60;
  private lastFrameTime = 0;
  private renderAccum = 0;

  private activeDemo: DemoDef | null = null;
  private demoTotalSteps = 0;

  constructor() {
    this.canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.renderer.configureDpr(WORLD.width, WORLD.height);

    this.state = createSim(this.preset, this.params);

    this.panel = new Panel(this.params, DEMOS, {
      onParamsChange: (p) => this.handleParams(p),
      onResetParams: () => this.softReset(),
      onPauseToggle: () => this.togglePause(),
      onStepOnce: () => this.singleStep(),
      onResetWorld: () => this.fullReset(),
      onDisplayFps: (fps) => this.setDisplayFps(fps),
      onDemo: (demo) => this.startDemo(demo),
      onSelfCheck: () => this.runSelfCheck(),
    });
    document.getElementById('panel-root')!.appendChild(this.panel.element);

    this.input = new KeyboardInput(window, () => this.handleBlur());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP' || e.code === 'Escape') this.togglePause();
      if (e.code === 'KeyR') this.fullReset();
    });

    this.renderFrame();
    requestAnimationFrame(this.loop);

    // 自动化验证入口：URL 带 ?selfcheck=1 时加载即跑全部检查，并把结果写入标题元素
    const params = new URLSearchParams(window.location.search);
    if (params.get('selfcheck') === '1') {
      const results = runAllChecks();
      const marker = document.createElement('div');
      marker.id = 'selfcheck-marker';
      marker.dataset.passed = String(results.filter((r) => r.pass).length);
      marker.dataset.total = String(results.length);
      marker.textContent = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}`).join(' | ');
      document.body.appendChild(marker);
      this.panel.renderChecks(results);
    }
    // 自动化验证入口：?demo=<id> 自动播放指定演示，结束后把事件序列写入标记元素
    const demoId = params.get('demo');
    if (demoId) {
      const demo = DEMOS.find((d) => d.id === demoId);
      if (demo) {
        this.startDemo(demo);
        this.demoFinishHook = () => {
          const marker = document.createElement('div');
          marker.id = 'demo-marker';
          marker.dataset.demo = demo.id;
          marker.dataset.events = this.state.events.map((e) => `${e.step}:${e.type}`).join(',');
          marker.textContent = marker.dataset.events;
          document.body.appendChild(marker);
        };
      }
    }
  }

  private demoFinishHook: (() => void) | null = null;

  private handleParams(p: TunableParams): void {
    this.params = p;
    this.state.params = { ...p };
  }

  /** 参数恢复默认：保留当前模拟位置，仅替换参数 */
  private softReset(): void {
    this.params = { ...DEFAULT_PARAMS };
    this.state.params = { ...DEFAULT_PARAMS };
  }

  private fullReset(): void {
    this.activeDemo = null;
    this.input.clear();
    this.preset = WORLD;
    this.state = createSim(this.preset, this.params);
    this.panel.clearEventLog();
    this.panel.setPaused(this.paused);
    this.renderFrame();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.panel.setPaused(this.paused);
    if (this.paused) this.input.clear();
    this.lastFrameTime = 0;
    this.renderAccum = 0;
    this.renderFrame();
  }

  /** 单步：无论是否暂停，平台与角色一起精确推进一个 1/60s 步帧 */
  private singleStep(): void {
    if (!this.paused) {
      this.paused = true;
      this.panel.setPaused(true);
    }
    this.advanceOneStep();
    this.renderFrame();
  }

  private setDisplayFps(fps: 30 | 60): void {
    this.displayFps = fps;
    this.lastFrameTime = 0;
    this.renderAccum = 0;
  }

  private handleBlur(): void {
    // 失焦自动暂停，杜绝残留按住状态；恢复时不会补算失焦期间的时间
    if (!this.paused) {
      this.paused = true;
      this.panel.setPaused(true);
    }
    this.lastFrameTime = 0;
    this.renderAccum = 0;
    this.renderFrame();
  }

  private startDemo(demo: DemoDef): void {
    this.activeDemo = demo;
    this.preset = demo.preset;
    this.paused = false;
    this.panel.setPaused(false);
    this.input.clear();
    this.state = createSim(this.preset, this.params);
    this.demoTotalSteps = Math.round(demo.durationSec / FIXED_DT);
    this.panel.clearEventLog();
    this.renderer.configureDpr(demo.preset.width, demo.preset.height);
    this.lastFrameTime = 0;
  }

  private runSelfCheck(): void {
    const results = runAllChecks();
    this.panel.renderChecks(results);
  }

  private currentInput(): InputState {
    if (this.activeDemo) {
      return buildDemoInput(this.activeDemo.spans, this.state.step + 1);
    }
    return this.input.consume();
  }

  private advanceOneStep(): void {
    stepSim(this.state, this.preset, this.currentInput());
    if (this.activeDemo && this.state.step >= this.demoTotalSteps) {
      this.activeDemo = null;
      if (this.demoFinishHook) {
        this.demoFinishHook();
        this.demoFinishHook = null;
      }
    }
  }

  /**
   * 主循环：物理用固定 1/60s 步长，累加器消费真实流逝时间；
   * 渲染按选定的 30/60fps 节流，暂停时累加器冻结——恢复后不补算。
   */
  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    if (this.lastFrameTime === 0) this.lastFrameTime = now;
    let elapsed = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    if (elapsed > 0.25) elapsed = 0.25; // 后台标签页等大间隔钳制，避免追帧风暴

    if (!this.paused) {
      // 固定步长推进；显示节奏只影响下面的渲染节流
      let budget = elapsed;
      let guard = 0;
      while (budget >= FIXED_DT && guard < 8) {
        this.advanceOneStep();
        budget -= FIXED_DT;
        guard++;
      }
      this.renderAccum += elapsed;
    }

    const frameInterval = 1 / this.displayFps;
    if (this.paused || this.renderAccum >= frameInterval) {
      this.renderAccum = 0;
      this.renderFrame();
    }
  };

  private renderFrame(): void {
    this.renderer.render(this.state, this.preset, this.displayFps, this.paused);
    const support = this.state.solids.find((s) => s.id === this.state.player.groundId);
    this.panel.updateReadout(this.state, support?.label ?? null);
  }
}

new App();
