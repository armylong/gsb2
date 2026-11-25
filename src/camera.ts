/**
 * 相机：世界坐标（米）与画布 CSS 像素的可逆仿射变换。
 * screen = world * scale + offset；world = (screen - offset) / scale。
 * 两个画布共享同一台相机，保证并排结果逐点对齐、取样点不随缩放漂移。
 */
import type { Vec2 } from './types.js';

export class Camera {
  scale = 60; // 像素 / 米
  offsetX = 20;
  offsetY = 20;

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.offsetX, y: p.y * this.scale + this.offsetY };
  }

  toWorld(p: Vec2): Vec2 {
    return { x: (p.x - this.offsetX) / this.scale, y: (p.y - this.offsetY) / this.scale };
  }

  /** 以锚点为中心缩放，锚点的世界坐标保持不动 */
  zoomAt(anchor: Vec2, factor: number): void {
    const before = this.toWorld(anchor);
    this.scale = Math.min(400, Math.max(8, this.scale * factor));
    this.offsetX = anchor.x - before.x * this.scale;
    this.offsetY = anchor.y - before.y * this.scale;
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.offsetX += dxScreen;
    this.offsetY += dyScreen;
  }

  /** 让指定世界矩形适配画布（留边距） */
  fit(rect: { x: number; y: number; w: number; h: number }, cssW: number, cssH: number): void {
    const pad = 28;
    const sx = (cssW - pad * 2) / rect.w;
    const sy = (cssH - pad * 2) / rect.h;
    this.scale = Math.min(sx, sy);
    this.offsetX = (cssW - rect.w * this.scale) / 2 - rect.x * this.scale;
    this.offsetY = (cssH - rect.h * this.scale) / 2 - rect.y * this.scale;
  }
}
