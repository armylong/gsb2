import type {
  Action,
  ActionResult,
  BoxDef,
  BoxPlacement,
  FloorSpec,
  GameState,
  LevelDef,
  PlatformSpec,
  RejectReason,
  Region,
  Side,
  TransferTarget,
} from './types';

// ---------------------------------------------------------------------------
// 基础查询
// ---------------------------------------------------------------------------

export function getLevel(levels: LevelDef[], levelId: number): LevelDef {
  const lv = levels.find((l) => l.id === levelId);
  if (!lv) throw new Error(`未知关卡 ${levelId}`);
  return lv;
}

export function getBox(level: LevelDef, boxId: string): BoxDef {
  const b = level.boxes.find((x) => x.id === boxId);
  if (!b) throw new Error(`未知画箱 ${boxId}`);
  return b;
}

export function getFloor(level: LevelDef, floor: number): FloorSpec {
  const f = level.floors.find((x) => x.id === floor);
  if (!f) throw new Error(`未知楼层 ${floor}`);
  return f;
}

export function getPlatform(level: LevelDef, floor: number, side: Side): PlatformSpec {
  return getFloor(level, floor)[side];
}

export function createInitialState(level: LevelDef): GameState {
  return {
    levelId: level.id,
    turn: 0,
    carFloor: level.startFloor,
    placements: level.initialPlacements.map((p) => ({ ...p })),
    deliveredInOrder: [],
  };
}

export function cloneState(s: GameState): GameState {
  return {
    levelId: s.levelId,
    turn: s.turn,
    carFloor: s.carFloor,
    placements: s.placements.map((p) => ({ ...p })),
    deliveredInOrder: [...s.deliveredInOrder],
  };
}

/** 交替门：偶数回合开左门，奇数回合开右门（回合 0 为初始状态，左门开） */
export function alternatingSide(turn: number): Side {
  return turn % 2 === 0 ? 'L' : 'R';
}

/** 某楼层某侧的门在给定回合是否开着 */
export function isDoorOpen(level: LevelDef, floorId: number, side: Side, turn: number): boolean {
  const mode = getFloor(level, floorId).doorMode;
  if (mode.kind === 'both') return true;
  if (mode.kind === 'fixed') return mode.side === side;
  return alternatingSide(turn) === side;
}

export function doorDescription(level: LevelDef, floorId: number, turn: number): string {
  const mode = getFloor(level, floorId).doorMode;
  if (mode.kind === 'both') return '两侧常开';
  if (mode.kind === 'fixed') return `只开${sideName(mode.side)}门`;
  return `交替门：本回合开${sideName(alternatingSide(turn))}门，下回合开${sideName(
    alternatingSide(turn + 1),
  )}门`;
}

export function sideName(side: Side): string {
  return side === 'L' ? '左' : '右';
}

export function regionName(region: Region): string {
  if (region === 'car') return '轿厢';
  if (region === 'stage') return '暂存位';
  return '展柜';
}

// ---------------------------------------------------------------------------
// 占位与通道
// ---------------------------------------------------------------------------

interface SlotKey {
  region: Region;
  floor: number | null;
  side: Side | null;
  index: number;
}

function slotKeysOf(p: BoxPlacement): SlotKey[] {
  const keys: SlotKey[] = [];
  for (let i = 0; i < 2; i++) {
    keys.push({ region: p.region, floor: p.floor, side: p.side, index: p.index + i });
  }
  return keys;
}

function regionCapacity(level: LevelDef, target: {
  region: Region;
  floor: number;
  side: Side;
}): number {
  if (target.region === 'car') return level.carSlots;
  const pf = getPlatform(level, target.floor, target.side);
  return target.region === 'stage' ? pf.stageSlots : pf.caseSlots;
}

function occupies(
  state: GameState,
  region: Region,
  floor: number | null,
  side: Side | null,
  index: number,
  ignoreBoxId?: string,
): BoxPlacement | undefined {
  // 轿厢占位的 floor/side 恒为 null，需要按区域归一化查询键，
  // 否则用目标自带的 floor/side 查轿厢会永远查不到已有箱子
  return state.placements.find(
    (p) =>
      p.boxId !== ignoreBoxId &&
      p.region === region &&
      (region === 'car' || (p.floor === floor && p.side === side)) &&
      slotKeysOf(p).some((k) => k.index === index),
  );
}

function findPackedIndex(
  state: GameState,
  level: LevelDef,
  target: { region: Region; floor: number; side: Side },
  len: 1 | 2,
  ignoreBoxId?: string,
): number | null {
  const cap = regionCapacity(level, target);
  // 靠门落位：从索引 0 开始找第一段连续空位
  for (let start = 0; start + len <= cap; start++) {
    let free = true;
    for (let i = 0; i < len; i++) {
      if (occupies(state, target.region, target.floor, target.side, start + i, ignoreBoxId)) {
        free = false;
        break;
      }
    }
    if (free) return start;
  }
  return null;
}

/**
 * 画箱到指定侧门之间是否畅通。
 * 站台（暂存位/展柜）是尽头式结构，门固定在索引 0 一端，无论左门右门，
 * 箱子都必须先经过索引 0，因此只检查更小索引上的遮挡。
 * 轿厢有左右两个门：左门查更小索引、右门查更大索引（含长箱占用格）。
 */
function blockerToDoor(
  state: GameState,
  level: LevelDef,
  p: BoxPlacement,
  doorSide: Side,
): BoxPlacement | undefined {
  // 站台：到索引 0 门口的单向通道
  if (p.region !== 'car') {
    for (let i = 0; i < p.index; i++) {
      const blocker = occupies(state, p.region, p.floor, p.side, i);
      if (blocker && blocker.boxId !== p.boxId) return blocker;
    }
    return undefined;
  }

  // 轿厢：方向感知
  const box = getBox(level, p.boxId);
  if (doorSide === 'L') {
    for (let i = 0; i < p.index; i++) {
      const blocker = occupies(state, 'car', null, null, i);
      if (blocker && blocker.boxId !== p.boxId) return blocker;
    }
  } else {
    const lastOccupied = p.index + box.len - 1;
    for (let i = lastOccupied + 1; i < level.carSlots; i++) {
      const blocker = occupies(state, 'car', null, null, i);
      if (blocker && blocker.boxId !== p.boxId) return blocker;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 动作校验与执行
// ---------------------------------------------------------------------------

export function moveCost(from: number, to: number): number {
  return Math.abs(from - to);
}

function fail(message: string, extra?: Partial<RejectReason>): ActionResult {
  return { ok: false, cost: 0, reason: { message, ...extra } };
}

export function applyMove(level: LevelDef, state: GameState, toFloor: number): ActionResult {
  if (!level.floors.some((f) => f.id === toFloor)) {
    return fail(`没有 ${toFloor} 层`);
  }
  if (toFloor === state.carFloor) {
    return fail('轿厢已经在这一层');
  }
  const cost = moveCost(state.carFloor, toFloor);
  const next = cloneState(state);
  next.carFloor = toFloor;
  next.turn += cost;
  return { ok: true, state: next, cost };
}

export function applyWait(state: GameState): ActionResult {
  const next = cloneState(state);
  next.turn += 1;
  return { ok: true, state: next, cost: 1 };
}

interface TransferContext {
  level: LevelDef;
  state: GameState;
  box: BoxDef;
  from: BoxPlacement;
  target: TransferTarget;
}

function validateTransfer(ctx: TransferContext): RejectReason | null {
  const { level, state, box, from, target } = ctx;

  // 1. 一切搬运都要求轿厢与画箱同层
  const fromFloor = from.region === 'car' ? state.carFloor : from.floor;
  if (fromFloor !== state.carFloor) {
    return { message: '轿厢不在这一层，无法搬运' };
  }
  if (target.floor !== state.carFloor) {
    return { message: '只能搬到轿厢当前停靠的楼层' };
  }

  const samePlatform =
    from.region !== 'car' &&
    target.region !== 'car' &&
    from.floor === target.floor &&
    from.side === target.side;

  // 同一区域内（轿厢->轿厢、同暂存位->同暂存位）不允许"重新落位"：
  // 货位只能通过过门搬运改变，避免把箱子叠到已有货位上
  if (from.region === target.region && (target.region === 'car' || samePlatform)) {
    return { message: '画箱已经在这个区域，不能在同一区域内重新落位' };
  }

  // 同站台内部（暂存位 <-> 展柜）不需要过门；其余搬运都要确定过门侧
  let doorSide: Side | null = null;
  if (!samePlatform) {
    if (from.region === 'car') {
      doorSide = target.side;
    } else if (target.region === 'car') {
      // 从站台进轿厢，只能走箱子自己所在那一侧的门
      doorSide = from.side!;
    } else {
      // 跨站台不允许：站台之间没有直通通道
      return {
        message: `两侧站台互不相通，画箱必须先进轿厢再从${sideName(target.side)}门出去`,
        side: target.side,
      };
    }

    // 目标侧必须与实际过门侧一致：右站台的箱子不能"隔空"从左门上车
    if (target.region === 'car' && target.side !== doorSide) {
      return {
        message: `画箱在${sideName(doorSide)}侧站台，只能走${sideName(doorSide)}门进轿厢`,
        side: target.side,
      };
    }

    if (!isDoorOpen(level, target.floor, doorSide, state.turn)) {
      const mode = getFloor(level, target.floor).doorMode;
      const hint =
        mode.kind === 'alternating'
          ? `本回合开${sideName(alternatingSide(state.turn))}门，下回合开${sideName(
              alternatingSide(state.turn + 1),
            )}门，可等待一拍`
          : '这一层不开这侧门';
      return { message: `${sideName(doorSide)}门关着，过不去（${hint}）`, side: doorSide };
    }

    // 3. 过梁高度
    const pf = getPlatform(level, target.floor, doorSide);
    if (pf.lintel === 'low' && box.height === 'tall') {
      return {
        message: `${sideName(doorSide)}门是低过梁，高箱 ${box.label} 过不去，只有矮箱能通过`,
        side: doorSide,
      };
    }
  } else {
    // 同站台内部搬运，门侧就是该站台自己的侧
    doorSide = from.side!;
  }

  // 4. 起点到该侧门的通道不能被别的画箱挡住（方向感知）
  const blocker = blockerToDoor(state, level, from, doorSide);
  if (blocker) {
    const blockerBox = getBox(level, blocker.boxId);
    return {
      message: `${blockerBox.label} 挡在 ${box.label} 到${sideName(doorSide)}门的通道上，先在有空位的楼层暂存它`,
      blockerId: blocker.boxId,
      side: doorSide,
    };
  }

  // 5. 目标区域容量与连续空位（排除画箱自己的旧占位）
  const cap = regionCapacity(level, target);
  if (cap <= 0) {
    return { message: `${target.floor} 层${sideName(target.side)}侧没有${regionName(target.region)}` };
  }
  const requested = target.index ?? findPackedIndex(state, level, target, box.len, box.id);
  if (requested === null) {
    return { message: `${regionName(target.region)}没有连续 ${box.len} 个空位，先腾地方` };
  }
  if (requested < 0 || requested + box.len > cap) {
    return { message: '目标货位超出该区域容量' };
  }
  for (let i = 0; i < box.len; i++) {
    const occupant = occupies(
      state,
      target.region,
      target.floor,
      target.side,
      requested + i,
      box.id,
    );
    if (occupant) {
      return {
        message: `${regionName(target.region)}第 ${requested + i + 1} 格已被占用`,
        blockerId: occupant.boxId,
      };
    }
  }

  // 6. 水平画箱必须保持水平：需要连续两格，单格展柜拒收
  if (box.horizontalOnly && box.len !== 2) {
    return { message: '水平画箱必须占连续两格，不能竖放' };
  }

  return null;
}

export function applyTransfer(
  level: LevelDef,
  state: GameState,
  boxId: string,
  target: TransferTarget,
): ActionResult {
  const from = state.placements.find((p) => p.boxId === boxId);
  if (!from) return fail('找不到这个画箱');
  const box = getBox(level, boxId);

  const reason = validateTransfer({ level, state, box, from, target });
  if (reason) return { ok: false, cost: 0, reason };

  const next = cloneState(state);
  const idx =
    target.index ?? findPackedIndex(next, level, target, box.len, box.id)!;
  const placement: BoxPlacement =
    target.region === 'car'
      ? { boxId, region: 'car', floor: null, side: null, index: idx }
      : { boxId, region: target.region, floor: target.floor, side: target.side, index: idx };

  next.placements = next.placements.filter((p) => p.boxId !== boxId);
  next.placements.push(placement);
  next.turn += 1;

  // 进入属于自己的展柜才记为已搬运
  const goal = level.goals.find((g) => g.boxId === boxId);
  const delivered =
    target.region === 'case' &&
    goal !== undefined &&
    goal.floor === target.floor &&
    goal.side === target.side;
  if (delivered && !next.deliveredInOrder.includes(boxId)) {
    next.deliveredInOrder.push(boxId);
  }
  // 从展柜搬出（撤展）则取消已搬运记录
  if (from.region === 'case' && next.deliveredInOrder.includes(boxId)) {
    next.deliveredInOrder = next.deliveredInOrder.filter((id) => id !== boxId);
  }

  return { ok: true, state: next, cost: 1 };
}

export function applyAction(level: LevelDef, state: GameState, action: Action): ActionResult {
  if (action.type === 'move') return applyMove(level, state, action.toFloor);
  if (action.type === 'wait') return applyWait(state);
  return applyTransfer(level, state, action.boxId, action.target);
}

/** 动作预览：不修改状态，返回预计花费与是否可行 */
export function previewAction(level: LevelDef, state: GameState, action: Action): ActionResult {
  return applyAction(level, cloneState(state), action);
}

// ---------------------------------------------------------------------------
// 通关与评分
// ---------------------------------------------------------------------------

export function isWon(level: LevelDef, state: GameState): boolean {
  return level.goals.every((g) =>
    state.placements.some(
      (p) =>
        p.boxId === g.boxId &&
        p.region === 'case' &&
        p.floor === g.floor &&
        p.side === g.side,
    ),
  );
}

export function remainingTurns(level: LevelDef, state: GameState): number {
  return Math.max(0, level.budget - state.turn);
}

export function score(level: LevelDef, state: GameState): number {
  if (!isWon(level, state)) return 0;
  return remainingTurns(level, state) * 10 + level.boxes.length * 100;
}

/** 画箱当前是否已经在自己的展柜里 */
export function isDelivered(level: LevelDef, state: GameState, boxId: string): boolean {
  const g = level.goals.find((x) => x.boxId === boxId);
  if (!g) return false;
  return state.placements.some(
    (p) =>
      p.boxId === boxId && p.region === 'case' && p.floor === g.floor && p.side === g.side,
  );
}
