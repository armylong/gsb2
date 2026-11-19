/**
 * overlay.ts — 覆盖在光照场上的 2D 标注层
 *
 * 与 WebGL 画布同尺寸叠放，负责绘制：房间墙体、光源圆盘与照射距离圈、
 * 挡板轮廓/顶点、检查点、非法拖动位置的红色虚像、命中高亮。
 * 所有绘制都经过 worldToScreen 映射，窗口缩放时逻辑读数不变。
 */

import { Circle, Poly } from './renderTypes';
import { Checkpoint, ROOM_H, ROOM_W, WALL } from '../core/presets';
import { Vec2 } from '../core/geometry';

export interface ViewMap {
  scale: number;
  offsetX: number;
  offsetY: number;
  cssW: number;
  cssH: number;
}

/** 900×600 逻辑房间等比适配到显示盒，居中留边 */
export function computeViewMap(cssW: number, cssH: number): ViewMap {
  const pad = 8;
  const scale = Math.min((cssW - pad * 2) / ROOM_W, (cssH - pad * 2) / ROOM_H);
  const drawW = ROOM_W * scale;
  const drawH = ROOM_H * scale;
  return {
    scale,
    offsetX: (cssW - drawW) / 2,
    offsetY: (cssH - drawH) / 2,
    cssW,
    cssH,
  };
}

export function worldToScreen(p: Vec2, m: ViewMap): Vec2 {
  return { x: m.offsetX + p.x * m.scale, y: m.offsetY + p.y * m.scale };
}

export function screenToWorld(p: Vec2, m: ViewMap): Vec2 {
  return { x: (p.x - m.offsetX) / m.scale, y: (p.y - m.offsetY) / m.scale };
}

export interface OverlayState {
  light: Circle;
  /** 光源有效照射距离 */
  range: number;
  /** 拖动中希望移动到但被拒绝的光源位置（虚像） */
  ghostLight: Circle | null;
  polys: Poly[];
  /** 正在拖动的挡板 id */
  dragPolyId: number | null;
  checkpoints: Checkpoint[];
  activeCheckpoint: number;
  pointMode: boolean;
  hover: 'light' | number | null;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, m: ViewMap, s: OverlayState): void {
  ctx.clearRect(0, 0, m.cssW, m.cssH);
  ctx.save();
  ctx.translate(m.offsetX, m.offsetY);
  ctx.scale(m.scale, m.scale);
  ctx.lineJoin = 'round';

  // 房间墙体（内区边界）
  ctx.strokeStyle = '#2b2f38';
  ctx.lineWidth = WALL;
  ctx.strokeRect(WALL / 2, WALL / 2, ROOM_W - WALL, ROOM_H - WALL);

  drawLightRange(ctx, s);
  drawPolys(ctx, s);
  drawCheckpoints(ctx, s);
  drawLight(ctx, s);

  ctx.restore();
}

function drawLightRange(ctx: CanvasRenderingContext2D, s: OverlayState): void {
  if (s.ghostLight) return; // 非法位置时暂停应用，照射圈停在上次有效位置
  ctx.save();
  ctx.setLineDash([10, 7]);
  ctx.beginPath();
  ctx.arc(s.light.c.x, s.light.c.y, s.range, 0, Math.PI * 2);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(217, 164, 0, 0.75)';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(138, 109, 0, 0.9)';
  ctx.fillText(`照射距离 ${Math.round(s.range)}`, s.light.c.x + 10, s.light.c.y - s.range + 4);
  ctx.restore();
}

function drawPolys(ctx: CanvasRenderingContext2D, s: OverlayState): void {
  for (const poly of s.polys) {
    ctx.beginPath();
    poly.verts.forEach((q, i) => {
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    const isDrag = poly.id === s.dragPolyId;
    const isHover = s.hover === poly.id;
    ctx.lineWidth = isDrag ? 3.5 : 2.5;
    ctx.strokeStyle = isDrag ? '#ffb020' : isHover ? '#7aa2ff' : '#1f2733';
    ctx.stroke();
    // 顶点小方块，明示凸多边形边界
    ctx.fillStyle = '#1f2733';
    for (const q of poly.verts) {
      ctx.fillRect(q.x - 3, q.y - 3, 6, 6);
    }
  }
}

function drawCheckpoints(ctx: CanvasRenderingContext2D, s: OverlayState): void {
  s.checkpoints.forEach((cp, i) => {
    const active = i === s.activeCheckpoint;
    ctx.beginPath();
    ctx.arc(cp.p.x, cp.p.y, active ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#ff5d5d' : 'rgba(255, 93, 93, 0.75)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#b91c1c';
    ctx.fillText(cp.name, cp.p.x + 9, cp.p.y - 7);
  });
}

function drawLight(ctx: CanvasRenderingContext2D, s: OverlayState): void {
  // 上次有效光源：实心圆盘（面积）或小圆点（点光源对照）
  const L = s.light;
  if (s.pointMode || L.r <= 0.5) {
    ctx.beginPath();
    ctx.arc(L.c.x, L.c.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd23f';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8a6d00';
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(L.c.x, L.c.y, L.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 210, 63, 0.35)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#d9a400';
    ctx.stroke();
    // 中心点
    ctx.beginPath();
    ctx.arc(L.c.x, L.c.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#8a6d00';
    ctx.fill();
  }

  // 非法虚像：红色虚线圆 + 叉
  if (s.ghostLight) {
    const g = s.ghostLight;
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(g.c.x, g.c.y, Math.max(g.r, 4), 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e11d48';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(g.c.x - 8, g.c.y - 8);
    ctx.lineTo(g.c.x + 8, g.c.y + 8);
    ctx.moveTo(g.c.x + 8, g.c.y - 8);
    ctx.lineTo(g.c.x - 8, g.c.y + 8);
    ctx.stroke();
    ctx.restore();
  }
}
