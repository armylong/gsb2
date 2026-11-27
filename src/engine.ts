// 折纸打孔核心引擎：纯逻辑，无 DOM 依赖，便于本地核对。
// 坐标约定：x 向右为正，y 向下为正。格子 (x,y) 表示该格左上角原点格。
// 折纸只做镜像反射（不旋转 90°），每片纸记录自己相对原始格子的朝向。

export type Axis = 'v' | 'h'; // v = 竖线折（沿竖线，左右翻）；h = 横线折（沿横线，上下翻）
export type Dir = 'left' | 'right' | 'up' | 'down';

export interface Pos {
  x: number;
  y: number;
}

/** 一片纸：对应原始网格中的一个格子 */
export interface Piece {
  id: number;
  /** 原始格子 */
  ox: number;
  oy: number;
  /** 相对原始方向的翻转次数（模 2）。竖折翻转 fx，横折翻转 fy */
  fx: 0 | 1;
  fy: 0 | 1;
  /** 该纸片上是否已被打孔（同一格重复打孔不新增洞） */
  holed: boolean;
}

/** 叠在同一位置的一摞纸，数组顺序自底向上，最后一个元素是顶层 */
export type Cell = Piece[];

export interface FoldRecord {
  axis: Axis;
  line: number;
  side: 'lt' | 'gt'; // 被折动一侧
  /** 被移动纸片的 id（折前自底向上的顺序），用于展开恢复 */
  movedIds: number[];
}

export type LogKind = 'fold' | 'unfold' | 'punch';

export interface LogEntry {
  seq: number;
  kind: LogKind;
  text: string;
}

export interface Level {
  id: number;
  name: string;
  brief: string;
  width: number;
  height: number;
  maxFolds: number;
  maxPunches: number;
  maxThickness: number;
  /** 通关必须出现孔的原始格子 */
  targets: Pos[];
  /** 通关必须完整保留（无孔）的原始格子 */
  preserves: Pos[];
  /** 通关示例动作，由引擎逐步执行并自检 */
  solution: SolutionStep[];
}

export type SolutionStep =
  | { kind: 'fold'; axis: Axis; line: number; side: 'lt' | 'gt' }
  | { kind: 'unfold' }
  | { kind: 'punch'; x: number; y: number; depth: number };

export interface GameState {
  level: Level;
  /** key -> 自底向上的纸层栈 */
  cells: Map<string, Cell>;
  folds: FoldRecord[];
  holes: Set<number>; // 已有孔的纸片 id
  foldsUsed: number;
  punchesUsed: number;
  log: LogEntry[];
  /** 撤销栈：每个成功动作（折/展开/打孔）前的深拷贝 */
  undoStack: GameState[];
  status: 'playing' | 'won';
}

export const keyOf = (x: number, y: number): string => `${x},${y}`;

export function createInitialState(level: Level): GameState {
  const cells = new Map<string, Cell>();
  let id = 0;
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      cells.set(keyOf(x, y), [
        { id, ox: x, oy: y, fx: 0, fy: 0, holed: false },
      ]);
      id++;
    }
  }
  return {
    level,
    cells,
    folds: [],
    holes: new Set(),
    foldsUsed: 0,
    punchesUsed: 0,
    log: [],
    undoStack: [],
    status: 'playing',
  };
}

export function cloneState(s: GameState): GameState {
  const cells = new Map<string, Cell>();
  for (const [k, stack] of s.cells) {
    cells.set(k, stack.map((p) => ({ ...p })));
  }
  return {
    ...s,
    cells,
    folds: s.folds.map((f) => ({ ...f, movedIds: [...f.movedIds] })),
    holes: new Set(s.holes),
    log: s.log.map((e) => ({ ...e })),
    undoStack: s.undoStack.map(cloneState),
  };
}

export function getCell(s: GameState, x: number, y: number): Cell | undefined {
  return s.cells.get(keyOf(x, y));
}

export function allPieces(s: GameState): Piece[] {
  const out: Piece[] = [];
  for (const stack of s.cells.values()) out.push(...stack);
  return out;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

const axisText = (axis: Axis): string => (axis === 'v' ? '竖线' : '横线');
const sideText = (side: 'lt' | 'gt'): string => (side === 'lt' ? '小坐标侧' : '大坐标侧');

function pushLog(s: GameState, kind: LogKind, text: string): void {
  s.log.push({ seq: s.log.length + 1, kind, text });
}

/**
 * 沿 axis 方向、坐标为 line 的网格线，把 side 一侧折到另一侧。
 * 允许折后超出原纸面；厚度超过关卡上限则拒绝并原地保持。
 */
export function applyFold(
  s: GameState,
  axis: Axis,
  line: number,
  side: 'lt' | 'gt',
): ActionResult {
  const lv = s.level;
  const limit = axis === 'v' ? lv.width : lv.height;
  if (!Number.isInteger(line) || line <= 0 || line >= limit) {
    return { ok: false, reason: `折痕必须落在 1..${limit - 1} 之间的网格线上` };
  }
  if (s.foldsUsed >= lv.maxFolds) {
    return { ok: false, reason: `折叠次数已用完（上限 ${lv.maxFolds} 次）` };
  }

  const inMovingSide = (x: number, y: number): boolean => {
    if (axis === 'v') return side === 'lt' ? x < line : x > line;
    return side === 'lt' ? y < line : y > line;
  };
  // 折痕线上的格子是铰链，始终保持不动。

  const sourceKeys = [...s.cells.keys()].filter((k) => {
    const [x, y] = k.split(',').map(Number);
    return inMovingSide(x, y);
  });
  if (sourceKeys.length === 0) {
    return { ok: false, reason: '该侧已经没有纸可折（可能已被前一次折走）' };
  }

  const mirror = (v: number): number => 2 * line - v;

  // 预演厚度，任何目标位置超限都整体拒绝，保证“原地保持”。
  const simulated = new Map<string, number>();
  for (const [k, stack] of s.cells) simulated.set(k, stack.length);
  for (const k of sourceKeys) {
    const [x, y] = k.split(',').map(Number);
    const tx = axis === 'v' ? mirror(x) : x;
    const ty = axis === 'h' ? mirror(y) : y;
    const tk = keyOf(tx, ty);
    const next = (simulated.get(tk) ?? 0) + (simulated.get(k) ?? 0);
    if (next > lv.maxThickness) {
      return {
        ok: false,
        reason: `折到 (${tx},${ty}) 后厚度为 ${next} 层，超过上限 ${lv.maxThickness} 层，已原地保持`,
      };
    }
    simulated.set(tk, next);
    simulated.delete(k);
  }

  const undo = cloneState(s);
  const movedIds: number[] = [];
  const next = new Map<string, Cell>();
  for (const [k, stack] of s.cells) {
    if (sourceKeys.includes(k)) continue;
    next.set(k, stack);
  }

  for (const k of sourceKeys) {
    const [x, y] = k.split(',').map(Number);
    const tx = axis === 'v' ? mirror(x) : x;
    const ty = axis === 'h' ? mirror(y) : y;
    const tk = keyOf(tx, ty);
    // 自底向上逐片翻转朝向；整摞翻面后层序物理反转，
    // 故压到目标栈顶部时按逆序放置（原顶层翻面后贴着目标栈）。
    const flipped: Cell = s.cells.get(k)!.map((p) => {
      const np: Piece = {
        ...p,
        fx: axis === 'v' ? ((p.fx ^ 1) as 0 | 1) : p.fx,
        fy: axis === 'h' ? ((p.fy ^ 1) as 0 | 1) : p.fy,
      };
      movedIds.push(p.id);
      return np;
    });
    const dest = next.get(tk) ?? [];
    next.set(tk, [...dest, ...flipped.reverse()]);
  }

  s.undoStack.push(undo);
  s.cells = next;
  s.folds.push({ axis, line, side, movedIds });
  s.foldsUsed += 1;
  pushLog(s, 'fold', `沿${axisText(axis)} ${line} 把${sideText(side)}折向另一侧`);
  return { ok: true };
}

/** 撤销最近一次折叠（展开）。打孔后仍可展开，孔跟随纸片走。 */
export function applyUnfold(s: GameState): ActionResult {
  const last = s.folds[s.folds.length - 1];
  if (!last) {
    return { ok: false, reason: '当前没有已折起的纸层可展开' };
  }
  const undo = cloneState(s);
  const idSet = new Set(last.movedIds);
  const next = new Map<string, Cell>();
  for (const [k, stack] of s.cells) next.set(k, [...stack]);

  const mirror = (v: number): number => 2 * last.line - v;

  // 逐摞处理：把属于本次折叠的纸片按原顺序取出、镜像回原位
  for (const [k, stack] of [...next.entries()]) {
    const movers = stack.filter((p) => idSet.has(p.id));
    if (movers.length === 0) continue;
    const stayers = stack.filter((p) => !idSet.has(p.id));
    if (stayers.length > 0) next.set(k, stayers);
    else next.delete(k);

    // 折叠时 mover 是按源栈自底向上依次压顶的，逆序还原回原层序
    for (let i = movers.length - 1; i >= 0; i--) {
      const p = movers[i];
      const ox = last.axis === 'v' ? mirror(Number(k.split(',')[0])) : Number(k.split(',')[0]);
      const oy = last.axis === 'h' ? mirror(Number(k.split(',')[1])) : Number(k.split(',')[1]);
      const ok2 = keyOf(ox, oy);
      const restored: Piece = {
        ...p,
        fx: last.axis === 'v' ? ((p.fx ^ 1) as 0 | 1) : p.fx,
        fy: last.axis === 'h' ? ((p.fy ^ 1) as 0 | 1) : p.fy,
      };
      const dest = next.get(ok2) ?? [];
      next.set(ok2, [...dest, restored]);
    }
  }

  s.undoStack.push(undo);
  s.cells = next;
  s.folds.pop();
  pushLog(s, 'unfold', `展开最近一次${axisText(last.axis)}折叠，层序恢复原样`);
  return { ok: true };
}

/**
 * 在叠好的纸的 (x,y) 位置，从顶层向下打穿 depth 层。
 * depth 必须为正且不超过该摞厚度；同一格重复打孔不新增洞，但照样结算次数。
 */
export function applyPunch(s: GameState, x: number, y: number, depth: number): ActionResult {
  const lv = s.level;
  if (s.punchesUsed >= lv.maxPunches) {
    return { ok: false, reason: `打孔次数已用完（上限 ${lv.maxPunches} 次）` };
  }
  if (!Number.isInteger(depth) || depth <= 0) {
    return { ok: false, reason: '打穿层数必须是正整数' };
  }
  const stack = s.cells.get(keyOf(x, y));
  if (!stack) {
    return { ok: false, reason: `(${x},${y}) 处没有纸，无法打孔，动作已原地保持` };
  }
  if (depth > stack.length) {
    return {
      ok: false,
      reason: `该位置只有 ${stack.length} 层，打穿 ${depth} 层会超出纸面，已原地保持`,
    };
  }

  const undo = cloneState(s);
  s.undoStack.push(undo);

  const top = stack.slice(stack.length - depth);
  let fresh = 0;
  for (const p of top) {
    if (!p.holed) {
      p.holed = true;
      s.holes.add(p.id);
      fresh++;
    }
  }
  s.punchesUsed += 1;
  const same = depth - fresh;
  pushLog(
    s,
    'punch',
    `在 (${x},${y}) 打穿顶层 ${depth} 层，新增 ${fresh} 个洞` +
      (same > 0 ? `（其中 ${same} 层已有孔，不新增但照常消耗次数）` : ''),
  );
  return { ok: true };
}

/** 撤销最近一个动作（折 / 展开 / 打孔），层序与计数全部回到动作前 */
export function undoLast(s: GameState): ActionResult {
  const prev = s.undoStack.pop();
  if (!prev) return { ok: false, reason: '没有可撤销的动作' };
  const kind = s.log[s.log.length - 1]?.kind;
  // prev 是动作前快照，直接整体还原
  s.cells = prev.cells;
  s.folds = prev.folds;
  s.holes = prev.holes;
  s.foldsUsed = prev.foldsUsed;
  s.punchesUsed = prev.punchesUsed;
  s.log = prev.log;
  s.undoStack = prev.undoStack;
  s.status = 'playing';
  pushLog(s, kind ?? 'fold', `撤销上一步（${labelOf(kind)}），层序与计数已还原`);
  return { ok: true };
}

function labelOf(kind: LogKind | undefined): string {
  if (kind === 'fold') return '折叠';
  if (kind === 'unfold') return '展开';
  if (kind === 'punch') return '打孔';
  return '动作';
}

export interface WinReport {
  won: boolean;
  missing: Pos[]; // 目标中还没孔的
  broken: Pos[]; // 保留格中被打穿的
  extra: Pos[]; // 既非目标也非保留、却有孔的格子（提示用，不阻断通关）
}

export function evaluate(s: GameState): WinReport {
  const byOrigin = new Map<string, Piece>();
  for (const p of allPieces(s)) byOrigin.set(keyOf(p.ox, p.oy), p);
  const isHoled = (x: number, y: number): boolean => byOrigin.get(keyOf(x, y))?.holed ?? false;

  const missing = s.level.targets.filter((t) => !isHoled(t.x, t.y));
  const broken = s.level.preserves.filter((t) => isHoled(t.x, t.y));

  const targetSet = new Set(s.level.targets.map((t) => keyOf(t.x, t.y)));
  const preserveSet = new Set(s.level.preserves.map((t) => keyOf(t.x, t.y)));
  const extra: Pos[] = [];
  for (const p of allPieces(s)) {
    const k = keyOf(p.ox, p.oy);
    if (p.holed && !targetSet.has(k) && !preserveSet.has(k)) extra.push({ x: p.ox, y: p.oy });
  }
  return { won: missing.length === 0 && broken.length === 0, missing, broken, extra };
}

export function maybeWin(s: GameState): WinReport {
  const report = evaluate(s);
  if (report.won) s.status = 'won';
  return report;
}

/** 按关卡示例逐步播放（由 UI 调用，带间隔）；此处只做无界面执行与自检 */
export function runSolutionSelfCheck(level: Level): { ok: boolean; reason?: string } {
  const s = createInitialState(level);
  for (const step of level.solution) {
    const r =
      step.kind === 'fold'
        ? applyFold(s, step.axis, step.line, step.side)
        : step.kind === 'unfold'
          ? applyUnfold(s)
          : applyPunch(s, step.x, step.y, step.depth);
    if (!r.ok) return { ok: false, reason: `示例动作失败：${r.reason}` };
  }
  const report = evaluate(s);
  if (!report.won) {
    return {
      ok: false,
      reason: `示例未通关：缺 ${report.missing.map((p) => keyOf(p.x, p.y)).join(' ')}，` +
        `破坏 ${report.broken.map((p) => keyOf(p.x, p.y)).join(' ')}`,
    };
  }
  return { ok: true };
}
