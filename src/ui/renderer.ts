// Canvas 绘制层：应用主画布与 PNG 离屏导出共用同一批函数，
// 线宽一律按当前视图像素给定（应用侧线宽固定，与手画速度无关）。

import type { Vec2 } from '../lib/geometry';
import type { Epicycle } from '../lib/dft';
import type { DeviationReport } from '../lib/deviation';
import { THEME, heatColor } from './theme';

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const toView = (vt: ViewTransform, p: Vec2): Vec2 => ({
  x: p.x * vt.scale + vt.offsetX,
  y: p.y * vt.scale + vt.offsetY,
});

export function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = THEME.surface;
  ctx.fillRect(0, 0, w, h);
}

export function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, vt: ViewTransform): void {
  const step = 40;
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const x0 = ((vt.offsetX % step) + step) % step;
  const y0 = ((vt.offsetY % step) + step) % step;
  for (let x = x0; x < w; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = y0; y < h; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

interface PathStyle {
  color: string;
  width: number;
  dash?: number[];
  alpha?: number;
}

/**
 * 开放折线绘制：绝不 closePath —— 重建轨迹到一圈结束时停在最后一个采样点，
 * 不会出现一条跨画布连回首点的线。
 */
export function drawOpenPath(
  ctx: CanvasRenderingContext2D,
  pts: Vec2[],
  vt: ViewTransform,
  style: PathStyle,
): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.globalAlpha = style.alpha ?? 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.beginPath();
  const first = toView(vt, pts[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const q = toView(vt, pts[i]);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** 闭合原线（用于原线参照，显式闭合） */
export function drawClosedPath(
  ctx: CanvasRenderingContext2D,
  pts: Vec2[],
  vt: ViewTransform,
  style: PathStyle,
): void {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.globalAlpha = style.alpha ?? 1;
  ctx.lineJoin = 'round';
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.beginPath();
  const first = toView(vt, pts[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const q = toView(vt, pts[i]);
    ctx.lineTo(q.x, q.y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** 偏差热图：逐段按形变量上色（蓝色顺序色阶），误差越大越亮 */
export function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  report: DeviationReport,
  vt: ViewTransform,
  width: number,
): void {
  const pts = report.points;
  const max = Math.max(report.scaleMax, 1e-9);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const e = (a.shapeError + b.shapeError) / 2 / max;
    ctx.strokeStyle = heatColor(e);
    ctx.beginPath();
    const pa = toView(vt, a.original);
    const pb = toView(vt, b.original);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** 相位起点（接缝）标记：让「跨过首尾」的位置可见 */
export function drawSeamMarker(ctx: CanvasRenderingContext2D, p: Vec2, vt: ViewTransform): void {
  const q = toView(vt, p);
  ctx.save();
  ctx.strokeStyle = THEME.secondary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(q.x - 4, q.y - 4, 8, 8);
  ctx.restore();
}

/**
 * 圆链：圆轮廓 + 半径辐条 + 关节点；
 * 足够大的旋转圆在末端带一个切向箭头，箭头方向 = sign(k)，把旋转方向画出来。
 * k=0 只画中心标记（它不是转动圆）。
 */
export function drawEpicycleChain(
  ctx: CanvasRenderingContext2D,
  chain: Epicycle[],
  vt: ViewTransform,
): void {
  ctx.save();
  for (const c of chain) {
    const o = toView(vt, c.origin);
    const tip = toView(vt, c.tip);
    if (c.k === 0) {
      ctx.fillStyle = THEME.secondary;
      ctx.beginPath();
      ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const rView = c.r * vt.scale;
    // 圆
    ctx.strokeStyle = 'rgba(195,194,183,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(o.x, o.y, rView, 0, Math.PI * 2);
    ctx.stroke();
    // 辐条
    ctx.strokeStyle = 'rgba(195,194,183,0.6)';
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    // 方向箭头（只给看得见的圆画，避免噪点）
    if (rView >= 16) {
      const ang = Math.atan2(tip.y - o.y, tip.x - o.x);
      const tangent = ang + (c.k > 0 ? Math.PI / 2 : -Math.PI / 2);
      const s = 5;
      ctx.fillStyle = THEME.secondary;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(
        tip.x - s * Math.cos(tangent - 0.45),
        tip.y - s * Math.sin(tangent - 0.45),
      );
      ctx.lineTo(
        tip.x - s * Math.cos(tangent + 0.45),
        tip.y - s * Math.sin(tangent + 0.45),
      );
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawTip(ctx: CanvasRenderingContext2D, p: Vec2, vt: ViewTransform, color: string): void {
  const q = toView(vt, p);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = THEME.surface;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** 当前相位下：原线点与重建点之间的位置参照连线 */
export function drawReferencePair(
  ctx: CanvasRenderingContext2D,
  original: Vec2,
  rebuilt: Vec2,
  vt: ViewTransform,
): void {
  const a = toView(vt, original);
  const b = toView(vt, rebuilt);
  ctx.save();
  ctx.strokeStyle = THEME.warning;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = THEME.original;
  ctx.beginPath();
  ctx.arc(a.x, a.y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = THEME.rebuilt;
  ctx.beginPath();
  ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 整体平移向量箭头（偏差视图参照） */
export function drawTranslationArrow(
  ctx: CanvasRenderingContext2D,
  from: Vec2,
  delta: Vec2,
  vt: ViewTransform,
): void {
  if (Math.hypot(delta.x, delta.y) < 1e-6) return;
  const a = toView(vt, from);
  const b = toView(vt, { x: from.x + delta.x, y: from.y + delta.y });
  ctx.save();
  ctx.strokeStyle = THEME.aqua;
  ctx.fillStyle = THEME.aqua;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = 8;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - s * Math.cos(ang - 0.4), b.y - s * Math.sin(ang - 0.4));
  ctx.lineTo(b.x - s * Math.cos(ang + 0.4), b.y - s * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 离屏 PNG 导出渲染：与屏幕渲染共用上述函数，尺寸由参数独立指定 */
export function renderExportScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  vt: ViewTransform,
  scene: {
    original: Vec2[] | null;
    rebuilt: Vec2[] | null;
    chain: Epicycle[] | null;
    heatmap: DeviationReport | null;
  },
): void {
  drawBackground(ctx, w, h);
  drawGrid(ctx, w, h, vt);
  if (scene.heatmap) drawHeatmap(ctx, scene.heatmap, vt, 5);
  if (scene.original) drawClosedPath(ctx, scene.original, vt, {
    color: THEME.original, width: 2, dash: [6, 5], alpha: 0.75,
  });
  if (scene.rebuilt) drawOpenPath(ctx, scene.rebuilt, vt, {
    color: THEME.rebuilt, width: 2.5,
  });
  if (scene.chain) drawEpicycleChain(ctx, scene.chain, vt);
}
