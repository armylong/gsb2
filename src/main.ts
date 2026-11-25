/**
 * 页面控制器：把规则引擎接到 Canvas 与控件上。
 * 固定 60Hz 逻辑帧；暂停时单步每次推进一帧（含两个子步）。
 */
import { Engine, BODY_IDS, BODY_LABELS } from './model.js';
import { FRAME_DT, LATCH_BANDS, ROPE_SUM } from './geometry.js';
import { PRESETS } from './presets.js';
import { CANVAS_H, CANVAS_W, draw } from './render.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

class App {
  private engine: Engine;
  private ctx: CanvasRenderingContext2D;
  private running = false;
  private lastFrame = 0;
  private acc = 0;
  private rafId = 0;
  private stepCount = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>('stage');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    this.ctx = canvas.getContext('2d')!;
    this.engine = new Engine(PRESETS[3].weights); // 默认精确平衡台

    this.fillWeightOptions();
    this.bindControls();
    this.renderAll();
  }

  /** 配重选项：合并所有预设用到的值 + 常用自定义值，去重升序 */
  private fillWeightOptions(): void {
    const used = new Set<number>();
    for (const p of PRESETS) for (const id of BODY_IDS) used.add(p.weights[id]);
    [0.35, 0.4, 0.45, 0.6, 0.75, 0.8, 0.9, 1.0, 1.05, 1.1, 1.2, 1.4, 1.5, 1.6, 2.2].forEach((x) =>
      used.add(x),
    );
    const values = [...used].sort((a, b) => a - b);
    for (const id of BODY_IDS) {
      const select = $(<string>`w_${id}`) as HTMLSelectElement;
      select.innerHTML = values
        .map((v) => `<option value="${v}">${v.toFixed(2)} kg</option>`)
        .join('');
      select.value = String(this.engine.m[id]);
    }
  }

  // ---- 控件绑定 -----------------------------------------------------------

  private bindControls(): void {
    $('btnPlay').addEventListener('click', () => this.setRunning(true));
    $('btnPause').addEventListener('click', () => this.setRunning(false));
    $('btnStep').addEventListener('click', () => {
      this.setRunning(false);
      this.advanceOne();
    });
    $('btnReset').addEventListener('click', () => this.resetCurrent());

    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.textContent = preset.name;
      btn.title = `${preset.desc}\n预期：${preset.expected}`;
      btn.addEventListener('click', () => this.loadPreset(preset.id));
      $('presets').appendChild(btn);
    }

    for (const id of BODY_IDS) {
      const select = $(<string>`w_${id}`) as HTMLSelectElement;
      select.addEventListener('change', () => {
        this.engine.setWeight(id, Number(select.value));
        this.renderAll();
      });
    }

    for (const band of LATCH_BANDS) {
      $(<string>`latch_${band.id}`).addEventListener('click', () => {
        this.engine.toggleLatch(band.id);
        this.renderAll();
      });
    }

    // 空格：播放/暂停；方向键右：单步
    window.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLSelectElement) return;
      if (ev.code === 'Space') {
        ev.preventDefault();
        this.setRunning(!this.running);
      } else if (ev.code === 'ArrowRight') {
        ev.preventDefault();
        this.setRunning(false);
        this.advanceOne();
      }
    });
  }

  private loadPreset(id: string): void {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.setRunning(false);
    this.engine.reset(preset.weights);
    for (const latchId of preset.arm) this.engine.toggleLatch(latchId);
    for (const bodyId of BODY_IDS) {
      (<HTMLSelectElement>$(`w_${bodyId}`)).value = String(preset.weights[bodyId]);
    }
    this.stepCount = 0;
    $('presetDesc').textContent = preset.desc;
    $('presetExpect').textContent = `预期：${preset.expected}`;
    this.renderAll();
  }

  private resetCurrent(): void {
    this.setRunning(false);
    const weights = { ...this.engine.m };
    this.engine.reset(weights);
    this.stepCount = 0;
    $('presetDesc').textContent = '已用当前配重重置到初始摆位（h1=hL=h2=220，速度为 0）。';
    $('presetExpect').textContent = '';
    this.renderAll();
  }

  // ---- 仿真循环 -----------------------------------------------------------

  private setRunning(on: boolean): void {
    if (on === this.running) return;
    this.running = on;
    $('btnPlay').classList.toggle('active', on);
    $('btnPause').classList.toggle('active', !on);
    if (on) {
      this.lastFrame = performance.now();
      this.acc = 0;
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      cancelAnimationFrame(this.rafId);
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const elapsed = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.acc += elapsed;
    // 固定逻辑帧，避免刷新率差异影响规则结果
    let guard = 0;
    while (this.acc >= FRAME_DT && guard < 5) {
      this.advanceOne();
      this.acc -= FRAME_DT;
      guard++;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  private advanceOne(): void {
    this.engine.step(FRAME_DT);
    this.stepCount++;
    this.renderAll();
  }

  // ---- 渲染与数据面板 -----------------------------------------------------

  private renderAll(): void {
    const s = this.engine.snapshot();
    draw(this.ctx, s, this.engine.armedLatches);
    this.syncWeightSelects();
    this.renderReadouts(s);
    this.renderLatchButtons();
    this.renderLogs();
  }

  private syncWeightSelects(): void {
    for (const id of BODY_IDS) {
      const select = $(<string>`w_${id}`) as HTMLSelectElement;
      if (Number(select.value) !== this.engine.m[id]) select.value = String(this.engine.m[id]);
    }
  }

  private renderReadouts(s: ReturnType<Engine['snapshot']>): void {
    const rows = BODY_IDS.map((id) => {
      const contact = s.contacts[id];
      const lockText =
        id === 'lantern' && s.engagedLatch
          ? `卡榫:${s.engagedLatch === 'upper' ? '上' : '下'}`
          : contact === null
            ? '自由'
            : contact === -1
              ? '顶限位锁'
              : '底限位锁';
      return `<tr>
        <td>${BODY_LABELS[id]}</td>
        <td>${s.m[id].toFixed(2)}</td>
        <td>${s.h[id].toFixed(1)}</td>
        <td class="${Math.abs(s.v[id]) > 22 ? 'fast' : ''}">${s.v[id].toFixed(1)}</td>
        <td>${lockText}</td>
      </tr>`;
    }).join('');
    $('readouts').innerHTML = `
      <table>
        <thead><tr><th>体</th><th>配重 kg</th><th>高度 h (px)</th><th>速度 v (px/s)</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    const strandNames = ['锚-托架1', '托架1-FP1', 'FP2-灯', '灯-FP3', 'FP3-托架2', '托架2-锚'];
    const strandHtml = s.strands
      .map((len, i) => `<span class="strand">${strandNames[i]}: <b>${len.toFixed(1)}</b></span>`)
      .join('');
    $('strands').innerHTML = `
      <div class="strand-row">${strandHtml}</div>
      <div class="rope-sum">六段竖直绳段和（=2×高度和）：<b>${(2 * s.ropeSum).toFixed(1)}</b>
      ｜高度和 h1+hL+h2：<b class="${Math.abs(s.ropeSum - ROPE_SUM) > 1e-6 ? 'fast' : ''}">${s.ropeSum.toFixed(2)}</b> / 常量 ${ROPE_SUM}
      ｜绳张力 T：<b>${s.tension.toFixed(1)}</b>
      ｜逻辑帧：${this.stepCount} ｜仿真时间：${s.time.toFixed(2)}s</div>`;
  }

  private renderLatchButtons(): void {
    for (const band of LATCH_BANDS) {
      const btn = $(<string>`latch_${band.id}`) as HTMLButtonElement;
      const armed = this.engine.armedLatches.has(band.id);
      const engaged = this.engine.engagedLatch === band.id;
      btn.classList.toggle('armed', armed);
      btn.classList.toggle('engaged', engaged);
      btn.textContent = engaged
        ? `${band.label}卡榫：已合上（点击松开）`
        : armed
          ? `${band.label}卡榫：已扳下（点击松开）`
          : `${band.label}卡榫：松开（点击扳下）`;
    }
  }

  private renderLogs(): void {
    const checks = this.engine.checks
      .slice()
      .reverse()
      .map(
        (c) => `<tr class="check-${c.result}">
          <td>#${c.id}</td><td>${c.time.toFixed(2)}s</td>
          <td>${c.latch === 'upper' ? '上窗格' : '下窗格'}</td>
          <td><b>${c.result === 'locked' ? '卡住' : c.result === 'too-fast' ? '过快未卡' : '松开'}</b></td>
          <td>${c.hL.toFixed(1)}</td><td>${c.speed.toFixed(1)} / ${c.vMax}</td>
          <td class="note">${c.note}</td></tr>`,
      )
      .join('');
    $('checkLog').innerHTML = checks
      ? `<table><thead><tr><th>#</th><th>时刻</th><th>窗格</th><th>结果</th><th>灯高 h</th><th>|v|/阈值</th><th>说明</th></tr></thead><tbody>${checks}</tbody></table>`
      : '<p class="empty">暂无卡榫检查记录（扳下卡榫后，灯经过窗格时会在此留痕）。</p>';

    const events = this.engine.events
      .slice()
      .reverse()
      .slice(0, 40)
      .map((e) => `<li><span class="t">${e.time.toFixed(2)}s</span> ${e.text}</li>`)
      .join('');
    $('eventLog').innerHTML = events
      ? `<ul>${events}</ul>`
      : '<p class="empty">暂无机械事件。</p>';
  }
}

new App();
