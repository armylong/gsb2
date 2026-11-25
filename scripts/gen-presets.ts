// 预设题面生成器: 先构造一个"已解布局", 再从每格四边反推木片,
// 最后用 src/core 的求解器验证性质(唯一解 / 多解 / 看似可放却无解)。
// 运行: npm run gen:presets
import { mkdirSync, writeFileSync } from 'node:fs';
import { Board, Cell, Dir, DIRS, DIR_DELTA, Puzzle, Tile, Placement } from '../src/core/types.js';
import { isHole } from '../src/core/board.js';
import { countSolutions, diagnose, findCompletions } from '../src/core/solver.js';

// ---- 确定性随机(同一脚本反复生成结果一致) ----
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface GenOutput {
  puzzle: Puzzle;
  stats: string;
}

/**
 * 生成一个可解题面: 给每条边(内部相邻边共享一个纹路; 外边/洞边各自一个纹路)
 * 赋标签, 每格反推一块木片。alphabet 越大标签越独特, 解越容易唯一。
 */
function generateSolved(
  name: string,
  board: Board,
  alphabet: number,
  rng: () => number,
): GenOutput {
  const cells: Cell[] = [];
  for (let y = 0; y < board.height; y++)
    for (let x = 0; x < board.width; x++)
      if (!isHole(board, x, y)) cells.push({ x, y });

  const labelAt = new Map<string, string>();
  const pick = () => LABELS[Math.floor(rng() * alphabet)];
  const ekey = (x: number, y: number, d: Dir) => `${x},${y},${d}`;

  for (const c of cells) {
    for (const d of DIRS) {
      if (labelAt.has(ekey(c.x, c.y, d))) continue;
      const [dx, dy] = DIR_DELTA[d];
      const nx = c.x + dx;
      const ny = c.y + dy;
      const outside =
        nx < 0 || ny < 0 || nx >= board.width || ny >= board.height || isHole(board, nx, ny);
      const label = pick();
      labelAt.set(ekey(c.x, c.y, d), label);
      if (!outside) labelAt.set(ekey(nx, ny, ((d + 2) % 4) as Dir), label);
      else board.edgeConditions[ekey(c.x, c.y, d)] = label;
    }
  }

  const tiles: Tile[] = cells.map((c, i) => ({
    id: `T${i + 1}`,
    edges: DIRS.map((d) => labelAt.get(ekey(c.x, c.y, d))!) as [string, string, string, string],
  }));

  return {
    puzzle: { name, board, tiles, placements: [] },
    stats: `${cells.length} 格 / ${tiles.length} 片 / ${Object.keys(board.edgeConditions).length} 条固定边`,
  };
}

function makeBoard(width: number, holes: Cell[] = []): Board {
  return { width, height: width, holes, edgeConditions: {} };
}

// ---- 预设 1: 唯一解 (3x3, 大字母表, 锁一片) ----
function buildUnique(): { puzzle: Puzzle; count: number } {
  for (let seed = 1; seed < 500; seed++) {
    const rng = mulberry32(seed);
    const board = makeBoard(3);
    const { puzzle } = generateSolved('唯一解题面(3×3)', board, 22, rng);
    const count = countSolutions(board, puzzle.placements, puzzle.tiles, 20);
    if (count === 1) {
      // 锁一片在生成解的位置: 取求解器给出的唯一解中第一片
      const r = findCompletions(board, [], puzzle.tiles, 1);
      if (r.status === 'solved') {
        const lock = r.solutions[0][0];
        const locked: Placement = { ...lock, locked: true };
        puzzle.placements = [locked];
        const stillOne = countSolutions(board, puzzle.placements, puzzle.tiles, 20);
        if (stillOne === 1) return { puzzle, count: 1 };
      }
    }
  }
  throw new Error('unique: 找不到唯一解种子');
}

// ---- 预设 2: 多解 (3x3 中心留洞, 8 片, 小字母表) ----
function buildMulti(): { puzzle: Puzzle; count: number } {
  let best: { puzzle: Puzzle; count: number } | null = null;
  for (let seed = 1; seed < 500; seed++) {
    const rng = mulberry32(seed + 7000);
    const board = makeBoard(3, [{ x: 1, y: 1 }]);
    const { puzzle } = generateSolved('多解题面(中心留洞)', board, 3, rng);
    const count = countSolutions(board, puzzle.placements, puzzle.tiles, 50);
    if (count >= 5) return { puzzle, count };
    if (count >= 2 && (!best || count > best.count)) best = { puzzle, count };
  }
  if (best) return best;
  throw new Error('multi: 找不到多解种子');
}

// ---- 预设 3: 局部都能放, 最后缺一块 ----
// 先造一个 2x2 可解盘面, 再随机破坏一块木片, 用 diagnose 筛出
// "能无冲突地连放 3 块、最后 1 块无处可去"的种子。
function buildTrap(): { puzzle: Puzzle; fillable: number } {
  const total = 4;
  for (let seed = 1; seed < 2000; seed++) {
    const rng = mulberry32(seed + 9000);
    const board = makeBoard(2);
    const { puzzle } = generateSolved('陷阱题面(最后缺一块)', board, 4, rng);

    // 随机挑一块木片, 把它的边纹换成小字母表里的随机纹路(可能与原片偶合, 故多试种子)
    const victim = Math.floor(rng() * total);
    puzzle.tiles[victim] = {
      id: puzzle.tiles[victim].id,
      edges: DIRS.map(() => LABELS[Math.floor(rng() * 4)]) as [string, string, string, string],
    };

    const diag = diagnose(board, [], puzzle.tiles);
    if (!diag.solvable && diag.maxFillable === total - 1) {
      return { puzzle, fillable: diag.maxFillable };
    }
  }
  throw new Error('trap: 找不到"只差一块"的种子');
}

const u = buildUnique();
const m = buildMulti();
const t = buildTrap();

const header = `// 由 scripts/gen-presets.ts 生成, 请勿手改。运行 npm run gen:presets 重新生成。
import type { Puzzle } from '../core/types.js';

export interface PresetInfo {
  puzzle: Puzzle;
  /** 生成时用求解器验证的性质 */
  verified: string;
}

export const PRESETS: PresetInfo[] = [`;

const items = [
  { p: u.puzzle, v: `唯一解(含 1 片锁定); 求解器验证解数 = ${u.count}` },
  { p: m.puzzle, v: `多解; 求解器验证解数 ≥ ${m.count}(上限内)` },
  {
    p: t.puzzle,
    v: `无解; 深度诊断可无冲突连放 ${t.fillable} 块, 最后 1 块无处可放`,
  },
]
  .map(({ p, v }) => `  {\n    verified: ${JSON.stringify(v)},\n    puzzle: ${JSON.stringify(p, null, 4).replace(/\n/g, '\n    ')},\n  },`)
  .join('\n');

mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../src/data/presets.ts', import.meta.url),
  `${header}\n${items}\n];\n`,
);

console.log('presets 生成完成:');
console.log(' 1)', u.puzzle.name, '解数 =', u.count);
console.log(' 2)', m.puzzle.name, '解数 >=', m.count);
const tr = diagnose(t.puzzle.board, [], t.puzzle.tiles);
console.log(
  ' 3)',
  t.puzzle.name,
  tr.solvable ? '可解?!' : `无解; 最多能放 ${tr.maxFillable}/4 块; ${tr.explanation?.title}`,
);
