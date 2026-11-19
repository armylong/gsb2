import type { Dimensions } from './types';

/** 地图尺寸上限（需求：不超过 100 x 60 格）。 */
export const MAX_WIDTH = 100;
export const MAX_HEIGHT = 60;

/**
 * 实心地形网格。solid[y][x] === 1 表示实心静态格，0 表示空（含空洞）。
 * 空洞就是普通的空格，任何算法都不会把它当作实心区域。
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  /** 每行一个 Uint8Array，solid[y][x]。 */
  readonly solid: Uint8Array[];

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error('网格尺寸必须为整数');
    }
    if (width <= 0 || height <= 0 || width > MAX_WIDTH || height > MAX_HEIGHT) {
      throw new Error(`网格尺寸必须在 1..${MAX_WIDTH} x 1..${MAX_HEIGHT} 之间`);
    }
    this.width = width;
    this.height = height;
    this.solid = Array.from({ length: height }, () => new Uint8Array(width));
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isSolid(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.solid[y][x] === 1;
  }

  set(x: number, y: number, value: 0 | 1): void {
    if (!this.inBounds(x, y)) {
      throw new Error(`坐标 (${x}, ${y}) 越界`);
    }
    this.solid[y][x] = value;
  }

  /** 实心格总数。 */
  countSolid(): number {
    let n = 0;
    for (const row of this.solid) {
      for (let i = 0; i < row.length; i++) n += row[i];
    }
    return n;
  }

  clone(): Grid {
    const g = new Grid(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      g.solid[y].set(this.solid[y]);
    }
    return g;
  }

  /**
   * 从 ASCII 行构造：'#' 实心、'.' 空。便于测试与场景定义。
   * 所有行必须等长。
   */
  static fromRows(rows: readonly string[]): Grid {
    const height = rows.length;
    const width = rows[0]?.length ?? 0;
    if (height === 0 || width === 0) {
      throw new Error('场景不能为空');
    }
    const grid = new Grid(width, height);
    rows.forEach((row, y) => {
      if (row.length !== width) {
        throw new Error(`第 ${y} 行长度不一致`);
      }
      for (let x = 0; x < width; x++) {
        const ch = row[x];
        if (ch === '#') grid.solid[y][x] = 1;
        else if (ch !== '.') {
          throw new Error(`非法字符 '${ch}'，只允许 # 或 .`);
        }
      }
    });
    return grid;
  }

  toRows(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) line += this.solid[y][x] ? '#' : '.';
      rows.push(line);
    }
    return rows;
  }

  get dimensions(): Dimensions {
    return { width: this.width, height: this.height };
  }
}
