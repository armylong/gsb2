// main.js
// UI 接线：参数面板、播放控制、时间轴、统计显示、画布自适应。
// 所有仿真决策都在 controller/engine 中，本文件只负责事件与渲染。

import { PlaybackController } from './controller.js';
import { ParticleRenderer } from './renderer.js';
import { DEFAULT_PARAMS, MAX_PARTICLES, SIM_DT } from './engine.js';

// 参数预设：B 组故意与 A 组不同，打开页面即可比较节奏与外观差异。
const PARAMS_B = {
  emissionRate: 130,
  lifetime: 1.4,
  speed: 0.7,
  hue: 20,
  hueRange: 40,
  hueShift: -30,
  gravityScale: 1.4,
};

const SLIDER_DEFS = [
  { key: 'emissionRate', label: '发射频率', min: 1, max: 240, step: 1, unit: '/s' },
  { key: 'lifetime', label: '粒子寿命', min: 0.2, max: 6, step: 0.05, unit: 's' },
  { key: 'speed', label: '速度', min: 0.05, max: 1.2, step: 0.01, unit: '' },
  { key: 'hue', label: '基础色相', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'hueRange', label: '色相范围', min: 0, max: 180, step: 1, unit: '°' },
  { key: 'hueShift', label: '颜色变化', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'gravityScale', label: '重力倍率', min: 0, max: 3, step: 0.05, unit: 'x' },
];

const SEEK_MAX = 60;

const $ = (id) => document.getElementById(id);

class InspectorApp {
  constructor() {
    this.controller = new PlaybackController(DEFAULT_PARAMS, PARAMS_B);
    this.rendererA = new ParticleRenderer($('canvas-a'));
    this.rendererB = new ParticleRenderer($('canvas-b'));
    this.mode = 'A';
    this.lastFrameTime = performance.now();
    this.buildSliders('A', $('sliders-a'));
    this.buildSliders('B', $('sliders-b'));
    this.bindEvents();
    this.applyMode('A');
    this.syncParamControls('A');
    this.syncParamControls('B');
    this.refreshStats();
    requestAnimationFrame(this.frame);
  }

  /** 为一组参数生成滑块行。 */
  buildSliders(side, container) {
    for (const def of SLIDER_DEFS) {
      const row = document.createElement('div');
      row.className = 'slider-row';
      row.innerHTML = `
        <label for="${side}-${def.key}">${def.label}</label>
        <input id="${side}-${def.key}" type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
        <output id="${side}-${def.key}-out"></output>
      `;
      const input = row.querySelector('input');
      const output = row.querySelector('output');
      // input：拖动时只刷新读数；change：松手/键盘提交时才生效，
      // 生效即清空旧粒子并在当前时间点重建，避免新旧粒子混杂。
      input.addEventListener('input', () => {
        output.textContent = `${input.value}${def.unit}`;
      });
      input.addEventListener('change', () => {
        this.commitParams(side);
      });
      container.appendChild(row);
    }
  }

  /** 读取某组面板上的全部滑块值并提交给控制器。 */
  readParamsFromPanel(side) {
    const params = {};
    for (const def of SLIDER_DEFS) {
      params[def.key] = Number($(`${side}-${def.key}`).value);
    }
    return params;
  }

  commitParams(side) {
    const params = this.readParamsFromPanel(side);
    this.controller.setParams(side, params);
    this.updateSummary(side);
    this.refreshStats();
    this.refreshSeekUi();
  }

  resetParams(side) {
    const defaults = side === 'A' ? { ...DEFAULT_PARAMS } : { ...PARAMS_B };
    this.controller.setParams(side, defaults);
    this.syncParamControls(side);
    this.refreshStats();
    this.refreshSeekUi();
  }

  /** 把系统当前参数回填到滑块与读数。 */
  syncParamControls(side) {
    const system = side === 'A' ? this.controller.systemA : this.controller.systemB;
    for (const def of SLIDER_DEFS) {
      const input = $(`${side}-${def.key}`);
      const output = $(`${side}-${def.key}-out`);
      const value = system.params[def.key];
      input.value = value;
      output.textContent = `${value}${def.unit}`;
    }
    this.updateSummary(side);
  }

  updateSummary(side) {
    const system = side === 'A' ? this.controller.systemA : this.controller.systemB;
    const p = system.params;
    $(`summary-${side.toLowerCase()}`).textContent = JSON.stringify(
      {
        emissionRate: p.emissionRate,
        lifetime: p.lifetime,
        speed: p.speed,
        hue: p.hue,
        hueRange: p.hueRange,
        hueShift: p.hueShift,
        gravityScale: p.gravityScale,
      },
      null,
      2
    );
  }

  bindEvents() {
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-step').addEventListener('click', () => this.stepOnce());
    $('btn-restart').addEventListener('click', () => this.goToStart());

    const seek = $('seek');
    const seekNumber = $('seek-number');
    const doSeek = (value) => {
      const t = Math.min(SEEK_MAX, Math.max(0, Number(value) || 0));
      this.controller.seek(t);
      this.refreshSeekUi();
      this.refreshStats();
    };
    seek.addEventListener('change', () => doSeek(seek.value));
    seekNumber.addEventListener('change', () => doSeek(seekNumber.value));

    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener('change', (e) => this.applyMode(e.target.value));
    });

    document.querySelectorAll('.btn-reset').forEach((btn) => {
      btn.addEventListener('click', () => this.resetParams(btn.dataset.side));
    });

    window.addEventListener('resize', () => this.resizeRenderers());
    // ResizeObserver 覆盖面板/网格布局变化（如切换并排模式）。
    new ResizeObserver(() => this.resizeRenderers()).observe($('viewport'));

    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        this.stepOnce();
      } else if (e.code === 'Home') {
        e.preventDefault();
        this.goToStart();
      }
    });
  }

  applyMode(mode) {
    this.mode = mode;
    const viewport = $('viewport');
    viewport.classList.remove('mode-a', 'mode-b', 'mode-split');
    viewport.classList.add(`mode-${mode.toLowerCase()}`);
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
    // 布局变化后下一帧 resize 会被 ResizeObserver 捕获，这里立即处理一次。
    requestAnimationFrame(() => this.resizeRenderers());
  }

  resizeRenderers() {
    if (this.mode === 'A' || this.mode === 'split') this.rendererA.resize();
    if (this.mode === 'B' || this.mode === 'split') this.rendererB.resize();
  }

  togglePlay() {
    this.controller.toggle();
    this.refreshStats();
  }

  stepOnce() {
    this.controller.stepOnce();
    this.refreshSeekUi();
    this.refreshStats();
  }

  goToStart() {
    this.controller.goToStart();
    this.refreshSeekUi();
    this.refreshStats();
  }

  refreshSeekUi() {
    const t = this.controller.time;
    $('seek').value = Math.min(SEEK_MAX, t);
    $('seek-number').value = t.toFixed(2);
  }

  refreshStats() {
    const c = this.controller;
    $('stat-time').textContent = `${c.time.toFixed(3)} s`;
    $('stat-count-a').textContent =
      `${c.systemA.aliveCount} / ${MAX_PARTICLES}` +
      `（累计 ${c.systemA.totalEmitted}）`;
    $('stat-count-b').textContent =
      `${c.systemB.aliveCount} / ${MAX_PARTICLES}` +
      `（累计 ${c.systemB.totalEmitted}）`;
    $('stat-state').textContent = c.playing
      ? `播放中（每步 ${SIM_DT.toFixed(4)} s）`
      : '已暂停';
    $('btn-play').textContent = c.playing ? '⏸ 暂停' : '▶ 播放';
    this.refreshSeekUi();
  }

  frame = (now) => {
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.controller.update(dt);

    if (this.mode === 'A' || this.mode === 'split') {
      this.rendererA.draw(this.controller.systemA);
    }
    if (this.mode === 'B' || this.mode === 'split') {
      this.rendererB.draw(this.controller.systemB);
    }
    this.refreshStats();
    requestAnimationFrame(this.frame);
  };
}

new InspectorApp();
