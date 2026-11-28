import { mapHoles } from './geometry';
import type {
  Action,
  Cell,
  CellAssessment,
  CellLayer,
  ColorId,
  Coord,
  Evaluation,
  FailureInfo,
  GameState,
  GameStatus,
  InkId,
  LevelDef,
  MaskAction,
  Snapshot,
  StampAction,
  StampRequest,
  StencilId,
} from './types';

export interface PreviewHole {
  /** 模板本地孔位。 */
  local: Coord;
  /** 落在棋盘上的目标格（可能出界）。 */
  target: Coord;
  onBoard: boolean;
  masked: boolean;
  clean: boolean;
  /** 接触后该格的颜色；出界或挡墨时为 null。 */
  afterColor: ColorId | null;
}

export interface StampPreview {
  request: StampRequest;
  holes: PreviewHole[];
  onBoard: Coord[];
  inked: Coord[];
  masked: Coord[];
  offBoard: Coord[];
  cleanContacts: Coord[];
  /** 实际结算墨量的格数 = 接触到且未被挡墨的棋盘格，含重复接触。 */
  cost: number;
  inkRemaining: number;
  affordable: boolean;
  canApply: boolean;
  /** 不能盖印时的原因；能盖印时为 null。 */
  reason: string | null;
}

export type StampFailureReason = 'not-playing' | 'no-contact' | 'insufficient-ink';

export interface StampRejected {
  ok: false;
  reason: StampFailureReason;
  message: string;
  preview: StampPreview;
}

export interface StampApplied {
  ok: true;
  game: GameState;
  entry: StampAction;
  preview: StampPreview;
}

export type StampResult = StampApplied | StampRejected;

export function inkColor(level: LevelDef, ink: InkId): ColorId {
  const def = level.inks.find((i) => i.id === ink);
  if (!def) throw new Error(`未知墨色：${ink}`);
  return def.color;
}

export function inkName(level: LevelDef, ink: InkId): string {
  const def = level.inks.find((i) => i.id === ink);
  return def?.name ?? ink;
}

export function inkSymbol(level: LevelDef, ink: InkId): string {
  const def = level.inks.find((i) => i.id === ink);
  return def?.symbol ?? '?';
}

export function colorName(level: LevelDef, color: ColorId): string {
  return level.palette.find((p) => p.id === color)?.name ?? color;
}

export function colorSymbol(level: LevelDef, color: ColorId): string {
  return level.palette.find((p) => p.id === color)?.symbol ?? '?';
}

/**
 * 叠色只取决于“当前颜色”和“本次墨色”这一对。
 * 表里没有的组合按新墨的固有色处理（例如两种复色再叠加）。
 */
export function mixColor(level: LevelDef, below: ColorId, ink: InkId): ColorId {
  const above = inkColor(level, ink);
  return level.mix[`${below}|${above}`] ?? above;
}

export function colorOfLayers(level: LevelDef, layers: CellLayer[]): ColorId {
  let color = level.paperColor;
  for (const layer of layers) {
    color = mixColor(level, color, layer.ink);
  }
  return color;
}

export function cloneCell(cell: Cell): Cell {
  return {
    layers: cell.layers.map((layer) => ({
      ...layer,
      orientation: { ...layer.orientation },
      pivot: { ...layer.pivot },
    })),
  };
}

export function cloneCells(cells: Cell[]): Cell[] {
  return cells.map(cloneCell);
}

export function indexOf(level: LevelDef, x: number, y: number): number {
  return y * level.width + x;
}

export function coordInLevel(level: LevelDef, x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < level.width && y < level.height;
}

export function cellAt(state: GameState, level: LevelDef, x: number, y: number): Cell | undefined {
  if (!coordInLevel(level, x, y)) return undefined;
  return state.cells[indexOf(level, x, y)];
}

export function createGame(level: LevelDef): GameState {
  return {
    levelId: level.id,
    cells: Array.from({ length: level.width * level.height }, () => ({ layers: [] })),
    inkLeft: { ...level.budget },
    mask: Array.from({ length: level.width * level.height }, () => false),
    stampNo: 0,
    history: [],
    status: 'playing',
    failure: null,
  };
}

function cloneFailure(failure: FailureInfo | null): FailureInfo | null {
  if (!failure) return null;
  return {
    ...failure,
    cells: failure.cells.map((c) => ({ ...c })),
    newCells: failure.newCells.map((c) => ({ ...c })),
  };
}

export function snapshotOf(state: GameState): Snapshot {
  return {
    cells: cloneCells(state.cells),
    inkLeft: { ...state.inkLeft },
    mask: [...state.mask],
    stampNo: state.stampNo,
    status: state.status,
    failure: cloneFailure(state.failure),
  };
}

function coordsFromHoles(level: LevelDef, holes: Coord[], state: GameState) {
  const onBoard: Coord[] = [];
  const inked: Coord[] = [];
  const masked: Coord[] = [];
  const offBoard: Coord[] = [];
  const cleanContacts: Coord[] = [];
  for (const coord of holes) {
    if (!coordInLevel(level, coord.x, coord.y)) {
      offBoard.push(coord);
      continue;
    }
    onBoard.push(coord);
    const idx = indexOf(level, coord.x, coord.y);
    if (state.mask[idx]) {
      masked.push(coord);
      continue;
    }
    inked.push(coord);
    if (level.plan[coord.y]![coord.x] === 'clean') cleanContacts.push(coord);
  }
  return { onBoard, inked, masked, offBoard, cleanContacts };
}

export function previewStamp(level: LevelDef, state: GameState, request: StampRequest): StampPreview {
  const stencil = level.stencils.find((s) => s.id === request.stencilId);
  if (!stencil) throw new Error(`未知模板：${request.stencilId}`);
  const targetHoles = mapHoles(stencil, request.pivot, request.orientation);
  const mapped = coordsFromHoles(level, targetHoles, state);
  const cost = mapped.inked.length;
  const inkRemaining = state.inkLeft[request.ink] ?? 0;
  const affordable = cost <= inkRemaining;
  let reason: string | null;
  if (state.status !== 'playing') {
    reason =
      state.status === 'solved'
        ? '本关已经完成，请撤回或重置后继续。'
        : '本次印画已判失败，请撤回失败的一印或重置。';
  } else if (cost === 0) {
    reason = '本次没有接触棋盘内未被挡墨的格，不能盖印。';
  } else if (!affordable) {
    reason = `墨量不足：本次接触 ${cost} 格，${inkName(level, request.ink)}只剩 ${inkRemaining} 格。整次不会盖下。`;
  } else {
    reason = null;
  }
  const previewHoles: PreviewHole[] = targetHoles.map((target, i) => {
    const local = stencil.holes[i]!;
    const onBoard = coordInLevel(level, target.x, target.y);
    const idx = onBoard ? indexOf(level, target.x, target.y) : -1;
    const masked = onBoard && state.mask[idx]!;
    const clean = onBoard && level.plan[target.y]![target.x] === 'clean';
    let afterColor: ColorId | null = null;
    if (onBoard && !masked) {
      afterColor = mixColor(level, colorOfLayers(level, state.cells[idx]!.layers), request.ink);
    }
    return { local, target, onBoard, masked, clean, afterColor };
  });
  return {
    request,
    holes: previewHoles,
    ...mapped,
    cost,
    inkRemaining,
    affordable,
    canApply: reason === null,
    reason,
  };
}

function failureOf(level: LevelDef, cells: Cell[], stampNo: number, newCells: Coord[]): FailureInfo | null {
  const dirty: Coord[] = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      if (level.plan[y]![x] === 'clean' && cells[indexOf(level, x, y)]!.layers.length > 0) {
        dirty.push({ x, y });
      }
    }
  }
  if (dirty.length === 0) return null;
  return { stampNo, cells: dirty, newCells: newCells.map((c) => ({ ...c })) };
}

export function stamp(level: LevelDef, state: GameState, request: StampRequest): StampResult {
  const preview = previewStamp(level, state, request);
  if (state.status !== 'playing') {
    return { ok: false, reason: 'not-playing', message: preview.reason ?? '当前不能盖印。', preview };
  }
  if (preview.cost === 0) {
    return { ok: false, reason: 'no-contact', message: preview.reason ?? '本次没有接触任何格。', preview };
  }
  if (preview.cost > (state.inkLeft[request.ink] ?? 0)) {
    return {
      ok: false,
      reason: 'insufficient-ink',
      message: preview.reason ?? '墨量不足，整次不会盖下。',
      preview,
    };
  }

  const before = snapshotOf(state);
  const cells = cloneCells(state.cells);
  const stampNo = state.stampNo + 1;
  for (const coord of preview.inked) {
    const idx = indexOf(level, coord.x, coord.y);
    cells[idx]!.layers.push({
      ink: request.ink,
      stampNo,
      stencilId: request.stencilId,
      orientation: { ...request.orientation },
      pivot: { ...request.pivot },
    });
  }
  const inkLeft = { ...state.inkLeft, [request.ink]: state.inkLeft[request.ink]! - preview.cost };
  const failure = failureOf(level, cells, stampNo, preview.cleanContacts);
  const withInk: GameState = { ...state, cells, inkLeft, stampNo, status: 'playing', failure };
  const evaluation = evaluate(level, withInk);
  const status: GameStatus = failure ? 'failed' : evaluation.solved ? 'solved' : 'playing';
  const entry: StampAction = {
    kind: 'stamp',
    stampNo,
    stencilId: request.stencilId,
    ink: request.ink,
    orientation: { ...request.orientation },
    pivot: { ...request.pivot },
    cost: preview.cost,
    contacted: preview.onBoard.map((c) => ({ ...c })),
    inked: preview.inked.map((c) => ({ ...c })),
    masked: preview.masked.map((c) => ({ ...c })),
    offBoard: preview.offBoard.map((c) => ({ ...c })),
    cleanContacts: preview.cleanContacts.map((c) => ({ ...c })),
    before,
  };
  const game: GameState = { ...withInk, status, history: [...state.history, entry] };
  return { ok: true, game, entry, preview };
}

export function toggleMask(
  level: LevelDef,
  state: GameState,
  x: number,
  y: number,
): { ok: true; game: GameState; action: MaskAction } | { ok: false; message: string } {
  if (state.status !== 'playing') {
    return { ok: false, message: state.status === 'solved' ? '本关已经完成。' : '请先撤回失败的一印。' };
  }
  if (!coordInLevel(level, x, y)) return { ok: false, message: '这里不在棋盘内。' };
  const idx = indexOf(level, x, y);
  const before = snapshotOf(state);
  const wasMasked = state.mask[idx]!;
  const mask = [...state.mask];
  mask[idx] = !wasMasked;
  const action: MaskAction = { kind: 'mask', x, y, wasMasked, before };
  return { ok: true, game: { ...state, mask, history: [...state.history, action] }, action };
}

export function undo(state: GameState): { game: GameState; action: Action } | null {
  const action = state.history[state.history.length - 1];
  if (!action) return null;
  const before = action.before;
  const game: GameState = {
    levelId: state.levelId,
    cells: cloneCells(before.cells),
    inkLeft: { ...before.inkLeft },
    mask: [...before.mask],
    stampNo: before.stampNo,
    status: before.status,
    failure: cloneFailure(before.failure),
    history: state.history.slice(0, -1),
  };
  return { game, action };
}

export function undoLabel(level: LevelDef, state: GameState): string {
  const action = state.history[state.history.length - 1];
  if (!action) return '没有可撤回的操作';
  if (action.kind === 'stamp') {
    return `撤回第 ${action.stampNo} 印（${inkName(level, action.ink)}，返还 ${action.cost} 格）`;
  }
  return `撤回 (${action.x + 1}, ${action.y + 1}) 的挡墨纸`;
}

export function evaluate(level: LevelDef, state: GameState): Evaluation {
  const cells: CellAssessment[] = [];
  const mismatches: Coord[] = [];
  const cleanViolations: Coord[] = [];
  let exactTotal = 0;
  let exactMatched = 0;
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const token = level.plan[y]![x]!;
      const cell = state.cells[indexOf(level, x, y)]!;
      const currentColor = colorOfLayers(level, cell.layers);
      const requirement = token === 'free' ? 'free' : token === 'clean' ? 'clean' : 'exact';
      const targetColor = requirement === 'exact' ? token : null;
      const exact = requirement !== 'exact' || currentColor === targetColor;
      const cleanViolated = requirement === 'clean' && cell.layers.length > 0;
      if (requirement === 'exact') {
        exactTotal += 1;
        if (exact) exactMatched += 1;
        else mismatches.push({ x, y });
      } else if (cleanViolated) {
        cleanViolations.push({ x, y });
      }
      cells.push({
        x,
        y,
        requirement,
        targetColor,
        currentColor,
        layerCount: cell.layers.length,
        exact,
        cleanViolated,
      });
    }
  }
  return {
    cells,
    exactTotal,
    exactMatched,
    mismatches,
    cleanViolations,
    solved: mismatches.length === 0 && cleanViolations.length === 0,
  };
}

export function isMasked(state: GameState, level: LevelDef, x: number, y: number): boolean {
  if (!coordInLevel(level, x, y)) return false;
  return state.mask[indexOf(level, x, y)]!;
}

export function layerSourceLabel(level: LevelDef, layer: CellLayer): string {
  const stencil = level.stencils.find((s) => s.id === layer.stencilId);
  return `第 ${layer.stampNo} 印 · ${inkName(level, layer.ink)} · ${stencil?.name ?? layer.stencilId} · ${layer.orientation.flipped ? '翻面' : '正面'} / 旋 ${(((layer.orientation.rotation % 4) + 4) % 4) * 90}°`;
}

export function stencilById(level: LevelDef, id: StencilId) {
  return level.stencils.find((s) => s.id === id);
}

export function countPlan(level: LevelDef): { exact: number; clean: number; free: number } {
  let exact = 0;
  let clean = 0;
  let free = 0;
  for (const row of level.plan) {
    for (const token of row) {
      if (token === 'free') free += 1;
      else if (token === 'clean') clean += 1;
      else exact += 1;
    }
  }
  return { exact, clean, free };
}
