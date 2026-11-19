/**
 * 应用主控制器：样例生成、简化、误差计算、交互与 UI 状态机。
 *
 * 异步一致性约定：
 * - 每次“切换样例 / 执行简化”都会生成新的 runToken；
 *   异步计算（简化 + BVH 距离）完成后若 token 已过期则直接丢弃，
 *   绝不让旧结果被标记成新结果；
 * - 计算进行中显示 busy 遮罩并禁用触发按钮；
 * - 每次新计算开始时清理旧的点击检查标记。
 */
import * as THREE from 'three';
import {
  SAMPLE_BUILDERS,
  SAMPLE_DESCRIPTIONS,
  SampleId,
} from './lib/meshGenerate';
import {
  BoundaryInfo,
  MeshData,
  cloneMesh,
  computeBoundary,
  triangleCount,
  vertexCount,
} from './lib/meshTypes';
import {
  SimplifyResult,
  ensureSimplifierReady,
  simplifyMesh,
} from './lib/simplify';
import {
  ErrorMetrics,
  MeshBVH,
  buildBVH,
  buildDistanceColors,
  colormap,
  computeSampledError,
  nearestPointOnOriginal,
} from './lib/errorMetrics';
import { MeshViewer, ViewMode } from './lib/viewer';
import { InspectionMarks } from './lib/inspection';
import { renderTrend, TrendRow } from './lib/trendChart';
import { downloadOBJ } from './lib/objIO';

const RATIO_MIN = 0.25;
const RATIO_MAX = 0.9;
const TREND_RATIOS = [0.9, 0.75, 0.5, 0.35, 0.25];

interface ActiveState {
  sampleId: SampleId;
  original: MeshData;
  originalBoundary: BoundaryInfo;
  originalBVH: MeshBVH;
  /** 当前展示的“结果”网格：不简化时等于原网格的拷贝 */
  result: MeshData;
  metrics: ErrorMetrics | null;
  simplify: SimplifyResult | null;
  isReference: boolean;
  lockBorder: boolean;
  ratio: number;
}

class App {
  private viewer!: MeshViewer;
  private marks!: InspectionMarks;
  private state: ActiveState | null = null;
  private runToken = 0;
  private trendToken = 0;
  private busyCounter = 0;

  private readonly el = {
    sampleButtons: document.getElementById('sample-buttons')!,
    sampleDescription: document.getElementById('sample-description')!,
    originalStats: document.getElementById('original-stats')!,
    boundaryStats: document.getElementById('boundary-stats')!,
    resetButton: document.getElementById('reset-button')!,
    ratioSlider: document.getElementById('ratio-slider') as HTMLInputElement,
    ratioOutput: document.getElementById('ratio-output')!,
    lockBorder: document.getElementById('lock-border') as HTMLInputElement,
    simplifyButton: document.getElementById('simplify-button') as HTMLButtonElement,
    simplifyStatus: document.getElementById('simplify-status')!,
    modeSplit: document.getElementById('mode-split')!,
    modeOverlay: document.getElementById('mode-overlay')!,
    wireframe: document.getElementById('wireframe-toggle') as HTMLInputElement,
    metricMax: document.getElementById('metric-max')!,
    metricRms: document.getElementById('metric-rms')!,
    metricMean: document.getElementById('metric-mean')!,
    metricCount: document.getElementById('metric-count')!,
    rangeSlider: document.getElementById('range-slider') as HTMLInputElement,
    rangeOutput: document.getElementById('range-output')!,
    colorbar: document.getElementById('colorbar') as HTMLCanvasElement,
    colorbarMax: document.getElementById('colorbar-max')!,
    inspection: document.getElementById('inspection-readout')!,
    clearInspection: document.getElementById('clear-inspection')!,
    trend: document.getElementById('trend-container')!,
    exportButton: document.getElementById('export-button') as HTMLButtonElement,
    busy: document.getElementById('busy-overlay')!,
    busyDetail: document.getElementById('busy-detail')!,
    labelLeft: document.getElementById('viewport-label-left')!,
    labelRight: document.getElementById('viewport-label-right')!,
  };

  async start(): Promise<void> {
    this.viewer = new MeshViewer(document.getElementById('viewer-container')!, {
      viewMode: 'split',
      wireframe: false,
      distanceColors: null,
      colorRange: 1,
    });
    this.marks = new InspectionMarks(this.viewer.sceneRoot);
    this.bindEvents();
    this.buildSampleButtons();
    await this.withBusy('初始化简化器 (WebAssembly)', () => ensureSimplifierReady());
    await this.loadSample('sphere');
  }

  private buildSampleButtons(): void {
    for (const [id, def] of Object.entries(SAMPLE_BUILDERS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sample';
      button.dataset.sample = id;
      button.textContent = def.label;
      button.addEventListener('click', () => this.loadSample(id as SampleId));
      this.el.sampleButtons.appendChild(button);
    }
  }

  private bindEvents(): void {
    this.el.ratioSlider.addEventListener('input', () => {
      this.el.ratioOutput.textContent = `${this.el.ratioSlider.value}%`;
    });
    this.el.lockBorder.addEventListener('change', () => {
      if (!this.state) return;
      this.state.lockBorder = this.el.lockBorder.checked;
      // 边界锁定只对简化结果有意义：参照状态下只刷新趋势，否则重新执行当前简化
      if (this.state.isReference) {
        void this.updateTrend();
      } else {
        void this.runSimplify();
      }
    });
    this.el.simplifyButton.addEventListener('click', () => this.runSimplify());
    this.el.resetButton.addEventListener('click', () => this.restoreReference());

    this.el.modeSplit.addEventListener('click', () => this.setViewMode('split'));
    this.el.modeOverlay.addEventListener('click', () => this.setViewMode('overlay'));
    this.el.wireframe.addEventListener('change', () => {
      this.viewer.setState({ wireframe: this.el.wireframe.checked });
    });

    this.el.rangeSlider.addEventListener('input', () => this.applyColorRange());
    this.el.clearInspection.addEventListener('click', () => this.clearInspection());
    this.el.exportButton.addEventListener('click', () => this.exportCurrent());

    // 点击拾取：区分拖拽（轨道控制）与点击
    let downX = 0;
    let downY = 0;
    const canvas = this.viewer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    canvas.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 5) return; // 视为轨道拖拽，不拾取
      this.handlePick(e.clientX, e.clientY);
    });
  }

  private setViewMode(mode: ViewMode): void {
    this.viewer.setState({ viewMode: mode });
    this.el.modeSplit.classList.toggle('active', mode === 'split');
    this.el.modeOverlay.classList.toggle('active', mode === 'overlay');
    const split = mode === 'split';
    this.el.labelLeft.classList.toggle('hidden', !split);
    this.el.labelRight.classList.toggle('hidden', !split);
  }

  private setBusy(on: boolean, detail = ''): void {
    this.busyCounter += on ? 1 : -1;
    if (this.busyCounter < 0) this.busyCounter = 0;
    this.el.busy.classList.toggle('hidden', this.busyCounter === 0);
    if (detail) this.el.busyDetail.textContent = detail;
    this.el.simplifyButton.disabled = this.busyCounter > 0;
  }

  /**
   * 作用域式 busy：无论 task 正常返回、抛错还是因 token 过期提前退出，
   * 进入时 +1、退出时必定 -1，杜绝遮罩计数泄漏导致界面永久卡住。
   */
  private async withBusy<T>(detail: string, task: () => Promise<T>): Promise<T> {
    this.setBusy(true, detail);
    try {
      return await task();
    } finally {
      this.setBusy(false);
    }
  }

  private async loadSample(id: SampleId): Promise<void> {
    const token = ++this.runToken;
    this.trendToken++; // 使任何在途的旧趋势任务失效
    this.clearInspection();
    try {
      const original = await this.withBusy(`生成样例：${SAMPLE_BUILDERS[id].label}`, async () => {
        await this.nextFrame(); // 让遮罩先渲染一帧
        const built = SAMPLE_BUILDERS[id].build();
        if (triangleCount(built) > 12000) {
          throw new Error('内部错误：生成的网格超过 12000 面上限');
        }
        return built;
      });
      if (token !== this.runToken) return;

      const originalBoundary = computeBoundary(original);
      const originalBVH = await this.withBusy('构建原始网格 BVH', () =>
        new Promise<MeshBVH>((resolve) => setTimeout(() => resolve(buildBVH(original)), 0)),
      );
      if (token !== this.runToken) return;

      this.state = {
        sampleId: id,
        original,
        originalBoundary,
        originalBVH,
        result: cloneMesh(original),
        metrics: null,
        simplify: null,
        isReference: true,
        lockBorder: this.el.lockBorder.checked,
        ratio: 1,
      };

      this.viewer.setOriginal(original);
      this.viewer.setSimplified(cloneMesh(original), null);
      this.updateSampleUI();
      this.el.simplifyStatus.classList.remove('visible', 'ok', 'warn');
      await this.recomputeError(token, '零误差参照计算');
      if (token === this.runToken) void this.updateTrend();
    } catch (err) {
      this.showFatal(err);
    }
  }

  /** 恢复原状态：结果网格还原为原始网格，读数走同一采样管线得到零误差参照。 */
  private async restoreReference(): Promise<void> {
    if (!this.state) return;
    const token = ++this.runToken;
    this.clearInspection();
    this.state.result = cloneMesh(this.state.original);
    this.state.simplify = null;
    this.state.isReference = true;
    this.state.ratio = 1;
    this.viewer.setSimplified(cloneMesh(this.state.original), null);
    this.el.simplifyStatus.classList.remove('visible', 'ok', 'warn');
    await this.recomputeError(token, '恢复原状态并计算参照读数');
  }

  private async runSimplify(): Promise<void> {
    if (!this.state) return;
    const ratio = Number(this.el.ratioSlider.value) / 100;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) return;
    const token = ++this.runToken;
    const lockBorder = this.el.lockBorder.checked;
    this.clearInspection();
    // 简化是 CPU 同步调用，放到下一个宏任务让遮罩先绘制
    const result = await this.withBusy(
      `meshoptimizer 简化（目标保留 ${Math.round(ratio * 100)}%）`,
      () =>
        new Promise<SimplifyResult>((resolve) =>
          setTimeout(() => resolve(simplifyMesh(this.state!.original, { ratio, lockBorder })), 0),
        ),
    );
    if (token !== this.runToken) return;

    this.state.result = result.mesh;
    this.state.simplify = result;
    this.state.isReference = false;
    this.state.ratio = ratio;
    this.state.lockBorder = lockBorder;
    this.viewer.setSimplified(result.mesh, null);
    this.updateSimplifyStatus(result, ratio);
    await this.recomputeError(token, 'BVH 距离采样与误差计算');
  }

  /** 用固定采样规则重新计算当前结果相对原始网格的距离误差。 */
  private async recomputeError(token: number, detail: string): Promise<void> {
    if (!this.state) return;
    const metrics = await this.withBusy(detail, () =>
      new Promise<ErrorMetrics>((resolve) =>
        setTimeout(() => resolve(computeSampledError(this.state!.result, this.state!.originalBVH)), 0),
      ),
    );
    if (token !== this.runToken) return; // 旧结果，丢弃
    this.state.metrics = metrics;
    this.el.rangeSlider.disabled = false;
    this.el.rangeSlider.value = '100';
    this.updateMetricUI();
    this.updateColors();
  }
  private updateColors(): void {
    if (!this.state?.metrics) return;
    const range = this.currentRangeValue();
    const colors = buildDistanceColors(this.state.result, this.state.metrics, range);
    this.viewer.setSimplified(this.state.result, colors);
    this.drawColorbar(range);
  }

  private currentRangeValue(): number {
    // 滑块 10–100% 映射到 [0.1·max, max]；不简化（max=0）时用 1
    if (!this.state?.metrics || this.state.metrics.max === 0) return 1;
    const pct = Number(this.el.rangeSlider.value) / 100;
    return Math.max(1e-9, this.state.metrics.max * Math.max(0.1, pct));
  }

  private applyColorRange(): void {
    const range = this.currentRangeValue();
    this.el.rangeOutput.textContent = range.toExponential(3);
    this.updateColors();
  }

  private drawColorbar(range: number): void {
    const canvas = this.el.colorbar;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const color = new THREE.Color();
    for (let x = 0; x < w; x++) {
      colormap(x / (w - 1), color);
      ctx.fillStyle = `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`;
      ctx.fillRect(x, 0, 1, h);
    }
    this.el.rangeOutput.textContent = range.toExponential(3);
    this.el.colorbarMax.textContent = range.toExponential(3);
  }

  private updateSampleUI(): void {
    if (!this.state) return;
    const { original, originalBoundary, sampleId } = this.state;
    document.querySelectorAll<HTMLButtonElement>('button.sample').forEach((b) => {
      b.classList.toggle('active', b.dataset.sample === sampleId);
    });
    this.el.sampleDescription.textContent = SAMPLE_DESCRIPTIONS[sampleId];
    this.el.originalStats.innerHTML = `
      <div class="stat-cell"><div class="k">原始顶点数</div><div class="v">${vertexCount(original).toLocaleString()}</div></div>
      <div class="stat-cell"><div class="k">原始面数</div><div class="v">${triangleCount(original).toLocaleString()}</div></div>`;
    this.el.boundaryStats.innerHTML = `
      <strong>边界</strong>：${originalBoundary.loopCount} 条回路 ·
      ${originalBoundary.edgeCount} 条边界边 ·
      ${originalBoundary.vertexCount} 个边界顶点
      ${originalBoundary.loopCount === 0 ? '（闭合网格，无边界）' : ''}`;
  }

  private updateSimplifyStatus(result: SimplifyResult, ratio: number): void {
    const box = this.el.simplifyStatus;
    box.classList.add('visible');
    box.classList.toggle('ok', result.reached);
    box.classList.toggle('warn', !result.reached);
    const targetLine = `目标面数 ${result.targetTriangles.toLocaleString()}（${Math.round(ratio * 100)}%）`;
    const actualLine = `实际面数 <strong>${result.actualTriangles.toLocaleString()}</strong>（${((result.actualTriangles / result.sourceTriangles) * 100).toFixed(1)}%）`;
    const reachLine = result.reached
      ? '✅ 达到目标面数（±1 面舍入容差）'
      : `⚠️ 受拓扑约束未能达到目标：简化器在 ${result.actualTriangles.toLocaleString()} 面时已无法继续折叠，未复制任何原网格面冒充结果`;
    const borderLine = result.lockBorder
      ? '🔒 LockBorder 开启：保留的边界顶点偏移为 0（容差 0），仅保护网格边界，不含材质接缝'
      : '边界未锁定：边界顶点可随折叠移动';
    box.innerHTML = [targetLine, actualLine, reachLine, borderLine]
      .map((l) => `<div class="line"><span>${l}</span></div>`)
      .join('');
  }

  private updateMetricUI(): void {
    if (!this.state?.metrics) return;
    const m = this.state.metrics;
    this.el.metricMax.textContent = m.max.toExponential(4);
    this.el.metricRms.textContent = m.rms.toExponential(4);
    this.el.metricMean.textContent = m.mean.toExponential(4);
    this.el.metricCount.textContent = m.sampleCount.toLocaleString();
  }

  private handlePick(clientX: number, clientY: number): void {
    if (!this.state || this.busyCounter > 0) return;
    const hit = this.viewer.pickSimplified(clientX, clientY);
    if (!hit) {
      // 空背景：不生成检查点（保留现有标记，直到下一次有效点击或重新计算）
      return;
    }
    const nearest = nearestPointOnOriginal(hit.point, this.state.originalBVH);
    if (!nearest) return;
    const mark = this.marks.place(hit.point, nearest.point, nearest.distance, nearest.faceIndex);
    this.el.inspection.classList.add('active');
    this.el.inspection.classList.remove('muted');
    this.el.inspection.innerHTML = `
      <div>命中面索引：<strong>${hit.faceIndex ?? -1}</strong></div>
      <div>命中点：${fmtVec(mark.hitPoint)}</div>
      <div>原表面最近点（面 ${mark.faceIndex}）：${fmtVec(mark.nearestPoint)}</div>
      <div>连线距离：<strong style="color:#ffe08a">${mark.distance.toExponential(4)}</strong></div>`;
  }

  private clearInspection(): void {
    this.marks?.clear();
    if (this.el) {
      this.el.inspection.classList.remove('active');
      this.el.inspection.classList.add('muted');
      this.el.inspection.textContent = '尚无检查点';
    }
  }

  private exportCurrent(): void {
    if (!this.state) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${this.state.sampleId}_${this.state.isReference ? 'reference' : `keep${Math.round(this.state.ratio * 100)}`}_${stamp}.obj`;
    downloadOBJ(this.state.result, name, name.replace(/\.obj$/, ''));
  }

  /**
   * 误差趋势：在固定档位上逐一简化并采样（含 100% 零误差参照）。
   * 后台运行，使用独立的 trendToken：样例切换或再次调用都会使在途的旧批次过期，
   * 但与主简化的 runToken 互不干扰，趋势计算不弹 busy 遮罩、不阻塞交互。
   */
  private async updateTrend(): Promise<void> {
    if (!this.state) return;
    const token = ++this.trendToken;
    const snapshot = this.state;
    const rows: TrendRow[] = [];
    // 零误差参照行
    const refMetrics = computeSampledError(snapshot.original, snapshot.originalBVH);
    rows.push({
      ratio: 1,
      triangles: triangleCount(snapshot.original),
      max: refMetrics.max,
      rms: refMetrics.rms,
      reached: true,
      reference: true,
    });
    for (const ratio of TREND_RATIOS) {
      if (token !== this.trendToken) return;
      await this.nextFrame();
      if (token !== this.trendToken || !this.state) return;
      const r = simplifyMesh(snapshot.original, {
        ratio,
        lockBorder: this.el.lockBorder.checked,
      });
      const m = computeSampledError(r.mesh, snapshot.originalBVH);
      rows.push({
        ratio,
        triangles: r.actualTriangles,
        max: m.max,
        rms: m.rms,
        reached: r.reached,
      });
      if (token === this.trendToken) renderTrend(this.el.trend, rows, this.state.ratio);
    }
  }

  private showFatal(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(err);
    this.el.busy.classList.remove('hidden');
    this.el.busyDetail.textContent = `发生错误：${message}`;
    this.el.simplifyButton.disabled = true;
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function fmtVec(v: THREE.Vector3): string {
  return `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
}

new App().start().catch((err) => {
  console.error(err);
  const busy = document.getElementById('busy-detail');
  if (busy) busy.textContent = `初始化失败：${err.message}`;
});
