// ============================================================
// Canvas 渲染层：棋盘 / 色签方块 / 印记 / 阻挡与提示动效
// ============================================================

import {
  Board,
  COLORS,
  ColorId,
  DIR_VEC,
  Dir,
  GameState,
  Progress,
  cellKey,
  faceColor,
} from '../game/engine';
import type { HintAction } from '../game/solver';

export interface RollAnim {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  dir: Dir;
  oriFrom: string;
  start: number;
  dur: number;
}
export interface BumpAnim {
  x: number;
  y: number;
  dir: Dir;
  start: number;
  dur: number;
}
export interface Flash {
  x: number;
  y: number;
  reason: 'wall' | 'stamp';
  start: number;
  dur: number;
}
export interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  start: number;
  dur: number;
}

export interface DrawModel {
  board: Board;
  state: GameState;
  progress: Progress;
  now: number;
  roll: RollAnim | null;
  bump: BumpAnim | null;
  flashes: Flash[];
  floats: FloatText[];
  hintAction: HintAction | null;
  won: boolean;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function hexAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hashAngle(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return (h - Math.floor(h) - 0.5) * 0.12;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  cssW = 0;
  cssH = 0;
  cell = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
  }

  /** 按容器宽度与棋盘宽高比重设像素尺寸（处理 DPR） */
  fit(cols: number, rows: number) {
    const parent = this.canvas.parentElement;
    const avail = parent ? parent.clientWidth : window.innerWidth - 48;
    const w = Math.max(280, Math.floor(avail));
    const h = Math.round((w * rows) / cols);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cssW = w;
    this.cssH = h;
    this.cell = w / cols;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    if (this.cell <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return null;
    const x = Math.floor(px / this.cell);
    const y = Math.floor(py / this.cell);
    if (x < 0 || y < 0) return null;
    return { x, y };
  }

  draw(m: DrawModel) {
    const ctx = this.ctx;
    const { board } = m;
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this.drawBackdrop(board);
    this.drawCells(m);
    this.drawStamps(m);
    this.drawHintUnderCube(m);
    this.drawFlashes(m);
    this.drawCube(m);
    this.drawOccupiedBadge(m);
    this.drawFloats(m);
    if (m.won) this.drawWinTint();
  }

  // ---------- 底板 ----------
  private drawBackdrop(board: Board) {
    const ctx = this.ctx;
    const pad = this.cell * 0.18;
    roundRectPath(
      ctx,
      pad * 0.4,
      pad * 0.4,
      this.cssW - pad * 0.8,
      this.cssH - pad * 0.8,
      this.cell * 0.22,
    );
    ctx.fillStyle = '#ece2cb';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#d8c9a6';
    ctx.stroke();
    void board;
  }

  // ---------- 格子 ----------
  private drawCells(m: DrawModel) {
    const ctx = this.ctx;
    const c = this.cell;
    for (let y = 0; y < m.board.rows; y++) {
      for (let x = 0; x < m.board.cols; x++) {
        const cell = m.board.cells[y][x];
        const px = x * c;
        const py = y * c;
        const g = c * 0.08;
        if (cell.kind === 'wall') {
          this.drawWall(px + g, py + g, c - g * 2, c - g * 2);
        } else {
          // 地板 / 素格 / 目标格共用底砖
          const alt = (x + y) % 2 === 0;
          roundRectPath(ctx, px + g * 0.6, py + g * 0.6, c - g * 1.2, c - g * 1.2, c * 0.14);
          ctx.fillStyle = alt ? '#fbf6e9' : '#f5edd9';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(190,170,130,0.35)';
          ctx.stroke();

          if (cell.kind === 'clean') this.drawCleanMark(px, py, c);
          if (cell.kind === 'slot') this.drawSlotPad(m, cell.slotIndex, px, py, c);
        }
      }
    }
  }

  private drawWall(x: number, y: number, w: number, h: number) {
    const ctx = this.ctx;
    const r = w * 0.18;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, '#525a70');
    grad.addColorStop(1, '#333a4d');
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = grad;
    ctx.fill();
    // 顶部高光 + 砖缝
    roundRectPath(ctx, x + w * 0.12, y + h * 0.12, w * 0.76, h * 0.2, r * 0.6);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1, w * 0.04);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.2, y + h * 0.58);
    ctx.lineTo(x + w * 0.8, y + h * 0.58);
    ctx.stroke();
  }

  private drawCleanMark(px: number, py: number, c: number) {
    const ctx = this.ctx;
    const inset = c * 0.16;
    roundRectPath(ctx, px + inset, py + inset, c - inset * 2, c - inset * 2, c * 0.16);
    ctx.fillStyle = 'rgba(74,189,154,0.10)';
    ctx.fill();
    ctx.setLineDash([c * 0.12, c * 0.09]);
    ctx.lineWidth = Math.max(1.2, c * 0.045);
    ctx.strokeStyle = '#46a98c';
    ctx.stroke();
    ctx.setLineDash([]);
    if (c >= 40) {
      ctx.fillStyle = '#3d947b';
      ctx.font = `700 ${c * 0.3}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('素', px + c / 2, py + c / 2 + c * 0.02);
    }
  }

  private drawSlotPad(m: DrawModel, index: number, px: number, py: number, c: number) {
    const ctx = this.ctx;
    const status = m.progress.slots[index];
    if (!status) return;
    const info = COLORS[status.need];
    const cx = px + c / 2;
    const cy = py + c / 2;
    const rad = c * 0.34;

    // 封口格：菱形外框 + 「封」角标
    if (status.seal) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      roundRectPath(ctx, -rad * 1.18, -rad * 1.18, rad * 2.36, rad * 2.36, c * 0.1);
      ctx.fillStyle = hexAlpha(info.hex, 0.12);
      ctx.fill();
      ctx.lineWidth = Math.max(2, c * 0.07);
      ctx.strokeStyle = info.deep;
      ctx.stroke();
      ctx.restore();
      this.drawSealTag(px + c * 0.78, py + c * 0.2);
    }

    // 要求色环
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = Math.max(2.5, c * 0.085);
    ctx.strokeStyle = info.hex;
    ctx.stroke();

    if (c >= 38) {
      ctx.fillStyle = hexAlpha(info.deep, 0.85);
      ctx.font = `800 ${c * 0.3}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.name, cx, cy + c * 0.02);
    }

    // 已正确盖印：小对勾角标（完整印面在 drawStamps 里）
    if (status.kind === 'right') {
      this.drawCheckBadge(px + c * 0.8, py + c * 0.24, c * 0.16, '#1f9d63');
    } else if (status.kind === 'wrong') {
      this.drawCrossBadge(px + c * 0.8, py + c * 0.24, c * 0.16);
    }
  }

  private drawSealTag(cx: number, cy: number) {
    const ctx = this.ctx;
    const r = this.cell * 0.13;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#c8402a';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${r * 1.15}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('封', cx, cy + r * 0.08);
  }

  private drawCheckBadge(cx: number, cy: number, r: number, color: string) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1.6, r * 0.28);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.42, cy + r * 0.02);
    ctx.lineTo(cx - r * 0.12, cy + r * 0.32);
    ctx.lineTo(cx + r * 0.48, cy - r * 0.34);
    ctx.stroke();
  }

  private drawCrossBadge(cx: number, cy: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#d92d20';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1.6, r * 0.3);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.35, cy - r * 0.35);
    ctx.lineTo(cx + r * 0.35, cy + r * 0.35);
    ctx.moveTo(cx + r * 0.35, cy - r * 0.35);
    ctx.lineTo(cx - r * 0.35, cy + r * 0.35);
    ctx.stroke();
  }

  // ---------- 印记 ----------
  private drawStamps(m: DrawModel) {
    const c = this.cell;
    for (const [k, colorId] of Object.entries(m.state.stamps)) {
      const [xs, ys] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      // 当前方块正压着的印，改到方块右上角顶层画角标（见 drawOccupiedBadge），
      // 否则圆盘会被方块本体完全遮住。
      const occupied = m.state.x === x && m.state.y === y && !m.roll;
      if (occupied) continue;
      this.drawStampDisc(x + 0.5, y + 0.5, c * 0.33, colorId, hashAngle(x, y));
    }
  }

  /** 方块正站在印上时，在其右上角画一枚不被遮挡的印鉴角标 */
  private drawOccupiedBadge(m: DrawModel) {
    if (m.roll) return;
    const colorId = m.state.stamps[cellKey(m.state.x, m.state.y)];
    if (!colorId) return;
    const c = this.cell;
    const cx = m.state.x * c + c * 0.86;
    const cy = m.state.y * c + c * 0.84;
    const r = Math.max(c * 0.17, 7);
    this.drawStampBadge(cx, cy, r, colorId);
  }

  private drawStampDisc(cxGrid: number, cyGrid: number, rad: number, colorId: ColorId, rot: number) {
    const ctx = this.ctx;
    const c = this.cell;
    const cx = cxGrid * c;
    const cy = cyGrid * c;
    const info = COLORS[colorId];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    // 印泥底
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(info.hex, 0.9);
    ctx.fill();
    ctx.lineWidth = Math.max(2, c * 0.05);
    ctx.strokeStyle = hexAlpha(info.deep, 0.9);
    ctx.stroke();
    // 内圈
    ctx.beginPath();
    ctx.arc(0, 0, rad * 0.78, 0, Math.PI * 2);
    ctx.setLineDash([rad * 0.32, rad * 0.18]);
    ctx.lineWidth = Math.max(1.2, c * 0.028);
    ctx.strokeStyle = hexAlpha('#ffffff', 0.75);
    ctx.stroke();
    ctx.setLineDash([]);
    if (c >= 36) {
      ctx.fillStyle = info.ink;
      ctx.font = `900 ${rad * 0.95}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.name, 0, rad * 0.06);
    }
    ctx.restore();
  }

  private drawStampBadge(cx: number, cy: number, r: number, colorId: ColorId) {
    const ctx = this.ctx;
    const info = COLORS[colorId];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = info.hex;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = info.ink;
    ctx.font = `900 ${r * 1.1}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.name, cx, cy + r * 0.08);
  }

  // ---------- 提示 ----------
  private drawHintUnderCube(m: DrawModel) {
    const a = m.hintAction;
    if (!a) return;
    const ctx = this.ctx;
    const c = this.cell;
    const pulse = 0.5 + 0.5 * Math.sin(m.now / 220);

    if (a.type === 'move') {
      const v = DIR_VEC[a.dir];
      const tx = m.state.x + v.dx;
      const ty = m.state.y + v.dy;
      const cx = (tx + 0.5) * c;
      const cy = (ty + 0.5) * c;
      ctx.save();
      ctx.globalAlpha = 0.35 + pulse * 0.4;
      ctx.fillStyle = '#0f9d8f';
      roundRectPath(ctx, tx * c + c * 0.14, ty * c + c * 0.14, c * 0.72, c * 0.72, c * 0.16);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b6e64';
      ctx.font = `900 ${c * 0.4}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const arrow = { N: '↑', E: '→', S: '↓', W: '←' }[a.dir];
      const bounce = Math.sin(m.now / 180) * c * 0.05;
      const off = { N: [0, -bounce], E: [bounce, 0], S: [0, bounce], W: [-bounce, 0] }[a.dir];
      ctx.fillText(arrow, cx + off[0], cy + off[1]);
      ctx.restore();
    } else {
      // stamp：脚下脉冲环
      const cx = (m.state.x + 0.5) * c;
      const cy = (m.state.y + 0.5) * c;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, c * (0.42 + pulse * 0.06), 0, Math.PI * 2);
      ctx.lineWidth = c * 0.07;
      ctx.strokeStyle = hexAlpha('#0f9d8f', 0.55 + pulse * 0.4);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- 阻挡闪烁 ----------
  private drawFlashes(m: DrawModel) {
    const ctx = this.ctx;
    const c = this.cell;
    for (const f of m.flashes) {
      const t = clamp01((m.now - f.start) / f.dur);
      const alpha = 1 - t;
      const cx = (f.x + 0.5) * c;
      const cy = (f.y + 0.5) * c;
      ctx.save();
      if (f.reason === 'wall') {
        // 墙：冷白撞击环
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#eef2ff';
        ctx.lineWidth = c * 0.08;
        const rad = c * (0.2 + t * 0.22);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(226,232,255,${alpha * 0.85})`;
        ctx.font = `900 ${c * 0.26}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('碰', cx, cy);
      } else {
        // 印：朱红禁止环 + 斜杠，明确区别于墙
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#e23c2e';
        ctx.lineWidth = c * 0.09;
        const rad = c * (0.3 + t * 0.08);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - rad * 0.7, cy - rad * 0.7);
        ctx.lineTo(cx + rad * 0.7, cy + rad * 0.7);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ---------- 方块 ----------
  private cubeCenter(m: DrawModel): { cx: number; cy: number; compress: number; axis: Dir | null; hop: number } {
    const c = this.cell;
    let gx = m.state.x;
    let gy = m.state.y;
    let compress = 0;
    let axis: Dir | null = null;
    let hop = 0;

    if (m.roll) {
      const t = clamp01((m.now - m.roll.start) / m.roll.dur);
      const e = easeInOut(t);
      gx = m.roll.fx + (m.roll.tx - m.roll.fx) * e;
      gy = m.roll.fy + (m.roll.ty - m.roll.fy) * e;
      compress = Math.sin(Math.PI * t);
      axis = m.roll.dir;
      hop = Math.sin(Math.PI * t) * c * 0.1;
    }
    let cx = (gx + 0.5) * c;
    let cy = (gy + 0.5) * c - hop;

    if (m.bump) {
      const t = clamp01((m.now - m.bump.start) / m.bump.dur);
      const off = Math.sin(Math.PI * t) * c * 0.16;
      const v = DIR_VEC[m.bump.dir];
      cx += v.dx * off;
      cy += v.dy * off;
      compress = Math.sin(Math.PI * t) * 0.5;
      axis = m.bump.dir;
    }
    return { cx, cy, compress, axis, hop };
  }

  private drawCube(m: DrawModel) {
    const ctx = this.ctx;
    const c = this.cell;
    const { cx, cy, compress, axis } = this.cubeCenter(m);
    const size = c * 0.78;

    // 阴影（不随 hop 移动，简单压在地面）
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.42 + (m.roll ? Math.sin(Math.PI * clamp01((m.now - m.roll.start) / m.roll.dur)) * c * 0.1 : 0), size * 0.46, size * 0.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60,45,20,0.22)';
    ctx.fill();
    ctx.restore();

    // 选择当前要显示的朝向：翻滚前半程旧朝向，后半程新朝向（压缩最扁处切换）
    let ori = m.state.ori;
    if (m.roll) {
      const t = clamp01((m.now - m.roll.start) / m.roll.dur);
      if (t < 0.5) ori = m.roll.oriFrom;
    }

    // 沿运动轴压缩 / 垂直轴膨胀，模拟绕边滚 90°
    let sx = 1;
    let sy = 1;
    if (axis === 'E' || axis === 'W') {
      sx = 1 - 0.34 * compress;
      sy = 1 + 0.07 * compress;
    } else if (axis === 'N' || axis === 'S') {
      sy = 1 - 0.34 * compress;
      sx = 1 + 0.07 * compress;
    }

    const bottom = faceColor(ori, 'B');
    const top = faceColor(ori, 'T');

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sx, sy);

    // 贴地色外环 —— 明确“现在是哪一面贴着纸”
    roundRectPath(ctx, -size * 0.56, -size * 0.56, size * 1.12, size * 1.12, size * 0.24);
    ctx.fillStyle = COLORS[bottom].hex;
    ctx.fill();

    // 本体
    const bodyGrad = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    bodyGrad.addColorStop(0, '#ffffff');
    bodyGrad.addColorStop(1, '#efe7d4');
    roundRectPath(ctx, -size / 2, -size / 2, size, size, size * 0.2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, c * 0.035);
    ctx.strokeStyle = '#5b513c';
    ctx.stroke();

    this.drawSideTabs(ori, size);
    this.drawTopFace(top, size);

    ctx.restore();
  }

  private drawSideTabs(ori: string, size: number) {
    const ctx = this.ctx;
    const tab = size * 0.2;
    const len = size * 0.46;
    const thickness = size * 0.16;
    const fontSize = thickness * 0.82;
    const defs: { slot: 'N' | 'S' | 'E' | 'W'; x: number; y: number; w: number; h: number }[] = [
      { slot: 'N', x: -len / 2, y: -size / 2 + tab * 0.28, w: len, h: thickness },
      { slot: 'S', x: -len / 2, y: size / 2 - tab * 0.28 - thickness, w: len, h: thickness },
      { slot: 'W', x: -size / 2 + tab * 0.28, y: -len / 2, w: thickness, h: len },
      { slot: 'E', x: size / 2 - tab * 0.28 - thickness, y: -len / 2, w: thickness, h: len },
    ];
    for (const d of defs) {
      const colorId = faceColor(ori, d.slot);
      const info = COLORS[colorId];
      roundRectPath(ctx, d.x, d.y, d.w, d.h, thickness * 0.32);
      ctx.fillStyle = info.hex;
      ctx.fill();
      if (size >= 40) {
        ctx.fillStyle = info.ink;
        ctx.font = `800 ${fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const horizontal = d.slot === 'N' || d.slot === 'S';
        const tx = d.x + d.w / 2;
        const ty = d.y + d.h / 2 + fontSize * 0.06;
        if (horizontal) ctx.fillText(info.name, tx, ty);
        else {
          // 左右竖条只在空间足够时写一个字（旋转）
          ctx.save();
          ctx.translate(tx, ty);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(info.name, 0, 0);
          ctx.restore();
        }
      }
    }
  }

  private drawTopFace(top: ColorId, size: number) {
    const ctx = this.ctx;
    const info = COLORS[top];
    const t = size * 0.42;
    roundRectPath(ctx, -t / 2, -t / 2, t, t, size * 0.12);
    const grad = ctx.createLinearGradient(0, -t / 2, 0, t / 2);
    grad.addColorStop(0, hexAlpha(info.hex, 1));
    grad.addColorStop(1, info.deep);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * 0.025);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke();
    ctx.fillStyle = info.ink;
    ctx.font = `900 ${size * 0.26}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.name, 0, size * 0.02);
  }

  // ---------- 漂浮文字 ----------
  private drawFloats(m: DrawModel) {
    const ctx = this.ctx;
    const c = this.cell;
    for (const f of m.floats) {
      const t = clamp01((m.now - f.start) / f.dur);
      const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const y = (f.y + 0.2 - t * 0.5) * c;
      const x = (f.x + 0.5) * c;
      ctx.save();
      ctx.globalAlpha = clamp01(alpha);
      ctx.font = `800 ${c * 0.24}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(f.text).width + c * 0.28;
      roundRectPath(ctx, x - w / 2, y - c * 0.2, w, c * 0.4, c * 0.12);
      ctx.fillStyle = 'rgba(43,38,30,0.92)';
      ctx.fill();
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y + c * 0.02);
      ctx.restore();
    }
  }

  private drawWinTint() {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 236, 170, 0.12)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();
  }
}
