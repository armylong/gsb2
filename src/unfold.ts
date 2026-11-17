/**
 * unfold.ts —— 六面十字展开图
 *
 * 十字槽位(全部按规范 r 向右、u 向上摆放):
 *              [+Y]
 *      [-X] [+Z] [+X] [-Z]
 *              [-Y]
 * 该展开中 +Z 为中心,物理共享边在图内直接相邻;折叠到外层的 6 对外边
 * 用同色弧线连接,颜色与边带一致 —— 12 条共享边全部可见、可点击。
 */

import {
  GRID, FACE_LABEL,
  SHARED_EDGES, edgeColor,
  displayTickCorrespondence,
  type FaceId, type FaceEdge, type Side, type TransformMap, type EnvironmentHit,
} from './facemath';
import { TEX_SIZE, edgeBandColor } from './texturegen';

interface Slot { face: FaceId; col: number; row: number }

const SLOTS: Slot[] = [
  { face: 'py', col: 1, row: 0 },
  { face: 'nx', col: 0, row: 1 },
  { face: 'pz', col: 1, row: 1 },
  { face: 'px', col: 2, row: 1 },
  { face: 'nz', col: 3, row: 1 },
  { face: 'ny', col: 1, row: 2 },
];

const TILE = 240;
const PAD = 46;
const COLS = 4;
const ROWS = 3;
export const UNFOLD_W = COLS * TILE + PAD * 2;
export const UNFOLD_H = ROWS * TILE + PAD * 2 + 26;

export interface UnfoldSelection {
  edge: FaceEdge | null;
  cell: { face: FaceId; row: number; col: number } | null;
}

export class UnfoldView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private transforms: TransformMap;
  private faces: Record<FaceId, HTMLCanvasElement>;
  private selection: UnfoldSelection = { edge: null, cell: null };
  private hit: EnvironmentHit | null = null;
  private hover: FaceEdge | null = null;
  onEdgeClick: ((e: FaceEdge) => void) | null = null;
  onFaceClick: ((f: FaceId) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, transforms: TransformMap,
    faces: Record<FaceId, HTMLCanvasElement>) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.transforms = transforms;
    this.faces = faces;
    canvas.width = UNFOLD_W;
    canvas.height = UNFOLD_H;
    canvas.style.aspectRatio = `${UNFOLD_W}/${UNFOLD_H}`;
    canvas.addEventListener('pointermove', (ev) => this.handleMove(ev));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    canvas.addEventListener('click', (ev) => this.handleClick(ev));
  }

  update(transforms: TransformMap, faces: Record<FaceId, HTMLCanvasElement>): void {
    this.transforms = transforms;
    this.faces = faces;
    this.draw();
  }

  setSelection(sel: UnfoldSelection): void { this.selection = sel; this.draw(); }
  setHit(hit: EnvironmentHit | null): void { this.hit = hit; this.draw(); }

  private slotOf(face: FaceId): Slot { return SLOTS.find((s) => s.face === face)!; }
  private tileRect(face: FaceId): { x: number; y: number; w: number; h: number } {
    const s = this.slotOf(face);
    return { x: PAD + s.col * TILE, y: PAD + s.row * TILE, w: TILE, h: TILE };
  }

  /** 边在槽位中的像素矩形(点击热区) */
  private edgeRect(face: FaceId, side: Side): { x: number; y: number; w: number; h: number } {
    const r = this.tileRect(face);
    const b = TILE * 0.09;
    if (side === 'left') return { x: r.x - b / 2, y: r.y, w: b, h: r.h };
    if (side === 'right') return { x: r.x + r.w - b / 2, y: r.y, w: b, h: r.h };
    if (side === 'top') return { x: r.x, y: r.y - b / 2, w: r.w, h: b };
    return { x: r.x, y: r.y + r.h - b / 2, w: r.w, h: b };
  }

  private pickEdge(mx: number, my: number): FaceEdge | null {
    for (const s of SLOTS) {
      for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
        const r = this.edgeRect(s.face, side);
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
          return { face: s.face, side };
        }
      }
    }
    return null;
  }

  private pickFace(mx: number, my: number): FaceId | null {
    for (const s of SLOTS) {
      const r = this.tileRect(s.face);
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return s.face;
    }
    return null;
  }

  private eventPos(ev: MouseEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - box.left) * (this.canvas.width / box.width),
      y: (ev.clientY - box.top) * (this.canvas.height / box.height),
    };
  }

  private handleMove(ev: MouseEvent): void {
    const p = this.eventPos(ev);
    const e = this.pickEdge(p.x, p.y);
    this.canvas.style.cursor = e ? 'pointer' : 'default';
    if ((e?.face !== this.hover?.face) || (e?.side !== this.hover?.side)) {
      this.hover = e;
      this.draw();
    }
  }

  private handleClick(ev: MouseEvent): void {
    const p = this.eventPos(ev);
    const e = this.pickEdge(p.x, p.y);
    if (e) { this.onEdgeClick?.(e); return; }
    const f = this.pickFace(p.x, p.y);
    if (f) this.onFaceClick?.(f);
  }

  /** 带单面变换地绘制一个槽位(翻转 + 顺时针旋转) */
  private drawTransformedTile(face: FaceId): void {
    const r = this.tileRect(face);
    const tr = this.transforms[face];
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    if (tr.flip) ctx.scale(-1, 1);
    if (tr.rot) ctx.rotate((tr.rot * Math.PI) / 2);
    ctx.drawImage(this.faces[face], -r.w / 2, -r.h / 2, r.w, r.h);
    ctx.restore();
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#10141b';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 外层共享边弧线(槽位不相邻的 6 对)
    this.drawOuterConnectors();

    // 槽位瓦片
    for (const s of SLOTS) {
      this.drawTransformedTile(s.face);
      const r = this.tileRect(s.face);
      const tr = this.transforms[s.face];
      const bad = tr.rot !== 0 || tr.flip;
      ctx.strokeStyle = bad ? '#ff5d5d' : '#2a3342';
      ctx.lineWidth = bad ? 3 : 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      // 标题
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = bad ? '#ff8f8f' : '#c8d2e0';
      const tag = bad ? `  ⚠ rot${tr.rot * 90}°${tr.flip ? '+翻转' : ''}` : '';
      ctx.fillText(`${FACE_LABEL[s.face]}${tag}`, r.x + r.w / 2, r.y - 6);
    }

    // 检查点命中的格子高亮
    if (this.hit) {
      const r = this.tileRect(this.hit.face);
      const cw = r.w / GRID;
      const ch = r.h / GRID;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffd23f';
      ctx.strokeRect(r.x + this.hit.col * cw + 2, r.y + this.hit.row * ch + 2, cw - 4, ch - 4);
      if (this.hit.mismatched) {
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = '#ff5d5d';
        ctx.strokeRect(
          r.x + this.hit.canonicalCol * cw + 2,
          r.y + this.hit.canonicalRow * ch + 2, cw - 4, ch - 4,
        );
        ctx.setLineDash([]);
      }
    }

    // 选中的格子
    if (this.selection.cell) {
      const r = this.tileRect(this.selection.cell.face);
      const cw = r.w / GRID;
      const ch = r.h / GRID;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#57d9a3';
      ctx.strokeRect(
        r.x + this.selection.cell.col * cw + 2,
        r.y + this.selection.cell.row * ch + 2, cw - 4, ch - 4,
      );
    }

    // 边高亮:选中边 + 其邻接边,悬停边
    const active = this.selection.edge;
    if (active) {
      const se = SHARED_EDGES.find((s) =>
        (s.a.face === active.face && s.a.side === active.side)
        || (s.b.face === active.face && s.b.side === active.side))!;
      for (const e of [se.a, se.b]) this.highlightEdge(e, edgeColor(se), 5);
    }
    if (this.hover && !(active && active.face === this.hover.face && active.side === this.hover.side)) {
      this.highlightEdge(this.hover, '#ffffff', 2.5);
    }
  }

  private highlightEdge(e: FaceEdge, color: string, width: number): void {
    const r = this.edgeRect(e.face, e.side);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  /** 槽位不相邻的共享边,画同色虚线弧连接 */
  private drawOuterConnectors(): void {
    const ctx = this.ctx;
    for (const se of SHARED_EDGES) {
      if (this.areAdjacentInNet(se.a.face, se.b.face)) continue;
      const a = this.edgeMidpoint(se.a);
      const b = this.edgeMidpoint(se.b);
      const color = edgeColor(se);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      // 控制点向画布外缘偏移,形成弧线
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const outX = cx < this.canvas.width / 2 ? -34 : 34;
      const outY = cy < this.canvas.height / 2 ? -30 : 30;
      ctx.quadraticCurveTo(cx + outX, cy + outY, b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`E${se.id}`, cx + outX * 0.6, cy + outY * 0.6);
      ctx.restore();
    }
  }

  private edgeMidpoint(e: FaceEdge): { x: number; y: number } {
    const r = this.edgeRect(e.face, e.side);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  private areAdjacentInNet(f1: FaceId, f2: FaceId): boolean {
    const a = this.slotOf(f1);
    const b = this.slotOf(f2);
    return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
  }

  /** 供信息面板使用:当前选中边的逐刻度对应表 */
  selectedEdgeTickTable(transforms: TransformMap): { a: FaceEdge; b: FaceEdge; pairs: number[][] } | null {
    const e = this.selection.edge;
    if (!e) return null;
    const se = SHARED_EDGES.find((s) =>
      (s.a.face === e.face && s.a.side === e.side)
      || (s.b.face === e.face && s.b.side === e.side))!;
    const pairs: number[][] = [];
    for (let t = 0; t <= GRID; t++) {
      const p = displayTickCorrespondence(se.a, t, transforms);
      pairs.push([p.tickA, p.tickB]);
    }
    return { a: se.a, b: se.b, pairs };
  }
}

/** 供 3D 视图复用:边带颜色 */
export function bandColor(face: FaceId, side: Side): string {
  return edgeBandColor(face, side);
}

export function texSize(): number { return TEX_SIZE; }
