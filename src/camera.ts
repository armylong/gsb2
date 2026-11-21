// 共享轨道相机：纯数据状态，两个对照窗每帧拿到完全相同的 VP 矩阵。
import { v3, type Vec3, type Mat4, mat4LookAt, mat4Perspective } from './gl-matrix';

export const FOV_Y = (55 * Math.PI) / 180;
const NEAR = 0.1;
const FAR = 400;

// 推镜参数：恒定世界速度，足够慢以便观察远处逐帧变化
const DOLLY_SPEED = 1.1; // 世界单位 / 秒
const DOLLY_MIN_DIST = 3.2;
const DOLLY_MAX_SECONDS = 16;

interface CamState {
  target: Vec3;
  yaw: number;
  pitch: number;
  dist: number;
}

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = (8 * Math.PI) / 180;
  dist = 26;

  private dolly: { start: CamState; t: number; playing: boolean } | null = null;
  playing = false;

  private snapshot(): CamState {
    return { target: v3.clone(this.target), yaw: this.yaw, pitch: this.pitch, dist: this.dist };
  }

  private restore(s: CamState): void {
    this.target = v3.clone(s.target);
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.dist = s.dist;
  }

  /** 视线方向单位向量（从 target 指向 eye）。 */
  dir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)];
  }

  eye(): Vec3 {
    return v3.add(this.target, v3.scale(this.dir(), this.dist));
  }

  /** 相机右方向（与地面平行）。 */
  right(): Vec3 {
    const d = this.dir();
    return v3.norm([d[2], 0, -d[0]]);
  }

  /** 相机前进方向（eye 指向 target，水平推进时用）。 */
  forward(): Vec3 {
    return v3.norm(v3.scale(this.dir(), -1));
  }

  getVP(aspect: number): Mat4 {
    const proj = mat4Perspective(FOV_Y, aspect, NEAR, FAR);
    const view = mat4LookAt(this.eye(), this.target, [0, 1, 0]);
    // 列主序矩阵乘法 P*V
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          proj[0 * 4 + r] * view[c * 4 + 0] +
          proj[1 * 4 + r] * view[c * 4 + 1] +
          proj[2 * 4 + r] * view[c * 4 + 2] +
          proj[3 * 4 + r] * view[c * 4 + 3];
      }
    }
    return out;
  }

  rotate(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * 0.005;
    this.pitch = Math.min(
      Math.PI / 2 - 0.02,
      Math.max(0.035, this.pitch - dyPx * 0.004),
    );
  }

  zoom(factor: number): void {
    this.dist = Math.min(120, Math.max(1.6, this.dist * factor));
  }

  pan(dxPx: number, dyPx: number, heightPx: number): void {
    const viewH = 2 * this.dist * Math.tan(FOV_Y / 2);
    const k = viewH / heightPx;
    const r = this.right();
    // 屏幕向上对应世界里的"相机上方投影到地面"的反方向
    const d = this.dir();
    const screenUp = v3.norm(v3.sub([0, 1, 0], v3.scale(d, d[1])));
    const move = v3.add(
      v3.scale(r, -dxPx * k),
      v3.scale(screenUp, dyPx * k),
    );
    this.target = v3.add(this.target, move);
  }

  /** 整体平移 eye 与 target（不足一像素对照位用），取景方向不变。 */
  translate(delta: Vec3): void {
    this.target = v3.add(this.target, delta);
  }

  presetGrazing(): void {
    this.stopDolly();
    this.restore({ target: [0, 0, 0], yaw: 0, pitch: (7.5 * Math.PI) / 180, dist: 27 });
  }

  presetTop(): void {
    this.stopDolly();
    this.restore({ target: [0, 0, 0], yaw: 0, pitch: (88 * Math.PI) / 180, dist: 13 });
  }

  startDolly(): void {
    this.dolly = { start: this.snapshot(), t: 0, playing: true };
    this.playing = true;
  }

  stopDolly(): void {
    this.dolly = null;
    this.playing = false;
  }

  replayDolly(): void {
    if (!this.dolly) this.startDolly();
    else {
      this.restore(this.dolly.start);
      this.dolly.t = 0;
      this.dolly.playing = true;
      this.playing = true;
    }
  }

  get dollyProgress(): number {
    if (!this.dolly) return 0;
    return Math.min(1, this.dolly.t / DOLLY_MAX_SECONDS);
  }

  get isDollyPlaying(): boolean {
    return !!this.dolly?.playing;
  }

  update(dt: number): void {
    if (!this.dolly?.playing) return;
    this.dolly.t += dt;
    // 恒定速度沿视线推进：dist 匀速减小（方向与 target 都不动，即纯推镜）
    const next = this.dist - DOLLY_SPEED * dt;
    if (next <= DOLLY_MIN_DIST || this.dolly.t >= DOLLY_MAX_SECONDS) {
      this.dist = Math.max(DOLLY_MIN_DIST, next);
      this.dolly.playing = false;
      this.playing = false;
      return;
    }
    this.dist = next;
  }
}
