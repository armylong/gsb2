import type { Grid } from './Grid';
import type { ComponentLabeling } from './types';

/** 四邻接方向（上下左右）；对角方向刻意排除，对角接触不算相连。 */
const NEIGHBORS = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
] as const;

/**
 * 对静态网格做连通块标注（BFS，仅上下左右相邻）。
 *
 * 编号从 1 开始连续分配；同时判断每个块是否与底部地基
 * （y === height - 1 的实心格）连通。
 * 复杂度 O(width * height)。
 */
export function labelComponents(grid: Grid): ComponentLabeling {
  const { width, height } = grid;
  const compIdAt: Int16Array[] = Array.from({ length: height }, () => new Int16Array(width));
  const sizes = new Map<number, number>();
  const grounded = new Set<number>();
  let nextId = 0;
  const queue: number[] = [];

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      if (grid.solid[sy][sx] !== 1 || compIdAt[sy][sx] !== 0) continue;

      const id = ++nextId;
      let size = 0;
      let touchesFoundation = false;
      queue.length = 0;
      queue.push(sy * width + sx);
      compIdAt[sy][sx] = id;

      while (queue.length > 0) {
        const packed = queue.pop()!;
        const x = packed % width;
        const y = (packed / width) | 0;
        size++;
        if (y === height - 1) touchesFoundation = true;

        for (const [dx, dy] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (
            nx >= 0 &&
            ny >= 0 &&
            nx < width &&
            ny < height &&
            grid.solid[ny][nx] === 1 &&
            compIdAt[ny][nx] === 0
          ) {
            compIdAt[ny][nx] = id;
            queue.push(ny * width + nx);
          }
        }
      }

      sizes.set(id, size);
      if (touchesFoundation) grounded.add(id);
    }
  }

  return { compIdAt, sizes, grounded, count: nextId };
}

/** 判断指定实心格所在连通块是否接地；空格返回 false。 */
export function isGroundedCell(grid: Grid, x: number, y: number): boolean {
  if (!grid.isSolid(x, y)) return false;
  const labeling = labelComponents(grid);
  const id = labeling.compIdAt[y][x];
  return labeling.grounded.has(id);
}
