import { axialToOffset, offsetToAxial } from './hex';
import { GameMap, cellKey } from './map';
import type { Enemy, Unit, UnitId } from './types';

export type ScenarioId = 'sandbox' | 'corner' | 'door' | 'handoff';

export interface ScenarioExpectation {
  col: number;
  row: number;
  note: string;
}

export interface ScenarioSpec {
  id: ScenarioId;
  title: string;
  blurb: string;
  /** Compact rows, 15 tokens × 12 rows: `.` floor, `#` wall, `D` open door, `d` closed door. */
  rows: readonly string[];
  units: ReadonlyArray<{ id: UnitId; label: string; col: number; row: number; radius: number }>;
  enemies: ReadonlyArray<{ id: number; label: string; col: number; row: number }>;
  /** A few cells whose expected player-view status is spelled out in the UI and tests. */
  expectVisible: readonly ScenarioExpectation[];
  expectHidden: readonly ScenarioExpectation[];
}

export interface ScenarioState {
  map: GameMap;
  units: Unit[];
  enemies: Enemy[];
}

export function materialise(spec: ScenarioSpec): ScenarioState {
  const map = GameMap.fromSerialised([...spec.rows]);
  const units: Unit[] = spec.units.map((u) => {
    const { q, r } = offsetToAxial(u.col, u.row);
    return { id: u.id, label: u.label, q, r, radius: u.radius };
  });
  const enemies: Enemy[] = spec.enemies.map((e) => {
    const { q, r } = offsetToAxial(e.col, e.row);
    return { id: e.id, label: e.label, q, r };
  });
  return { map, units, enemies };
}

export function offsetKey(col: number, row: number): string {
  const { q, r } = offsetToAxial(col, row);
  return cellKey(q, r);
}

export function keyToOffset(key: string): { col: number; row: number } {
  const comma = key.indexOf(',');
  const q = Number(key.slice(0, comma));
  const r = Number(key.slice(comma + 1));
  return axialToOffset(q, r);
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** Main free-play board: mixed walls, one closed and one open door, two scouts. */
const SANDBOX_ROWS = [
  '.....###.......',
  '.....#.#.......',
  '.......#.......',
  '..###..#..##...',
  '..#........#...',
  '..#..d.....#...',
  '.....D.........',
  '..###...####...',
  '........#......',
  '...##...#..##..',
  '...##......##..',
  '...............',
];

/**
 * Corner occlusion. A pillar stands east of A. A probe cell sits directly in
 * its shadow; a nearby cell is only grazed by the centre line and must stay
 * visible.
 */
const CORNER_ROWS = [
  '...............',
  '...............',
  '...............',
  '...............',
  '......###......',
  '......###......',
  '......###......',
  '...............',
  '...............',
  '...............',
  '...............',
  '...............',
];

/**
 * Narrow doorway. A full-height wall with one single-cell door splits the
 * board. Closed: the east half is dark. Open: the cone pours through the
 * one-cell gap. A second door further south gives B its own way through.
 */
const DOOR_ROWS = [
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......d.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......D.......',
  '.......#.......',
  '.......#.......',
];

/**
 * Vision handoff. Two open halls separated by a wall with a single two-cell
 * gap. Each scout covers its own hall; a thin strip of cells on both sides of
 * the gap is genuinely seen by both, which is what makes step-by-step handoff
 * observable. Removing one scout must not erase what the other still sees.
 */
const HANDOFF_ROWS = [
  '...............',
  '...............',
  '...............',
  '...............',
  '...............',
  '######..#######',
  '...............',
  '...............',
  '...............',
  '...............',
  '...............',
  '...............',
];

/** F is not a token; write it as floor. Kept separate for clarity. */
function rowsOf(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/F/g, '.'));
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: 'sandbox',
    title: '自由沙盘',
    blurb: '15×12 综合棋盘：混合墙体、一扇关闭的门与一扇打开的门。移动斥候、开门关窗，观察三态视野。',
    rows: SANDBOX_ROWS,
    units: [
      { id: 'A', label: '斥候 A', col: 3, row: 6, radius: 5 },
      { id: 'B', label: '斥候 B', col: 13, row: 10, radius: 3 },
    ],
    enemies: [
      { id: 1, label: 'E1', col: 9, row: 5 },
      { id: 2, label: 'E2', col: 10, row: 1 },
      { id: 3, label: 'E3', col: 12, row: 8 },
    ],
    expectVisible: [
      { col: 4, row: 6, note: 'A 东侧邻格' },
      { col: 5, row: 6, note: '打开的门本身可见，且可通行' },
    ],
    expectHidden: [
      { col: 9, row: 5, note: '关着的门（5,5）之后，敌标记 E1 不可见' },
    ],
  },
  {
    id: 'corner',
    title: '转角遮挡',
    blurb: 'A 位于开阔地，方形立柱挡住正后方；擦着立柱边角的格子没有内穿，仍应可见。',
    rows: CORNER_ROWS,
    units: [
      { id: 'A', label: '斥候 A', col: 2, row: 6, radius: 7 },
      { id: 'B', label: '斥候 B', col: 8, row: 2, radius: 4 },
    ],
    enemies: [
      { id: 1, label: 'E1', col: 9, row: 6 },
      { id: 2, label: 'E2', col: 10, row: 4 },
    ],
    expectVisible: [
      { col: 5, row: 6, note: '立柱前的地面' },
      { col: 10, row: 4, note: '擦过立柱边角的格子（不进遮挡）' },
    ],
    expectHidden: [
      { col: 9, row: 6, note: '立柱正后方，敌标记 E1 被完全挡住' },
    ],
  },
  {
    id: 'door',
    title: '狭门开关',
    blurb: '隔墙上的两扇单格门。关门时门后全黑；开门后视野立即穿过门缝，门后一格可见。',
    rows: DOOR_ROWS,
    units: [
      { id: 'A', label: '斥候 A', col: 3, row: 5, radius: 6 },
      { id: 'B', label: '斥候 B', col: 12, row: 10, radius: 3 },
    ],
    enemies: [
      { id: 1, label: 'E1', col: 9, row: 5 },
      { id: 2, label: 'E2', col: 2, row: 5 },
    ],
    expectVisible: [
      { col: 4, row: 5, note: 'A 东侧邻格' },
      { col: 12, row: 10, note: 'B 自身所在格' },
      { col: 7, row: 5, note: '关闭的门本身在 A 视线内，应当可见' },
    ],
    expectHidden: [
      { col: 9, row: 5, note: '关闭的门（7,5）之后，E1 不可见' },
    ],
  },
  {
    id: 'handoff',
    title: '两人视野交接',
    blurb: '两名斥候分处两侧房间，中部走廊只有距离够近的一方能看见；收回一方视野不会抹掉另一方仍能看到的格子。',
    rows: rowsOf(HANDOFF_ROWS),
    units: [
      { id: 'A', label: '斥候 A', col: 5, row: 3, radius: 4 },
      { id: 'B', label: '斥候 B', col: 9, row: 8, radius: 4 },
    ],
    enemies: [
      { id: 1, label: 'E1', col: 10, row: 0 },
      { id: 2, label: 'E2', col: 13, row: 4 },
    ],
    expectVisible: [
      { col: 6, row: 3, note: 'A 的邻格，仅 A 看见' },
      { col: 10, row: 8, note: 'B 的邻格，仅 B 看见' },
      { col: 7, row: 5, note: '墙缝中线，两人同时看见（共享视野）' },
    ],
    expectHidden: [
      { col: 10, row: 0, note: 'A 视距外、B 的墙影内，敌标记 E1 不可见' },
    ],
  },
];

export function scenarioById(id: ScenarioId): ScenarioSpec {
  const spec = SCENARIOS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown scenario ${id}`);
  return spec;
}
