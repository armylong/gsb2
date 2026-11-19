import type { World } from '../core/World';
import type { Cell } from '../core/types';

export type ViewMode = 'component' | 'owner' | 'solid';

export interface Preview {
  cells: readonly Cell[];
  /** 形状中被地图边界裁掉的格（用于“超出地图”提示）。 */
  outOfBounds: readonly Cell[];
  mode: 'dig' | 'fill';
}

export interface RenderOptions {
  cellSize: number;
  viewMode: ViewMode;
  preview: Preview | null;
  selectedFragmentId: number | null;
}

/** 连通块编号 -> 稳定颜色（HSL 均分，编号不变色不变）。 */
function componentColor(id: number, alpha = 1): string {
  const hue = (id * 47 + 15) % 360;
  return `hsla(${hue}, 62%, 52%, ${alpha})`;
}

function fragmentColor(id: number, alpha = 1): string {
  const hue = (id * 89 + 200) % 360;
  return `hsla(${hue}, 80%, 45%, ${alpha})`;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 绘图上下文');
    this.ctx = ctx;
  }

  /** 画布尺寸随格子大小与地图尺寸调整。 */
  resize(cellSize: number, width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(width * cellSize * dpr);
    this.canvas.height = Math.floor(height * cellSize * dpr);
    this.canvas.style.width = `${width * cellSize}px`;
    this.canvas.style.height = `${height * cellSize}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(world: World, opts: RenderOptions): void {
    const { ctx } = this;
    const cs = opts.cellSize;
    const w = world.width * cs;
    const h = world.height * cs;

    ctx.fillStyle = '#0f1420';
    ctx.fillRect(0, 0, w, h);
    this.drawGridLines(w, h, cs, world);

    // 静态格
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        if (world.grid.solid[y][x] !== 1) continue;
        this.drawStaticCell(world, x, y, cs, opts.viewMode);
      }
    }

    // 碎片格（保持原形，按 drop 平移，可能横跨两个像素行）
    for (const f of world.fragments) {
      const selected = opts.selectedFragmentId === f.id;
      for (const c of f.cells) {
        const px = c.x * cs;
        const py = (c.y + f.drop) * cs;
        ctx.fillStyle = fragmentColor(f.id, selected ? 1 : 0.85);
        ctx.fillRect(px + 0.5, py + 0.5, cs - 1, cs - 1);
        if (selected) {
          ctx.strokeStyle = '#ffd54a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 1, py + 1, cs - 2, cs - 2);
        }
      }
      this.drawFragmentLabel(f, cs);
    }

    // 连通块编号与格数（组件视图）
    if (opts.viewMode === 'component') {
      this.drawComponentLabels(world, cs);
    }

    // 地基行加深描边
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, (world.height - 1) * cs);
    ctx.lineTo(w, (world.height - 1) * cs);
    ctx.stroke();

    if (opts.preview) this.drawPreview(world, opts.preview, cs);
  }

  private drawGridLines(w: number, h: number, cs: number, world: World): void {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= world.width; x++) {
      ctx.moveTo(x * cs + 0.5, 0);
      ctx.lineTo(x * cs + 0.5, h);
    }
    for (let y = 0; y <= world.height; y++) {
      ctx.moveTo(0, y * cs + 0.5);
      ctx.lineTo(w, y * cs + 0.5);
    }
    ctx.stroke();
  }

  private drawStaticCell(
    world: World,
    x: number,
    y: number,
    cs: number,
    viewMode: ViewMode,
  ): void {
    const { ctx } = this;
    const px = x * cs;
    const py = y * cs;
    if (viewMode === 'solid') {
      ctx.fillStyle = y === world.height - 1 ? '#5b6478' : '#8a93a8';
      ctx.fillRect(px + 0.5, py + 0.5, cs - 1, cs - 1);
      return;
    }
    const id = world.labeling.compIdAt[y][x];
    const grounded = world.labeling.grounded.has(id);
    if (viewMode === 'owner') {
      ctx.fillStyle = grounded ? '#3d8b4f' : '#c47b2a';
    } else {
      ctx.fillStyle = componentColor(id, grounded ? 0.95 : 0.6);
    }
    ctx.fillRect(px + 0.5, py + 0.5, cs - 1, cs - 1);
  }

  /** 在每个连通块的质心位置标注 “编号:格数”。 */
  private drawComponentLabels(world: World, cs: number): void {
    const { ctx } = this;
    if (cs < 10) return; // 格子太小时不挤文字
    const sums = new Map<number, { sx: number; sy: number; n: number }>();
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const id = world.labeling.compIdAt[y][x];
        if (id === 0) continue;
        const acc = sums.get(id) ?? { sx: 0, sy: 0, n: 0 };
        acc.sx += x;
        acc.sy += y;
        acc.n++;
        sums.set(id, acc);
      }
    }
    ctx.font = `bold ${Math.max(9, cs * 0.55)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [id, acc] of sums) {
      const cx = (acc.sx / acc.n + 0.5) * cs;
      const cy = (acc.sy / acc.n + 0.5) * cs;
      const size = world.labeling.sizes.get(id)!;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const text = `${id}:${size}`;
      ctx.strokeText(text, cx, cy);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, cx, cy);
    }
  }

  private drawFragmentLabel(
    f: World['fragments'][number],
    cs: number,
  ): void {
    if (cs < 10) return;
    const { ctx } = this;
    let sx = 0;
    let sy = 0;
    for (const c of f.cells) {
      sx += c.x;
      sy += c.y + f.drop;
    }
    const cx = (sx / f.cells.length + 0.5) * cs;
    const cy = (sy / f.cells.length + 0.5) * cs;
    ctx.font = `bold ${Math.max(9, cs * 0.55)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    const text = `F${f.id}:${f.size}`;
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(text, cx, cy);
  }

  private drawPreview(world: World, preview: Preview, cs: number): void {
    const { ctx } = this;
    const fill = preview.mode === 'dig' ? 'rgba(255,80,80,0.35)' : 'rgba(90,220,120,0.35)';
    const stroke = preview.mode === 'dig' ? 'rgba(255,120,120,0.9)' : 'rgba(140,255,160,0.9)';
    for (const c of preview.cells) {
      if (!world.grid.inBounds(c.x, c.y)) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(c.x * cs + 1, c.y * cs + 1, cs - 2, cs - 2);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(c.x * cs + 1, c.y * cs + 1, cs - 2, cs - 2);
    }
    // 越界部分：在地图边缘画红色叉号提示“只作用于有效部分”
    ctx.strokeStyle = 'rgba(255,90,90,0.9)';
    ctx.lineWidth = 2;
    for (const c of preview.outOfBounds) {
      const x = Math.min(Math.max(c.x, -0.5), world.width - 0.5) * cs;
      const y = Math.min(Math.max(c.y, -0.5), world.height - 0.5) * cs;
      const r = cs * 0.35;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
    }
  }
}
