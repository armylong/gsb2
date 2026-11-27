import type {
  Action,
  DoughState,
  GameEvent,
  GameState,
  Gear,
  LevelSpec,
  Result,
  SimulationResult,
  Zone,
} from './types';

export type { Action } from './types';

// ─────────────────────────────────────────────────────────────
// 初始化与克隆
// ─────────────────────────────────────────────────────────────

export function initState(level: LevelSpec): GameState {
  const doughs: DoughState[] = level.doughs.map((d) => ({
    id: d.id,
    name: d.name,
    doneness: d.startDoneness,
    zone: d.startZone,
    window: [...d.window] as [number, number],
    deadline: d.deadline,
    ovenRemaining: null,
  }));
  return {
    levelId: level.id,
    turn: 1,
    gear: 1,
    doughs,
    proofSlots: Array.from({ length: level.proofSlots }, (_, i) => ({ index: i, doughId: null })),
    ovenDoughId: null,
    deliveries: [],
    log: [{ turn: 0, text: `关卡开始：${level.title}`, kind: 'info' }],
    status: 'playing',
  };
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    doughs: s.doughs.map((d) => ({ ...d, window: [...d.window] as [number, number] })),
    proofSlots: s.proofSlots.map((p) => ({ ...p })),
    deliveries: s.deliveries.map((d) => ({ ...d, reasons: [...d.reasons] })),
    log: s.log.map((l) => ({ ...l })),
  };
}

// ─────────────────────────────────────────────────────────────
// 操作合法性
// ─────────────────────────────────────────────────────────────

export function getDough(s: GameState, id: string): DoughState | undefined {
  return s.doughs.find((d) => d.id === id);
}

export function freeProofSlot(s: GameState): number | null {
  const slot = s.proofSlots.find((p) => p.doughId === null);
  return slot ? slot.index : null;
}

/** 一团面本拍可以去的位置（主要操作三选一，已在炉中/已交单则为空） */
export function legalTargets(s: GameState, doughId: string): Zone[] {
  const d = getDough(s, doughId);
  if (!d || d.zone === 'oven' || d.zone === 'delivered' || d.zone === 'failed') return [];
  const targets: Zone[] = [];
  const zone: Zone = d.zone; // 此处已排除 oven/delivered/failed，只剩 bench/proof/rack
  if (zone !== 'proof' && freeProofSlot(s) !== null) targets.push('proof');
  if (zone !== 'rack') targets.push('rack');
  if (s.ovenDoughId === null) targets.push('oven');
  return targets;
}

export function setGear(prev: GameState, gear: Gear): GameState {
  if (prev.gear === gear) return prev;
  const s = cloneState(prev);
  s.gear = gear;
  s.log.push({ turn: s.turn, text: `温箱档位调为 ${gear} 档（每拍 +${gear}）`, kind: 'gear' });
  return s;
}

// ─────────────────────────────────────────────────────────────
// 结算（纯函数）：顺序固定为 换位 → 烤炉 → 温箱 → 凉架
// 刚换位的面团在「目的地」参与本拍结算，事件流逐行可核对。
// ─────────────────────────────────────────────────────────────

const ZONE_LABEL: Record<Zone, string> = {
  bench: '案板',
  proof: '温箱',
  rack: '凉架',
  oven: '烤炉',
  delivered: '已交单',
  failed: '失败',
};

export function zoneLabel(z: Zone): string {
  return ZONE_LABEL[z];
}

function evaluateDelivery(
  d: DoughState,
  turn: number,
): { result: Exclude<Result, null>; reasons: string[] } {
  const [lo, hi] = d.window;
  const reasons: string[] = [];
  if (d.doneness < lo) {
    reasons.push(`熟度 ${d.doneness} 低于窗口下限 ${lo}（夹生）`);
    return { result: 'early', reasons };
  }
  if (d.doneness > hi) {
    reasons.push(`熟度 ${d.doneness} 高于窗口上限 ${hi}（烤过）`);
    return { result: 'late', reasons };
  }
  if (turn > d.deadline) {
    reasons.push(`熟度合格但第 ${turn} 拍才交单，已超过截止回合 ${d.deadline}`);
    return { result: 'overdue', reasons };
  }
  return { result: 'success', reasons: [`第 ${turn} 拍准时交单，熟度 ${d.doneness} 落在窗口 [${lo}, ${hi}]`] };
}

export function simulateTurn(prev: GameState, level: LevelSpec, action: Action): SimulationResult {
  if (prev.status !== 'playing') {
    return { state: cloneState(prev), events: [], rejected: '本关已结束，请重置或撤销' };
  }
  const s = cloneState(prev);
  const events: GameEvent[] = [];
  const turn = s.turn;

  // 1) 主要操作：换位（或 pass）
  if (action.type === 'move') {
    const d = getDough(s, action.doughId);
    if (!d) return { state: prev, events: [], rejected: '找不到这团面' };
    if (!legalTargets(prev, action.doughId).includes(action.target)) {
      return {
        state: prev,
        events: [],
        rejected: `${d.name} 本拍不能移到${ZONE_LABEL[action.target]}（槽位占用或正在烘烤）`,
      };
    }
    const from = d.zone;
    // 离开温箱要腾空槽
    if (from === 'proof') {
      const slot = s.proofSlots.find((p) => p.doughId === d.id);
      if (slot) slot.doughId = null;
    }
    d.zone = action.target;
    if (action.target === 'proof') {
      const idx = freeProofSlot(s);
      if (idx !== null) s.proofSlots[idx].doughId = d.id;
    }
    if (action.target === 'oven') {
      s.ovenDoughId = d.id;
      d.ovenRemaining = level.ovenBakeTurns;
    }
    events.push({ kind: 'move', turn, doughId: d.id, from, to: action.target });
    s.log.push({
      turn,
      text: `${d.name}：${ZONE_LABEL[from]} → ${ZONE_LABEL[action.target]}`,
      kind: 'move',
    });
  } else {
    events.push({ kind: 'pass', turn });
    s.log.push({ turn, text: '本拍不移动面团（空拍）', kind: 'move' });
  }

  // 2) 烤炉结算：占炉倒数，归零立即交单（炉内熟度冻结）
  if (s.ovenDoughId) {
    const d = getDough(s, s.ovenDoughId)!;
    d.ovenRemaining = (d.ovenRemaining ?? 1) - 1;
    events.push({ kind: 'oven-tick', turn, doughId: d.id, remaining: d.ovenRemaining });
    if (d.ovenRemaining === 0) {
      events.push({ kind: 'bake-done', turn, doughId: d.id });
      const { result, reasons } = evaluateDelivery(d, turn);
      d.zone = result === 'success' ? 'delivered' : 'failed';
      d.ovenRemaining = null;
      s.ovenDoughId = null;
      const record = { turn, doughId: d.id, doneness: d.doneness, result, reasons };
      s.deliveries.push(record);
      events.push({ kind: 'delivery', turn, delivery: record });
      const label =
        result === 'success' ? '交单成功' : result === 'early' ? '夹生退单' : result === 'late' ? '烤过退单' : '超时退单';
      s.log.push({ turn, text: `${d.name} ${label}：${reasons.join('；')}`, kind: 'result' });
    }
  }

  // 3) 温箱结算：同一档位给箱内每团加熟度（本拍刚进箱的也在此结算）
  const gearRate = level.gearRates[s.gear];
  for (const slot of s.proofSlots) {
    if (slot.doughId === null) continue;
    const d = getDough(s, slot.doughId);
    if (!d) continue;
    d.doneness = Math.min(level.maxDoneness, d.doneness + gearRate);
    events.push({ kind: 'proof-tick', turn, doughId: d.id, amount: gearRate, doneness: d.doneness });
    if (gearRate > 0) {
      s.log.push({ turn, text: `${d.name} 在温箱(${s.gear}档) +${gearRate} → 熟度 ${d.doneness}`, kind: 'tick' });
    }
  }

  // 4) 凉架结算：以另一种（更慢的）速度变化
  for (const d of s.doughs) {
    if (d.zone !== 'rack') continue;
    d.doneness = Math.min(level.maxDoneness, d.doneness + level.rackRate);
    events.push({ kind: 'rack-tick', turn, doughId: d.id, amount: level.rackRate, doneness: d.doneness });
    s.log.push({ turn, text: `${d.name} 在凉架 +${level.rackRate} → 熟度 ${d.doneness}`, kind: 'tick' });
  }

  // 5) 胜负判定：任一退单即失败；全部成功交单即通关。退单不清空其他面团。
  if (s.deliveries.some((r) => r.result !== 'success')) {
    s.status = 'lost';
    s.log.push({ turn, text: '出现退单，本关失败（可撤销回到整回合开始）', kind: 'info' });
  } else if (s.doughs.every((d) => d.zone === 'delivered')) {
    s.status = 'won';
    s.log.push({ turn, text: '全部订单合格交单，通关！', kind: 'info' });
  }

  s.turn += 1;
  return { state: s, events, rejected: null };
}

// ─────────────────────────────────────────────────────────────
// 赶单分析：每团面现在还能不能赶上自己的单
// ─────────────────────────────────────────────────────────────

export type CatchStatus = 'ok' | 'tight' | 'impossible';

export interface CatchInfo {
  doughId: string;
  status: CatchStatus;
  detail: string;
  earliestEntry: number;
  latestEntry: number;
}

export function analyzeCatch(prev: GameState, level: LevelSpec): CatchInfo[] {
  const t = prev.turn;
  const maxRate = Math.max(level.rackRate, ...Object.values(level.gearRates));
  const infos: CatchInfo[] = [];
  let ovenFreeAt = t;

  // 炉里已有面团：它的交单时间被锁定，先占住烤炉档期
  const fixed = prev.ovenDoughId ? getDough(prev, prev.ovenDoughId)! : null;
  if (fixed) {
    ovenFreeAt = t + (fixed.ovenRemaining ?? 0);
    const deliveryTurn = ovenFreeAt - 1;
    const [lo, hi] = fixed.window;
    const ok = fixed.doneness >= lo && fixed.doneness <= hi && deliveryTurn <= fixed.deadline;
    infos.push({
      doughId: fixed.id,
      status: ok ? (deliveryTurn >= fixed.deadline - 1 ? 'tight' : 'ok') : 'impossible',
      detail: ok
        ? `炉中烘烤，第 ${deliveryTurn} 拍自动交单（熟度已冻结为 ${fixed.doneness}）`
        : `炉中熟度 ${fixed.doneness} 或交单拍 ${deliveryTurn} 已不满足窗口/截止`,
      earliestEntry: t - 1,
      latestEntry: t - 1,
    });
  }

  const pending = prev.doughs
    .filter((d) => d !== fixed && d.zone !== 'delivered' && d.zone !== 'failed')
    .sort((a, b) => a.deadline - b.deadline);

  for (const d of pending) {
    const [lo, hi] = d.window;
    // 熟度只会涨不会降：当前已超上限 → 无解
    if (d.doneness > hi) {
      infos.push({
        doughId: d.id,
        status: 'impossible',
        detail: `当前熟度 ${d.doneness} 已超过窗口上限 ${hi}，无法回退`,
        earliestEntry: t,
        latestEntry: -1,
      });
      continue;
    }
    // 最晚入炉拍：交单拍 = 入炉拍 + ovenBakeTurns - 1 ≤ deadline
    const latestEntry = d.deadline - level.ovenBakeTurns + 1;
    // 最早入炉拍：熟度要来得及涨到下限
    const need = Math.max(0, lo - d.doneness);
    const earliestByDoneness = t + Math.ceil(need / maxRate);
    const entry = Math.max(ovenFreeAt, earliestByDoneness);
    if (entry > latestEntry) {
      infos.push({
        doughId: d.id,
        status: 'impossible',
        detail:
          earliestByDoneness > latestEntry
            ? `熟度最早第 ${earliestByDoneness} 拍才够得到窗口，但最晚第 ${latestEntry} 拍必须入炉`
            : `烤炉档期排不开：最早第 ${entry} 拍才能入炉，晚于最晚入炉拍 ${latestEntry}`,
        earliestEntry: earliestByDoneness,
        latestEntry,
      });
      continue;
    }
    const slack = latestEntry - entry;
    infos.push({
      doughId: d.id,
      status: slack <= 1 ? 'tight' : 'ok',
      detail: `第 ${entry}–${latestEntry} 拍之间入炉可赶上（交单不晚于第 ${d.deadline} 拍）`,
      earliestEntry: entry,
      latestEntry,
    });
    ovenFreeAt = entry + level.ovenBakeTurns;
  }

  return infos;
}

// ─────────────────────────────────────────────────────────────
// 测试/脚本辅助：按剧本逐拍执行
// ─────────────────────────────────────────────────────────────

export interface ScriptedTurn {
  gear?: Gear;
  action: Action;
}

export function runScript(
  level: LevelSpec,
  script: ScriptedTurn[],
): { state: GameState; results: SimulationResult[] } {
  let state = initState(level);
  const results: SimulationResult[] = [];
  for (const turn of script) {
    if (turn.gear !== undefined) state = setGear(state, turn.gear);
    const r = simulateTurn(state, level, turn.action);
    if (r.rejected) throw new Error(`第 ${state.turn} 拍操作被拒：${r.rejected}`);
    state = r.state;
    results.push(r);
  }
  return { state, results };
}
