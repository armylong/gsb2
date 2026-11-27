// 场景坐标 <-> 画布像素的相机。所有流线 / 起点都以场景坐标存储，
// 相机只负责视图变换；线宽按缩放反比补偿，屏幕上保持好辨认。
import { Vec2, Rect } from '../core/types.js';

export interface CameraOptions {
  width: number;
  height: number;
  scale: number; // 像素 / 场景单位
  center: Vec2; // 视图中心对应的场景坐标
}

export class Camera {
  width: number;
  height: number;
  scale: number;
  center: Vec2;

  constructor(opts: CameraOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.scale = opts.scale;
    this.center = { ...opts.center };
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: this.width / 2 + (p.x - this.center.x) * this.scale,
      y: this.height / 2 + (p.y - this.center.y) * this.scale
    };
  }

  screenToWorld(p: Vec2): Vec2 {
    return {
      x: this.center.x + (p.x - this.width / 2) / this.scale,
      y: this.center.y + (p.y - this.height / 2) / this.scale
    };
  }

  /** 以锚点（屏幕坐标）为中心缩放，锚点下的场景点保持不动 */
  zoomAt(screenAnchor: Vec2, factor: number): void {
    const before = this.screenToWorld(screenAnchor);
    this.scale = Math.min(8, Math.max(0.25, this.scale * factor));
    // 反解 center，使 before 仍投影到 screenAnchor
    this.center = {
      x: before.x - (screenAnchor.x - this.width / 2) / this.scale,
      y: before.y - (screenAnchor.y - this.height / 2) / this.scale
    };
  }

  pan(screenDelta: Vec2): void {
    this.center = {
      x: this.center.x - screenDelta.x / this.scale,
      y: this.center.y - screenDelta.y / this.scale
    };
  }

  /** 屏幕恒定线宽：场景线宽 = 期望像素宽度 / scale */
  worldLineWidth(screenPx: number): number {
    return screenPx / this.scale;
  }

  /** 当前视图覆盖的场景范围（导出 / 调试用） */
  viewRect(): Rect {
    const halfW = this.width / 2 / this.scale;
    const halfH = this.height / 2 / this.scale;
    return {
      xmin: this.center.x - halfW,
      xmax: this.center.x + halfW,
      ymin: this.center.y - halfH,
      ymax: this.center.y + halfH
    };
  }

  toJSON() {
    return { scale: this.scale, center: { ...this.center } };
  }
}
