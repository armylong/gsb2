// 全局可调参数：传播消耗与声源强度
export const STEP_COST = 1; // 每走一格消耗的强度
export const STEP_TIME = 1; // 每走一格消耗的时间(tick)
export const DOOR_CLOSED_EXTRA = 4; // 关闭的门额外衰减的强度(时间不变)
export const FOOTSTEP_INTENSITY = 10; // 脚步初始强度
export const IMPACT_INTENSITY = 20; // 撞击初始强度

export type Terrain = 'wall' | 'floor' | 'door';

export interface Cell {
  terrain: Terrain;
  /** 仅 terrain === 'door' 时有意义 */
  doorOpen: boolean;
}

export class GameMap {
  readonly w: number;
  readonly h: number;
  cells: Cell[];

  constructor(w: number, h: number, cells?: Cell[]) {
    this.w = w;
    this.h = h;
    this.cells = cells ?? Array.from({ length: w * h }, () => ({ terrain: 'floor' as Terrain, doorOpen: false }));
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  at(x: number, y: number): Cell {
    return this.cells[this.idx(x, y)];
  }

  /** 声音能否进入该格(墙完全阻断) */
  passable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.at(x, y).terrain !== 'wall';
  }

  /** 进入该格消耗的强度(关闭的门有额外衰减) */
  enterCost(x: number, y: number): number {
    const c = this.at(x, y);
    if (c.terrain === 'door' && !c.doorOpen) return STEP_COST + DOOR_CLOSED_EXTRA;
    return STEP_COST;
  }

  /** 深拷贝:发声时对地图做快照,之后的编辑不影响已发出的事件 */
  clone(): GameMap {
    return new GameMap(
      this.w,
      this.h,
      this.cells.map((c) => ({ ...c })),
    );
  }
}

/**
 * 用字符画建图:
 *   '#' 墙   '.' 空地   'D' 关闭的门   'd' 打开的门
 */
export function mapFromStrings(rows: string[]): GameMap {
  const h = rows.length;
  const w = rows[0].length;
  const map = new GameMap(w, h);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`第 ${y} 行长度不一致`);
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      const cell = map.cells[map.idx(x, y)];
      if (ch === '#') cell.terrain = 'wall';
      else if (ch === '.') cell.terrain = 'floor';
      else if (ch === 'D') {
        cell.terrain = 'door';
        cell.doorOpen = false;
      } else if (ch === 'd') {
        cell.terrain = 'door';
        cell.doorOpen = true;
      } else throw new Error(`未知字符 '${ch}' @(${x},${y})`);
    }
  });
  return map;
}
