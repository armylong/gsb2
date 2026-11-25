/**
 * Canvas 渲染器：热图（离屏 ImageData 插值放大）+ 场景叠层 + 探针射线。
 * 不处理输入事件，只负责画；两块画布用同一相机与同一曝光，保证可比。
 */
import type { FloorAnalysis, HeatMap, ToolMode, Vec2, WallSegment, World } from './types.js';
import { Camera } from './camera.js';
import { rgbToHex } from './geometry.js';
import { createToneMapper, mapIrradToBytes } from './tonemap.js';

export type HeatMode = 'direct' | 'reflected' | 'total';

export interface HoverInfo {
  kind: 'wall' | 'lamp-a' | 'lamp-b' | 'sample' | 'floor';
  id?: string;
  pos?: Vec2;
}

export interface RenderState {
  world: World;
  camera: Camera;
  heat: HeatMap | null;
  mode: HeatMode;
  exposure: number;
  showHeat: boolean;
  tool: ToolMode;
  selectedSampleId: string | null;
  analysis: FloorAnalysis | null;
  hover: HoverInfo | null;
  draftWall: { a: Vec2; b: Vec2 } | null;
  /** 探针对比面板里“假设关闭”的墙 */
  hypotheticalDisabled: ReadonlySet<string>;
  /** 当前被选中的墙（显示端点手柄） */
  selectedWallId: string | null;
}

const BG = '#1b1d22';
const FLOOR = '#f4f1ea';
const GRID = 'rgba(60,60,70,0.18)';

export class SceneRenderer {
  private offscreen: HTMLCanvasElement | null = null;
  private cacheKey: string | null = null;

  render(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, st: RenderState): void {
    const { camera } = st;
    ctx.save();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);

    const r = st.world.room;
    const r0 = camera.toScreen({ x: r.x, y: r.y });
    const r1 = camera.toScreen({ x: r.x + r.w, y: r.y + r.h });

    // 地面底色
    ctx.fillStyle = FLOOR;
    ctx.fillRect(r0.x, r0.y, r1.x - r0.x, r1.y - r0.y);

    if (st.showHeat && st.heat) this.drawHeat(ctx, st, r0, r1);

    this.drawGrid(ctx, st, r0, r1);

    // 房间外轮廓强调
    ctx.strokeStyle = 'rgba(20,22,26,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r0.x, r0.y, r1.x - r0.x, r1.y - r0.y);

    // 探针射线（在墙之下、地面之上）
    if (st.analysis) this.drawProbeRays(ctx, st);

    for (const w of st.world.walls) this.drawWall(ctx, st, w);
    this.drawLamp(ctx, st);
    this.drawSamples(ctx, st);
    if (st.draftWall) this.drawDraftWall(ctx, st);

    ctx.restore();
  }

  private drawHeat(
    ctx: CanvasRenderingContext2D,
    st: RenderState,
    r0: Vec2,
    r1: Vec2,
  ): void {
    const heat = st.heat!;
    const key = `${heat.quality}-${st.mode}-${heat.cells.length}-${st.exposure}`;
    if (!this.offscreen || this.cacheKey !== key) {
      const off = (this.offscreen ??= document.createElement('canvas'));
      off.width = heat.nx;
      off.height = heat.ny;
      const octx = off.getContext('2d')!;
      const img = octx.createImageData(heat.nx, heat.ny);
      const tm = createToneMapper(st.exposure);
      for (let i = 0; i < heat.cells.length; i++) {
        const cell = heat.cells[i];
        const src =
          st.mode === 'direct'
            ? cell.direct
            : st.mode === 'reflected'
              ? {
                  r: cell.total.r - cell.direct.r,
                  g: cell.total.g - cell.direct.g,
                  b: cell.total.b - cell.direct.b,
                }
              : cell.total;
        mapIrradToBytes(src, tm, img.data, i * 4);
      }
      octx.putImageData(img, 0, 0);
      this.cacheKey = key;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.offscreen, r0.x, r0.y, r1.x - r0.x, r1.y - r0.y);
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, st: RenderState, r0: Vec2, r1: Vec2): void {
    const room = st.world.room;
    const { camera } = st;
    ctx.save();
    ctx.strokeStyle = GRID;
    ctx.fillStyle = 'rgba(40,42,48,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.ceil(room.x); gx <= room.x + room.w; gx++) {
      const s = camera.toScreen({ x: gx, y: 0 });
      ctx.moveTo(s.x, r0.y);
      ctx.lineTo(s.x, r1.y);
      ctx.fillText(`${gx}m`, s.x + 2, r1.y - 4);
    }
    for (let gy = Math.ceil(room.y); gy <= room.y + room.h; gy++) {
      const s = camera.toScreen({ x: 0, y: gy });
      ctx.moveTo(r0.x, s.y);
      ctx.lineTo(r1.x, s.y);
      ctx.fillText(`${gy}m`, r0.x + 3, s.y - 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawWall(ctx: CanvasRenderingContext2D, st: RenderState, w: WallSegment): void {
    const { camera } = st;
    const a = camera.toScreen(w.a);
    const b = camera.toScreen(w.b);
    const hex = rgbToHex(w.color);
    const hypothetical = st.hypotheticalDisabled.has(w.id);
    ctx.save();
    if (!w.enabled) {
      ctx.globalAlpha = 0.3;
      ctx.setLineDash([5, 5]);
    } else if (hypothetical) {
      ctx.setLineDash([9, 6]);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = st.selectedWallId === w.id ? 7 : 5;
    ctx.strokeStyle = hex;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (hypothetical) {
      // 假设关闭：橙色虚线描边提示
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ff9f43';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (st.selectedWallId === w.id) {
      ctx.setLineDash([]);
      for (const p of [a, b]) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2d6cdf';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(p.x - 4, p.y - 4, 8, 8);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawLamp(ctx: CanvasRenderingContext2D, st: RenderState): void {
    const cam = st.camera;
    const a = cam.toScreen(st.world.lamp.a);
    const b = cam.toScreen(st.world.lamp.b);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,214,140,0.9)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 端点手柄（拖动可调灯长）
    for (const p of [a, b]) {
      ctx.fillStyle = '#fff7e0';
      ctx.strokeStyle = '#c98a1a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSamples(ctx: CanvasRenderingContext2D, st: RenderState): void {
    const cam = st.camera;
    for (const sp of st.world.samples) {
      const p = cam.toScreen(sp.pos);
      const selected = sp.id === st.selectedSampleId;
      ctx.save();
      ctx.fillStyle = selected ? '#2d6cdf' : 'rgba(45,108,223,0.85)';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, selected ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (selected) {
        ctx.strokeStyle = 'rgba(45,108,223,0.5)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawProbeRays(ctx: CanvasRenderingContext2D, st: RenderState): void {
    const a = st.analysis!;
    const cam = st.camera;
    const origin = cam.toScreen(a.pos);
    const alpha = a.raysUsed > 300 ? 0.05 : 0.12;
    ctx.save();
    ctx.lineWidth = 1;
    for (const ray of a.rays) {
      const ex = origin.x + Math.cos(ray.angle) * ray.dist * cam.scale;
      const ey = origin.y + Math.sin(ray.angle) * ray.dist * cam.scale;
      if (ray.kind === 'lamp') ctx.strokeStyle = `rgba(255,209,102,${alpha + 0.1})`;
      else if (ray.kind === 'wall') {
        const w = st.world.walls.find((x) => x.id === ray.wallId);
        ctx.strokeStyle = w
          ? this.hexWithAlpha(rgbToHex(w.color), alpha + 0.08)
          : `rgba(150,150,150,${alpha})`;
      } else ctx.strokeStyle = `rgba(120,120,130,${alpha * 0.6})`;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    ctx.restore();
  }

  private hexWithAlpha(hex: string, alpha: number): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  private drawDraftWall(ctx: CanvasRenderingContext2D, st: RenderState): void {
    const a = st.camera.toScreen(st.draftWall!.a);
    const b = st.camera.toScreen(st.draftWall!.b);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#2d6cdf';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}
