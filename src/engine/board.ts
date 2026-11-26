import type { Cell, CellKind, Direction, ProbeAction, ProbeRecord } from '../types';

const DIR_DELTA: Record<Direction, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

/** 关卡底图：wall 固定可见，solid / empty 在交卷前隐藏 */
export class Board {
  readonly rows: number;
  readonly cols: number;
  private grid: CellKind[][];

  constructor(rows: string[]) {
    this.rows = rows.length;
    this.cols = rows[0]?.length ?? 0;
    this.grid = rows.map((line) =>
      line.split('').map((ch): CellKind => {
        if (ch === '#') return 'wall';
        if (ch === 'o') return 'empty';
        return 'solid';
      }),
    );
  }

  inside(r: number, c: number): boolean {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  }

  kind(r: number, c: number): CellKind {
    return this.grid[r][c];
  }

  isWall(r: number, c: number): boolean {
    return this.inside(r, c) && this.grid[r][c] === 'wall';
  }

  /** 非墙格（实地或空洞），可放探头、可标记、可走路 */
  isOpen(r: number, c: number): boolean {
    return this.inside(r, c) && this.grid[r][c] !== 'wall';
  }

  /** 非墙格的变量编号：按行优先顺序，求解器与约束转换共用同一套编号 */
  openCellIndex(r: number, c: number): number {
    if (!this.isOpen(r, c)) throw new Error(`墙格或越界格没有变量编号：(${r},${c})`);
    let idx = 0;
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < this.cols; j++) if (this.grid[i][j] !== 'wall') idx++;
    }
    for (let j = 0; j < c; j++) if (this.grid[r][j] !== 'wall') idx++;
    return idx;
  }

  /** 按编号顺序列出全部非墙格 */
  openCells(): Cell[] {
    const cells: Cell[] = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) if (this.isOpen(r, c)) cells.push({ r, c });
    }
    return cells;
  }

  /** 沿指定方向取连续格：从探头格的下一格开始，撞墙或出界即停，不能越墙 */
  lineCells(r: number, c: number, dir: Direction): Cell[] {
    const [dr, dc] = DIR_DELTA[dir];
    const cells: Cell[] = [];
    let nr = r + dr;
    let nc = c + dc;
    while (this.inside(nr, nc) && !this.isWall(nr, nc)) {
      cells.push({ r: nr, c: nc });
      nr += dr;
      nc += dc;
    }
    return cells;
  }

  /** 正交邻格：同样不越墙，墙后的格子不会出现在结果里 */
  adjacencyCells(r: number, c: number): Cell[] {
    const cells: Cell[] = [];
    for (const dir of ['up', 'down', 'left', 'right'] as Direction[]) {
      const [dr, dc] = DIR_DELTA[dir];
      const nr = r + dr;
      const nc = c + dc;
      if (this.inside(nr, nc) && !this.isWall(nr, nc)) cells.push({ r: nr, c: nc });
    }
    return cells;
  }

  /** 执行一次探测，返回带读数的记录。探头格本身不计入读数。 */
  probe(action: ProbeAction, id: number): ProbeRecord {
    if (!this.isOpen(action.r, action.c)) {
      throw new Error(`探头必须放在非墙格上：(${action.r},${action.c})`);
    }
    if (action.type === 'line') {
      if (!action.dir) throw new Error('方向探头缺少方向');
      const cells = this.lineCells(action.r, action.c, action.dir);
      const reading = cells.filter((p) => this.kind(p.r, p.c) === 'solid').length;
      return { ...action, id, reading, cells };
    }
    const cells = this.adjacencyCells(action.r, action.c);
    // 邻域探头：正交邻格里是否“至少一处空洞”
    const reading = cells.some((p) => this.kind(p.r, p.c) === 'empty') ? 1 : 0;
    return { ...action, id, reading, cells };
  }

  /**
   * 校验玩家提交的相邻格通路：
   * 1) 每格必须存在、非墙、是实地；2) 相邻格必须正交相邻；
   * 3) 必须从指定入口走到指定出口。
   */
  checkPath(path: Cell[], entry: Cell, exit: Cell): { ok: boolean; reason?: string } {
    if (path.length < 2) return { ok: false, reason: '通路至少要包含起点和终点两个格' };
    const first = path[0];
    const last = path[path.length - 1];
    if (first.r !== entry.r || first.c !== entry.c)
      return { ok: false, reason: '通路没有从指定入口开始' };
    if (last.r !== exit.r || last.c !== exit.c)
      return { ok: false, reason: '通路没有到达指定终点' };

    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (!this.inside(p.r, p.c)) return { ok: false, reason: `第 ${i + 1} 格在棋盘外` };
      if (this.isWall(p.r, p.c)) return { ok: false, reason: `通路经过了固定墙 (${p.r},${p.c})` };
      if (this.kind(p.r, p.c) === 'empty')
        return { ok: false, reason: `通路踩空了：(${p.r},${p.c}) 下面是空的` };
      if (i > 0) {
        const prev = path[i - 1];
        const manhattan = Math.abs(prev.r - p.r) + Math.abs(prev.c - p.c);
        if (manhattan !== 1)
          return { ok: false, reason: `第 ${i}、${i + 1} 格不是正交相邻，中间断开了` };
      }
    }
    return { ok: true };
  }
}

/** 把一次探测转成求解器约束：变量集合上 0/1（1=实地）之和的范围 */
export interface Constraint {
  recordId: number;
  vars: number[];
  lo: number;
  hi: number;
}

/**
 * 方向探头：读数 = 覆盖格里的实地数（精确等值）。
 * 邻域探头：reading=1 表示至少一个洞（实地数 <= n-1）；reading=0 表示全是实地。
 */
export function recordToConstraint(rec: ProbeRecord, indexOf: (r: number, c: number) => number): Constraint {
  const vars = rec.cells.map((p) => indexOf(p.r, p.c));
  if (rec.type === 'line') {
    return { recordId: rec.id, vars, lo: rec.reading, hi: rec.reading };
  }
  if (rec.reading === 0) {
    return { recordId: rec.id, vars, lo: vars.length, hi: vars.length };
  }
  return { recordId: rec.id, vars, lo: 0, hi: Math.max(0, vars.length - 1) };
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.r === b.r && a.c === b.c;
}
