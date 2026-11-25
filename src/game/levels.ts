import type { GameState, Puzzle, Vertex } from './types';
import { edgeKey } from './geometry';
import { emptyState } from './operations';

function edgesFromPaths(
  paths: Array<{ color: string; path: Vertex[] }>,
): GameState['edges'] {
  const edges: GameState['edges'] = {};
  for (const { color, path } of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      edges[edgeKey(path[i], path[i + 1])] = color;
    }
  }
  return edges;
}

function levelTwoInitial(): GameState {
  // 红带走之字：在 y=1、y=2、y=3 三行都水平穿过 x=2，
  // 与垂直直行的蓝带恰好形成三处对边交叉，且两带不共用任何格边。
  const red: Vertex[] = [
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 3, y: 2 },
    { x: 2, y: 2 },
    { x: 1, y: 2 },
    { x: 1, y: 3 },
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 3, y: 4 },
  ];
  const blue: Vertex[] = [
    { x: 2, y: 0 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 2, y: 3 },
    { x: 2, y: 4 },
  ];
  // 绿带走最右侧独立直列，与红蓝都不相交，保证全棋盘恰好三处交叉。
  const green: Vertex[] = [
    { x: 5, y: 0 },
    { x: 5, y: 1 },
    { x: 5, y: 2 },
    { x: 5, y: 3 },
    { x: 5, y: 4 },
  ];
  const edges = edgesFromPaths([
    { color: 'red', path: red },
    { color: 'blue', path: blue },
    { color: 'green', path: green },
  ]);
  // 三处交叉初始都由红带压在顶层：红带视角「压、压、压」，
  // 相邻两对都不交替，即题目要求的「两个相邻冲突」；点中间点翻转一次即可同时消除。
  const tops: GameState['tops'] = {
    '2,1': 'red',
    '2,2': 'red',
    '2,3': 'red',
  };
  return { puzzleId: 'level-2', edges, tops };
}

export const PUZZLES: Puzzle[] = [
  {
    id: 'level-1',
    name: '上手关：红蓝十字',
    width: 4,
    height: 3,
    hint: '从红色入口沿格边拉到红色出口，再拉蓝色；交叉点上点一下可翻转谁压谁，让蓝色露在顶层。中间 (2,2) 是禁用孔，试试用「改道」绕开。',
    ports: [
      { vertex: { x: 0, y: 1 }, color: 'red', kind: 'entry', label: '红入口' },
      { vertex: { x: 4, y: 1 }, color: 'red', kind: 'exit', label: '红出口' },
      { vertex: { x: 1, y: 0 }, color: 'blue', kind: 'entry', label: '蓝入口' },
      { vertex: { x: 1, y: 3 }, color: 'blue', kind: 'exit', label: '蓝出口' },
    ],
    holes: [{ x: 2, y: 2 }],
    targets: [{ vertex: { x: 1, y: 1 }, color: 'blue' }],
  },
  {
    id: 'level-2',
    name: '进阶关：两个相邻冲突',
    width: 5,
    height: 4,
    hint: '红带和蓝带在 (2,1)、(2,2)、(2,3) 连续交叉三次。同一条带相邻交叉点必须上下相间——当前红带在三个点都压在上面，两段冲突都已标红。点中间的交叉点 (2,2) 翻转一次，两段冲突会同时消失，三处目标花纹也同时达成。',
    ports: [
      { vertex: { x: 0, y: 1 }, color: 'red', kind: 'entry', label: '红入口' },
      { vertex: { x: 3, y: 4 }, color: 'red', kind: 'exit', label: '红出口' },
      { vertex: { x: 2, y: 0 }, color: 'blue', kind: 'entry', label: '蓝入口' },
      { vertex: { x: 2, y: 4 }, color: 'blue', kind: 'exit', label: '蓝出口' },
      { vertex: { x: 5, y: 0 }, color: 'green', kind: 'entry', label: '绿入口' },
      { vertex: { x: 5, y: 4 }, color: 'green', kind: 'exit', label: '绿出口' },
    ],
    holes: [
      { x: 4, y: 1 },
      { x: 4, y: 3 },
    ],
    targets: [
      { vertex: { x: 2, y: 1 }, color: 'red' },
      { vertex: { x: 2, y: 2 }, color: 'blue' },
      { vertex: { x: 2, y: 3 }, color: 'red' },
    ],
    initial: levelTwoInitial(),
  },
];

export function getPuzzle(id: string): Puzzle {
  const puzzle = PUZZLES.find((p) => p.id === id);
  if (!puzzle) throw new Error(`未知题面: ${id}`);
  return puzzle;
}

export function defaultState(puzzle: Puzzle): GameState {
  if (puzzle.initial) {
    return {
      puzzleId: puzzle.id,
      edges: { ...puzzle.initial.edges },
      tops: { ...puzzle.initial.tops },
    };
  }
  return emptyState(puzzle);
}
