// 盘面几何与冲突检测。所有判定都基于"当前已摆的位置",
// 拖动预览、补全、提示、导入校验共用同一套规则。

import {
  Board,
  Cell,
  Dir,
  DIR_DELTA,
  DIR_NAME,
  DIRS,
  EdgeLabel,
  EdgeRef,
  OPPOSITE,
  Placement,
  Tile,
  cellKey,
  edgeKey,
  rotatedEdge,
} from './types.js';

export type ConflictKind =
  | 'cell-invalid' // 格在盘外或洞里
  | 'cell-occupied' // 格子已被别的片占住
  | 'tile-duplicate' // 同一块片不能同时在盘面两处
  | 'edge-mismatch' // 两块相邻片纹路不一致
  | 'edge-condition-mismatch'; // 与外边/洞边固定条件不一致

export interface Conflict {
  kind: ConflictKind;
  /** 去重键, 全盘检查时同一条冲突只报一次 */
  key: string;
  message: string;
  /** 涉及的格子, 用于 canvas 高亮 */
  cells: Cell[];
  /** 涉及的边(取其中一方的视角), 用于画红边 */
  edge?: EdgeRef;
}

export function inBoard(board: Board, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < board.width && y < board.height;
}

export function isHole(board: Board, x: number, y: number): boolean {
  return board.holes.some((h) => h.x === x && h.y === y);
}

/** 'cell' 可放片; 'hole' 是留空; 'outside' 是盘外 */
export function cellKind(
  board: Board,
  x: number,
  y: number,
): 'cell' | 'hole' | 'outside' {
  if (!inBoard(board, x, y)) return 'outside';
  return isHole(board, x, y) ? 'hole' : 'cell';
}

export function placementAt(
  placements: Placement[],
  x: number,
  y: number,
): Placement | undefined {
  return placements.find((p) => p.x === x && p.y === y);
}

export function edgeConditionAt(
  board: Board,
  x: number,
  y: number,
  dir: Dir,
): EdgeLabel {
  return board.edgeConditions[edgeKey(x, y, dir)] ?? null;
}

export function setEdgeCondition(
  board: Board,
  x: number,
  y: number,
  dir: Dir,
  label: EdgeLabel,
): void {
  const k = edgeKey(x, y, dir);
  if (label === null) delete board.edgeConditions[k];
  else board.edgeConditions[k] = label;
}

/** 边条件只允许挂在外边界或洞边上; 返回非法的边条件列表 */
export function validateEdgeConditions(board: Board): EdgeRef[] {
  const bad: EdgeRef[] = [];
  for (const k of Object.keys(board.edgeConditions)) {
    const [xs, ys, ds] = k.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const dir = Number(ds) as Dir;
    if (cellKind(board, x, y) !== 'cell') {
      bad.push({ x, y, dir });
      continue;
    }
    const [dx, dy] = DIR_DELTA[dir];
    if (cellKind(board, x + dx, y + dy) === 'cell') bad.push({ x, y, dir });
  }
  return bad;
}

/**
 * 删掉所有不再合法的边条件(挖洞/填洞后调用)。
 * - 条件所在格变成洞: 条件无意义, 删
 * - 条件朝向的邻居从洞变成普通格: 条件变成"两个普通格之间", 删
 * 返回被删掉的条数。
 */
export function pruneEdgeConditions(board: Board): number {
  const bad = validateEdgeConditions(board);
  for (const ref of bad) delete board.edgeConditions[edgeKey(ref.x, ref.y, ref.dir)];
  return bad.length;
}

/** 两个相邻格共享边的规范键: 不管从哪一侧看都相同, 用于冲突去重 */
function sharedEdgeKey(x: number, y: number, dir: Dir): string {
  const [dx, dy] = DIR_DELTA[dir];
  const nx = x + dx;
  const ny = y + dy;
  const a = cellKey(x, y);
  const b = cellKey(nx, ny);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 检查"把 tile 以 rot 朝向放到 (x,y)"与当前盘面的全部冲突。
 * 已存在于 (x,y) 的放置会被忽略(用于旋转/重新检查同一个格)。
 */
export function checkPlacement(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
  tile: Tile,
  rot: Dir,
  x: number,
  y: number,
): Conflict[] {
  const out: Conflict[] = [];
  const tileById = new Map(tiles.map((t) => [t.id, t]));
  const here = { x, y };

  // 1. 位置合法性
  const kind = cellKind(board, x, y);
  if (kind !== 'cell') {
    out.push({
      kind: 'cell-invalid',
      key: `invalid:${cellKey(x, y)}`,
      message:
        kind === 'hole'
          ? `(${x + 1},${y + 1}) 是留空洞, 不能放片`
          : `(${x + 1},${y + 1}) 在棋盘外`,
      cells: [here],
    });
    return out; // 位置都不合法, 后续边检查没有意义
  }

  // 2. 格子占用
  const occupant = placements.find(
    (p) => p.x === x && p.y === y && p.tileId !== tile.id,
  );
  if (occupant) {
    out.push({
      kind: 'cell-occupied',
      key: `occupied:${cellKey(x, y)}`,
      message: `(${x + 1},${y + 1}) 已被 ${occupant.tileId} 占住`,
      cells: [here],
    });
  }

  // 3. 同一块片不能同时在盘面两处
  const twin = placements.find((p) => p.tileId === tile.id);
  if (twin && (twin.x !== x || twin.y !== y)) {
    out.push({
      kind: 'tile-duplicate',
      key: `dup:${tile.id}`,
      message: `木片 ${tile.id} 已摆在 (${twin.x + 1},${twin.y + 1}), 同一块不能同时放两处`,
      cells: [here, { x: twin.x, y: twin.y }],
    });
  }

  // 4. 四条边: 邻居片 / 洞边或外边的固定条件
  for (const dir of DIRS) {
    const label = rotatedEdge(tile, rot, dir);
    const [dx, dy] = DIR_DELTA[dir];
    const nx = x + dx;
    const ny = y + dy;
    const neighborKind = cellKind(board, nx, ny);

    if (neighborKind === 'cell') {
      const np = placements.find((p) => p.x === nx && p.y === ny);
      if (!np) continue; // 空格子, 以后放了再查
      const nTile = tileById.get(np.tileId);
      const nLabel = nTile ? rotatedEdge(nTile, np.rot, OPPOSITE[dir]) : '?';
      if (nLabel !== label) {
        const labels = [label, nLabel].sort().join('/');
        out.push({
          kind: 'edge-mismatch',
          key: `edge:${sharedEdgeKey(x, y, dir)}:${labels}`,
          message: `${tile.id} 的${DIR_NAME[dir]}纹路 ${label} 与相邻 ${np.tileId} 的纹路 ${nLabel} 不一致`,
          cells: [here, { x: nx, y: ny }],
          edge: { x, y, dir },
        });
      }
    } else {
      // 洞边或外边: 查固定边条件, null 表示不约束
      const cond = edgeConditionAt(board, x, y, dir);
      if (cond !== null && cond !== label) {
        out.push({
          kind: 'edge-condition-mismatch',
          key: `cond:${edgeKey(x, y, dir)}:${cond}/${label}`,
          message: `${tile.id} 的${DIR_NAME[dir]}纹路 ${label} 与${neighborKind === 'hole' ? '洞边' : '外边'}固定条件 ${cond} 不一致`,
          cells: [here],
          edge: { x, y, dir },
        });
      }
    }
  }

  return out;
}

/** 全盘检查: 汇总每个放置的冲突并去重, 另查悬挂的边条件(邻格其实存在) */
export function checkBoard(
  board: Board,
  placements: Placement[],
  tiles: Tile[],
): Conflict[] {
  const map = new Map<string, Conflict>();
  const tileById = new Map(tiles.map((t) => [t.id, t]));
  for (const p of placements) {
    const tile = tileById.get(p.tileId);
    if (!tile) continue;
    for (const c of checkPlacement(board, placements, tiles, tile, p.rot, p.x, p.y)) {
      map.set(c.key, c);
    }
  }
  return [...map.values()];
}

/** 棋盘上所有可放片的格子(不含洞), 行优先 */
export function allCells(board: Board): Cell[] {
  const out: Cell[] = [];
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      if (!isHole(board, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** 未被占用的可放片格子 */
export function freeCells(board: Board, placements: Placement[]): Cell[] {
  return allCells(board).filter((c) => !placementAt(placements, c.x, c.y));
}

export function usedTileIds(placements: Placement[]): Set<string> {
  return new Set(placements.map((p) => p.tileId));
}
