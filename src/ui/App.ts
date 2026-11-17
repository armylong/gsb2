import * as THREE from 'three';
import { CameraRig } from '../core/CameraRig';
import { CameraPath } from '../core/CameraPath';
import { buildExport, downloadJson } from '../core/exporter';
import { ALL_PRESETS, type Preset } from '../core/presets';
import { sanitizeKnots } from '../core/timeMapping';
import { runAllChecks, type VerificationReport } from '../core/verifier';
import type { CameraSample, TimeKnot } from '../core/types';
import { createInitialState, type AppState } from './state';
import {
  defaultViewportFactory,
  type IOverviewViewport,
  type ICameraPreview,
  type ViewportFactory,
} from './viewportTypes';

const DENSE = 600;

export interface AppEnv {
  document: Document;
  requestAnimationFrame: (cb: (wall: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  now: () => number;
}

export class App {
  private readonly state: AppState;
  private rig: CameraRig;
  private overview!: IOverviewViewport;
  private preview!: ICameraPreview;
  private raf = 0;
  private lastWall = 0;
  private readonly els: Record<string, HTMLElement> = {};
  private readonly factory: ViewportFactory;
  private readonly env: AppEnv;

  constructor(factory: ViewportFactory = defaultViewportFactory, env?: Partial<AppEnv>) {
    this.state = createInitialState();
    this.rig = new CameraRig(this.state.path, this.state.playback);
    this.factory = factory;
    this.env = {
      document: env?.document ?? document,
      requestAnimationFrame: env?.requestAnimationFrame ?? window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: env?.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window),
      now: env?.now ?? (() => performance.now()),
    };
  }

  start(): void {
    this.buildDom();
    this.overview = this.factory.createOverview(this.els.overviewHost, {
      onControlPointDrag: (i, p) => this.handlePointDrag(i, p),
      onControlPointDragStart: () => this.setPlaying(false),
      onControlPointDragEnd: () => this.rebuildRig(),
      onTargetDrag: (p) => this.handleTargetDrag(p),
    });
    this.preview = this.factory.createPreview(this.els.previewHost);
    this.applyPreset(this.state.activePresetId, true);
    this.refreshPathVisual();
    this.refreshTarget();
    this.seek(this.state.currentTime);
    this.raf = this.env.requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- DOM shell
  private buildDom(): void {
    const root = this.env.document.getElementById('app')!;
    root.innerHTML = `
      <div class="panel" id="left-panel"></div>
      <div class="viewports">
        <div class="viewport" id="overview-host">
          <div class="label">总览 · 路径 / 控制点（黄，可拖拽）/ 目标（红，可拖拽）/ 相机姿态（绿）</div>
        </div>
        <div class="viewport" id="preview-host">
          <div class="label">相机实际预览（局部轴：红=右 X，绿=上 Y，蓝=后 Z；视线沿 -Z）</div>
        </div>
      </div>
      <div class="panel" id="right-panel"></div>`;
    this.els.overviewHost = this.env.document.getElementById('overview-host')!;
    this.els.previewHost = this.env.document.getElementById('preview-host')!;
    this.els.left = this.env.document.getElementById('left-panel')!;
    this.els.right = this.env.document.getElementById('right-panel')!;
    this.renderLeftPanel();
    this.renderRightPanel();
  }

  // --------------------------------------------------------------- left panel
  private renderLeftPanel(): void {
    const s = this.state;
    this.els.left.innerHTML = `
      <h2>程序样例</h2>
      <div class="preset-list" id="preset-list"></div>

      <h2>路径</h2>
      <div class="row">
        <label>形态</label>
        <div class="btn-group" style="flex:1">
          <button data-mode="open" class="${s.path.mode === 'open' ? 'active' : ''}">开放路径</button>
          <button data-mode="closed" class="${s.path.mode === 'closed' ? 'active' : ''}">闭环</button>
        </div>
      </div>
      <div class="row">
        <button id="add-point" style="flex:1">＋ 添加控制点</button>
      </div>
      <div class="row">
        <button id="remove-point" style="flex:1">－ 删除末尾控制点</button>
      </div>
      <p class="hint">在总览中直接拖拽黄色控制点编辑形状；红色球为看向目标。</p>

      <h2>播放方式</h2>
      <div class="row">
        <label>速度</label>
        <div class="btn-group" style="flex:1">
          <button data-speed="constant" class="${s.playback.speedMode === 'constant' ? 'active' : ''}">按路程等速</button>
          <button data-speed="timed" class="${s.playback.speedMode === 'timed' ? 'active' : ''}">时间曲线变速</button>
        </div>
      </div>
      <div class="row">
        <label>总时长(s)</label>
        <input type="number" id="duration" min="0.5" step="0.5" value="${s.playback.duration}">
      </div>

      <h2>相机朝向</h2>
      <div class="row">
        <label>朝向</label>
        <div class="btn-group" style="flex:1">
          <button data-look="forward" class="${s.playback.lookMode === 'forward' ? 'active' : ''}">沿前进方向</button>
          <button data-look="target" class="${s.playback.lookMode === 'target' ? 'active' : ''}">看向目标点</button>
        </div>
      </div>
      <div class="row">
        <label>目标 X</label><input type="number" step="0.5" id="tx" value="${s.playback.target.x}">
      </div>
      <div class="row">
        <label>目标 Y</label><input type="number" step="0.5" id="ty" value="${s.playback.target.y}">
      </div>
      <div class="row">
        <label>目标 Z</label><input type="number" step="0.5" id="tz" value="${s.playback.target.z}">
      </div>

      <h2>时间曲线节点</h2>
      <p class="hint">每行 = 某时刻 t 走完进度 p。自动保持 t 递增、p 不倒退；首尾固定。</p>
      <table class="knot-table" id="knot-table"></table>
      <div class="row" style="margin-top:6px">
        <button id="add-knot" style="flex:1">＋ 添加节点</button>
      </div>

      <h2>导出 JSON</h2>
      <div class="row">
        <label>采样间隔(s)</label>
        <input type="number" id="export-dt" min="0.01" step="0.1" value="${s.exportInterval}">
      </div>
      <div class="row">
        <button id="export-btn" class="primary" style="flex:1">导出当前配置采样</button>
      </div>
    `;

    // Preset buttons.
    const list = this.env.document.getElementById('preset-list')!;
    for (const factory of ALL_PRESETS) {
      const preset = factory();
      const b = this.env.document.createElement('button');
      b.innerHTML = `${preset.name}<span class="desc">${preset.description}</span>`;
      if (preset.id === s.activePresetId) b.classList.add('active');
      b.onclick = () => this.applyPreset(preset.id);
      list.appendChild(b);
    }

    Array.from(this.env.document.querySelectorAll<HTMLButtonElement>('[data-mode]')).forEach((b) => {
      b.onclick = () => {
        this.state.path.mode = b.dataset.mode as AppState['path']['mode'];
        this.afterConfigChange();
      };
    });
    Array.from(this.env.document.querySelectorAll<HTMLButtonElement>('[data-speed]')).forEach((b) => {
      b.onclick = () => {
        this.state.playback.speedMode = b.dataset.speed as AppState['playback']['speedMode'];
        this.afterConfigChange();
      };
    });
    Array.from(this.env.document.querySelectorAll<HTMLButtonElement>('[data-look]')).forEach((b) => {
      b.onclick = () => {
        this.state.playback.lookMode = b.dataset.look as AppState['playback']['lookMode'];
        this.afterConfigChange();
      };
    });
    this.env.document.getElementById('add-point')!.onclick = () => {
      const pts = this.state.path.controlPoints;
      const last = pts[pts.length - 1];
      pts.push(last.clone().add(new THREE.Vector3(2, 0, 0)));
      this.afterConfigChange();
    };
    this.env.document.getElementById('remove-point')!.onclick = () => {
      if (this.state.path.controlPoints.length > 2) {
        this.state.path.controlPoints.pop();
        this.afterConfigChange();
      }
    };
    this.env.document.getElementById('duration')!.onchange = (e) => {
      const d = Math.max(0.5, Number((e.target as HTMLInputElement).value));
      this.state.playback.duration = d;
      this.state.playback.timeKnots = sanitizeKnots(this.state.playback.timeKnots, d);
      this.afterConfigChange();
    };
    for (const [id, axis] of [['tx', 'x'], ['ty', 'y'], ['tz', 'z']] as const) {
      this.env.document.getElementById(id)!.onchange = (e) => {
        this.state.playback.target[axis] = Number((e.target as HTMLInputElement).value);
        this.afterConfigChange();
      };
    }
    this.env.document.getElementById('add-knot')!.onclick = () => this.addKnot();
    this.env.document.getElementById('export-dt')!.onchange = (e) => {
      this.state.exportInterval = Math.max(0.01, Number((e.target as HTMLInputElement).value));
    };
    this.env.document.getElementById('export-btn')!.onclick = () => this.exportJson();

    this.renderKnotTable();
  }

  private renderKnotTable(): void {
    const table = this.env.document.getElementById('knot-table')!;
    const knots = this.state.playback.timeKnots;
    table.innerHTML = `
      <tr><th>t (s)</th><th>进度 p</th><th></th></tr>
      ${knots
        .map(
          (k, i) => `
        <tr>
          <td><input type="number" step="0.1" data-k="t" data-i="${i}" value="${k.t}" ${
            i === 0 || i === knots.length - 1 ? 'disabled' : ''
          }></td>
          <td><input type="number" step="0.05" min="0" max="1" data-k="p" data-i="${i}" value="${k.p}"></td>
          <td>${
            i === 0 || i === knots.length - 1
              ? ''
              : '<button data-del="' + i + '">✕</button>'
          }</td>
        </tr>`,
        )
        .join('')}`;
    Array.from(table.querySelectorAll<HTMLInputElement>('input')).forEach((inp) => {
      inp.onchange = () => {
        const i = Number(inp.dataset.i);
        const field = inp.dataset.k as keyof TimeKnot;
        const knots2 = this.state.playback.timeKnots.map((k) => ({ ...k }));
        knots2[i][field] = Number(inp.value);
        this.state.playback.timeKnots = sanitizeKnots(knots2, this.state.playback.duration);
        this.afterConfigChange(false);
      };
    });
    Array.from(table.querySelectorAll<HTMLButtonElement>('[data-del]')).forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.del);
        const knots2 = this.state.playback.timeKnots.filter((_, idx) => idx !== i);
        this.state.playback.timeKnots = sanitizeKnots(knots2, this.state.playback.duration);
        this.afterConfigChange(false);
      };
    });
  }

  private addKnot(): void {
    const d = this.state.playback.duration;
    const knots = this.state.playback.timeKnots;
    // Insert at the midpoint time of the widest gap.
    let best = 0;
    let bestGap = -1;
    for (let i = 1; i < knots.length; i++) {
      const gap = knots[i].t - knots[i - 1].t;
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    const t = (knots[best - 1].t + knots[best].t) / 2;
    const p = (knots[best - 1].p + knots[best].p) / 2;
    const next = [...knots, { t, p }].sort((a, b) => a.t - b.t);
    this.state.playback.timeKnots = sanitizeKnots(next, d);
    this.afterConfigChange(false);
  }

  // -------------------------------------------------------------- right panel
  private renderRightPanel(): void {
    this.els.right.innerHTML = `
      <h2>播放控制</h2>
      <div class="btn-group">
        <button id="play" class="primary">▶ 播放</button>
        <button id="pause">⏸ 暂停</button>
        <button id="reset">⟲ 重置</button>
      </div>
      <div class="row" style="margin-top:8px">
        <label>倍率</label>
        <select id="rate">
          ${[0.25, 0.5, 1, 2, 4].map((r) => `<option value="${r}" ${r === this.state.rate ? 'selected' : ''}>${r}×</option>`).join('')}
        </select>
      </div>

      <h2>时间定位</h2>
      <div class="scrubber-row">
        <input type="range" id="scrub" min="0" max="${this.state.playback.duration}" step="0.01" value="0">
        <input type="number" id="time-input" min="0" max="${this.state.playback.duration}" step="0.1" value="0">
      </div>
      <p class="hint">暂停时可直接在右侧输入时间定位；定位与从头播放到该时刻结果完全一致。</p>
      <div class="segment-nav">
        <button id="seg-prev">◀ 接缝/节点前</button>
        <button id="seg-next">接缝/节点后 ▶</button>
      </div>

      <h2>当前状态</h2>
      <div class="readout" id="readout"></div>

      <h2>数值验证（可重复）</h2>
      <div class="row">
        <button id="verify" class="primary" style="flex:1">运行全部检查</button>
      </div>
      <div id="verify-report"></div>
    `;
    this.env.document.getElementById('play')!.onclick = () => this.setPlaying(true);
    this.env.document.getElementById('pause')!.onclick = () => this.setPlaying(false);
    this.env.document.getElementById('reset')!.onclick = () => {
      this.setPlaying(false);
      this.seek(0);
    };
    this.env.document.getElementById('rate')!.onchange = (e) => {
      this.state.rate = Number((e.target as HTMLSelectElement).value);
    };
    const scrub = this.env.document.getElementById('scrub')! as HTMLInputElement;
    scrub.oninput = () => {
      this.setPlaying(false);
      this.seek(Number(scrub.value));
    };
    const timeInput = this.env.document.getElementById('time-input')! as HTMLInputElement;
    timeInput.onchange = () => {
      this.setPlaying(false);
      this.seek(Number(timeInput.value));
    };
    this.env.document.getElementById('seg-prev')!.onclick = () => this.jumpSegment(-1);
    this.env.document.getElementById('seg-next')!.onclick = () => this.jumpSegment(1);
    this.env.document.getElementById('verify')!.onclick = () => this.runVerification();
  }

  // ------------------------------------------------------------------ behavior
  /** Load a generated preset by id. Public so tests and console use can drive it. */
  applyPresetPublic(id: string): void {
    this.applyPreset(id);
  }

  get duration(): number {
    return this.state.playback.duration;
  }

  private applyPreset(id: string, initial = false): void {
    const factory = ALL_PRESETS.find((f) => f().id === id)!;
    const preset: Preset = factory();
    this.state.path = {
      mode: preset.path.mode,
      tension: preset.path.tension,
      controlPoints: preset.path.controlPoints.map((v) => v.clone()),
    };
    this.state.playback = {
      speedMode: preset.playback.speedMode,
      lookMode: preset.playback.lookMode,
      duration: preset.playback.duration,
      timeKnots: preset.playback.timeKnots.map((k) => ({ ...k })),
      target: preset.playback.target.clone(),
    };
    this.state.activePresetId = id;
    this.state.currentTime = 0;
    this.state.playing = false;
    if (!initial) this.afterConfigChange();
    else {
      this.rebuildRig();
      this.renderLeftPanel();
    }
  }

  private afterConfigChange(rebuildPanels = true): void {
    this.rebuildRig();
    if (rebuildPanels) this.renderLeftPanel();
    else this.renderKnotTable();
    this.renderRightPanel();
    this.refreshPathVisual();
    this.refreshTarget();
    this.seek(Math.min(this.state.currentTime, this.state.playback.duration));
  }

  private rebuildRig(): void {
    this.rig = new CameraRig(this.state.path, this.state.playback);
  }

  private handlePointDrag(index: number, worldPos: THREE.Vector3): void {
    this.state.path.controlPoints[index].copy(worldPos);
    // Live rebuild so both views update while dragging.
    this.rebuildRig();
    this.refreshPathVisual();
    this.seek(this.state.currentTime);
  }

  private handleTargetDrag(p: THREE.Vector3): void {
    this.state.playback.target.copy(p);
    this.rebuildRig();
    this.refreshTarget();
    this.seek(this.state.currentTime);
    const tx = this.env.document.getElementById('tx') as HTMLInputElement | null;
    if (tx) {
      tx.value = p.x.toFixed(2);
      (this.env.document.getElementById('ty') as HTMLInputElement).value = p.y.toFixed(2);
      (this.env.document.getElementById('tz') as HTMLInputElement).value = p.z.toFixed(2);
    }
  }

  private refreshPathVisual(): void {
    const pts = this.state.path.controlPoints;
    const dense: THREE.Vector3[] = [];
    for (let i = 0; i <= DENSE; i++) {
      dense.push(this.rig.path.positionAt(i / DENSE));
    }
    this.overview.updatePath(pts, this.state.path.mode === 'closed', dense);
    this.overview.setTargetVisible(this.state.playback.lookMode === 'target');
  }

  private refreshTarget(): void {
    this.overview.updateTarget(this.state.playback.target);
    this.overview.setTargetVisible(this.state.playback.lookMode === 'target');
  }

  setPlaying(v: boolean): void {
    this.state.playing = v;
    const play = this.env.document.getElementById('play') as HTMLButtonElement | null;
    if (play) play.classList.toggle('active', v);
    // At the end of an open path, restart from 0.
    if (v && this.state.currentTime >= this.state.playback.duration && this.state.path.mode === 'open') {
      this.seek(0);
    }
  }

  /** Stateless seek: evaluator returns the exact pose for this time. */
  seek(t: number): void {
    const d = this.state.playback.duration;
    this.state.currentTime = THREE.MathUtils.clamp(t, 0, d);
    const sample = this.rig.sampleAt(this.state.currentTime);
    this.overview.gizmo.update(sample);
    this.overview.gizmo.setHeld(sample.targetHeld);
    this.preview.applySample(sample);
    this.updateReadout(sample);
    const scrub = this.env.document.getElementById('scrub') as HTMLInputElement | null;
    const timeInput = this.env.document.getElementById('time-input') as HTMLInputElement | null;
    if (scrub) {
      scrub.max = String(d);
      scrub.value = this.state.currentTime.toFixed(3);
    }
    if (timeInput) {
      timeInput.max = String(d);
      timeInput.value = this.state.currentTime.toFixed(3);
    }
  }

  private updateReadout(s: CameraSample): void {
    const el = this.env.document.getElementById('readout');
    if (!el) return;
    const f3 = (v: THREE.Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
    const deg = (r: number) => `${THREE.MathUtils.radToDeg(r).toFixed(1)}°`;
    el.innerHTML = `
      <div><span class="k">时间 t</span><span class="v">${s.time.toFixed(3)} s</span> / ${this.state.playback.duration}s</div>
      <div><span class="k">路程进度</span><span class="v">${(s.progress * 100).toFixed(2)}%</span></div>
      <div><span class="k">已走路程</span><span class="v">${s.arcLength.toFixed(3)} m</span> / ${this.rig.path.totalLength.toFixed(3)} m</div>
      <div><span class="k">位置</span><span class="v">${f3(s.position)}</span></div>
      <div><span class="k">切线 T</span><span class="v">${f3(s.tangent)}</span></div>
      <div><span class="k">上方向 Y</span><span class="v">${f3(s.up)}</span></div>
      <div><span class="k">右方向 X</span><span class="v">${f3(s.right)}</span></div>
      <div><span class="k">欧拉角</span><span class="v">${deg(s.euler.x)} / ${deg(s.euler.y)} / ${deg(s.euler.z)}</div>
      <div><span class="k">当前速度</span><span class="v">${this.rig.speedAtTime(s.time).toFixed(3)} m/s</span></div>
      <div><span class="k">目标重合</span>${s.targetHeld ? '<span class="held-badge">保持最近有效朝向</span>' : '<span class="v">否</span>'}</div>`;
  }

  /** Jump to the previous/next notable instant: time-curve knots or seam. */
  private jumpSegment(dir: -1 | 1): void {
    const d = this.state.playback.duration;
    const candidates: number[] = [];
    if (this.state.path.mode === 'closed') candidates.push(0, d);
    if (this.state.playback.speedMode === 'timed') {
      candidates.push(...this.state.playback.timeKnots.map((k) => k.t));
    } else {
      // Even in constant mode offer quartile marks for seam/segment review.
      for (let i = 0; i <= 4; i++) candidates.push((i / 4) * d);
    }
    const unique = [...new Set(candidates.map((t) => Number(t.toFixed(4))))].sort((a, b) => a - b);
    const cur = this.state.currentTime;
    let target: number;
    if (dir > 0) {
      target = unique.find((t) => t > cur + 1e-6) ?? unique[0];
    } else {
      target = [...unique].reverse().find((t) => t < cur - 1e-6) ?? unique[unique.length - 1];
    }
    this.setPlaying(false);
    this.seek(target);
  }

  private exportJson(): void {
    const doc = buildExport(this.rig, { intervalSeconds: this.state.exportInterval });
    downloadJson(doc, `camera-dolly-${this.state.activePresetId}-${this.state.playback.speedMode}.json`);
  }

  private runVerification(): void {
    const report: VerificationReport = runAllChecks(
      this.state.activePresetId,
      this.state.path,
      this.state.playback,
    );
    const host = this.env.document.getElementById('verify-report')!;
    host.innerHTML = `
      <div class="summary">
        <span class="${report.failed === 0 ? 'ok' : 'bad'}">
          ${report.failed === 0 ? '✓ 全部通过' : `✗ ${report.failed} 项失败`}
        </span>
        （${report.passed}/${report.checks.length}）
      </div>
      ${report.checks
        .map(
          (c) => `
        <div class="check ${c.pass ? 'pass' : 'fail'}">
          <div class="head"><span>${c.label}</span><span class="status">${c.pass ? 'PASS' : 'FAIL'}</span></div>
          <div class="measure">${Object.entries(c.measurements)
            .map(([k, v]) => `${k}: <b>${v}</b>`)
            .join('　')}</div>
          <div class="detail">${c.detail}</div>
        </div>`,
        )
        .join('')}`;
  }

  // --------------------------------------------------------------------- loop
  private loop = (wall: number): void => {
    if (this.lastWall === 0) this.lastWall = wall;
    const dt = Math.min(0.1, (wall - this.lastWall) / 1000);
    this.lastWall = wall;

    if (this.state.playing) {
      const d = this.state.playback.duration;
      let next = this.state.currentTime + dt * this.state.rate;
      if (this.state.path.mode === 'closed') {
        // Loop forever on closed paths.
        next = ((next % d) + d) % d;
        this.seek(next);
      } else if (next >= d) {
        // Open path: stop exactly at the end.
        this.seek(d);
        this.setPlaying(false);
      } else {
        this.seek(next);
      }
    }

    this.overview.render();
    this.preview.render();
    this.raf = this.env.requestAnimationFrame(this.loop);
  };

  dispose(): void {
    this.env.cancelAnimationFrame(this.raf);
    this.overview.dispose();
    this.preview.dispose();
  }
}

// Re-export so the entry module stays thin.
export { CameraPath };
