/** 网格坐标, 列 col 为 x, 行 row 为 y, 均以网格左上角为原点 */
export interface Cell {
  col: number;
  row: number;
}

/** 顺时针旋转次数: 0/1/2/3, 每次 90° */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * 物品定义(稳定身份)。
 * shape 是未旋转(rotation=0)时的占格, 必须是归一化后的集合:
 * 最小 col / row 均为 0, 无重复格。
 */
export interface ItemDef {
  id: string;
  name: string;
  shape: Cell[];
  /** 程序生成图形时使用的色相(0-360) */
  hue: number;
}

/** 一件物品在某个背包中的放置结果 */
export interface Placement {
  itemId: string;
  bagId: string;
  /** 旋转后包围盒左上角所在的网格坐标(锚点) */
  anchor: Cell;
  rotation: Rotation;
}

/** 背包定义 */
export interface BagDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
}

/** 一份完整的世界状态: 两个背包 + 全部放置结果 */
export interface WorldState {
  bags: BagDef[];
  placements: Placement[];
}

/** 持久化到本地的布局文件 */
export interface LayoutFile {
  version: 1;
  savedAt: string;
  items: ItemDef[];
  world: WorldState;
}
