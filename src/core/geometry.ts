import type { Cell, ItemDef, Placement, Rotation } from './types';

export const cellKey = (c: Cell): string => `${c.col},${c.row}`;

export const sameCell = (a: Cell, b: Cell): boolean =>
  a.col === b.col && a.row === b.row;

export interface Bounds {
  cols: number;
  rows: number;
}

export function boundsOf(cells: Cell[]): Bounds {
  if (cells.length === 0) return { cols: 0, rows: 0 };
  return {
    cols: Math.max(...cells.map((c) => c.col)) + 1,
    rows: Math.max(...cells.map((c) => c.row)) + 1,
  };
}

/** 去重并平移到左上角 (min col = 0, min row = 0) */
export function normalize(cells: Cell[]): Cell[] {
  if (cells.length === 0) return [];
  const minCol = Math.min(...cells.map((c) => c.col));
  const minRow = Math.min(...cells.map((c) => c.row));
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const c of cells) {
    const nc = { col: c.col - minCol, row: c.row - minRow };
    const k = cellKey(nc);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(nc);
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/**
 * 形状顺时针旋转 90°。
 * 输入需已归一化; 若上一级包围盒高为 h, 映射: (col,row) -> (h-1-row, col),
 * 旋转后再归一化(贴齐左上角)。
 */
export function rotateCellsCW(cells: Cell[]): Cell[] {
  const h = boundsOf(cells).rows;
  return normalize(cells.map((c) => ({ col: h - 1 - c.row, row: c.col })));
}

export function addRotation(r: Rotation, delta: number): Rotation {
  return (((r + delta) % 4) + 4) % 4 as Rotation;
}

/**
 * 一次性算出基础形状的四个旋转层级, 所有坐标换算都以它为唯一真相,
 * 保证"同一物理格"在各层级间的对应关系稳定、不会跳到另一侧。
 */
export function rotationLevels(shape: Cell[]): Cell[][] {
  const levels: Cell[][] = [normalize(shape)];
  for (let i = 1; i <= 3; i++) levels.push(rotateCellsCW(levels[i - 1]));
  return levels;
}

export function rotatedShape(shape: Cell[], r: Rotation): Cell[] {
  return rotationLevels(shape)[r];
}

export function shapeBounds(shape: Cell[], r: Rotation): Bounds {
  return boundsOf(rotatedShape(shape, r));
}

/** 基础形状格在第 r 级旋转下的渲染相对坐标 */
export function renderedRelOf(shape: Cell[], r: Rotation, baseCell: Cell): Cell {
  const levels = rotationLevels(shape);
  const idx = levels[0].findIndex((c) => sameCell(c, baseCell));
  if (idx < 0) throw new Error(`基础形状中不存在格子 ${cellKey(baseCell)}`);
  return levels[r][idx];
}

/** 第 r 级旋转下的渲染相对格, 反向映射回基础形状格 */
export function baseCellFromRendered(shape: Cell[], r: Rotation, renderedRel: Cell): Cell {
  const levels = rotationLevels(shape);
  const idx = levels[r].findIndex((c) => sameCell(c, renderedRel));
  if (idx < 0) throw new Error(`旋转形状中不存在格子 ${cellKey(renderedRel)}`);
  return levels[0][idx];
}

/** 物品按当前放置实际占用的全局网格坐标 */
export function occupiedCells(item: ItemDef, p: Placement): Cell[] {
  return rotatedShape(item.shape, p.rotation).map((c) => ({
    col: c.col + p.anchor.col,
    row: c.row + p.anchor.row,
  }));
}

/**
 * 旋转后重新计算锚点: 被按住的物理格(baseGrab)在屏幕上的全局网格位置保持不动,
 * 锚点 = 该全局位置 - 物理格在新层级下的相对坐标。
 * 因为抓取点不动, 预览不会突然跳到鼠标另一侧。
 */
export function rotateAroundGrab(
  item: ItemDef,
  p: Placement,
  baseGrab: Cell,
  delta: 1 | -1,
): { rotation: Rotation; anchor: Cell } {
  const rotation = addRotation(p.rotation, delta);
  const oldRel = renderedRelOf(item.shape, p.rotation, baseGrab);
  const grabGlobal = {
    col: p.anchor.col + oldRel.col,
    row: p.anchor.row + oldRel.row,
  };
  const newRel = renderedRelOf(item.shape, rotation, baseGrab);
  return {
    rotation,
    anchor: { col: grabGlobal.col - newRel.col, row: grabGlobal.row - newRel.row },
  };
}
