import type { ChartRect, PackedAtlas, SurfaceDef } from './types.js';

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PackItem {
  surfaceId: string;
  w: number;
  h: number;
}

/**
 * MaxRects 装箱（BSSF：best short side fit），不旋转。
 * 纯确定性算法：相同输入必然得到相同矩形，用于「同设置可重建」校验。
 */
function maxRectsPack(size: number, items: PackItem[]): { placed: (ChartRect | null)[] } {
  const free: FreeRect[] = [{ x: 0, y: 0, w: size, h: size }];
  const placed: (ChartRect | null)[] = new Array(items.length).fill(null);

  const split = (rect: FreeRect, ux: number, uy: number, uw: number, uh: number): FreeRect[] => {
    // 标准 MaxRects：把与已用矩形相交的空闲矩形切成最多 4 条余量
    const out: FreeRect[] = [];
    if (rect.x < ux) {
      out.push({ x: rect.x, y: rect.y, w: ux - rect.x, h: rect.h });
    }
    if (rect.x + rect.w > ux + uw) {
      out.push({ x: ux + uw, y: rect.y, w: rect.x + rect.w - (ux + uw), h: rect.h });
    }
    if (rect.y < uy) {
      out.push({ x: rect.x, y: rect.y, w: rect.w, h: uy - rect.y });
    }
    if (rect.y + rect.h > uy + uh) {
      out.push({ x: rect.x, y: uy + uh, w: rect.w, h: rect.y + rect.h - (uy + uh) });
    }
    return out;
  };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    let best: FreeRect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const rect of free) {
      if (rect.w >= item.w && rect.h >= item.h) {
        const left = rect.w - item.w;
        const top = rect.h - item.h;
        const shortSide = Math.min(left, top);
        const longSide = Math.max(left, top);
        if (shortSide < bestShort || (shortSide === bestShort && longSide < bestLong)) {
          bestShort = shortSide;
          bestLong = longSide;
          best = rect;
        }
      }
    }
    if (!best) continue; // 装不下，留给 overflow

    const sx = best.x;
    const sy = best.y;
    const chart: ChartRect = {
      surfaceId: item.surfaceId,
      x: sx,
      y: sy,
      w: item.w,
      h: item.h,
      uv: { u0: 0, v0: 0, u1: 0, v1: 0 },
    };

    // 拆分与占用矩形相交的所有空闲矩形
    const next: FreeRect[] = [];
    for (const rect of free) {
      if (
        sx >= rect.x + rect.w ||
        sx + item.w <= rect.x ||
        sy >= rect.y + rect.h ||
        sy + item.h <= rect.y
      ) {
        next.push(rect); // 不相交
      } else {
        next.push(...split(rect, sx, sy, item.w, item.h));
      }
    }
    // 剔除被其它空闲矩形包含的冗余矩形
    const pruned = next.filter((a) => {
      for (const b of next) {
        if (a === b) continue;
        if (
          a.x >= b.x &&
          a.y >= b.y &&
          a.x + a.w <= b.x + b.w &&
          a.y + a.h <= b.y + b.h
        ) {
          return false;
        }
      }
      return true;
    });
    free.length = 0;
    free.push(...pruned);
    placed[idx] = chart;
  }
  return { placed };
}

/**
 * 为一组采样面生成互不重叠的图集区域。
 * @param paddingPx 每个 chart 四周保留的扩张边距（像素），缓解接缝渗色
 */
export function packAtlas(
  surfaces: SurfaceDef[],
  atlasSize: number,
  texelsPerUnit: number,
  paddingPx: number,
): PackedAtlas {
  // 面积大的先装，面积相同按 id 保证确定性
  const ordered = surfaces
    .map((s, originalIndex) => ({
      surface: s,
      originalIndex,
      w: Math.max(2, Math.ceil(s.width * texelsPerUnit)),
      h: Math.max(2, Math.ceil(s.height * texelsPerUnit)),
    }))
    .sort((a, b) => b.w * b.h - a.w * a.h || a.surface.id.localeCompare(b.surface.id));

  const items: PackItem[] = ordered.map((o) => ({
    surfaceId: o.surface.id,
    w: o.w + paddingPx * 2,
    h: o.h + paddingPx * 2,
  }));

  const { placed } = maxRectsPack(atlasSize, items);
  const rects: ChartRect[] = [];
  const overflow: string[] = [];

  ordered.forEach((o, i) => {
    const chart = placed[i];
    if (!chart) {
      overflow.push(o.surface.id);
      return;
    }
    // 去掉 padding，得到实际纹素矩形
    const x = chart.x + paddingPx;
    const y = chart.y + paddingPx;
    const w = o.w;
    const h = o.h;
    rects[o.originalIndex] = {
      surfaceId: o.surface.id,
      x,
      y,
      w,
      h,
      uv: {
        u0: (x + 0.5) / atlasSize,
        v0: 1 - (y + h - 0.5) / atlasSize,
        u1: (x + w - 0.5) / atlasSize,
        v1: 1 - (y + 0.5) / atlasSize,
      },
    };
  });

  return { size: atlasSize, rects: rects.filter(Boolean), overflow };
}

/** 断言：任意两个 chart（含 padding）互不重叠，验证命令会调用 */
export function assertNoOverlap(atlas: PackedAtlas, paddingPx: number): void {
  const boxes = atlas.rects.map((r) => ({
    id: r.surfaceId,
    x0: r.x - paddingPx,
    y0: r.y - paddingPx,
    x1: r.x + r.w + paddingPx,
    y1: r.y + r.h + paddingPx,
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
      if (overlap) {
        throw new Error(`图集区域重叠: ${a.id} 与 ${b.id}`);
      }
    }
  }
}
