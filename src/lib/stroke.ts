// 手画采集与闭合质量评估。
// 采集层只记录原始指针点（带时间戳仅用于诊断，不参与取样）；
// 取样统一走 resampleArcLength —— 慢手多产生的事件不会多占采样。

import type { Vec2 } from './geometry';
import { dist, polylineLength } from './geometry';

export interface RawPoint extends Vec2 {
  t: number;
}

export interface ClosureInfo {
  gap: number;
  totalLength: number;
  /** 缺口占整圈周长比例 */
  ratio: number;
  quality: 'closed' | 'loose' | 'open';
  message: string;
}

export type ClosureAction = 'auto-close' | 'bridge-line' | 'keep-open' | 'redraw';

export function assessClosure(raw: RawPoint[]): ClosureInfo {
  if (raw.length < 4) {
    return {
      gap: Infinity, totalLength: 0, ratio: Infinity, quality: 'open',
      message: '点数太少，请按住拖出一整圈封闭线',
    };
  }
  const gap = dist(raw[0], raw[raw.length - 1]);
  const totalLength = polylineLength(raw);
  const ratio = gap / Math.max(totalLength, 1e-9);
  if (ratio <= 0.05) {
    return { gap, totalLength, ratio, quality: 'closed', message: `闭合良好（缺口 ${(ratio * 100).toFixed(1)}% 周长）` };
  }
  if (ratio <= 0.18) {
    return {
      gap, totalLength, ratio, quality: 'loose',
      message: `闭合位置偏差 ${(ratio * 100).toFixed(1)}% 周长：可自动吸附闭合，或加直线桥接`,
    };
  }
  return {
    gap, totalLength, ratio, quality: 'open',
    message: `缺口达周长 ${(ratio * 100).toFixed(1)}%，不像封闭线：请重画，或强制桥接`,
  };
}

/** 按用户选择处理首尾 */
export function applyClosure(raw: RawPoint[], action: ClosureAction): Vec2[] {
  const pts: Vec2[] = raw.map(({ x, y }) => ({ x, y }));
  switch (action) {
    case 'auto-close':
      // 吸附：尾点直接并到首点，闭合处无额外线段
      pts[pts.length - 1] = { ...pts[0] };
      return pts;
    case 'bridge-line':
      // 保留真实路径，仅追加一条首点连线作为桥
      return [...pts, { ...pts[0] }];
    case 'keep-open':
      return pts;
    case 'redraw':
      return [];
  }
}

/** Pointer Events 采集器；把屏幕坐标转换交给外部传入的逆变换 */
export class StrokeCollector {
  private raw: RawPoint[] = [];
  private active = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly toModel: (clientX: number, clientY: number) => Vec2,
    private readonly onUpdate: (raw: RawPoint[]) => void,
    private readonly onEnd: (raw: RawPoint[]) => void,
  ) {
    el.addEventListener('pointerdown', this.handleDown);
    el.addEventListener('pointermove', this.handleMove);
    el.addEventListener('pointerup', this.handleUp);
    el.addEventListener('pointercancel', this.handleUp);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.handleDown);
    this.el.removeEventListener('pointermove', this.handleMove);
    this.el.removeEventListener('pointerup', this.handleUp);
    this.el.removeEventListener('pointercancel', this.handleUp);
  }

  private handleDown = (e: PointerEvent): void => {
    this.active = true;
    this.el.setPointerCapture(e.pointerId);
    this.raw = [{ ...this.toModel(e.clientX, e.clientY), t: performance.now() }];
    this.onUpdate(this.raw);
  };

  private handleMove = (e: PointerEvent): void => {
    if (!this.active) return;
    const p = this.toModel(e.clientX, e.clientY);
    const last = this.raw[this.raw.length - 1];
    // 过滤设备抖动产生的零位移重复点（与速度无关，纯几何去重）
    if (dist(p, last) < 0.5) return;
    this.raw.push({ ...p, t: performance.now() });
    this.onUpdate(this.raw);
  };

  private handleUp = (): void => {
    if (!this.active) return;
    this.active = false;
    this.onEnd(this.raw);
  };
}
