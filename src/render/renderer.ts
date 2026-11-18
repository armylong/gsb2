import type { Block, Camera, Character, EntityId, Scene } from '../core/types';
import { GRID_SIZE, blockAABB, characterAABB, project } from '../core/geometry';
import type { OrderResult } from '../core/ordering';
import { CHAR_DIMENSIONS } from '../core/scene';

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((n & 255) * factor));
  return `rgb(${r},${g},${b})`;
}

export interface RenderOptions {
  selectedId: EntityId | null;
  order: OrderResult;
  hoverCell: { gx: number; gy: number } | null;
  /** 拖动中积木的临时占地（用于红色/绿色预览）。 */
  dragPreview: { block: Block; valid: boolean } | null;
  naiveMode: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(scene: Scene, cam: Camera, opts: RenderOptions): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#20263a';
    ctx.fillRect(0, 0, rect.width, rect.height);

    this.drawGrid(cam);
    this.drawHoverCell(cam, opts.hoverCell);
    this.drawFootprints(scene, cam, opts);

    const boxes = this.sceneBoxes(scene);
    const byId = new Map(boxes.map((b) => [b.id, b]));
    opts.order.order.forEach((id, index) => {
      const e = byId.get(id);
      if (!e) return;
      if (id === 'character') this.drawCharacter(scene.character, cam, id === opts.selectedId, index, opts);
      else {
        const block = scene.blocks.find((b) => b.id === id)!;
        this.drawBlock(block, cam, id === opts.selectedId, index, opts);
      }
    });

    if (opts.dragPreview) this.drawDragPreview(cam, opts.dragPreview);
  }

  private sceneBoxes(scene: Scene): { id: EntityId; box: ReturnType<typeof blockAABB> }[] {
    return [
      ...scene.blocks.map((b) => ({ id: b.id, box: blockAABB(b) })),
      { id: 'character', box: characterAABB(scene.character) },
    ];
  }

  private drawGrid(cam: Camera): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID_SIZE; i++) {
      const a = project({ x: i, y: 0, z: 0 }, cam);
      const b = project({ x: i, y: GRID_SIZE, z: 0 }, cam);
      const c = project({ x: 0, y: i, z: 0 }, cam);
      const d = project({ x: GRID_SIZE, y: i, z: 0 }, cam);
      ctx.strokeStyle = i === 0 || i === GRID_SIZE ? '#3d4a72' : '#2c3554';
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.moveTo(c.sx, c.sy);
      ctx.lineTo(d.sx, d.sy);
      ctx.stroke();
    }
    // 坐标标注
    ctx.fillStyle = '#5a6792';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < GRID_SIZE; i++) {
      const p1 = project({ x: i + 0.5, y: 0, z: 0 }, cam);
      ctx.fillText(String(i), p1.sx, p1.sy - 4);
      const p2 = project({ x: 0, y: i + 0.5, z: 0 }, cam);
      ctx.fillText(String(i), p2.sx - 10, p2.sy + 3);
    }
  }

  private drawHoverCell(cam: Camera, cell: { gx: number; gy: number } | null): void {
    if (!cell || cell.gx < 0 || cell.gy < 0 || cell.gx >= GRID_SIZE || cell.gy >= GRID_SIZE) return;
    const ctx = this.ctx;
    const pts = [
      project({ x: cell.gx, y: cell.gy, z: 0 }, cam),
      project({ x: cell.gx + 1, y: cell.gy, z: 0 }, cam),
      project({ x: cell.gx + 1, y: cell.gy + 1, z: 0 }, cam),
      project({ x: cell.gx, y: cell.gy + 1, z: 0 }, cam),
    ];
    ctx.fillStyle = 'rgba(120,160,255,0.18)';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy)));
    ctx.closePath();
    ctx.fill();
  }

  private drawFootprints(scene: Scene, cam: Camera, opts: RenderOptions): void {
    const ctx = this.ctx;
    for (const b of scene.blocks) {
      const isConflict = opts.order.cycleEntities.includes(b.id) ||
        opts.order.interpenetrations.some((p) => p.a === b.id || p.b === b.id);
      const pts = [
        project({ x: b.x, y: b.y, z: 0 }, cam),
        project({ x: b.x + b.sx, y: b.y, z: 0 }, cam),
        project({ x: b.x + b.sx, y: b.y + b.sy, z: 0 }, cam),
        project({ x: b.x, y: b.y + b.sy, z: 0 }, cam),
      ];
      ctx.fillStyle = isConflict ? 'rgba(255,90,110,0.28)' : 'rgba(255,255,255,0.08)';
      ctx.strokeStyle = isConflict ? '#ff5a6e' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  private poly(pts: { sx: number; sy: number }[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy)));
    ctx.closePath();
  }

  private drawBlock(block: Block, cam: Camera, selected: boolean, orderIndex: number, opts: RenderOptions): void {
    const ctx = this.ctx;
    const b = blockAABB(block);
    const p = (x: number, y: number, z: number) => project({ x, y, z }, cam);
    const isConflict = opts.order.cycleEntities.includes(block.id) ||
      opts.order.interpenetrations.some((pr) => pr.a === block.id || pr.b === block.id);
    const base = isConflict ? '#ff5a6e' : block.color;

    // 南面（y=maxY）
    this.poly([
      p(b.minX, b.maxY, b.maxZ), p(b.maxX, b.maxY, b.maxZ),
      p(b.maxX, b.maxY, b.minZ), p(b.minX, b.maxY, b.minZ),
    ]);
    ctx.fillStyle = shade(base, 0.72);
    ctx.fill();
    // 东面（x=maxX）
    this.poly([
      p(b.maxX, b.minY, b.maxZ), p(b.maxX, b.maxY, b.maxZ),
      p(b.maxX, b.maxY, b.minZ), p(b.maxX, b.minY, b.minZ),
    ]);
    ctx.fillStyle = shade(base, 0.55);
    ctx.fill();
    // 顶面
    this.poly([
      p(b.minX, b.minY, b.maxZ), p(b.maxX, b.minY, b.maxZ),
      p(b.maxX, b.maxY, b.maxZ), p(b.minX, b.maxY, b.maxZ),
    ]);
    ctx.fillStyle = shade(base, 1.05);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,26,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 选中高亮 + 高物体底面位置投影
    if (selected) {
      const groundPts = [
        p(b.minX, b.minY, 0), p(b.maxX, b.minY, 0),
        p(b.maxX, b.maxY, 0), p(b.minX, b.maxY, 0),
      ];
      ctx.strokeStyle = '#ffd76b';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      this.poly(groundPts);
      ctx.stroke();
      ctx.setLineDash([]);
      const center = p((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
      const top = p(b.maxX, b.maxY, b.maxZ);
      ctx.strokeStyle = 'rgba(255,215,107,0.7)';
      ctx.beginPath();
      ctx.moveTo(center.sx, center.sy);
      ctx.lineTo(top.sx, top.sy);
      ctx.stroke();
      ctx.fillStyle = '#ffd76b';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`底面 (${block.x.toFixed(1)}, ${block.y.toFixed(1)})`, center.sx, center.sy + 14);
    }

    // 绘制顺序序号标签
    const labelPos = p(b.minX, b.minY, b.maxZ);
    ctx.fillStyle = 'rgba(15,20,35,0.8)';
    ctx.beginPath();
    ctx.arc(labelPos.sx - 6, labelPos.sy - 6, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = opts.naiveMode && opts.order.naiveViolations.some(
      (r) => r.before === block.id || r.after === block.id,
    ) ? '#ffb86b' : '#cfe0ff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(orderIndex), labelPos.sx - 6, labelPos.sy - 6);
    ctx.textBaseline = 'alphabetic';
  }

  private drawCharacter(c: Character, cam: Camera, selected: boolean, orderIndex: number, opts: RenderOptions): void {
    const ctx = this.ctx;
    const half = CHAR_DIMENSIONS.sx / 2;
    const h = CHAR_DIMENSIONS.h;
    const p = (x: number, y: number, z: number) => project({ x, y, z }, cam);

    // 身体（简化为小长方体 + 头）
    const body = {
      minX: c.x - half, maxX: c.x + half,
      minY: c.y - half, maxY: c.y + half,
      minZ: c.z, maxZ: c.z + h * 0.75,
    };
    const base = '#e0607e';
    this.poly([
      p(body.minX, body.maxY, body.maxZ), p(body.maxX, body.maxY, body.maxZ),
      p(body.maxX, body.maxY, body.minZ), p(body.minX, body.maxY, body.minZ),
    ]);
    ctx.fillStyle = shade(base, 0.75);
    ctx.fill();
    this.poly([
      p(body.maxX, body.minY, body.maxZ), p(body.maxX, body.maxY, body.maxZ),
      p(body.maxX, body.maxY, body.minZ), p(body.maxX, body.minY, body.minZ),
    ]);
    ctx.fillStyle = shade(base, 0.58);
    ctx.fill();
    this.poly([
      p(body.minX, body.minY, body.maxZ), p(body.maxX, body.minY, body.maxZ),
      p(body.maxX, body.maxY, body.maxZ), p(body.minX, body.maxY, body.maxZ),
    ]);
    ctx.fillStyle = shade(base, 1.05);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,26,0.55)';
    ctx.stroke();

    const headCenter = p(c.x, c.y, c.z + h * 0.88);
    const r = cam.k * 0.22;
    ctx.fillStyle = '#f2d3b6';
    ctx.beginPath();
    ctx.arc(headCenter.sx, headCenter.sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,26,0.5)';
    ctx.stroke();

    if (selected) {
      const ground = [
        p(c.x - half, c.y - half, 0), p(c.x + half, c.y - half, 0),
        p(c.x + half, c.y + half, 0), p(c.x - half, c.y + half, 0),
      ];
      ctx.strokeStyle = '#ffd76b';
      ctx.setLineDash([4, 3]);
      this.poly(ground);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const tag = p(c.x, c.y, c.z + h);
    ctx.fillStyle = 'rgba(15,20,35,0.8)';
    ctx.beginPath();
    ctx.arc(tag.sx + 8, tag.sy - 8, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = opts.naiveMode && opts.order.naiveViolations.some(
      (r) => r.before === 'character' || r.after === 'character',
    ) ? '#ffb86b' : '#cfe0ff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(orderIndex), tag.sx + 8, tag.sy - 8);
    ctx.textBaseline = 'alphabetic';
  }

  private drawDragPreview(cam: Camera, preview: { block: Block; valid: boolean }): void {
    const ctx = this.ctx;
    const b = blockAABB(preview.block);
    const p = (x: number, y: number, z: number) => project({ x, y, z }, cam);
    const pts = [
      p(b.minX, b.minY, 0), p(b.maxX, b.minY, 0),
      p(b.maxX, b.maxY, 0), p(b.minX, b.maxY, 0),
    ];
    ctx.fillStyle = preview.valid ? 'rgba(110,220,140,0.25)' : 'rgba(255,90,110,0.3)';
    ctx.strokeStyle = preview.valid ? '#6edc8c' : '#ff5a6e';
    ctx.lineWidth = 1.5;
    this.poly(pts);
    ctx.fill();
    ctx.stroke();
  }
}
