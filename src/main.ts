import { PointViewer, type PickResult } from './viewer';
import { buildScene, SCENE_INFO, type PointCloud, type SceneId } from './lib/scenes';
import { stratifiedSample, subCloud } from './lib/sampling';
import { computeDensity, selectActive, SpatialHash, type ClippingOptions, type DensityStats } from './lib/density';
import { validateBoundary, type BoundaryValidation } from './lib/validation';
import { analyzeProjection, type OverlapResult } from './lib/projection';
import { densityColors, depthColors, labelColors, overlapColors, turbo } from './lib/colors';

type ColorMode = 'density' | 'depth' | 'label' | 'overlap';

const COLOR_MODES: Array<[ColorMode, string]> = [
  ['density', '邻域密度 (ppv)'],
  ['depth', '相机深度'],
  ['overlap', '投影重叠标记'],
  ['label', '真值标签 (对照)'],
];

interface AppState {
  sceneId: SceneId;
  seed: number;
  ratio: number;
  radius: number;
  clip: ClippingOptions;
  colorMode: ColorMode;
  binSize: number;
  depthGap: number;
}

/**
 * 一次完整管线的运行期产物, 任何参数变化都会整体替换, 杜绝旧统计残留。
 * 约定: refCloud 为参与统计的完整点云 (剖切"仅隐藏"时含被切掉的点);
 * renderCount = 实际渲染点数, 即 refCloud 前 renderCount 个点;
 * stats 的各数组前 renderCount 项与渲染点一一对应, 其余为隐藏点。
 */
interface RunData {
  refCloud: PointCloud;
  renderCount: number;
  stats: DensityStats;
  hash: SpatialHash;
  validation: BoundaryValidation;
  legendRange: { lo: number; hi: number } | null;
  overlap: OverlapResult | null;
  selected: number | null; // 渲染点下标 (< renderCount)
}

class App {
  private viewer: PointViewer;
  private state: AppState = {
    sceneId: 'plane',
    seed: SCENE_INFO.plane.defaultSeed,
    ratio: 1,
    radius: 0.18,
    clip: { enabled: false, axis: 1, plane: 0, excludeFromStats: true },
    colorMode: 'density',
    binSize: 0.15,
    depthGap: 0.3,
  };
  private data: RunData | null = null;
  private depthTimer: number | undefined;
  private els = this.grabElements();

  constructor() {
    this.viewer = new PointViewer(document.getElementById('viewport')!);
    this.buildRadios();
    this.bindUi();
    this.viewer.onPick((r) => this.handlePick(r));
    this.viewer.onCameraIdle(() => this.handleCameraIdle());
    this.syncRadio('scene', this.state.sceneId);
    this.syncRadio('colormode', this.state.colorMode);
    this.runPipeline(true);
  }

  // ---------------- UI 绑定 ----------------

  private grabElements() {
    const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
    return {
      scenePicker: $('scene-picker'),
      colorPicker: $('color-picker'),
      sceneDesc: $('scene-desc'),
      sceneSeed: $('scene-seed'),
      rawCount: $('raw-count'),
      ratio: $<HTMLInputElement>('ratio'),
      ratioVal: $('ratio-val'),
      sampledCount: $('sampled-count'),
      radius: $<HTMLInputElement>('radius'),
      radiusVal: $('radius-val'),
      sphereVol: $('sphere-vol'),
      clipEnable: $<HTMLInputElement>('clip-enable'),
      clipAxis: $<HTMLSelectElement>('clip-axis'),
      clipPlane: $<HTMLInputElement>('clip-plane'),
      clipPlaneVal: $('clip-plane-val'),
      clipExclude: $<HTMLInputElement>('clip-exclude'),
      clipStatus: $('clip-status'),
      legendBar: $<HTMLCanvasElement>('legend-bar'),
      legendLo: $('legend-lo'),
      legendHi: $('legend-hi'),
      legendNote: $('legend-note'),
      binSize: $<HTMLInputElement>('bin-size'),
      depthGap: $<HTMLInputElement>('depth-gap'),
      overlapNow: $('overlap-now'),
      validation: $<HTMLTableSectionElement>('validation').querySelector('tbody')!,
      pickInfo: $('pick-info'),
    };
  }

  private buildRadios(): void {
    (Object.keys(SCENE_INFO) as SceneId[]).forEach((id) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="scene" value="${id}" />${SCENE_INFO[id].name}`;
      this.els.scenePicker.appendChild(label);
    });
    COLOR_MODES.forEach(([id, name]) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="colormode" value="${id}" />${name}`;
      this.els.colorPicker.appendChild(label);
    });
  }

  private bindUi(): void {
    this.els.scenePicker.addEventListener('change', (e) => {
      const id = (e.target as HTMLInputElement).value as SceneId;
      this.state.sceneId = id;
      this.state.seed = SCENE_INFO[id].defaultSeed;
      this.runPipeline(true);
    });
    this.els.colorPicker.addEventListener('change', (e) => {
      this.state.colorMode = (e.target as HTMLInputElement).value as ColorMode;
      this.applyColors();
    });
    this.els.ratio.addEventListener('input', () => {
      this.state.ratio = parseFloat(this.els.ratio.value);
      this.runPipeline(false);
    });
    this.els.radius.addEventListener('input', () => {
      this.state.radius = parseFloat(this.els.radius.value);
      this.runPipeline(false);
    });
    this.els.clipEnable.addEventListener('change', () => {
      this.state.clip.enabled = this.els.clipEnable.checked;
      this.runPipeline(false);
    });
    this.els.clipAxis.addEventListener('change', () => {
      this.state.clip.axis = parseInt(this.els.clipAxis.value, 10) as 0 | 1 | 2;
      this.runPipeline(false);
    });
    this.els.clipPlane.addEventListener('input', () => {
      this.state.clip.plane = parseFloat(this.els.clipPlane.value);
      // 仅移动切面: 统计重算 (切过的点变化), 但不重建相机
      this.runPipeline(false);
    });
    this.els.clipExclude.addEventListener('change', () => {
      this.state.clip.excludeFromStats = this.els.clipExclude.checked;
      this.runPipeline(false);
    });
    this.els.binSize.addEventListener('change', () => {
      this.state.binSize = parseFloat(this.els.binSize.value) || 0.15;
      if (this.data?.overlap) this.runProjection();
    });
    this.els.depthGap.addEventListener('change', () => {
      this.state.depthGap = parseFloat(this.els.depthGap.value) || 0.3;
      if (this.data?.overlap) this.runProjection();
    });
    this.els.overlapNow.addEventListener('click', () => {
      this.state.colorMode = 'overlap';
      this.syncRadio('colormode', 'overlap');
      this.runProjection();
      this.applyColors();
    });
  }

  private syncRadio(name: string, value: string): void {
    document
      .querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)
      .forEach((r) => (r.checked = r.value === value));
  }

  // ---------------- 核心管线 ----------------

  /**
   * 场景/抽样/邻域/剖切任一参数变化 => 从原始点云重跑全链路,
   * 旧的密度、验证结果、投影结果、选中标记全部丢弃, 保证旧统计不残留。
   */
  private runPipeline(reframe: boolean): void {
    const s = this.state;
    const full = buildScene(s.sceneId, s.seed);
    const sampledIdx = stratifiedSample(full, s.ratio, s.seed);
    const sampled = subCloud(full, sampledIdx);

    const visibleSampled = selectActive(sampled, s.clip); // sampled 下标的可见点
    const hiddenCount = sampled.count - visibleSampled.length;
    const includeHidden = s.clip.enabled && !s.clip.excludeFromStats;

    // 组装 refCloud: 前半 = 可见/渲染点, 后半 = 隐藏但参与统计的点
    const visibleCloud = subCloud(sampled, visibleSampled);
    let refCloud: PointCloud;
    let renderCount: number;
    if (includeHidden && hiddenCount > 0) {
      const hiddenMask = new Uint8Array(sampled.count).fill(1);
      for (const vi of visibleSampled) hiddenMask[vi] = 0;
      const hiddenIdx: number[] = [];
      for (let i = 0; i < sampled.count; i++) if (hiddenMask[i]) hiddenIdx.push(i);
      const hiddenCloud = subCloud(sampled, Uint32Array.from(hiddenIdx));
      refCloud = concatClouds(visibleCloud, hiddenCloud);
      renderCount = visibleCloud.count;
    } else {
      refCloud = visibleCloud;
      renderCount = visibleCloud.count;
    }

    const statsIdx = allIndices(refCloud.count);
    const stats = computeDensity(refCloud, statsIdx, s.radius);
    const hash = new SpatialHash(refCloud.positions, statsIdx, s.radius);
    const validation = validateBoundary(refCloud, stats);

    this.data = {
      refCloud,
      renderCount,
      stats,
      hash,
      validation,
      legendRange: null,
      overlap: null,
      selected: null,
    };
    this.viewer.clearMarkers();
    this.viewer.setPointCloud(refCloud.positions, refCloud.bounds, reframe);
    this.viewer.setClip(s.clip.enabled, s.clip.axis, s.clip.plane);
    this.applyColors();
    this.renderPanels(full, sampled, visibleSampled.length, hiddenCount, includeHidden);
    this.els.pickInfo.textContent = '尚未选择点 (参数已更新, 请重新点击)';
  }

  private runProjection(): void {
    if (!this.data) return;
    const dir = this.viewer.viewDirection();
    // 投影分析与密度统计使用同一批参与点 (含被剖切隐藏但仍统计的点)
    this.data.overlap = analyzeProjection(
      this.data.refCloud,
      allIndices(this.data.refCloud.count),
      dir,
      this.state.binSize,
      this.state.depthGap,
    );
    this.renderOverlapSummary();
  }

  private applyColors(): void {
    if (!this.data) return;
    const mode = this.state.colorMode;
    const d = this.data;
    if (mode === 'density') {
      const { rgb, logMin, logMax } = densityColors(d.stats.densities);
      this.viewer.setColors(rgb);
      d.legendRange = { lo: logMin, hi: logMax };
      this.drawLegend(
        'log10(ρ) 密度色阶, 单位 ppv (点/单位体积)',
        (10 ** logMin).toFixed(2),
        (10 ** logMax).toFixed(2),
      );
    } else if (mode === 'depth') {
      this.viewer.updateCameraMatrix();
      const rgb = depthColors(this.viewer.viewDepths(d.refCloud.positions));
      this.viewer.setColors(rgb);
      this.drawLegend('相机空间深度 (近=红, 远=蓝), 单位与场景坐标一致', '近', '远');
    } else if (mode === 'label') {
      this.viewer.setColors(labelColors(d.refCloud.labels));
      this.drawLegend('真值标签: 橙=密集结构, 青=稀疏噪声', '稀疏', '密集', true);
    } else if (mode === 'overlap') {
      if (!d.overlap) this.runProjection();
      this.viewer.setColors(overlapColors(d.overlap!.isOverlap));
      this.drawLegend('红=该屏幕格沿视线深度跨度超阈值 (投影重叠), 蓝=干净格', '干净', '重叠', true);
      // drawLegend 会覆盖说明区, 重叠统计摘要最后写入以保证可见
      this.renderOverlapSummary();
    }
    this.updateRadioActive();
  }

  private handleCameraIdle(): void {
    if (this.state.colorMode === 'depth') {
      window.clearTimeout(this.depthTimer);
      this.depthTimer = window.setTimeout(() => this.applyColors(), 60);
    }
    if (this.state.colorMode === 'overlap' && this.data?.overlap) {
      this.runProjection();
      this.applyColors();
    }
  }

  // ---------------- 拾取与邻域 ----------------

  private handlePick(r: PickResult | null): void {
    if (!this.data || !r) {
      this.viewer.clearMarkers();
      if (this.data) this.data.selected = null;
      this.els.pickInfo.textContent = '已取消选择';
      return;
    }
    const d = this.data;
    const displayIdx = r.index;
    d.selected = displayIdx;
    const pos = d.refCloud.positions;
    const px = pos[displayIdx * 3];
    const py = pos[displayIdx * 3 + 1];
    const pz = pos[displayIdx * 3 + 2];
    const neighborIdx = d.hash.query(d.refCloud.positions, px, py, pz, this.state.radius);

    // < renderCount 为画面可见点; 其余为被剖切隐藏但仍参与统计的点
    const shown: Array<[number, number, number]> = [];
    const hidden: Array<[number, number, number]> = [];
    for (const i of neighborIdx) {
      const triple: [number, number, number] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      (i < d.renderCount ? shown : hidden).push(triple);
    }
    this.viewer.showNeighborhood([px, py, pz], shown, hidden);

    const ownCount = d.stats.counts[displayIdx];
    const ownDensity = d.stats.densities[displayIdx];
    const truth = d.refCloud.labels[displayIdx] === 1 ? '密集结构' : '稀疏噪声';
    const cutNote =
      hidden.length > 0
        ? `\n其中 ${hidden.length} 个邻点已被剖切隐藏, 但按当前设置仍参与统计 (品红)`
        : '';
    this.els.pickInfo.textContent =
      `点 #${displayIdx} (真值: ${truth})\n` +
      `坐标 = (${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)})\n` +
      `邻域半径 r = ${this.state.radius}, 球形体积 V = ${d.stats.sphereVolume.toFixed(4)}\n` +
      `邻域大小 k = ${ownCount} 个点 (含自身)\n` +
      `局部密度 ρ = ${ownDensity.toFixed(3)} ppv (点/单位体积)\n` +
      `实际参与统计邻点: ${neighborIdx.length} 个, 画面中绿色球标记` +
      cutNote;
  }

  // ---------------- 面板渲染 ----------------

  private renderPanels(
    full: PointCloud,
    sampled: PointCloud,
    visibleCount: number,
    hiddenCount: number,
    includeHidden: boolean,
  ): void {
    const s = this.state;
    this.els.sceneDesc.textContent = full.description;
    this.els.sceneSeed.textContent = String(s.seed);
    this.els.rawCount.textContent = String(full.count);
    this.els.ratioVal.textContent = `${Math.round(s.ratio * 100)}%`;
    this.els.sampledCount.textContent = String(sampled.count);
    this.els.radiusVal.textContent = s.radius.toFixed(2);
    const vol = (4 / 3) * Math.PI * s.radius ** 3;
    this.els.sphereVol.textContent = vol.toFixed(4);
    this.els.clipPlaneVal.textContent = s.clip.plane.toFixed(2);

    if (!s.clip.enabled) {
      this.els.clipStatus.textContent = '剖切关闭: 全部点参与统计与显示。';
    } else if (!includeHidden) {
      this.els.clipStatus.textContent =
        `剖切开启: 切掉 ${hiddenCount} 个点, 这些点既不显示也不参与密度统计; 参与 ${visibleCount} 个。`;
    } else {
      this.els.clipStatus.textContent =
        `剖切开启: 隐藏 ${hiddenCount} 个点, 但它们仍参与密度统计 (仅视觉剖切); 参与 ${visibleCount + hiddenCount} 个。`;
    }

    const v = this.data!.validation;
    const rows: Array<[string, string, string?]> = [
      ['参与统计点数', String(this.data!.refCloud.count)],
      ['Otsu 密度阈值 (ppv)', v.threshold.toFixed(3)],
      ['密集类平均密度 (ppv)', v.denseMean.toFixed(3)],
      ['稀疏类平均密度 (ppv)', v.sparseMean.toFixed(3)],
      ['log10 类间距 (倍)', v.logSeparation.toFixed(2)],
      ['精确率 precision', v.precision.toFixed(3), v.precision >= 0.8 ? 'good' : 'warn'],
      ['召回率 recall', v.recall.toFixed(3), v.recall >= 0.8 ? 'good' : 'warn'],
      ['F1', v.f1.toFixed(3), v.f1 >= 0.8 ? 'good' : 'warn'],
      ['混淆矩阵 TP/FP/TN/FN', `${v.confusion.tp}/${v.confusion.fp}/${v.confusion.tn}/${v.confusion.fn}`],
    ];
    this.els.validation.innerHTML = rows
      .map(([k, val, cls]) => `<tr><td>${k}</td><td class="${cls ?? ''}">${val}</td></tr>`)
      .join('');
    if (this.data?.overlap) this.renderOverlapSummary();
  }

  private renderOverlapSummary(): void {
    const o = this.data!.overlap!;
    this.els.legendNote.innerHTML =
      `沿当前视线: 投影格 ${o.totalBins} 个, 其中重叠格 ${o.overlapBins} 个; ` +
      `落在重叠格的点占比 <b class="warn">${(o.overlapPointFraction * 100).toFixed(1)}%</b> ` +
      `(格边长 ${o.binSize}, 深度判据 >${o.depthGap})。旋转视角可让重叠点在屏幕上分开。`;
  }

  private drawLegend(note: string, lo: string, hi: string, categorical = false): void {
    const ctx = this.els.legendBar.getContext('2d')!;
    const w = this.els.legendBar.width;
    const h = this.els.legendBar.height;
    if (categorical) {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'rgb(70,110,200)');
      grad.addColorStop(1, 'rgb(235,64,52)');
      ctx.fillStyle = grad;
    } else {
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const [r, g, b] = turbo(t);
        grad.addColorStop(t, `rgb(${r},${g},${b})`);
      }
      ctx.fillStyle = grad;
    }
    ctx.fillRect(0, 0, w, h);
    this.els.legendLo.textContent = lo;
    this.els.legendHi.textContent = hi;
    this.els.legendNote.textContent = note;
  }

  private updateRadioActive(): void {
    this.els.colorPicker.querySelectorAll('label').forEach((l) => {
      const input = l.querySelector('input')!;
      l.classList.toggle('active', (input as HTMLInputElement).value === this.state.colorMode && (input as HTMLInputElement).checked);
    });
    this.els.scenePicker.querySelectorAll('label').forEach((l) => {
      const input = l.querySelector('input')!;
      l.classList.toggle('active', (input as HTMLInputElement).value === this.state.sceneId && (input as HTMLInputElement).checked);
    });
  }
}

function allIndices(n: number): Uint32Array {
  const arr = new Uint32Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  return arr;
}

/** 拼接两个点云 (可见点在前, 隐藏点在后), 包围盒取并集 */
function concatClouds(a: PointCloud, b: PointCloud): PointCloud {
  const positions = new Float32Array((a.count + b.count) * 3);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.count * 3);
  const labels = new Uint8Array(a.count + b.count);
  labels.set(a.labels, 0);
  labels.set(b.labels, a.count);
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    min[d] = Math.min(a.bounds.min[d], b.bounds.min[d]);
    max[d] = Math.max(a.bounds.max[d], b.bounds.max[d]);
  }
  return {
    positions,
    labels,
    count: a.count + b.count,
    bounds: { min, max },
    description: a.description,
  };
}

new App();
