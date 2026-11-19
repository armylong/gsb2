import './styles.css';
import { Engine } from '../engine/engine';
import { FIELD } from '../engine/world';
import { DEMOS, type DemoEvent } from '../engine/demos';
import { SceneRenderer } from './renderer';
import { renderConfig } from './configPanel';
import { renderContext, renderHud, renderLogs, renderTree } from './panels';

const BASE_TICK_MS = 500; // 1× 速度下每个决策周期(0.5 模拟秒)对应 500ms 真实时间

class App {
  private engine = new Engine();
  private renderer: SceneRenderer;
  private playing = false;
  private speed = 1;
  private lastTickAt = 0;
  private pendingEvents: DemoEvent[] = [];
  private activeDemoId: string | null = null;

  constructor() {
    const canvas = document.querySelector('#scene') as HTMLCanvasElement;
    this.renderer = new SceneRenderer(canvas, this.engine);

    this.bindControls(canvas);
    this.renderAll();
    requestAnimationFrame(this.loop);
  }

  private bindControls(canvas: HTMLCanvasElement): void {
    const playBtn = document.querySelector('#btn-play') as HTMLButtonElement;
    playBtn.addEventListener('click', () => {
      this.playing = !this.playing;
      playBtn.textContent = this.playing ? '⏸ 暂停' : '▶ 播放';
      playBtn.classList.toggle('primary', !this.playing);
      this.lastTickAt = performance.now();
    });

    document.querySelector('#btn-step')!.addEventListener('click', () => {
      this.playing = false;
      playBtn.textContent = '▶ 播放';
      playBtn.classList.add('primary');
      this.advanceOnce(); // 单步: 无论是否暂停都只推进一个周期
    });

    (document.querySelector('#sel-speed') as HTMLSelectElement).addEventListener('change', (e) => {
      this.speed = Number((e.target as HTMLSelectElement).value);
      this.lastTickAt = performance.now();
    });

    document.querySelector('#btn-reset')!.addEventListener('click', () => {
      this.engine.reset();
      this.pendingEvents = [];
      this.activeDemoId = null;
      this.playing = false;
      playBtn.textContent = '▶ 播放';
      playBtn.classList.add('primary');
      this.renderAll();
    });

    document.querySelector('#btn-clear-log')!.addEventListener('click', () => {
      this.engine.clearLogs();
      this.renderAll();
    });

    this.bindCanvasDrag(canvas);
    this.bindDemos();

    const rules = document.querySelector('#tree-rules') as HTMLElement;
    rules.innerHTML =
      '规则: ① 持续动作 enter 只发生一次, 跨周期复用实例与进度; ' +
      '② 抢占时旧动作 abort 恰好一次并清掉自己的移动目标(owner token); ' +
      '③ 顺序被中断后游标归零, 重新进入从第一步移动重新开始、等待重新计时; ' +
      '④ 巡逻点编号只在等待"成功完成"时推进, 中断不推进; ' +
      '⑤ 模拟时间仅在周期推进时增加, 暂停时移动与等待计时全部冻结。';
  }

  private bindCanvasDrag(canvas: HTMLCanvasElement): void {
    let dragging = false;

    canvas.addEventListener('pointerdown', (e) => {
      if (this.renderer.isOnTarget(e.clientX, e.clientY)) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = this.renderer.toWorld(e.clientX, e.clientY);
      // 限制在有限场地内
      this.engine.world.target.pos = {
        x: Math.max(12, Math.min(FIELD.width - 12, p.x)),
        y: Math.max(12, Math.min(FIELD.height - 12, p.y)),
      };
      this.engine.world.target.exists = true;
      this.renderAll();
    });
    const end = (): void => {
      dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private bindDemos(): void {
    const host = document.querySelector('#demos') as HTMLElement;
    host.innerHTML = DEMOS.map(
      (d) => `
      <button class="btn demo-btn" data-demo="${d.id}">
        <b>${d.title}</b>
        <span class="demo-desc">${d.description}</span>
      </button>`,
    ).join('');
    host.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const demo = DEMOS.find((d) => d.id === btn.dataset.demo)!;
        this.pendingEvents = demo.build(this.engine);
        this.activeDemoId = demo.id;
        this.playing = true;
        const playBtn = document.querySelector('#btn-play') as HTMLButtonElement;
        playBtn.textContent = '⏸ 暂停';
        playBtn.classList.remove('primary');
        this.lastTickAt = performance.now();
        this.renderAll();
      });
    });
  }

  private loop = (now: number): void => {
    if (this.playing) {
      const interval = BASE_TICK_MS / this.speed;
      if (now - this.lastTickAt >= interval) {
        this.lastTickAt = now;
        this.advanceOnce();
      }
    }
    this.renderer.render();
    requestAnimationFrame(this.loop);
  };

  /** 推进一个决策周期: 先处理演示事件, 再 tick 引擎 */
  private advanceOnce(): void {
    const nextTick = this.engine.world.tick + 1;
    const due = this.pendingEvents.filter((ev) => ev.atTick === nextTick);
    for (const ev of due) ev.apply(this.engine);
    this.pendingEvents = this.pendingEvents.filter((ev) => ev.atTick !== nextTick);
    this.engine.tick();
    this.renderAll();
  }

  private renderAll(): void {
    this.renderer.render();
    renderHud(this.engine, document.querySelector('#hud')!);
    renderTree(this.engine, document.querySelector('#tree-panel')!);
    renderContext(this.engine, document.querySelector('#context-panel')!);
    renderLogs(this.engine, document.querySelector('#log-panel')!);
    renderConfig(this.engine, document.querySelector('#config-panel')!, () => this.renderAll());
    // 演示按钮高亮
    document.querySelectorAll<HTMLElement>('.demo-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.demo === this.activeDemoId);
    });
  }
}

new App();
