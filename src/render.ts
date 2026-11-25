/**
 * Canvas 渲染：严格按固定穿线关系绘制，不引入任何物理。
 * 坐标系：y 向下为正，与引擎一致；h = 动滑轮中心相对切线的下垂量。
 */
import {
  H_MAX,
  H_MIN,
  LATCH_BANDS,
  PULLEY_CY,
  PULLEY_R,
  TANGENT_X,
  X_CARRIAGE1,
  X_CARRIAGE2,
  X_FP1,
  X_FP2,
  X_FP3,
  X_LANTERN,
  X_LEFT_ANCHOR,
  X_RIGHT_ANCHOR,
  Y_TANGENT,
} from './geometry.js';
import type { EngineSnapshot } from './model.js';
import type { LatchId } from './model.js';

export const CANVAS_W = 760;
export const CANVAS_H = 640;
const PANEL_TOP = 40;
const PANEL_BOTTOM = Y_TANGENT + H_MAX + 60;

const COL = {
  bg: '#f7f2e7',
  panel: '#efe6d2',
  panelEdge: '#c9b894',
  rope: '#8a5a2b',
  ropeDark: '#6b431f',
  pulley: '#3d3a33',
  pulleyInner: '#d8cfb8',
  carriage: '#5b7a99',
  carriageDark: '#3f5871',
  lantern: '#d97a44',
  lanternDark: '#a8542a',
  paper: '#ffe9c2',
  anchor: '#2e2b25',
  bandFill: 'rgba(96, 138, 116, 0.16)',
  bandEdge: '#608a74',
  latchArmed: '#b8862e',
  latchEngaged: '#c0452f',
  latchIdle: '#9c9384',
  limit: '#b0493a',
  text: '#33302a',
  textDim: '#6f675b',
};

export function draw(ctx: CanvasRenderingContext2D, s: EngineSnapshot, armed: Set<LatchId>): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawCabinet(ctx);
  drawBands(ctx, s, armed);
  drawTravelLimits(ctx);
  drawRope(ctx, s);
  drawFixedPulleys(ctx);
  drawAnchors(ctx);
  drawMovables(ctx, s);
  drawBandLabels(ctx);
}

function drawCabinet(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COL.panel;
  ctx.fillRect(28, PANEL_TOP, CANVAS_W - 56, PANEL_BOTTOM - PANEL_TOP);
  ctx.strokeStyle = COL.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(28, PANEL_TOP, CANVAS_W - 56, PANEL_BOTTOM - PANEL_TOP);
  // 顶部横梁（定滑轮固定处）
  ctx.fillStyle = '#cdbf9f';
  ctx.fillRect(28, PANEL_TOP, CANVAS_W - 56, 26);
  ctx.fillStyle = COL.textDim;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('展柜顶梁（定滑轮固定）', 40, PANEL_TOP + 18);
}

function drawTravelLimits(ctx: CanvasRenderingContext2D): void {
  const yMin = Y_TANGENT + H_MIN;
  const yMax = Y_TANGENT + H_MAX;
  ctx.strokeStyle = COL.limit;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  line(ctx, X_LEFT_ANCHOR - 14, yMin, X_RIGHT_ANCHOR + 14, yMin);
  line(ctx, X_LEFT_ANCHOR - 14, yMax, X_RIGHT_ANCHOR + 14, yMax);
  ctx.setLineDash([]);
  ctx.fillStyle = COL.limit;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`顶限位 h=${H_MIN}`, X_RIGHT_ANCHOR - 78, yMin - 5);
  ctx.fillText(`底限位 h=${H_MAX}`, X_RIGHT_ANCHOR - 78, yMax + 15);
}

function drawBands(ctx: CanvasRenderingContext2D, s: EngineSnapshot, armed: Set<LatchId>): void {
  for (const band of LATCH_BANDS) {
    const y0 = Y_TANGENT + band.hMin;
    const y1 = Y_TANGENT + band.hMax;
    const x0 = X_CARRIAGE1 - 30;
    const x1 = X_CARRIAGE2 + 30;
    ctx.fillStyle = COL.bandFill;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = COL.bandEdge;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);

    // 卡榫本体：画在窗格右侧，状态用颜色区分
    const engaged = s.engagedLatch === band.id;
    const isArmed = armed.has(band.id);
    ctx.fillStyle = engaged ? COL.latchEngaged : isArmed ? COL.latchArmed : COL.latchIdle;
    const cx = x1 + 8;
    const cy = (y0 + y1) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (engaged) {
      // 合上：实心叉
      ctx.moveTo(cx - 3, cy - 3);
      ctx.lineTo(cx + 3, cy + 3);
      ctx.moveTo(cx + 3, cy - 3);
      ctx.lineTo(cx - 3, cy + 3);
    } else {
      // 松开：单点
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
}

function drawBandLabels(ctx: CanvasRenderingContext2D): void {
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  for (const band of LATCH_BANDS) {
    const y0 = Y_TANGENT + band.hMin;
    ctx.fillStyle = COL.bandEdge;
    ctx.fillText(`${band.label} ${band.hMin}–${band.hMax}（阈值|v|≤${band.vMax}）`, X_CARRIAGE1 - 24, y0 - 6);
  }
}

/** 按穿线顺序绘制整条绳（含绕滑轮的半圆弧）。所有竖直段严格落在 TANGENT_X 切线列上。 */
function drawRope(ctx: CanvasRenderingContext2D, s: EngineSnapshot): void {
  const y1 = Y_TANGENT + s.h.carriage1;
  const yL = Y_TANGENT + s.h.lantern;
  const y2 = Y_TANGENT + s.h.carriage2;
  const tx = TANGENT_X;

  ctx.strokeStyle = COL.rope;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  // 列0：左锚点 → 托架1左（下）
  ctx.moveTo(tx[0], Y_TANGENT);
  ctx.lineTo(tx[0], y1);
  // 下绕托架1：列0 → 列1 的下半圆
  ctx.arc(X_CARRIAGE1, y1, PULLEY_R, Math.PI, 0, false);
  // 列1：托架1右 → FP1左（上）
  ctx.lineTo(tx[1], Y_TANGENT);
  // 上绕 FP1：列1 → 列2 的上半圆
  ctx.arc(X_FP1, PULLEY_CY, PULLEY_R, Math.PI, 0, true);
  // 水平段：列2 → 列3
  ctx.lineTo(tx[3], Y_TANGENT);
  // 上绕 FP2：列3 → 列4 的上半圆
  ctx.arc(X_FP2, PULLEY_CY, PULLEY_R, Math.PI, 0, true);
  // 列4：FP2右 → 纸灯左（下）
  ctx.lineTo(tx[4], yL);
  // 下绕纸灯：列4 → 列5
  ctx.arc(X_LANTERN, yL, PULLEY_R, Math.PI, 0, false);
  // 列5：纸灯右 → FP3左（上）
  ctx.lineTo(tx[5], Y_TANGENT);
  // 上绕 FP3：列5 → 列6
  ctx.arc(X_FP3, PULLEY_CY, PULLEY_R, Math.PI, 0, true);
  // 水平段：列6 → 列7
  ctx.lineTo(tx[7], Y_TANGENT);
  // 列7：FP3右 → 托架2左（下）
  ctx.lineTo(tx[7], y2);
  // 下绕托架2：列7 → 列8
  ctx.arc(X_CARRIAGE2, y2, PULLEY_R, Math.PI, 0, false);
  // 列8：托架2右 → 右锚点（上）
  ctx.lineTo(tx[8], Y_TANGENT);
  ctx.stroke();
}

function drawFixedPulleys(ctx: CanvasRenderingContext2D): void {
  for (const x of [X_FP1, X_FP2, X_FP3]) {
    ctx.fillStyle = COL.pulleyInner;
    ctx.beginPath();
    ctx.arc(x, PULLEY_CY, PULLEY_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COL.pulley;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = COL.pulley;
    ctx.beginPath();
    ctx.arc(x, PULLEY_CY, 3, 0, Math.PI * 2);
    ctx.fill();
    // 支架连到顶梁
    ctx.strokeStyle = COL.pulley;
    ctx.lineWidth = 2;
    line(ctx, x, PANEL_TOP + 26, x, PULLEY_CY - PULLEY_R);
  }
}

function drawAnchors(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COL.anchor;
  for (const x of [X_LEFT_ANCHOR, X_RIGHT_ANCHOR]) {
    ctx.fillRect(x - 5, PANEL_TOP + 22, 10, 8);
    ctx.beginPath();
    ctx.arc(x, Y_TANGENT - 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawMovables(ctx: CanvasRenderingContext2D, s: EngineSnapshot): void {
  drawCarriage(ctx, X_CARRIAGE1, Y_TANGENT + s.h.carriage1, s.m.carriage1, s.contacts.carriage1, '托架1');
  drawLantern(ctx, X_LANTERN, Y_TANGENT + s.h.lantern, s.m.lantern, s.engagedLatch !== null);
  drawCarriage(ctx, X_CARRIAGE2, Y_TANGENT + s.h.carriage2, s.m.carriage2, s.contacts.carriage2, '托架2');
}

function drawCarriage(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  mass: number,
  contact: -1 | 1 | null,
  label: string,
): void {
  // 动滑轮
  ctx.fillStyle = COL.pulleyInner;
  ctx.beginPath();
  ctx.arc(cx, cy, PULLEY_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COL.pulley;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = COL.pulley;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  // 托架托盘（滑轮下方）
  const trayW = 46;
  const trayY = cy + PULLEY_R + 6;
  ctx.fillStyle = COL.carriage;
  ctx.fillRect(cx - trayW / 2, trayY, trayW, 8);
  ctx.fillStyle = COL.carriageDark;
  ctx.fillRect(cx - trayW / 2, trayY + 8, trayW, 4);
  // 配重块
  const bw = 16 + mass * 8;
  const bh = 16;
  ctx.fillStyle = COL.carriageDark;
  ctx.fillRect(cx - bw / 2, trayY + 12, bw, bh);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${mass.toFixed(2)}kg`, cx, trayY + 24);
  // 标签与锁状态
  ctx.fillStyle = COL.text;
  ctx.font = '12px sans-serif';
  ctx.fillText(label, cx, cy - PULLEY_R - 8);
  if (contact !== null) {
    ctx.fillStyle = COL.limit;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(contact === -1 ? '🔒顶限位' : '🔒底限位', cx, trayY + 46);
  }
}

function drawLantern(ctx: CanvasRenderingContext2D, cx: number, cy: number, mass: number, latched: boolean): void {
  // 动滑轮
  ctx.fillStyle = COL.pulleyInner;
  ctx.beginPath();
  ctx.arc(cx, cy, PULLEY_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COL.pulley;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = COL.pulley;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  // 纸灯灯罩
  const topY = cy + PULLEY_R + 4;
  const lampH = 46;
  const lampW = 40;
  ctx.fillStyle = COL.paper;
  ctx.strokeStyle = COL.lanternDark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - lampW / 2, topY);
  ctx.quadraticCurveTo(cx - lampW / 2 - 6, topY + lampH / 2, cx - lampW / 2, topY + lampH);
  ctx.lineTo(cx + lampW / 2, topY + lampH);
  ctx.quadraticCurveTo(cx + lampW / 2 + 6, topY + lampH / 2, cx + lampW / 2, topY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 纸灯骨架横线
  ctx.strokeStyle = COL.lantern;
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const yy = topY + (lampH * i) / 4;
    line(ctx, cx - lampW / 2 + 2, yy, cx + lampW / 2 - 2, yy);
  }
  // 上下盖
  ctx.fillStyle = COL.lanternDark;
  ctx.fillRect(cx - 10, topY - 4, 20, 5);
  ctx.fillRect(cx - 8, topY + lampH, 16, 5);
  // 穗子
  ctx.strokeStyle = COL.lanternDark;
  ctx.lineWidth = 1.5;
  line(ctx, cx, topY + lampH + 5, cx, topY + lampH + 16);
  // 标签
  ctx.fillStyle = COL.text;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`纸灯 ${mass.toFixed(2)}kg`, cx, cy - PULLEY_R - 8);
  if (latched) {
    ctx.fillStyle = COL.latchEngaged;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('🔒卡榫锁定', cx, topY + lampH + 30);
  }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
