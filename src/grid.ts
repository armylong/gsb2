/** 网格坐标工具与几何常量。所有模块共享同一套相邻 / 方向语义，避免编辑顺序影响。 */

export interface Cell {
  readonly x: number;
  readonly y: number;
}

export const WIDTH = 18;
export const HEIGHT = 12;

/** 四邻方向，按固定顺序列出（确定性的一部分）。 */
export const CARDINALS = [
  { dx: 0, dy: -1, name: 'N' },
  { dx: 1, dy: 0, name: 'E' },
  { dx: 0, dy: 1, name: 'S' },
  { dx: -1, dy: 0, name: 'W' },
] as const;

export type Cardinal = (typeof CARDINALS)[number];
export type Direction = 'N' | 'E' | 'S' | 'W';

export const DIRECTION_ORDER: readonly Direction[] = ['N', 'E', 'S', 'W'];

export function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseKey(key: string): Cell {
  const [xs, ys] = key.split(',');
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`非法格子键: ${key}`);
  }
  return { x, y };
}

export function inBounds(x: number, y: number, w = WIDTH, h = HEIGHT): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

export function neighbors(x: number, y: number, w = WIDTH, h = HEIGHT): Cell[] {
  const out: Cell[] = [];
  for (const d of CARDINALS) {
    const nx = x + d.dx;
    const ny = y + d.dy;
    if (inBounds(nx, ny, w, h)) out.push({ x: nx, y: ny });
  }
  return out;
}

/** 按固定顺序产出 (from -> to, 方向) 的邻接对，保证遍历顺序稳定。 */
export function* adjacentPairs(w = WIDTH, h = HEIGHT): Generator<{
  from: Cell;
  to: Cell;
  dir: Direction;
}> {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (const d of CARDINALS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (inBounds(nx, ny, w, h)) {
          yield { from: { x, y }, to: { x: nx, y: ny }, dir: d.name };
        }
      }
    }
  }
}

export function opposite(dir: Direction): Direction {
  switch (dir) {
    case 'N':
      return 'S';
    case 'S':
      return 'N';
    case 'E':
      return 'W';
    case 'W':
      return 'E';
  }
}

/** 比较两个格子键的自然序，用于跨集合的稳定排序。 */
export function compareKeys(a: string, b: string): number {
  const pa = parseKey(a);
  const pb = parseKey(b);
  return pa.y - pb.y || pa.x - pb.x;
}
