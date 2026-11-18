import { LEVELS } from '../math/levels';

export interface HudState {
  desiredDistance: number;
  actualDistance: number;
  safeDistance: number;
  minDistance: number;
  minClearance: number;
  collisionRadius: number;
  constrained: boolean;
  frustumClamped: boolean;
  noSolution: boolean;
  limitingBoxes: string[];
  collisionEnabled: boolean;
  yawDeg: number;
  pitchDeg: number;
  fps: number;
  levelLabel: string;
  waypointIndex: number;
  waypointTotal: number;
  waypointLabel: string;
}

export class Hud {
  private root: HTMLElement;
  private statusEl: HTMLElement;
  private warningEl: HTMLElement;
  private helpEl: HTMLElement;

  // 回调
  onSelectLevel: ((id: string) => void) | null = null;
  onToggleMap: (() => void) | null = null;
  onToggleCollision: (() => void) | null = null;
  onReset: (() => void) | null = null;
  onPrevWaypoint: (() => void) | null = null;
  onNextWaypoint: (() => void) | null = null;
  onRadiusChange: ((r: number) => void) | null = null;
  onNearChange: ((n: number) => void) | null = null;

  constructor() {
    this.root = document.getElementById('hud')!;
    this.root.innerHTML = `
      <div class="hud-card">
        <div class="hud-title">第三人称相机碰撞演示</div>
        <div class="hud-row" id="hud-level-row">
          <label>预设现场</label>
          <div class="btn-group" id="level-buttons"></div>
        </div>
        <div class="hud-grid" id="hud-status"></div>
        <div class="hud-warning" id="hud-warning" hidden>⚠ 受限：当前空间无法容纳最小相机距离，已保持安全姿态</div>
        <div class="hud-row">
          <label>碰撞半径 <span id="radius-val"></span></label>
          <input type="range" id="radius-slider" min="0.05" max="0.8" step="0.01" value="0.32">
        </div>
        <div class="hud-row">
          <label>近裁剪面 <span id="near-val"></span></label>
          <input type="range" id="near-slider" min="0.05" max="0.5" step="0.01" value="0.1">
        </div>
        <div class="hud-row btn-row">
          <button id="btn-map">俯视辅助图 (M)</button>
          <button id="btn-collision">碰撞对照 (C)</button>
          <button id="btn-reset">一键重置 (R)</button>
        </div>
        <div class="hud-row">
          <label>检查路线</label>
          <div class="btn-group">
            <button id="btn-wp-prev">◀ 上一步</button>
            <button id="btn-wp-next">下一步 ▶</button>
          </div>
        </div>
        <div class="hud-waypoint" id="hud-waypoint"></div>
      </div>
      <div class="hud-card hud-help" id="hud-help"></div>
    `;

    this.statusEl = document.getElementById('hud-status')!;
    this.warningEl = document.getElementById('hud-warning')!;
    this.helpEl = document.getElementById('hud-help')!;

    const levelBtns = document.getElementById('level-buttons')!;
    LEVELS.forEach((lv) => {
      const b = document.createElement('button');
      b.textContent = lv.label;
      b.dataset.level = lv.id;
      b.addEventListener('click', () => this.onSelectLevel?.(lv.id));
      levelBtns.appendChild(b);
    });

    document.getElementById('btn-map')!.addEventListener('click', () => this.onToggleMap?.());
    document.getElementById('btn-collision')!.addEventListener('click', () => this.onToggleCollision?.());
    document.getElementById('btn-reset')!.addEventListener('click', () => this.onReset?.());
    document.getElementById('btn-wp-prev')!.addEventListener('click', () => this.onPrevWaypoint?.());
    document.getElementById('btn-wp-next')!.addEventListener('click', () => this.onNextWaypoint?.());

    const slider = document.getElementById('radius-slider') as HTMLInputElement;
    document.getElementById('radius-val')!.textContent = `${parseFloat(slider.value).toFixed(2)}m`;
    slider.addEventListener('input', () => {
      const r = parseFloat(slider.value);
      document.getElementById('radius-val')!.textContent = `${r.toFixed(2)}m`;
      this.onRadiusChange?.(r);
    });

    const nearSlider = document.getElementById('near-slider') as HTMLInputElement;
    document.getElementById('near-val')!.textContent = `${parseFloat(nearSlider.value).toFixed(2)}m`;
    nearSlider.addEventListener('input', () => {
      const n = parseFloat(nearSlider.value);
      document.getElementById('near-val')!.textContent = `${n.toFixed(2)}m`;
      this.onNearChange?.(n);
    });

    this.helpEl.innerHTML = `
      <div class="hud-title-sm">操作说明</div>
      <table class="help-table">
        <tr><td>W A S D / 方向键</td><td>地面移动（贴墙滑动）</td></tr>
        <tr><td>鼠标左键拖拽</td><td>水平 / 俯仰视角</td></tr>
        <tr><td>滚轮</td><td>期望跟随距离</td></tr>
        <tr><td>M</td><td>俯视辅助图开关</td></tr>
        <tr><td>C</td><td>碰撞开关对照</td></tr>
        <tr><td>R</td><td>重置位置与视角</td></tr>
        <tr><td>检查路线按钮</td><td>逐步跳转到航点</td></tr>
      </table>
      <div class="help-note">红色=实际相机与碰撞球，青色空心=期望相机，黄色=观察点，绿色=检查航点。</div>
    `;
  }

  setActiveLevel(id: string): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => {
      b.classList.toggle('active', b.dataset.level === id);
    });
  }

  setMapButton(on: boolean): void {
    document.getElementById('btn-map')!.classList.toggle('active', on);
  }

  setCollisionButton(on: boolean): void {
    const btn = document.getElementById('btn-collision')!;
    btn.classList.toggle('active', on);
    btn.textContent = on ? '碰撞：开启 (C)' : '碰撞：关闭 (C)';
  }

  update(s: HudState): void {
    const rows: Array<[string, string, string?]> = [
      ['期望距离', s.desiredDistance.toFixed(2) + ' m'],
      ['实际距离', s.actualDistance.toFixed(2) + ' m', s.actualDistance < s.desiredDistance - 0.05 ? 'warn' : 'ok'],
      ['碰撞安全距离', s.safeDistance < 0 ? '无合法位姿' : s.safeDistance.toFixed(2) + ' m'],
      ['公布最小距离', s.minDistance.toFixed(2) + ' m'],
      ['实际最小净距', Number.isNaN(s.minClearance) ? '—（冻结安全位姿）' : s.minClearance.toFixed(3) + ' m',
        Number.isNaN(s.minClearance) ? 'warn' : s.minClearance < 0.02 ? 'warn' : 'ok'],
      ['碰撞半径', s.collisionRadius.toFixed(2) + ' m'],
      ['偏航 / 俯仰', `${s.yawDeg.toFixed(0)}° / ${s.pitchDeg.toFixed(0)}°`],
      ['帧率', s.fps.toFixed(0) + ' FPS'],
      ['限制来源', s.limitingBoxes.length ? s.limitingBoxes.join('、') : '—'],
      ['近裁面回退', s.frustumClamped ? '是' : '否'],
    ];
    this.statusEl.innerHTML = rows
      .map(([k, v, cls]) => `<div class="hud-cell"><span class="k">${k}</span><span class="v ${cls ?? ''}">${v}</span></div>`)
      .join('');
    this.warningEl.hidden = !s.constrained;
    document.getElementById('hud-waypoint')!.textContent =
      `航点 ${s.waypointIndex + 1}/${s.waypointTotal}：${s.waypointLabel}`;
  }
}
