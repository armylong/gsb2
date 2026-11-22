import './style.css';
import { Renderer, type BlendWeights } from './webgl/renderer';
import {
  CLIPS,
  applyCameraEdit,
  createConfig,
  createInitialState,
  step,
  type Clip,
  type SimConfig,
  type SimState,
} from './scene/sim';
import { LineChart, type Series } from './ui/line-chart';
import { TrialRunner } from './app/trial';
import type { FrameSample, TrialSummary } from './metrics/metrics';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

class App {
  private renderer: Renderer;
  private chart: LineChart;
  private runner: TrialRunner;
  private cfg: SimConfig;
  private state: SimState;
  private blend: BlendWeights = { cur: 0.35, hist: 0.65 };
  private playing = true;
  private speed = 1;
  private activeClip: Clip | null = null;
  private clipFrame = 0;
  private liveSamples: FrameSample[] = [];
  private readonly maxLive = 240;
  private lastTime = 0;
  private acc = 0;
  private readonly stepInterval = 1 / 30; // 30 simulation steps per second
  private summaries: TrialSummary[] = [];

  constructor() {
    const canvas = $<HTMLCanvasElement>('gl');
    this.renderer = new Renderer(canvas);
    this.chart = new LineChart($<HTMLCanvasElement>('chart'));
    this.chart.yLabel = '';
    const rect = $('canvasWrap').getBoundingClientRect();
    this.cfg = createConfig(Math.max(320, rect.width), Math.max(240, rect.height));
    this.state = createInitialState(this.cfg);
    this.runner = new TrialRunner(this.renderer);

    this.buildClipButtons();
    this.bindControls();
    this.bindDrag(canvas);
    this.observeResize();
    this.positionLabels();

    this.lastTime = performance.now();
    const loop = (t: number) => {
      this.tick(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---- sizing -------------------------------------------------------------

  private observeResize(): void {
    const wrap = $('canvasWrap');
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(320, Math.floor(rect.width * dpr));
      const h = Math.max(240, Math.floor(rect.height * dpr));
      this.cfg = createConfig(w, h);
      this.renderer.resize(w, h);
      this.chart.resize();
      this.positionLabels();
      this.drawOnce();
    });
    ro.observe(wrap);
    this.chart.resize();
  }

  private positionLabels(): void {
    const css = $('gl').getBoundingClientRect().width;
    const vwCss = Math.floor(css / 3);
    const labels = [$('lbl0'), $('lbl1'), $('lbl2')];
    labels.forEach((l, i) => {
      (l as HTMLElement).style.left = `${i * vwCss + 8}px`;
    });
  }

  // ---- controls -----------------------------------------------------------

  private buildClipButtons(): void {
    const host = $('clipBtns');
    CLIPS.forEach((clip, i) => {
      const b = document.createElement('button');
      b.textContent = clip.label;
      b.dataset.clip = String(i);
      b.addEventListener('click', () => this.loadClip(i));
      host.appendChild(b);
    });
    this.setClipDescription(null);
  }

  private setClipDescription(clip: Clip | null): void {
    $('clipDesc').textContent = clip
      ? clip.description
      : '未选择片段时为自由模式：相机匀速平移，可随时暂停、单步、瞬移或拖动。';
    document.querySelectorAll<HTMLButtonElement>('[data-clip]').forEach((b) => {
      b.classList.toggle('active', clip !== null && Number(b.dataset.clip) === CLIPS.indexOf(clip));
    });
  }

  private bindControls(): void {
    $('play').addEventListener('click', () => {
      this.playing = !this.playing;
      $('play').textContent = this.playing ? '暂停' : '播放';
    });
    $('step').addEventListener('click', () => {
      this.playing = false;
      $('play').textContent = '播放';
      this.advanceOne();
    });
    $('resetView').addEventListener('click', () => {
      this.activeClip = null;
      this.setClipDescription(null);
      this.state = createInitialState(this.cfg);
      this.clipFrame = 0;
      this.renderer.invalidateHistory();
      this.liveSamples = [];
      this.drawOnce();
    });
    $('jump').addEventListener('click', () => {
      // Discontinuous cut: history caches must be fully dropped.
      applyCameraEdit(this.state, 180, 0);
      this.renderer.invalidateHistory();
      this.drawOnce();
    });
    $('fgToggle').addEventListener('click', () => {
      this.state.fgVisible = this.state.fgVisible > 0.5 ? 0 : 1;
      // No global reset: only the uncovered pixels miss in the temporal pass,
      // which is exactly the local-new-frame behavior under test.
      this.drawOnce();
    });

    const speed = $<HTMLInputElement>('speed');
    speed.addEventListener('input', () => {
      this.speed = Number(speed.value);
      $('speedVal').textContent = `${this.speed.toFixed(1)}×`;
    });

    const curW = $<HTMLInputElement>('curW');
    const histW = $<HTMLInputElement>('histW');
    curW.addEventListener('input', () => {
      this.blend.cur = Number(curW.value);
      $('curWVal').textContent = this.blend.cur.toFixed(2);
      this.drawOnce();
    });
    histW.addEventListener('input', () => {
      this.blend.hist = Number(histW.value);
      $('histWVal').textContent = this.blend.hist.toFixed(2);
      this.drawOnce();
    });

    const repeats = $<HTMLInputElement>('repeats');
    repeats.addEventListener('input', () => {
      $('repeatsVal').textContent = repeats.value;
    });

    $('runTrial').addEventListener('click', () => this.runTrial());
    $('stopTrial').addEventListener('click', () => this.runner.stop());
  }

  private bindDrag(canvas: HTMLCanvasElement): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.runner.isRunning) return;
      dragging = true;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      lastY = e.clientY;
      this.playing = false;
      $('play').textContent = '播放';
      this.activeClip = null;
      this.setClipDescription(null);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Dragging the scene right means the camera origin moves left in world space.
      applyCameraEdit(this.state, -dx, dy);
      this.renderer.invalidateHistory();
      this.drawOnce();
    });
    const end = () => {
      dragging = false;
      canvas.classList.remove('dragging');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private loadClip(i: number): void {
    this.activeClip = CLIPS[i];
    this.clipFrame = 0;
    this.state = createInitialState(this.cfg);
    this.activeClip.init(this.state, this.cfg);
    this.renderer.invalidateHistory();
    this.liveSamples = [];
    this.setClipDescription(this.activeClip);
    this.drawOnce();
  }

  // ---- simulation ---------------------------------------------------------

  private advanceOne(): void {
    if (this.activeClip) {
      if (this.clipFrame >= this.activeClip.duration) return;
      this.activeClip.apply(this.state, this.cfg, this.clipFrame);
      this.clipFrame += 1;
    } else {
      step(this.state, this.cfg);
    }
    this.drawOnce(true);
  }

  private tick(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.playing && !this.runner.isRunning) {
      this.acc += dt * this.speed;
      let guard = 0;
      while (this.acc >= this.stepInterval && guard < 8) {
        this.advanceOne();
        this.acc -= this.stepInterval;
        guard++;
      }
    }
  }

  private drawOnce(record = true): void {
    this.renderer.render(this.state, this.blend);
    $('frameNo').textContent = String(this.state.frame);
    if (record) {
      const stats = this.renderer.regionStats();
      this.liveSamples.push({ f: this.state.frame, ...stats });
      if (this.liveSamples.length > this.maxLive) this.liveSamples.shift();
      this.updateLivePanel();
    }
  }

  private updateLivePanel(): void {
    const last = this.liveSamples[this.liveSamples.length - 1];
    if (!last) return;
    $('liveMean').textContent = last.meanAbsLuma.toFixed(2);
    $('liveMax').textContent = last.maxAbsLuma.toFixed(1);
    $('liveReuse').textContent = `${(last.reuseFraction * 100).toFixed(1)}%`;

    const series: Series[] = [
      { label: '平均|Δ亮度|', color: '#3987e5', points: this.liveSamples.map((s) => ({ x: s.f, y: s.meanAbsLuma })) },
      { label: '历史沿用%', color: '#d95926', points: this.liveSamples.map((s) => ({ x: s.f, y: s.reuseFraction * 100 })) },
    ];
    this.chart.setSeries(series);
  }

  // ---- trial measurement --------------------------------------------------

  private async runTrial(): Promise<void> {
    if (this.runner.isRunning) return;
    const repeats = Number($<HTMLInputElement>('repeats').value);
    this.summaries = [];
    this.renderSummaryTable();
    $('runTrial').setAttribute('disabled', '');
    this.playing = false;
    $('play').textContent = '播放';

    await this.runner.run(this.renderer.width, this.renderer.height, repeats, this.blend, {
      onProgress: (ci, rep, n, f, total) => {
        $('trialStatus').textContent =
          `片段 ${ci + 1}/${CLIPS.length} · 第 ${rep + 1}/${n} 次 · 帧 ${f + 1}/${total}`;
      },
      onClipDone: (clip, avg, summary) => {
        this.summaries.push(summary);
        this.renderSummaryTable();
        // Show the averaged curve of the most recently finished clip.
        const series: Series[] = [
          { label: '平均|Δ亮度|', color: '#3987e5', points: avg.map((s) => ({ x: s.f, y: s.meanAbsLuma })) },
          { label: '历史沿用%', color: '#d95926', points: avg.map((s) => ({ x: s.f, y: s.reuseFraction * 100 })) },
        ];
        this.chart.setSeries(series);
        this.liveSamples = avg.slice(-this.maxLive);
        void clip;
      },
      onAllDone: () => {
        $('runTrial').removeAttribute('disabled');
        $('trialStatus').textContent = '测量完成';
        // Leave the renderer showing a fresh free-mode frame after the trial.
        this.activeClip = null;
        this.setClipDescription(null);
        this.state = createInitialState(this.cfg);
        this.renderer.invalidateHistory();
        this.drawOnce();
      },
    });
  }

  private renderSummaryTable(): void {
    const body = $('summaryBody');
    if (this.summaries.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="muted">运行测量后填入</td></tr>';
      return;
    }
    body.innerHTML = '';
    for (const s of this.summaries) {
      const clip = CLIPS.find((c) => c.id === s.clipId);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${clip?.label ?? s.clipId}</td>
        <td>${s.flickerAmp.toFixed(2)}</td>
        <td>${s.flickerPeak.toFixed(1)}</td>
        <td>${(s.reuseMean * 100).toFixed(1)}%</td>
        <td>${s.recoveryFrames < 0 ? '未收敛' : s.recoveryFrames}</td>`;
      body.appendChild(tr);
    }
  }
}

new App();
