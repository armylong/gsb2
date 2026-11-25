import { RULES } from './rules';
import { isAboveWater, tideLevel } from './tide';
import type {
  EdgeDef,
  LevelDef,
  LogEntry,
  Motion,
  PostcardDef,
  RunRecord,
  RunStatus,
} from './types';

export interface SimState {
  level: LevelDef;
  tick: number;
  cellId: string;
  /** 携带中的卡片 id */
  carried: string[];
  /** 已交付的卡片 id */
  delivered: string[];
  /** 仍在场上的卡片 id -> 所在格 */
  loose: Record<string, string>;
  /** 当前连续受淹刻数 */
  wetTicks: number;
  /** 历史累计等待刻数 */
  waitedTicks: number;
  /** 移动被打断次数 */
  interruptCount: number;
  status: RunStatus;
  log: LogEntry[];
  /** 最近一次移动的完整过程，供渲染动画 */
  lastMotion: Motion | null;
  pickupTicks: Record<string, number>;
  deliverTicks: Record<string, number>;
  runId: string;
  startedAt: string;
}

export interface MoveResult {
  ok: boolean;
  reason?: string;
  motion?: Motion;
}

export function createSimulation(level: LevelDef): SimState {
  const loose: Record<string, string> = {};
  for (const p of level.postcards) loose[p.id] = p.cell;
  const state: SimState = {
    level,
    tick: 0,
    cellId: level.start,
    carried: [],
    delivered: [],
    loose,
    wetTicks: 0,
    waitedTicks: 0,
    interruptCount: 0,
    status: 'running',
    log: [{ t: 0, kind: 'start', text: `从${cellName(level, level.start)}出发，潮水周期 ${level.tidePeriod} 刻` }],
    lastMotion: null,
    pickupTicks: {},
    deliverTicks: {},
    runId: `run-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    startedAt: new Date().toISOString(),
  };
  return state;
}

export function cellName(level: LevelDef, id: string): string {
  const c = level.cells.find((x) => x.id === id);
  return c ? `${c.name}(${id})` : id;
}

export function cardDef(level: LevelDef, id: string): PostcardDef {
  const p = level.postcards.find((x) => x.id === id);
  if (!p) throw new Error(`未知卡片 ${id}`);
  return p;
}

export function carriesHeavy(state: SimState): boolean {
  return state.carried.some((id) => cardDef(state.level, id).kind === 'heavy');
}

export function carriesLight(state: SimState): boolean {
  return state.carried.some((id) => cardDef(state.level, id).kind === 'light');
}

export function findEdge(level: LevelDef, a: string, b: string): EdgeDef | undefined {
  return level.edges.find(
    (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
  );
}

export function moveDuration(state: SimState): number {
  return carriesHeavy(state) ? RULES.HEAVY_MOVE_TICKS : RULES.MOVE_TICKS;
}

/** 某刻一条路是否可通行（含负重限制）；不检查端点格子 */
export function edgeUsableAt(
  level: LevelDef,
  edge: EdgeDef,
  heavy: boolean,
  t: number,
): boolean {
  if (heavy && edge.height <= RULES.HEAVY_MIN_EDGE_HEIGHT) return false;
  return isAboveWater(tideLevel(t, level.tidePeriod), edge.height);
}

export function cellDryAt(level: LevelDef, cellId: string, t: number): boolean {
  const cell = level.cells.find((c) => c.id === cellId);
  if (!cell) return false;
  return isAboveWater(tideLevel(t, level.tidePeriod), cell.height);
}

function pushLog(state: SimState, kind: LogEntry['kind'], text: string): void {
  state.log.push({ t: state.tick, kind, text });
}

/** 当前格相邻格及此刻的可通行判断 */
export function neighbors(state: SimState): {
  cellId: string;
  edge: EdgeDef;
  feasible: boolean;
  reason?: string;
}[] {
  const heavy = carriesHeavy(state);
  return state.level.edges
    .filter((e) => e.a === state.cellId || e.b === state.cellId)
    .map((e) => {
      const other = e.a === state.cellId ? e.b : e.a;
      const reasons: string[] = [];
      if (!edgeUsableAt(state.level, e, heavy, state.tick)) {
        if (heavy && e.height <= RULES.HEAVY_MIN_EDGE_HEIGHT) {
          reasons.push('重信片压不住低路，禁行');
        } else {
          reasons.push('路已被潮水淹没');
        }
      }
      if (!cellDryAt(state.level, other, state.tick)) reasons.push('对面格已上水');
      if (!cellDryAt(state.level, state.cellId, state.tick) && reasons.length === 0) {
        // 脚下上水时只允许紧急撤离
      }
      return { cellId: other, edge: e, feasible: reasons.length === 0, reason: reasons.join('；') };
    });
}

/**
 * 尝试跨格。移动按刻推进，任一刻边界发现水位没过路面 / 目标格即打断，
 * 打断后按规则撤退：优先回出发格，出发格也上水则撤向最近的高处干地。
 */
export function move(state: SimState, targetId: string): MoveResult {
  if (state.status !== 'running') return { ok: false, reason: '本局已结束，重开后再试' };
  const edge = findEdge(state.level, state.cellId, targetId);
  if (!edge) return { ok: false, reason: '两格之间没有路' };

  const heavy = carriesHeavy(state);
  const originWet = !cellDryAt(state.level, state.cellId, state.tick);

  if (heavy && edge.height <= RULES.HEAVY_MIN_EDGE_HEIGHT) {
    pushLog(state, 'refuse', `负重信片不能走高程 ${edge.height} 的${edge.note ?? '路'}`);
    return { ok: false, reason: '重信片禁止走低路' };
  }
  if (!edgeUsableAt(state.level, edge, false, state.tick)) {
    pushLog(state, 'refuse', `${edge.note ?? '这条路'}已淹没，无法起步`);
    return { ok: false, reason: '路已被潮水淹没' };
  }
  if (!cellDryAt(state.level, targetId, state.tick)) {
    pushLog(state, 'refuse', `${cellName(state.level, targetId)}已上水，不能过去`);
    return { ok: false, reason: '目标格已上水' };
  }
  if (!originWet && !cellDryAt(state.level, state.cellId, state.tick)) {
    return { ok: false, reason: '脚下已上水' };
  }

  const duration = moveDuration(state);
  const startTick = state.tick;

  // 逐刻模拟途中水位
  let interruptAt: number | null = null;
  for (let k = 1; k <= duration; k++) {
    const tau = startTick + k;
    const edgeOk = isAboveWater(tideLevel(tau, state.level.tidePeriod), edge.height);
    const targetOk = cellDryAt(state.level, targetId, tau);
    if (!edgeOk || !targetOk) {
      interruptAt = tau;
      break;
    }
  }

  if (interruptAt === null) {
    // 走完整段
    state.tick = startTick + duration;
    state.cellId = targetId;
    state.wetTicks = cellDryAt(state.level, targetId, state.tick) ? 0 : state.wetTicks + 1;
    const motion: Motion = { edge, from: edge.a === targetId ? edge.b : edge.a, to: targetId, startTick, duration };
    state.lastMotion = motion;
    pushLog(
      state,
      'move',
      `${originWet ? '紧急撤离到' : '走到'}${cellName(state.level, targetId)}，耗时 ${duration} 刻（t=${state.tick}）`,
    );
    checkStandingWater(state);
    return { ok: true, motion };
  }

  // —— 途中被打断 ——
  state.interruptCount += 1;
  state.tick = interruptAt;
  const originId = edge.a === targetId ? edge.b : edge.a;
  pushLog(
    state,
    'interrupt',
    `走到${edge.note ?? '路上'}第 ${interruptAt - startTick}/${duration} 刻时潮水没过路径，移动打断（t=${interruptAt}）`,
  );

  const retreat = resolveRetreat(state, edge, originId, targetId);
  if (!retreat) {
    state.status = 'stranded';
    pushLog(state, 'fail', `四周无路可撤，被困在${edge.note ?? '淹没的路'}上，本局失败`);
    return { ok: false, reason: '被困，无路可撤', motion: state.lastMotion ?? undefined };
  }

  state.tick += retreat.duration;
  state.cellId = retreat.cellId;
  state.wetTicks = 0;
  const motion: Motion = {
    edge,
    from: originId,
    to: targetId,
    startTick,
    duration,
    interruptedAt: interruptAt,
    retreatTo: retreat.cellId,
    retreatDuration: retreat.duration,
  };
  state.lastMotion = motion;
  pushLog(
    state,
    'retreat',
    `撤退到${cellName(state.level, retreat.cellId)}，撤退耗时 ${retreat.duration} 刻（t=${state.tick}）`,
  );
  return { ok: true, motion };
}

interface RetreatOption {
  cellId: string;
  viaEdge: EdgeDef;
  cellHeight: number;
}

/**
 * 撤退规则：
 * 1) 出发格在打断时刻仍干 -> 原路退回出发格；
 * 2) 否则在两端点的邻格中选当前干地、且有路可达的最高格（同高优先前进侧、再按 id）；
 * 3) 没有任何可选高地 -> 被困失败。
 */
function resolveRetreat(
  state: SimState,
  currentEdge: EdgeDef,
  originId: string,
  targetId: string,
): { cellId: string; duration: number } | null {
  const t = state.tick;
  if (cellDryAt(state.level, originId, t)) {
    return { cellId: originId, duration: RULES.RETREAT_TICKS };
  }

  const candidates: RetreatOption[] = [];
  const ends = [targetId, originId];
  for (const end of ends) {
    for (const e of state.level.edges) {
      if (e.a !== end && e.b !== end) continue;
      const other = e.a === end ? e.b : e.a;
      if (other === originId || other === targetId) continue;
      const cell = state.level.cells.find((c) => c.id === other)!;
      if (!cellDryAt(state.level, other, t)) continue;
      if (!isAboveWater(tideLevel(t, state.level.tidePeriod), e.height)) continue;
      candidates.push({ cellId: other, viaEdge: e, cellHeight: cell.height });
    }
  }

  if (candidates.length === 0) {
    // 端点本身若还干（比如目标格高），就近上端点
    for (const end of ends) {
      if (cellDryAt(state.level, end, t)) candidates.push({ cellId: end, viaEdge: currentEdge, cellHeight: state.level.cells.find((c) => c.id === end)!.height });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((x, y) => {
    if (y.cellHeight !== x.cellHeight) return y.cellHeight - x.cellHeight;
    const xForward = x.cellId !== originId ? 0 : 1;
    const yForward = y.cellId !== originId ? 0 : 1;
    if (xForward !== yForward) return xForward - yForward;
    return x.cellId.localeCompare(y.cellId);
  });
  return { cellId: candidates[0].cellId, duration: RULES.RETREAT_TICKS };
}

/** 原地等待 n 刻；低格等过涨潮会逐刻受淹。单次最多 MAX_WAIT 刻，截断会留日志 */
export function wait(state: SimState, n: number): number {
  if (state.status !== 'running') return 0;
  const requested = Math.floor(n);
  const nClamped = Math.max(1, Math.min(RULES.MAX_WAIT, requested));
  let wet = 0;
  for (let i = 0; i < nClamped; i++) {
    state.tick += 1;
    if (cellDryAt(state.level, state.cellId, state.tick)) {
      state.wetTicks = 0;
    } else {
      state.wetTicks += 1;
      wet += 1;
      if (carriesLight(state) && state.wetTicks >= RULES.LIGHT_RUIN_WET_TICKS) {
        pushLog(state, 'wet', `在${cellName(state.level, state.cellId)}受淹，轻信片泡水 ${state.wetTicks} 刻后损毁（t=${state.tick}）`);
        state.status = 'ruined';
      } else if (state.wetTicks >= RULES.STRANDED_WET_TICKS) {
        pushLog(state, 'wet', `连续受淹 ${state.wetTicks} 刻，爬虫被困在${cellName(state.level, state.cellId)}（t=${state.tick}）`);
        state.status = 'stranded';
      }
    }
  }
  state.waitedTicks += nClamped;
  if (requested > RULES.MAX_WAIT) {
    pushLog(state, 'wait', `单次等待上限 ${RULES.MAX_WAIT} 刻，请求 ${requested} 刻被截断`);
  }
  if (wet > 0) {
    pushLog(
      state,
      'wet',
      `等待 ${nClamped} 刻，其中 ${wet} 刻站在水里（连续受淹 ${state.wetTicks}/${RULES.STRANDED_WET_TICKS}，t=${state.tick}）`,
    );
  } else {
    pushLog(state, 'wait', `原地等待 ${nClamped} 刻（t=${state.tick}）`);
  }
  return nClamped;
}

/** 拾取当前格上的信片（不传 id 则拾取该格全部 loose 卡片） */
export function pickup(state: SimState, cardId?: string): void {
  if (state.status !== 'running') return;
  const here = Object.entries(state.loose).filter(([, cell]) => cell === state.cellId);
  const targets = cardId ? here.filter(([id]) => id === cardId) : here;
  for (const [id] of targets) {
    delete state.loose[id];
    state.carried.push(id);
    state.pickupTicks[id] = state.tick;
    const p = cardDef(state.level, id);
    pushLog(state, 'pickup', `在${cellName(state.level, state.cellId)}拾得${p.label}（t=${state.tick}）`);
  }
}

/** 在家礁交件；allRequired=false 时交任意信片即算成功（单信片试验局） */
export function deliver(state: SimState, allRequired = true): boolean {
  if (state.status !== 'running') return false;
  if (state.cellId !== state.level.home) {
    pushLog(state, 'refuse', `只有回到${cellName(state.level, state.level.home)}才能交件`);
    return false;
  }
  if (state.carried.length === 0) return false;
  for (const id of [...state.carried]) {
    state.delivered.push(id);
    state.deliverTicks[id] = state.tick;
    const p = cardDef(state.level, id);
    pushLog(state, 'deliver', `${p.label}交到信箱，取件 t=${state.pickupTicks[id]} → 交件 t=${state.tick}，全程 ${state.tick - state.pickupTicks[id]} 刻`);
  }
  state.carried = [];
  if (!allRequired || state.delivered.length === state.level.postcards.length) {
    state.status = 'success';
    pushLog(state, 'deliver', `交件完成，总耗时 ${state.tick} 刻`);
  }
  return true;
}

/** 等待结束 / 移动结束后检查站位上水（移动到达时理论上目标是干的，留作兜底） */
function checkStandingWater(state: SimState): void {
  if (cellDryAt(state.level, state.cellId, state.tick)) {
    state.wetTicks = 0;
    return;
  }
  state.wetTicks += 1;
  if (carriesLight(state) && state.wetTicks >= RULES.LIGHT_RUIN_WET_TICKS) {
    state.status = 'ruined';
    pushLog(state, 'fail', `轻信片泡水损毁（t=${state.tick}）`);
  } else if (state.wetTicks >= RULES.STRANDED_WET_TICKS) {
    state.status = 'stranded';
    pushLog(state, 'fail', `连续受淹被困（t=${state.tick}）`);
  }
}

/** 把一局结果固化成可对照的记录 */
export function finalizeRecord(state: SimState): RunRecord {
  return {
    id: state.runId,
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    outcome: state.status,
    pickupTicks: { ...state.pickupTicks },
    deliverTicks: { ...state.deliverTicks },
    waitedTicks: state.waitedTicks,
    totalTicks: state.tick,
    maxWetTicks: state.wetTicks,
    interruptCount: state.interruptCount,
    log: [...state.log],
  };
}
