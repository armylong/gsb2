// 应用主编排：单组/对比模式、参数与视角同步、诊断刷新、HUD
import * as THREE from 'three';
import { ShadowBench } from './three/ShadowBench.js';
import { diagnose, diffReports, STATE_LABELS } from './diag/engine.js';
import {
  DEFAULT_PARAMS,
  DEFAULT_VIEW,
  PARAM_PRESETS,
  VIEW_PRESETS,
  OBJECT_DEFS,
} from './diag/scene-config.js';
import { buildControls, syncSliders } from './ui/controls.js';
import { renderDiagnosis, renderDiff } from './ui/diagnosis-panel.js';
export class App {
  constructor() {
    this.mode = 'single';
    this.stateA = structuredClone(DEFAULT_PARAMS);
    this.stateB = structuredClone(DEFAULT_PARAMS);
    this.activeSide = 'A';
    this.benches = {};
    this.reports = {};
    this.selectedObject = null;
    this._hudLabels = new Map();
    this._raf = null;
  }

  init() {
    this.dom = {
      stageA: document.getElementById('stage-a'),
      stageB: document.getElementById('stage-b'),
      controls: document.getElementById('controls'),
      diagnosis: document.getElementById('diagnosis'),
      diff: document.getElementById('diff-panel'),
      modeSingle: document.getElementById('mode-single'),
      modeCompare: document.getElementById('mode-compare'),
      resetParams: document.getElementById('reset-params'),
      resetScene: document.getElementById('reset-scene'),
      resetView: document.getElementById('reset-view'),
      moveToggle: document.getElementById('move-toggle'),
      badgeA: document.getElementById('badge-a'),
      badgeB: document.getElementById('badge-b'),
      compareBar: document.getElementById('compare-bar'),
    };

    this.benchA = new ShadowBench(this.dom.stageA, this.stateA);
    this.benchA.on(() => this.refresh('A'));

    this.controls = buildControls(this.dom.controls, {
      onPreset: (id) => this.applyPreset(id),
      onView: (id) => this.applyView(id),
      onParam: (key, v) => this.applyParam(key, v),
      onSelectObject: (id) => this.selectObject(id),
    });
    syncSliders(this.controls.sliders, this.stateA);

    this.dom.modeSingle.addEventListener('click', () => this.setMode('single'));
    this.dom.modeCompare.addEventListener('click', () => this.setMode('compare'));
    this.dom.resetParams.addEventListener('click', () => this.resetParams());
    this.dom.resetScene.addEventListener('click', () => this.resetScene());
    this.dom.resetView.addEventListener('click', () => this.applyView(DEFAULT_VIEW.id));
    this.dom.moveToggle.addEventListener('change', (e) => this.setMoveMode(e.target.checked));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.selectObject(null);
    });

    this.setMode('single');
    this.applyView(DEFAULT_VIEW.id);
    this.refresh('A');
  }

  // ------------------------------------------------------------ 模式切换

  setMode(mode) {
    this.mode = mode;
    this.dom.modeSingle.classList.toggle('active', mode === 'single');
    this.dom.modeCompare.classList.toggle('active', mode === 'compare');
    document.body.classList.toggle('compare-mode', mode === 'compare');
    this.dom.diff.classList.toggle('hidden', mode !== 'compare');
    this.dom.compareBar.classList.toggle('hidden', mode !== 'compare');
    document.querySelector('.stage-b-wrap').classList.toggle('hidden', mode !== 'compare');

    if (mode === 'compare') {
      const bWrap = document.querySelector('.stage-b-wrap');
      const createB = !this.benchB;
      if (createB) bWrap.classList.remove('hidden'); // 先显示，避免零尺寸容器初始化 WebGL
      if (!this.benchB) {
        this.benchB = new ShadowBench(this.dom.stageB, this.stateB);
        this.benchB.on(() => this.refresh('B'));
        this.benchB.syncObjectsFrom(this.benchA);
      }
      // 切换时保持相机与物体一致
      this.benchB.syncObjectsFrom(this.benchA);
      this.benchB.syncCameraFrom(this.benchA);
      this.benchB.applyParams(this.stateB, true);
      // 两帧后再次对齐尺寸：display 切换与布局完成后 ResizeObserver 才能拿到真实宽高
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.benchA.resize();
        if (this.benchB) this.benchB.resize();
      }));
      this.benchB.resize();
      this.benchA.resize();
      this.dom.badgeA.textContent = `A 组（${this.activeSide === 'A' ? '编辑中' : '基准'}）`;
      this.dom.badgeB.textContent = `B 组（${this.activeSide === 'B' ? '编辑中' : '对照'}）`;
    } else if (this.benchB) {
      this.benchB.dispose();
      this.benchB = null;
      this.dom.stageB.innerHTML = '';
    }
    this.refresh('A');
    if (mode === 'compare') this.refresh('B');
  }

  // ------------------------------------------------------------ 参数操作

  activeBench() {
    return this.activeSide === 'A' ? this.benchA : this.benchB;
  }

  activeState() {
    return this.activeSide === 'A' ? this.stateA : this.stateB;
  }

  setActiveSide(side) {
    this.activeSide = side;
    const state = this.activeState();
    syncSliders(this.controls.sliders, state);
    this.selectObject(null);
    if (this.mode === 'compare') {
      this.dom.badgeA.textContent = `A 组（${side === 'A' ? '编辑中' : '基准'}）`;
      this.dom.badgeB.textContent = `B 组（${side === 'B' ? '编辑中' : '对照'}）`;
    }
  }

  applyParam(key, value) {
    const state = this.activeState();
    state[key] = value;
    this.activeBench().applyParams({ [key]: value });
    if (this.mode === 'single') syncSliders(this.controls.sliders, this.stateA);
  }

  applyPreset(presetId) {
    const preset = PARAM_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const state = this.activeState();
    Object.assign(state, preset.params);
    this.activeBench().applyParams(preset.params, true);
    syncSliders(this.controls.sliders, state);
    this.flashPreset(presetId);
  }

  flashPreset(id) {
    document.querySelectorAll('[data-preset]').forEach((b) =>
      b.classList.toggle('active', b.dataset.preset === id));
  }

  applyView(viewId) {
    const view = VIEW_PRESETS.find((v) => v.id === viewId) || DEFAULT_VIEW;
    this.benchA.setView(view.position, view.target);
    if (this.benchB) this.benchB.syncCameraFrom(this.benchA);
  }

  selectObject(id) {
    this.selectedObject = id;
    this.benchA.selectObject(id);
    if (this.benchB) this.benchB.selectObject(id);
    document.querySelectorAll('[data-object]').forEach((row) =>
      row.classList.toggle('selected', row.dataset.object === id));
  }

  setMoveMode(on) {
    this.benchA.setMoveEnabled(on);
    if (this.benchB) this.benchB.setMoveEnabled(on);
    if (!on) this.selectObject(null);
  }

  // ------------------------------------------------------------ 重置

  resetParams() {
    const state = this.activeState();
    Object.assign(state, structuredClone(DEFAULT_PARAMS));
    this.activeBench().applyParams(DEFAULT_PARAMS, true);
    syncSliders(this.controls.sliders, state);
  }

  resetScene() {
    this.benchA.resetObjects();
    if (this.benchB) this.benchB.syncObjectsFrom(this.benchA);
    this.selectObject(null);
  }

  // ------------------------------------------------------------ 诊断刷新

  refresh(side) {
    const bench = side === 'A' ? this.benchA : this.benchB;
    if (!bench) return;
    const report = diagnose(bench.getDescriptor());
    this.reports[side] = report;
    bench.updateOverlays(report);
    this._updateObjectRows(report);

    if (side === 'A' || this.mode === 'single') {
      renderDiagnosis(this.dom.diagnosis, report, bench.params);
      this._updateHud(bench, report);
    }
    if (this.mode === 'compare' && this.reports.A && this.reports.B) {
      renderDiff(
        this.dom.diff,
        diffReports(this.reports.A, this.reports.B),
        'A 组',
        'B 组',
      );
      this._updateCompareBar();
    }
  }

  _updateObjectRows(report) {
    for (const o of report.objectReports) {
      const entry = this.controls.objectRows[o.id];
      if (!entry) continue;
      entry.state.textContent = `${STATE_LABELS[o.state]}${o.inView ? '' : '（视野外）'}`;
      entry.state.className = `object-state state-text-${o.state}`;
    }
  }

  _updateCompareBar() {
    const a = this.reports.A;
    const b = this.reports.B;
    this.dom.badgeA.textContent = `A 组｜覆盖 ${Math.round(a.viewCoverage * 100)}%｜texel ${a.texel.toFixed(3)}`;
    this.dom.badgeB.textContent = `B 组｜覆盖 ${Math.round(b.viewCoverage * 100)}%｜texel ${b.texel.toFixed(3)}`;
  }

  /** 场景角标：把未覆盖且在视野内的物体名投影到屏幕，提示受影响区域 */
  _updateHud(bench, report) {
    const container = bench.container;
    for (const el of this._hudLabels.values()) el.remove();
    this._hudLabels.clear();

    for (const o of report.objectReports) {
      if (o.state === 'inside' || !o.inView) continue;
      const def = OBJECT_DEFS.find((d) => d.id === o.id);
      const projected = new THREE.Vector3(
        def.position[0],
        def.position[1] + 2,
        def.position[2],
      ).project(bench.camera);
      if (projected.z > 1) continue;
      const label = document.createElement('div');
      label.className = `hud-label hud-${o.state}`;
      label.textContent = `${def.label}：${STATE_LABELS[o.state]}`;
      label.style.left = `${((projected.x + 1) / 2) * 100}%`;
      label.style.top = `${((1 - projected.y) / 2) * 100}%`;
      container.appendChild(label);
      this._hudLabels.set(o.id, label);
    }
  }
}
