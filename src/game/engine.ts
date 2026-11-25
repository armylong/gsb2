// ============================================================
// 滚方块盖印 —— 核心规则引擎（纯数据 / 纯函数，不依赖 DOM）
// ============================================================

// ---------- 六面色签 ----------
export type ColorId = 'R' | 'O' | 'Y' | 'G' | 'B' | 'P';

export interface ColorInfo {
  id: ColorId;
  name: string; // 中文名
  hex: string; // 主色
  deep: string; // 暗部 / 描边
  light: string; // 浅底
  ink: string; // 主色底上的文字色
}

export const COLORS: Record<ColorId, ColorInfo> = {
  R: { id: 'R', name: '赤', hex: '#e0474c', deep: '#a92b31', light: '#fbdcdd', ink: '#ffffff' },
  O: { id: 'O', name: '橙', hex: '#f07f2e', deep: '#b8530f', light: '#fde3cd', ink: '#3a1d05' },
  Y: { id: 'Y', name: '黄', hex: '#e9bf22', deep: '#9a7b0a', light: '#fbeebd', ink: '#43330a' },
  G: { id: 'G', name: '绿', hex: '#2fa36b', deep: '#1c7449', light: '#cdeedd', ink: '#ffffff' },
  B: { id: 'B', name: '蓝', hex: '#3e7bfa', deep: '#1f51c4', light: '#d6e2ff', ink: '#ffffff' },
  P: { id: 'P', name: '紫', hex: '#8b5cf6', deep: '#6329c9', light: '#e7dcff', ink: '#ffffff' },
};

export const COLOR_IDS: ColorId[] = ['R', 'O', 'Y', 'G', 'B', 'P'];

// ---------- 朝向 ----------
// Ori 是长度 6 的字符串，槽位顺序固定为 T(顶) B(贴地) N(北/上侧) S(南/下侧) E(东/右侧) W(西/左侧)
export const ORI_SLOTS = ['T', 'B', 'N', 'S', 'E', 'W'] as const;
export type FaceSlot = (typeof ORI_SLOTS)[number];
export const SLOT_INDEX: Record<FaceSlot, number> = { T: 0, B: 1, N: 2, S: 3, E: 4, W: 5 };

export type Ori = string;

export function faceColor(ori: Ori, slot: FaceSlot): ColorId {
  return ori[SLOT_INDEX[slot]] as ColorId;
}

/**
 * 按方向绕接触边滚 90°。
 * 向某方向滚时，该方向的侧面先贴地 -> 成为新的 B。
 */
export function rollOri(ori: Ori, dir: Dir): Ori {
  const o = ori;
  switch (dir) {
    case 'N':
      // T'=S  B'=N  N'=T  S'=B
      return o[3] + o[2] + o[0] + o[1] + o[4] + o[5];
    case 'S':
      // T'=N  B'=S  N'=B  S'=T
      return o[2] + o[3] + o[1] + o[0] + o[4] + o[5];
    case 'E':
      // T'=W  B'=E  N'=N  S'=S  E'=T  W'=B
      return o[5] + o[4] + o[2] + o[3] + o[0] + o[1];
    case 'W':
      // T'=E  B'=W  N'=N  S'=S  E'=B  W'=T
      return o[4] + o[5] + o[2] + o[3] + o[1] + o[0];
  }
}

/** 绕竖直轴水平转向 q 个 90°（俯视顺时针为 +1），T/B 不变。用于派生不同起手朝向。 */
export function yawOri(ori: Ori, q: number): Ori {
  let o = ori;
  const turns = ((q % 4) + 4) % 4;
  // 顺时针一格: N'=W S'=E E'=N W'=S
  for (let i = 0; i < turns; i++) {
    o = o[0] + o[1] + o[5] + o[4] + o[2] + o[3];
  }
  return o;
}

// ---------- 方向 ----------
export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIR_LIST: Dir[] = ['N', 'E', 'S', 'W'];
export const DIR_VEC: Record<Dir, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  E: { dx: 1, dy: 0 },
  S: { dx: 0, dy: 1 },
  W: { dx: -1, dy: 0 },
};
export const DIR_LABEL: Record<Dir, string> = { N: '北/上', E: '东/右', S: '南/下', W: '西/左' };
export const DIR_SHORT: Record<Dir, string> = { N: '上', E: '右', S: '下', W: '左' };
export const DIR_ARROW: Record<Dir, string> = { N: '▲', E: '▶', S: '▼', W: '◀' };

// ---------- 题面 / 棋盘 ----------
/**
 * ASCII 地图字符：
 *  #  墙（边墙 / 障碍）
 *  .  普通地板
 *  空格 同 .
 *  @  起点
 *  ~  素格：可以走过，但不能在上面留色
 *  1-9 / a-z 盖印目标格，具体要求在 slots 里声明
 */
export interface SlotDef {
  need: ColorId;
  seal?: boolean; // 封口格：所有普通目标盖好后才允许盖
  note?: string;
}

export interface VariantDef {
  id: string;
  label: string;
  ori: Ori;
  note: string;
}

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  brief: string;
  rows: string[];
  slots: Record<string, SlotDef>;
  startOri: Ori;
  stampedBlocks: boolean; // “盖过的格不能再经过”规则的默认开关
  variants?: VariantDef[];
  fork?: boolean;
  forkNote?: string;
}

export type CellKind = 'wall' | 'floor' | 'clean' | 'slot';

export interface Cell {
  x: number;
  y: number;
  kind: CellKind;
  ch: string;
  slotIndex: number; // -1 表示非目标格
}

export interface SlotCell {
  index: number;
  x: number;
  y: number;
  def: SlotDef;
}

export interface Board {
  level: LevelDef;
  cols: number;
  rows: number;
  cells: Cell[][]; // cells[y][x]
  start: { x: number; y: number };
  slotCells: SlotCell[];
}

export function parseLevel(level: LevelDef): Board {
  const rows = level.rows.length;
  const cols = Math.max(...level.rows.map((r) => r.length));
  const cells: Cell[][] = [];
  const slotCells: SlotCell[] = [];
  let start = { x: 1, y: 1 };

  for (let y = 0; y < rows; y++) {
    const line = level.rows[y].padEnd(cols, '#');
    const row: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const ch = line[x] ?? '#';
      let kind: CellKind;
      let slotIndex = -1;
      if (ch === '#') {
        kind = 'wall';
      } else if (ch === '~') {
        kind = 'clean';
      } else if (ch === '@' || ch === '.' || ch === ' ') {
        kind = 'floor';
        if (ch === '@') start = { x, y };
      } else if (level.slots[ch]) {
        kind = 'slot';
        slotIndex = slotCells.length;
        slotCells.push({ index: slotIndex, x, y, def: level.slots[ch] });
      } else {
        // 未声明的字符按墙处理，避免误配
        kind = 'wall';
      }
      row.push({ x, y, kind, ch, slotIndex });
    }
    cells.push(row);
  }
  return { level, cols, rows, cells, start, slotCells };
}

export function cellAt(board: Board, x: number, y: number): Cell | null {
  if (y < 0 || y >= board.rows || x < 0 || x >= board.cols) return null;
  return board.cells[y][x];
}

export function slotAt(board: Board, x: number, y: number): SlotCell | null {
  const c = cellAt(board, x, y);
  if (!c || c.slotIndex < 0) return null;
  return board.slotCells[c.slotIndex] ?? null;
}

// ---------- 运行时局面（快照，可持久化 / 入撤销栈） ----------
export interface GameState {
  x: number;
  y: number;
  ori: Ori;
  /** key `${x},${y}` -> 盖下的颜色（包括盖错的印 / 污渍） */
  stamps: Record<string, ColorId>;
}

export const cellKey = (x: number, y: number): string => `${x},${y}`;

export function initialState(board: Board, oriOverride?: Ori): GameState {
  return {
    x: board.start.x,
    y: board.start.y,
    ori: oriOverride ?? board.level.startOri,
    stamps: {},
  };
}

// ---------- 移动 ----------
export type BlockReason = 'wall' | 'stamp';

export interface MoveOk {
  ok: true;
  state: GameState;
  tx: number;
  ty: number;
}
export interface MoveBlocked {
  ok: false;
  reason: BlockReason;
  tx: number;
  ty: number;
}
export type MoveResult = MoveOk | MoveBlocked;

/**
 * 只判定“进入目标格”是否合法。
 * 盖印格阻挡规则只阻挡“再次进入”；当前正站在刚盖的印上时，离开不受限。
 */
export function tryMove(state: GameState, board: Board, dir: Dir, stampedBlocks: boolean): MoveResult {
  const v = DIR_VEC[dir];
  const tx = state.x + v.dx;
  const ty = state.y + v.dy;
  const c = cellAt(board, tx, ty);
  if (!c || c.kind === 'wall') {
    return { ok: false, reason: 'wall', tx, ty };
  }
  if (stampedBlocks && state.stamps[cellKey(tx, ty)] !== undefined) {
    return { ok: false, reason: 'stamp', tx, ty };
  }
  return {
    ok: true,
    tx,
    ty,
    state: { ...state, x: tx, y: ty, ori: rollOri(state.ori, dir) },
  };
}

// ---------- 盖印 ----------
export type StampVerdict = 'right' | 'wrong-color' | 'clean-blot' | 'floor-blot';

export type StampResult =
  | { ok: true; state: GameState; verdict: StampVerdict; color: ColorId }
  | { ok: false; reason: 'occupied' | 'seal-locked' };

export function normalSlotsAllRight(state: GameState, board: Board): boolean {
  return board.slotCells
    .filter((sc) => !sc.def.seal)
    .every((sc) => state.stamps[cellKey(sc.x, sc.y)] === sc.def.need);
}

export function tryStamp(state: GameState, board: Board): StampResult {
  const key = cellKey(state.x, state.y);
  if (state.stamps[key] !== undefined) {
    return { ok: false, reason: 'occupied' };
  }
  const cell = board.cells[state.y]?.[state.x];
  if (!cell || cell.kind === 'wall') {
    return { ok: false, reason: 'occupied' };
  }

  // 封口格：普通目标未全部正确盖好前，不允许落印（也不产生错印）
  const sc = cell.slotIndex >= 0 ? board.slotCells[cell.slotIndex] : null;
  if (sc?.def.seal && !normalSlotsAllRight(state, board)) {
    return { ok: false, reason: 'seal-locked' };
  }

  const color = faceColor(state.ori, 'B');
  let verdict: StampVerdict;
  if (sc) {
    verdict = color === sc.def.need ? 'right' : 'wrong-color';
  } else if (cell.kind === 'clean') {
    verdict = 'clean-blot';
  } else {
    verdict = 'floor-blot';
  }

  return {
    ok: true,
    color,
    verdict,
    state: { ...state, stamps: { ...state.stamps, [key]: color } },
  };
}

// ---------- 局面评估 ----------
export type SlotStateKind = 'empty' | 'right' | 'wrong';

export interface SlotStatus {
  index: number;
  x: number;
  y: number;
  need: ColorId;
  seal: boolean;
  got?: ColorId;
  kind: SlotStateKind;
}

export interface WrongStamp {
  x: number;
  y: number;
  color: ColorId;
  kind: 'wrong-color' | 'clean-blot' | 'floor-blot';
}

export interface Progress {
  slots: SlotStatus[];
  rightCount: number;
  total: number;
  normalRight: number;
  normalTotal: number;
  sealRight: number;
  sealTotal: number;
  sealsReady: boolean;
  wrongStamps: WrongStamp[];
  won: boolean;
}

export function evaluate(board: Board, state: GameState): Progress {
  const slots: SlotStatus[] = board.slotCells.map((sc) => {
    const got = state.stamps[cellKey(sc.x, sc.y)];
    let kind: SlotStateKind = 'empty';
    if (got !== undefined) kind = got === sc.def.need ? 'right' : 'wrong';
    return {
      index: sc.index,
      x: sc.x,
      y: sc.y,
      need: sc.def.need,
      seal: !!sc.def.seal,
      got,
      kind,
    };
  });

  const wrongStamps: WrongStamp[] = [];
  for (const [k, color] of Object.entries(state.stamps)) {
    const [xs, ys] = k.split(',');
    const x = Number(xs);
    const y = Number(ys);
    const cell = cellAt(board, x, y);
    const sc = cell && cell.slotIndex >= 0 ? board.slotCells[cell.slotIndex] : null;
    if (sc && color === sc.def.need) continue; // 正确印
    let kind: WrongStamp['kind'];
    if (sc) kind = 'wrong-color';
    else if (cell?.kind === 'clean') kind = 'clean-blot';
    else kind = 'floor-blot';
    wrongStamps.push({ x, y, color, kind });
  }

  const rightCount = slots.filter((s) => s.kind === 'right').length;
  const normalSlots = slots.filter((s) => !s.seal);
  const sealSlots = slots.filter((s) => s.seal);
  const normalRight = normalSlots.filter((s) => s.kind === 'right').length;
  const sealRight = sealSlots.filter((s) => s.kind === 'right').length;
  const sealsReady = normalRight === normalSlots.length;
  const won = rightCount === slots.length && wrongStamps.length === 0;

  return {
    slots,
    rightCount,
    total: slots.length,
    normalRight,
    normalTotal: normalSlots.length,
    sealRight,
    sealTotal: sealSlots.length,
    sealsReady,
    wrongStamps,
    won,
  };
}

/** 生成一段简短的局面文字，用于提示文案 / 调试 */
export function describePose(state: GameState): string {
  const b = faceColor(state.ori, 'B');
  const t = faceColor(state.ori, 'T');
  return `顶${t} 底${b}`;
}
