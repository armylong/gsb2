/**
 * 应用主控制器：串联几何内核、2D/3D 视图、播放动画、手动角度、选中联动与验证展示。
 */
import './style.css';
import * as THREE from 'three';
import { POLYHEDRONS, getPreset } from './presets';
import { buildModel, evaluateFold } from './geometry';
import { faceMetrics, validateModel, type FaceMetrics } from './validate';
import type { BuiltModel } from './types';
import { NetRenderer, FACE_COLORS } from './netRenderer';
import { FoldViewer, type ViewMode } from './foldViewer';

class App {
  private model: BuiltModel;
  private net: NetRenderer;
  private viewer: FoldViewer;
  private progress = 0;
  private playing = false;
  private playDir: 1 | -1 = 1;
  private rafId = 0;
  private lastTs = 0;
  private selectedId: string | null = null;
  /** 当前手动覆盖的铰链子面 id；null 表示统一进度模式。 */
  private manualFaceId: string | null = null;

  private el = {
    modelSwitch: document.getElementById('modelSwitch')!,
    playBtn: document.getElementById('playBtn')! as HTMLButtonElement,
    reverseBtn: document.getElementById('reverseBtn')! as HTMLButtonElement,
    slider: document.getElementById('progressSlider')! as HTMLInputElement,
    progressValue: document.getElementById('progressValue')!,
    hingeControl: document.getElementById('hingeControl')!,
    hingeSelect: document.getElementById('hingeSelect')! as HTMLSelectElement,
    hingeSlider: document.getElementById('hingeSlider')! as HTMLInputElement,
    hingeValue: document.getElementById('hingeValue')!,
    hingeReset: document.getElementById('hingeReset')!,
    viewSwitch: document.getElementById('viewSwitch')!,
    selectionInfo: document.getElementById('selectionInfo')!,
    validationList: document.getElementById('validationList')!,
  };

  constructor() {
    this.model = buildModel(getPreset(POLYHEDRONS[0].key));
    this.net = new NetRenderer(document.getElementById('netCanvas')! as HTMLCanvasElement);
    this.viewer = new FoldViewer(document.getElementById('threeCanvas')! as HTMLCanvasElement);
    this.net.onPick = (id) => this.selectFace(id);
    this.viewer.onPick = (id) => this.selectFace(id);
    this.buildModelSwitch();
    this.bindControls();
    this.loadModel(POLYHEDRONS[0].key, true);
  }

  private buildModelSwitch() {
    this.el.modelSwitch.innerHTML = '';
    for (const p of POLYHEDRONS) {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.dataset.key = p.key;
      b.addEventListener('click', () => this.loadModel(p.key));
      this.el.modelSwitch.appendChild(b);
    }
  }

  /** 更换纸模：重建模型、清除选择与手动覆盖、进度归零。 */
  private loadModel(key: string, initial = false) {
    this.stopPlay();
    this.model = buildModel(getPreset(key));
    this.progress = 0;
    this.selectedId = null;
    this.manualFaceId = null;
    this.el.slider.value = '0';
    this.el.progressValue.textContent = '0';
    this.net.setModel(this.model);
    this.viewer.setModel(this.model);
    this.buildHingeOptions();
    this.syncModelButtons(key);
    this.setViewMode('orbit');
    this.renderValidation();
    this.updateSelectionPanel();
    if (!initial) this.viewer.setProgress(0);
  }

  private syncModelButtons(key: string) {
    this.el.modelSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === key);
    });
  }

  private buildHingeOptions() {
    this.el.hingeSelect.innerHTML = '';
    for (const h of this.model.hingeEdges) {
      const opt = document.createElement('option');
      opt.value = h.child;
      opt.textContent = `${h.parent} → ${h.child}（边 ${h.va}-${h.vb}）`;
      this.el.hingeSelect.appendChild(opt);
    }
  }

  private bindControls() {
    this.el.slider.addEventListener('input', () => {
      this.stopPlay();
      this.progress = Number(this.el.slider.value) / 100;
      this.el.progressValue.textContent = this.el.slider.value;
      // 进入统一进度：清除手动覆盖
      this.clearManual(false);
      this.viewer.setProgress(this.progress);
      this.updateSelectionPanel();
    });

    this.el.playBtn.addEventListener('click', () => this.togglePlay());
    this.el.reverseBtn.addEventListener('click', () => {
      this.playDir = (this.playDir * -1) as 1 | -1;
      if (!this.playing) this.togglePlay();
    });

    this.el.hingeSelect.addEventListener('change', () => {
      this.manualFaceId = this.el.hingeSelect.value || null;
      this.syncManualSliderFromAngle();
      this.applyManual();
    });
    this.el.hingeSlider.addEventListener('input', () => this.applyManual());
    this.el.hingeReset.addEventListener('click', () => this.clearManual(true));

    this.el.viewSwitch.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => this.setViewMode(b.dataset.view as ViewMode));
    });
  }

  private setViewMode(mode: ViewMode) {
    this.viewer.setViewMode(mode);
    this.el.viewSwitch.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
  }

  private togglePlay() {
    if (this.playing) {
      this.stopPlay();
      return;
    }
    // 播放统一进度，先退出手动模式
    this.clearManual(false);
    if (this.progress >= 1 && this.playDir === 1) this.progress = 0;
    if (this.progress <= 0 && this.playDir === -1) this.progress = 1;
    this.playing = true;
    this.el.playBtn.textContent = '⏸ 暂停';
    this.lastTs = performance.now();
    const tick = (ts: number) => {
      if (!this.playing) return;
      const dt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      this.progress = THREE.MathUtils.clamp(this.progress + this.playDir * dt * 0.35, 0, 1);
      this.el.slider.value = String(this.progress * 100);
      this.el.progressValue.textContent = (this.progress * 100).toFixed(1);
      this.viewer.setProgress(this.progress);
      this.updateSelectionPanel();
      if (this.progress === 0 || this.progress === 1) {
        this.stopPlay();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopPlay() {
    this.playing = false;
    cancelAnimationFrame(this.rafId);
    this.el.playBtn.textContent = '▶ 播放';
  }

  /** 手动改变选中铰链的绝对角度（度），下游随动、其它分支保持。 */
  private applyManual() {
    if (!this.manualFaceId) return;
    const deg = Number(this.el.hingeSlider.value);
    this.el.hingeValue.textContent = deg.toFixed(1);
    const rad = THREE.MathUtils.degToRad(deg);
    this.viewer.setOverride(this.manualFaceId, rad);
    this.updateSelectionPanel();
  }

  /** 手动滑块初始化为该铰链在当前统一进度下应有的角度，避免跳变。 */
  private syncManualSliderFromAngle() {
    if (!this.manualFaceId) return;
    const face = this.model.faceById.get(this.manualFaceId)!;
    const deg = THREE.MathUtils.radToDeg(face.targetAngle * this.progress);
    this.el.hingeSlider.value = String(deg);
    this.el.hingeValue.textContent = deg.toFixed(1);
  }

  /** 退出手动模式：删除覆盖角，明确恢复当前统一进度姿态（绝对值，无累加）。 */
  private clearManual(refreshSlider: boolean) {
    this.manualFaceId = null;
    this.viewer.clearOverrides();
    this.viewer.setProgress(this.progress);
    this.el.hingeSelect.value = '';
    if (refreshSlider) {
      this.el.hingeSlider.value = '0';
      this.el.hingeValue.textContent = '0';
    }
    this.updateSelectionPanel();
  }

  private selectFace(id: string | null) {
    this.selectedId = id;
    this.net.setSelected(id);
    this.viewer.setSelected(id);
    this.updateSelectionPanel();
  }

  private currentPoses() {
    // 与 viewer 内部一致地复算一份用于面板指标
    const overrides = new Map<string, number>();
    if (this.manualFaceId) {
      overrides.set(
        this.manualFaceId,
        THREE.MathUtils.degToRad(Number(this.el.hingeSlider.value)),
      );
    }
    return evaluateFold(this.model, this.progress, overrides);
  }

  private updateSelectionPanel() {
    if (!this.selectedId) {
      this.el.selectionInfo.innerHTML = '<p class="muted">未选择面，点击展开图或立体模型中的面。</p>';
      return;
    }
    const id = this.selectedId;
    const fdef = this.model.def.faces.find((f) => f.id === id)!;
    const face = this.model.faceById.get(id)!;
    const poses = this.currentPoses();
    const m: FaceMetrics = faceMetrics(this.model, poses, id);
    const colorIdx = this.model.def.faces.findIndex((f) => f.id === id);
    const hinge = this.model.hingeEdges.find((h) => h.child === id);

    const fmt = (v: number | null, d = 4) => (v === null ? '—（根面）' : v.toFixed(d));
    this.el.selectionInfo.innerHTML = `
      <div class="face-tag">
        <span class="face-swatch" style="background:${FACE_COLORS[colorIdx % FACE_COLORS.length]}"></span>
        面 ${id} ${this.model.def.rootFaceId === id ? '<span class="badge pass">根面</span>' : ''}
      </div>
      <dl class="kv" style="margin-top:12px">
        <dt>父面</dt><dd>${face.parentId ?? '无（根面）'}</dd>
        <dt>顶点数</dt><dd>${fdef.targetVertexIds.length}</dd>
        <dt>面心世界位置</dt>
        <dd>(${m.centroid.x.toFixed(3)}, ${m.centroid.y.toFixed(3)}, ${m.centroid.z.toFixed(3)})</dd>
        <dt>外法线</dt>
        <dd>(${m.normal.x.toFixed(3)}, ${m.normal.y.toFixed(3)}, ${m.normal.z.toFixed(3)})</dd>
        <dt>当前折叠角</dt><dd>${m.effectiveAngleDeg.toFixed(2)}°</dd>
        <dt>折叠边长度</dt><dd>${fmt(m.hingeLength)}</dd>
        <dt>铰链端点误差</dt><dd>${fmt(m.hingeError)}</dd>
        <dt>裁切边闭合端点误差</dt><dd>${m.cutError.toFixed(4)}</dd>
        <dt>铰链边</dt><dd>${hinge ? `${hinge.va}–${hinge.vb}` : '—'}</dd>
      </dl>`;
  }

  private renderValidation() {
    const report = validateModel(this.model);
    this.el.validationList.innerHTML = report.entries
      .map((e) => {
        const passColor = e.pass ? 'var(--ok)' : 'var(--bad)';
        return `
        <div class="check-row">
          <div class="head">
            <span class="name">${e.name}</span>
            <span class="badge ${e.pass ? 'pass' : 'fail'}">${e.pass ? '通过' : '失败'}</span>
          </div>
          <div class="meta">${e.detail || '—'}</div>
          <div class="meta nums">
            允许误差 ≤ ${e.tolerance.toExponential(1)} ｜ 实测 ${e.actual.toExponential(3)}
            <span style="color:${passColor}">（${e.pass ? '在容差内' : '超出容差'}）</span>
          </div>
        </div>`;
      })
      .join('');
  }
}

new App();
