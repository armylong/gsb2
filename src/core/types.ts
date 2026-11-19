/**
 * 基础类型定义。
 *
 * 坐标系：x 向右增大、y 向下增大；地基 = 网格最底行 (y === height - 1)。
 * 所有形状均用整数格坐标表示，不使用多边形。
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** 一次编辑对网格造成的变化，便于统计与预览。 */
export interface EditResult {
  /** 实际被挖除的静态格数（原本实心 -> 空）。 */
  removed: number;
  /** 实际被补入的静态格数（原本空 -> 实心）。 */
  added: number;
  /** 作用范围内、参与判断的全部格坐标（含越界裁剪后的有效部分）。 */
  affected: ReadonlyArray<Cell>;
}

export interface Cell {
  x: number;
  y: number;
}

/** 格子归属，供暂停时逐格检查。 */
export type Owner =
  | { kind: 'empty' }
  | { kind: 'static'; componentId: number }
  | { kind: 'fragment'; fragmentId: number };

/** 连通块标注结果。 */
export interface ComponentLabeling {
  /** compIdAt[y][x]：0 表示空，>=1 表示连通块编号。 */
  compIdAt: Int16Array[];
  /** 连通块编号 -> 格数。 */
  sizes: Map<number, number>;
  /** 与底部地基连通的连通块编号集合。 */
  grounded: Set<number>;
  /** 连通块总数（编号 1..count 连续）。 */
  count: number;
}
