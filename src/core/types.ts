// 核心领域模型: 方片、盘面、放置、冲突
// 纯数据与纯函数, 不依赖 DOM, 方便单测。

/** 四个方向, 顺时针: 上 右 下 左 */
export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;
export const DIRS: Dir[] = [UP, RIGHT, DOWN, LEFT];
export const DIR_DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // UP:    dx, dy
  [1, 0],  // RIGHT
  [0, 1],  // DOWN
  [-1, 0], // LEFT
];
export const OPPOSITE: Dir[] = [DOWN, LEFT, UP, RIGHT];
export const DIR_NAME = ['上边', '右边', '下边', '左边'];

/** 纹路标签; null = 该边没有固定边条件(外边/洞边不约束) */
export type EdgeLabel = string | null;

export interface Cell {
  x: number;
  y: number;
}

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** 一个边条件的定位: 位于格子 (x,y) 的 dir 侧(外侧必须是盘外或洞) */
export interface EdgeRef extends Cell {
  dir: Dir;
}
export const edgeKey = (x: number, y: number, dir: Dir): string =>
  `${x},${y},${dir}`;

/**
 * 带边纹方片。edges 按 rotation=0 的 [上,右,下,左] 记录。
 * id 全局唯一; 同一 id 的片不能同时出现在盘面两处。
 */
export interface Tile {
  id: string;
  edges: [string, string, string, string];
}

/** 一次放置; rot 为顺时针旋转 90° 的次数 (0..3) */
export interface Placement {
  tileId: string;
  x: number;
  y: number;
  rot: Dir;
  /** 玩家锁住后, 补全/提示只能在其基础上推进, 不能改动它 */
  locked: boolean;
}

export interface Board {
  width: number;
  height: number;
  /** 洞: 不能放片的格子 */
  holes: Cell[];
  /** 固定边条件, 只允许出现在外边界或洞边; null 值表示无约束(不写入) */
  edgeConditions: Record<string, EdgeLabel>;
}

export interface Puzzle {
  name: string;
  board: Board;
  tiles: Tile[];
  placements: Placement[];
}

/** 取方片旋转 rot 后 dir 方向上的纹路 */
export function rotatedEdge(tile: Tile, rot: Dir, dir: Dir): string {
  return tile.edges[(dir - rot + 4) % 4];
}

/**
 * 找该方片的规范朝向: 边纹序列在四个旋转中字典序最小的那个 rot。
 * 旋转对称(或部分对称)的片, 不同 rot 会归一到同一个 rot,
 * 从根上保证它们不会被当成不同的选项/答案。
 */
export function canonicalRot(edges: readonly string[]): Dir {
  let best: Dir = 0;
  for (let r = 1 as Dir; r < 4; r = (r + 1) as Dir) {
    for (let d = 0; d < 4; d++) {
      const a = edges[(d - r + 4) % 4];
      const b = edges[(d - best + 4) % 4];
      if (a < b) {
        best = r;
        break;
      }
      if (a > b) break;
    }
  }
  return best;
}

/**
 * 某片在某朝向下的去重键。
 * 两个旋转等价 ⇔ 旋转后四边纹路序列完全相同,
 * 所以直接用「片 id + 旋转后边纹序列」做键,
 * 旋转对称的片不会因 rot 写法不同被算成不同选项/答案。
 */
export function optionKey(tile: Tile, rot: Dir): string {
  const seq = DIRS.map((d) => rotatedEdge(tile, rot, d)).join('|');
  return `${tile.id}#${seq}`;
}
