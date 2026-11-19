import type { Cell } from './types';

/**
 * 独立碎片：保持原始形状，只做竖直下落。
 * cells 为转出瞬间的绝对整数格坐标（已从静态网格删除），
 * drop 为累计下落距离（单位：格，运行时为浮点，停住时必为整数）。
 */
export class Fragment {
  readonly id: number;
  readonly cells: readonly Cell[];
  drop: number;

  constructor(id: number, cells: readonly Cell[], drop = 0) {
    this.id = id;
    this.cells = cells;
    this.drop = drop;
  }

  get size(): number {
    return this.cells.length;
  }

  /** 当前视觉/逻辑占据的最低行。 */
  get bottom(): number {
    let m = -Infinity;
    for (const c of this.cells) m = Math.max(m, c.y + this.drop);
    return m;
  }

  /**
   * 当前覆盖的整数行（下落中途可能横跨两行），用于编辑时排除碎片格。
   * 返回的坐标可能与静态网格重叠判断无关——调用方只做归属查询。
   */
  occupiedCells(): Cell[] {
    const out: Cell[] = [];
    for (const c of this.cells) {
      const ry = c.y + this.drop;
      const lo = Math.floor(ry);
      const hi = Math.ceil(ry);
      out.push({ x: c.x, y: lo });
      if (hi !== lo) out.push({ x: c.x, y: hi });
    }
    return out;
  }
}
