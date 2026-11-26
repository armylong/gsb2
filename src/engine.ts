// Pure game rules, state transitions and exhaustive hint/path finding.
// This module has no DOM or Canvas dependencies so it can be verified by Node.

export type SideId = 'inside' | 'outside';
export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Pos {
  r: number;
  c: number;
}

export interface DoorDef {
  id: string;
  /** One grid cell on each side; the pair shares one open/closed state. */
  at: Record<SideId, Pos>;
  initiallyOpen: boolean;
  label?: string;
}

export type MarkerKind = 'toggle' | 'once';

export interface MarkerDef {
  id: string;
  kind: MarkerKind;
  /** The same physical glass point, expressed in each side's local view. */
  at: Record<SideId, Pos>;
  doorId: string;
  label: string;
}

export interface TargetDef {
  side: SideId;
  pos: Pos;
  color: string;
  name: string;
}

export interface ReplayDef {
  /** Direction characters U/D/L/R (case-insensitive), spaces ignored. */
  win: string;
  dead?: string;
  deadNote?: string;
}

export interface Level {
  id: string;
  index: number;
  name: string;
  tagline: string;
  lesson: string;
  rows: number;
  cols: number;
  start: Record<SideId, Pos>;
  walls: Record<SideId, Pos[]>;
  doors: DoorDef[];
  markers: MarkerDef[];
  targets: TargetDef[];
  /** Physical column highlighted as the mirror column that is easy to misread. */
  guidePhysicalCol: number;
  replay: ReplayDef;
}

export interface GameState {
  pos: Record<SideId, Pos>;
  doors: Record<string, boolean>;
  /** True for one-shot markers after their first successful simultaneous trigger. */
  used: Record<string, boolean>;
  turn: number;
}

export type BlockReason = 'edge' | 'wall' | 'closed-door';

export type GameEvent =
  | { type: 'blocked'; side: SideId; reason: BlockReason }
  | {
      type: 'marker-toggle';
      markerId: string;
      doorId: string;
      open: boolean;
      kind: MarkerKind;
    }
  | { type: 'win' };

export interface StepInfo {
  dir: Dir;
  moved: Record<SideId, boolean>;
  blockedReason: Record<SideId, BlockReason | null>;
  events: GameEvent[];
  /** False when the press changed neither positions nor persistent marker/door state. */
  effective: boolean;
}

export interface StepResult {
  state: GameState;
  info: StepInfo;
}

export type DiagnosisKind =
  | 'already-won'
  | 'consumed-one-shot-door'
  | 'permanently-closed-door'
  | 'synchronization-deadlock'
  | 'terrain-deadlock'
  | 'search-limit';

export interface Diagnosis {
  kind: DiagnosisKind;
  title: string;
  detail: string;
  lines: string[];
  reachableStates: number;
  positions: Record<SideId, Pos>;
  doors: Record<string, boolean>;
  used: Record<string, boolean>;
}

export interface SearchSuccess {
  status: 'won';
  path: Dir[];
  reachedStates: number;
}

export interface SearchFailure {
  status: 'unsolvable' | 'limit';
  diagnosis: Diagnosis;
  reachedStates: number;
}

export type SearchResult = SearchSuccess | SearchFailure;

export const SIDES: SideId[] = ['inside', 'outside'];

export const SIDE_LABEL: Record<SideId, string> = {
  inside: '玻璃内侧视图',
  outside: '玻璃外侧视图（水平镜像）',
};

export const DIRS: Record<Dir, Pos> = {
  up: { r: -1, c: 0 },
  down: { r: 1, c: 0 },
  // In each side's own drawn view, left/right are screen-relative.
  left: { r: 0, c: -1 },
  right: { r: 0, c: 1 },
};

export const DIR_ARROW: Record<Dir, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

export const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
  W: 'up',
  S: 'down',
  A: 'left',
  D: 'right',
};

export function dirFromChar(ch: string): Dir | null {
  switch (ch.toLowerCase()) {
    case 'u':
      return 'up';
    case 'd':
      return 'down';
    case 'l':
      return 'left';
    case 'r':
      return 'right';
    default:
      return null;
  }
}

export function parseScript(script: string): Dir[] {
  const dirs: Dir[] = [];
  for (const ch of script) {
    const dir = dirFromChar(ch);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

export function posKey(p: Pos): string {
  return `${p.r},${p.c}`;
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.r === b.r && a.c === b.c;
}

export function addDir(p: Pos, dir: Dir): Pos {
  const d = DIRS[dir];
  return { r: p.r + d.r, c: p.c + d.c };
}

/** Outside local column is horizontally mirrored relative to physical columns. */
export function mirrorCol(c: number, cols: number): number {
  return cols - 1 - c;
}

export function physicalCol(side: SideId, localC: number, cols: number): number {
  return side === 'inside' ? localC : mirrorCol(localC, cols);
}

export function localColForPhysical(side: SideId, physicalC: number, cols: number): number {
  return side === 'inside' ? physicalC : mirrorCol(physicalC, cols);
}

export function inBounds(level: Level, p: Pos): boolean {
  return p.r >= 0 && p.r < level.rows && p.c >= 0 && p.c < level.cols;
}

export function findDoorAt(level: Level, side: SideId, p: Pos): DoorDef | null {
  return level.doors.find((door) => samePos(door.at[side], p)) ?? null;
}

export function findMarkerAt(level: Level, side: SideId, p: Pos): MarkerDef | null {
  return level.markers.find((marker) => samePos(marker.at[side], p)) ?? null;
}

export function findTargetAt(level: Level, side: SideId, p: Pos): TargetDef | null {
  return level.targets.find((target) => target.side === side && samePos(target.pos, p)) ?? null;
}

export function createInitialState(level: Level): GameState {
  const doors: Record<string, boolean> = {};
  const used: Record<string, boolean> = {};
  for (const door of level.doors) doors[door.id] = door.initiallyOpen;
  for (const marker of level.markers) {
    if (marker.kind === 'once') used[marker.id] = false;
  }
  return {
    pos: {
      inside: { ...level.start.inside },
      outside: { ...level.start.outside },
    },
    doors,
    used,
    turn: 0,
  };
}

export function isWin(level: Level, state: GameState): boolean {
  return level.targets.every((target) => samePos(state.pos[target.side], target.pos));
}

export function stateKey(state: GameState): string {
  // turn is deliberately excluded: BFS cares about positions and reversible/consumed state.
  return JSON.stringify({ p: state.pos, d: state.doors, u: state.used });
}

function blockedReasonAt(level: Level, state: GameState, side: SideId, dest: Pos): BlockReason | null {
  if (!inBounds(level, dest)) return 'edge';
  if (level.walls[side].some((wall) => samePos(wall, dest))) return 'wall';
  const door = findDoorAt(level, side, dest);
  // Entry checks the door. Leaving a cell is handled by checking only the destination,
  // so a door that closes under a beetle cannot trap it on its current tile.
  if (door && !state.doors[door.id]) return 'closed-door';
  return null;
}

/**
 * Applies one synchronous arrow press.
 *
 * Door state used for movement is the pre-press state. Marker effects are applied
 * only after both movement attempts resolve, so toggled doors affect the next press.
 */
export function step(level: Level, prev: GameState, dir: Dir): StepResult {
  const moved: Record<SideId, boolean> = { inside: false, outside: false };
  const blockedReason: Record<SideId, BlockReason | null> = {
    inside: null,
    outside: null,
  };
  const pos: Record<SideId, Pos> = {
    inside: { ...prev.pos.inside },
    outside: { ...prev.pos.outside },
  };
  const events: GameEvent[] = [];

  for (const side of SIDES) {
    const dest = addDir(prev.pos[side], dir);
    const reason = blockedReasonAt(level, prev, side, dest);
    if (reason) {
      blockedReason[side] = reason;
      moved[side] = false;
      events.push({ type: 'blocked', side, reason });
    } else {
      pos[side] = dest;
      moved[side] = true;
    }
  }

  const doors = { ...prev.doors };
  const used = { ...prev.used };

  for (const marker of level.markers) {
    const wasTogether =
      samePos(prev.pos.inside, marker.at.inside) &&
      samePos(prev.pos.outside, marker.at.outside);
    const isTogether =
      samePos(pos.inside, marker.at.inside) && samePos(pos.outside, marker.at.outside);

    // Trigger on the false -> true co-occupancy edge. Remaining on the marker,
    // including turns where a blocked beetle does not move, does not retrigger.
    if (!wasTogether && isTogether) {
      if (marker.kind === 'once' && prev.used[marker.id]) continue;

      const nextOpen = !doors[marker.doorId];
      doors[marker.doorId] = nextOpen;
      if (marker.kind === 'once') used[marker.id] = true;
      events.push({
        type: 'marker-toggle',
        markerId: marker.id,
        doorId: marker.doorId,
        open: nextOpen,
        kind: marker.kind,
      });
    }
  }

  const next: GameState = {
    pos,
    doors,
    used,
    turn: prev.turn + 1,
  };

  if (isWin(level, next)) events.push({ type: 'win' });

  const effective =
    moved.inside ||
    moved.outside ||
    level.doors.some((door) => doors[door.id] !== prev.doors[door.id]) ||
    level.markers.some((marker) => marker.kind === 'once' && used[marker.id] !== prev.used[marker.id]);

  return { state: next, info: { dir, moved, blockedReason, events, effective } };
}

export interface ReachInfo {
  reachable: Set<string>;
  blockedDoorIds: Set<string>;
  targetReachable: boolean;
}

/** Flood fill under the state's current door values. Closed doors are barriers. */
export function staticReach(level: Level, state: GameState, side: SideId): ReachInfo {
  const start = state.pos[side];
  const reachable = new Set<string>([posKey(start)]);
  const blockedDoorIds = new Set<string>();
  const queue: Pos[] = [start];

  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const dir of ['up', 'down', 'left', 'right'] as Dir[]) {
      const next = addDir(p, dir);
      if (!inBounds(level, next)) continue;
      if (level.walls[side].some((wall) => samePos(wall, next))) continue;
      const door = findDoorAt(level, side, next);
      if (door && !state.doors[door.id]) {
        blockedDoorIds.add(door.id);
        continue;
      }
      const key = posKey(next);
      if (!reachable.has(key)) {
        reachable.add(key);
        queue.push(next);
      }
    }
  }

  const target = level.targets.find((t) => t.side === side);
  return {
    reachable,
    blockedDoorIds,
    targetReachable: target ? reachable.has(posKey(target.pos)) : false,
  };
}

function snapshotLines(level: Level, state: GameState): string[] {
  const lines = [
    `内侧甲虫：第 ${state.pos.inside.r + 1} 行 / 第 ${state.pos.inside.c + 1} 列`,
    `外侧甲虫：第 ${state.pos.outside.r + 1} 行 / 第 ${state.pos.outside.c + 1} 列（视图列）`,
  ];
  for (const door of level.doors) {
    lines.push(`门 ${door.label ?? door.id}：${state.doors[door.id] ? '开启' : '关闭'}`);
  }
  for (const marker of level.markers) {
    if (marker.kind === 'once') {
      lines.push(`一次性标记 ${marker.label}：${state.used[marker.id] ? '已消耗/翻掉' : '未消耗'}`);
    }
  }
  return lines;
}

export function diagnoseStuck(
  level: Level,
  state: GameState,
  reachableStates = 0,
): Diagnosis {
  const base = {
    reachableStates,
    positions: {
      inside: { ...state.pos.inside },
      outside: { ...state.pos.outside },
    },
    doors: { ...state.doors },
    used: { ...state.used },
    lines: snapshotLines(level, state),
  };

  if (isWin(level, state)) {
    return {
      ...base,
      kind: 'already-won',
      title: '已经到达目标',
      detail: '当前状态已经过关，不需要继续寻路。',
    };
  }

  const insideReach = staticReach(level, state, 'inside');
  const outsideReach = staticReach(level, state, 'outside');
  const allBlockedDoors = new Set([...insideReach.blockedDoorIds, ...outsideReach.blockedDoorIds]);

  const consumedPermanentDoor = level.doors.find((door) => {
    if (state.doors[door.id]) return false;
    if (!allBlockedDoors.has(door.id)) return false;
    const controls = level.markers.filter((marker) => marker.doorId === door.id);
    return (
      controls.length > 0 &&
      controls.every((marker) => marker.kind === 'once' && state.used[marker.id])
    );
  });

  if (consumedPermanentDoor) {
    const marker = level.markers.find(
      (m) => m.doorId === consumedPermanentDoor.id && m.kind === 'once' && state.used[m.id],
    );
    return {
      ...base,
      kind: 'consumed-one-shot-door',
      title: '死局：一次性触发已错误消耗',
      detail:
        `“${marker?.label ?? '钥匙标记'}”已经翻掉，而它控制的 ` +
        `“${consumedPermanentDoor.label ?? consumedPermanentDoor.id}”当前关闭；` +
        '没有其他标记能再次反转这对门。撤销到触发前，或重放正确脚本。',
    };
  }

  const anyPermanentClosedDoor = level.doors.find((door) => {
    if (state.doors[door.id] || !allBlockedDoors.has(door.id)) return false;
    const controls = level.markers.filter((marker) => marker.doorId === door.id);
    return controls.every((marker) => marker.kind === 'once' && state.used[marker.id]);
  });

  if (anyPermanentClosedDoor) {
    return {
      ...base,
      kind: 'permanently-closed-door',
      title: '死局：关键门已无法再打开',
      detail: '当前关闭的关键门只受已消耗的一次性标记控制，目标格已被永久隔开。',
    };
  }

  if (insideReach.targetReachable && outsideReach.targetReachable) {
    return {
      ...base,
      kind: 'synchronization-deadlock',
      title: '死局：两侧无法同步停到目标',
      detail:
        '单独看每侧目标现在都能走到，但四方向同步移动与真实门/标记状态使它们无法同时停在各自目标格。试试撤销到不同的相遇时机。',
    };
  }

  const sideName = !insideReach.targetReachable ? '内侧' : '外侧';
  return {
    ...base,
    kind: 'terrain-deadlock',
    title: `死局：${sideName}目标已不可达`,
    detail:
      '穷举所有方向后仍无法过关；按当前墙、门和标记消耗状态，至少一侧目标无法进入。可撤销或重置后换一种触发顺序。',
  };
}

interface BfsNode {
  state: GameState;
  parentKey: string | null;
  dir: Dir | null;
}

export function solve(
  level: Level,
  start: GameState = createInitialState(level),
  maxStates = 200_000,
): SearchResult {
  if (isWin(level, start)) {
    return { status: 'won', path: [], reachedStates: 1 };
  }

  const startKey = stateKey(start);
  const nodes = new Map<string, BfsNode>();
  nodes.set(startKey, { state: start, parentKey: null, dir: null });
  const queue: string[] = [startKey];
  const dirs: Dir[] = ['up', 'down', 'left', 'right'];

  while (queue.length > 0) {
    const currentKey = queue.shift()!;
    const node = nodes.get(currentKey)!;

    for (const dir of dirs) {
      const result = step(level, node.state, dir);
      const nextKey = stateKey(result.state);
      if (nodes.has(nextKey)) continue;

      const nextNode: BfsNode = { state: result.state, parentKey: currentKey, dir };
      nodes.set(nextKey, nextNode);

      if (isWin(level, result.state)) {
        const path: Dir[] = [];
        let cursorKey: string | null = nextKey;
        while (cursorKey && cursorKey !== startKey) {
          const cursor: BfsNode | undefined = nodes.get(cursorKey);
          if (!cursor || !cursor.dir) break;
          path.push(cursor.dir);
          cursorKey = cursor.parentKey;
        }
        path.reverse();
        return { status: 'won', path, reachedStates: nodes.size };
      }

      if (nodes.size >= maxStates) {
        return {
          status: 'limit',
          reachedStates: nodes.size,
          diagnosis: {
            ...diagnoseStuck(level, result.state, nodes.size),
            kind: 'search-limit',
            title: '搜索达到上限',
            detail: '状态空间超过本地原型上限，未能证明无解；请缩小编队或提高 maxStates。',
          },
        };
      }

      queue.push(nextKey);
    }
  }

  return {
    status: 'unsolvable',
    reachedStates: nodes.size,
    diagnosis: diagnoseStuck(level, start, nodes.size),
  };
}

export interface Hint {
  dir: Dir | null;
  pathLength: number | null;
  result: SearchResult;
}

/** The UI intentionally exposes only `dir`; the full path stays available for tests/replays. */
export function nextHint(level: Level, state: GameState): Hint {
  const result = solve(level, state);
  if (result.status === 'won') {
    return { dir: result.path[0] ?? null, pathLength: result.path.length, result };
  }
  return { dir: null, pathLength: null, result };
}

export function runScript(
  level: Level,
  script: string | Dir[],
  initial: GameState = createInitialState(level),
): { states: GameState[]; infos: StepInfo[]; won: boolean } {
  const dirs = typeof script === 'string' ? parseScript(script) : script;
  const states: GameState[] = [initial];
  const infos: StepInfo[] = [];
  let state = initial;
  for (const dir of dirs) {
    const result = step(level, state, dir);
    state = result.state;
    states.push(state);
    infos.push(result.info);
  }
  return { states, infos, won: isWin(level, state) };
}
