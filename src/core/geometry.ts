import type { Coord, Orientation, StencilDef } from './types';

/** 把朝向规范到 0..3；翻面不改变归一化结果。 */
export function normalizeOrientation(o: Orientation): Orientation {
  return { rotation: ((o.rotation % 4) + 4) % 4, flipped: o.flipped };
}

/**
 * 单个孔位的朝向变换：先以定位点为轴左右翻面，再顺时针旋转。
 * 返回的是相对定位点的偏移，可以为负。
 */
export function transformHole(hole: Coord, orientation: Orientation): Coord {
  const o = normalizeOrientation(orientation);
  let x = o.flipped ? -hole.x : hole.x;
  let y = hole.y;
  for (let i = 0; i < o.rotation; i += 1) {
    const nx = -y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return { x, y };
}

/** 模板在当前朝向下覆盖到的棋盘坐标。 */
export function mapHoles(stencil: StencilDef, pivot: Coord, orientation: Orientation): Coord[] {
  return stencil.holes.map((hole) => {
    const local = transformHole(hole, orientation);
    return { x: pivot.x + local.x, y: pivot.y + local.y };
  });
}

export function orientationLabel(o: Orientation): string {
  const n = normalizeOrientation(o);
  const degree = n.rotation * 90;
  return n.flipped ? `翻面 · 旋 ${degree}°` : `旋 ${degree}°`;
}

export function rotateClockwise(o: Orientation): Orientation {
  return normalizeOrientation({ rotation: o.rotation + 1, flipped: o.flipped });
}

export function flipOrientation(o: Orientation): Orientation {
  return { rotation: normalizeOrientation(o).rotation, flipped: !o.flipped };
}

export function sameCoord(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function coordsEqual(a: Coord[], b: Coord[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a.map(coordKey));
  return b.every((c) => set.has(coordKey(c)));
}

/** 模板八个朝向下去重后的孔位轮廓，用于关卡设计与卡片预览。 */
export function uniqueOrientations(
  stencil: StencilDef,
  pivot: Coord = { x: 0, y: 0 },
): { orientation: Orientation; cells: Coord[] }[] {
  const seen = new Set<string>();
  const out: { orientation: Orientation; cells: Coord[] }[] = [];
  for (const flipped of [false, true]) {
    for (let rotation = 0; rotation < 4; rotation += 1) {
      const orientation = { rotation, flipped };
      const cells = mapHoles(stencil, pivot, orientation);
      const key = cells.map(coordKey).sort().join(';');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ orientation, cells });
    }
  }
  return out;
}

/** 孔位相对定位点的包围盒，含负偏移。 */
export function stencilBounds(holes: Coord[]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = holes.map((h) => h.x);
  const ys = holes.map((h) => h.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}
