/**
 * 单台投影机输出预览: 在其输出分辨率画布上绘制
 * 测试图裁剪段 × 融合权重(× 亮度), 即这台机器实际投射的画面。
 */
import { bakeOutput } from '../core/blend.ts';
import { buildView } from '../core/view.ts';
import { computeOverlap } from '../core/blend.ts';
import type { AppState } from './state.ts';
import type { ProjectorState } from '../core/types.ts';

export class OutputPreview {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;
  }

  /**
   * @param st 本机状态
   * @param other 另一台(用于求重叠/权重)
   */
  render(st: ProjectorState, other: ProjectorState, blendRatio: number): void {
    const w = st.outputWidth;
    const h = st.outputHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const view = buildView(st);
    const overlap = computeOverlap(st.quad, other.quad);
    const rgba = bakeOutput(
      { ...view, brightness: 1 }, // 预览只展示几何权重, 亮度用面板数值另标
      view.forwardH,
      other.quad,
      w,
      h,
      blendRatio,
      overlap,
    );
    this.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);

    // 四角顺序标注(便于和幕布手柄对应)
    this.ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(1, 1, w - 2, h - 2);
    const labels = ['TL(1)', 'TR(2)', 'BR(3)', 'BL(4)'];
    const pos = [
      [8, 18],
      [w - 70, 18],
      [w - 70, h - 10],
      [8, h - 10],
    ];
    this.ctx.font = 'bold 14px monospace';
    this.ctx.fillStyle = 'rgba(255,255,255,0.95)';
    labels.forEach((t, i) => this.ctx.fillText(t, pos[i][0], pos[i][1]));
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}

export function refreshAllPreviews(
  state: AppState,
  previews: OutputPreview[],
): void {
  previews.forEach((pv, i) => {
    pv.render(state.projectors[i], state.projectors[1 - i], state.blendRatio);
  });
}
