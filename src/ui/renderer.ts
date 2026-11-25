/**
 * 幕布画布渲染: 调用核心引擎逐像素合成, 再叠加四边形轮廓、角点手柄、探针。
 * 屏幕坐标与幕布坐标 1:1(幕布 1600×720), 通过 CSS 缩放适配容器。
 */
import { buildView } from '../core/view.ts';
import {
  renderComposite,
  sampleAt,
  type ProjectorView,
} from '../core/blend.ts';
import { PATTERN_W, PATTERN_H } from '../core/pattern.ts';
import { convexPolygonIntersection } from '../core/geometry.ts';
import type { AppState } from './state.ts';
import type { Point, Quad } from '../core/types.ts';

const HANDLE_R = 9;
const PROJECTOR_COLORS = ['#e5484d', '#3b6fe0'];

export interface RenderHandles {
  /** 命中检测用: 每台投影四个手柄的屏幕圆 */
  hitAreas: Array<{ projectorId: number; corner: number; x: number; y: number; r: number }>;
}

export class ScreenRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lastResult: ReturnType<typeof renderComposite> | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** 命中测试: 返回点中的手柄(投影 id, 角点序号), 否则 null */
  hitHandle(p: Point, state: AppState): { projectorId: number; corner: number } | null {
    for (const st of state.projectors) {
      for (let i = 0; i < 4; i++) {
        const h = st.quad[i];
        if (Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_R + 3) {
          return { projectorId: st.id, corner: i };
        }
      }
    }
    return null;
  }

  /** 点是否落在某台四边形内部(用于整体平移) */
  hitBody(p: Point, state: AppState): number | null {
    // 从后向前, 后绘制的(投影2)优先
    for (let k = state.projectors.length - 1; k >= 0; k--) {
      const st = state.projectors[k];
      if (this.pointInQuad(p, st.quad)) return st.id;
    }
    return null;
  }

  private pointInQuad(p: Point, q: Quad): boolean {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const pi = q[i];
      const pj = q[j];
      const intersect =
        pi.y > p.y !== pj.y > p.y &&
        p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  render(state: AppState, bitmapViews?: Map<number, ProjectorView>): RenderHandles {
    const scale = state.renderScale;
    const w = Math.round(state.screenWidth * scale);
    const h = Math.round(state.screenHeight * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;

    const views = state.projectors.map((st) => {
      const bm = bitmapViews?.get(st.id);
      return bm ?? buildView(st);
    });

    const result = renderComposite({
      width: w,
      height: h,
      scale,
      blendRatio: state.blendRatio,
      p1: views[0],
      p2: views[1],
      mode: state.viewMode,
    });
    this.lastResult = result;
    const img = new ImageData(new Uint8ClampedArray(result.rgba), w, h);
    ctx.putImageData(img, 0, 0);

    // 叠加层按幕布坐标绘制, 用 scale 变换
    ctx.save();
    ctx.scale(scale, scale);

    // 未覆盖区(缝隙/幕布空白)网格底纹提示
    this.drawUncoveredHint(state);

    // 重叠区高亮描边
    const overlap = convexPolygonIntersection([...state.projectors[0].quad], [...state.projectors[1].quad]);
    if (overlap.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(overlap[0].x, overlap[0].y);
      for (let i = 1; i < overlap.length; i++) ctx.lineTo(overlap[i].x, overlap[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      const cx = overlap.reduce((s, p) => s + p.x, 0) / overlap.length;
      const cy = overlap.reduce((s, p) => s + p.y, 0) / overlap.length;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText('重叠融合带', cx, cy);
      ctx.fillText('重叠融合带', cx, cy);
      ctx.textAlign = 'left';
    }

    // 两台四边形轮廓与手柄
    const hitAreas: RenderHandles['hitAreas'] = [];
    state.projectors.forEach((st, idx) => {
      const color = PROJECTOR_COLORS[idx];
      ctx.beginPath();
      ctx.moveTo(st.quad[0].x, st.quad[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(st.quad[i].x, st.quad[i].y);
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 角点手柄 + 序号
      const labels = ['左上', '右上', '右下', '左下'];
      st.quad.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        hitAreas.push({ projectorId: st.id, corner: i, x: p.x, y: p.y, r: HANDLE_R });
        // 角点名标注
        ctx.fillStyle = color;
        ctx.font = '11px sans-serif';
        const lx = p.x + (i === 0 || i === 3 ? -52 : 12);
        const ly = p.y + (i < 2 ? -12 : 20);
        ctx.fillText(`${st.name}·${labels[i]}`, lx, ly);
      });

      // 投影名标在四边形中心
      const cx = st.quad.reduce((s, p) => s + p.x, 0) / 4;
      const cy = st.quad.reduce((s, p) => s + p.y, 0) / 4;
      ctx.fillStyle = color;
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeText(st.name, cx - 24, cy);
      ctx.fillText(st.name, cx - 24, cy);
    });

    // 探针
    this.drawProbes(state, views);

    ctx.restore();
    return { hitAreas };
  }

  private drawUncoveredHint(state: AppState): void {
    const ctx = this.ctx;
    // 幕布边框
    ctx.strokeStyle = 'rgba(120,130,150,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, state.screenWidth - 1, state.screenHeight - 1);
  }

  private drawProbes(state: AppState, views: ProjectorView[]): void {
    const ctx = this.ctx;
    state.probes.forEach((p, idx) => {
      const s = sampleAt(p, views[0], views[1], state.blendRatio, PATTERN_W, PATTERN_H);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = s.in1 || s.in2 ? '#ffd23f' : '#8a8f98';
      ctx.fill();
      ctx.strokeStyle = '#1a1d23';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1a1d23';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), p.x, p.y + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    });
  }

  /** 取幕布坐标在当前合成结果中的数据(探针表用) */
  probeAt(state: AppState, p: Point, bitmapViews?: Map<number, ProjectorView>) {
    const views = state.projectors.map((st) => bitmapViews?.get(st.id) ?? buildView(st));
    return sampleAt(p, views[0], views[1], state.blendRatio, PATTERN_W, PATTERN_H);
  }

  getResult(): ReturnType<typeof renderComposite> | null {
    return this.lastResult;
  }
}
