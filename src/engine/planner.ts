import {
  carriesHeavy,
  carriesLight,
  cellDryAt,
  createSimulation,
  edgeUsableAt,
  findEdge,
  moveDuration,
} from './engine';
import { RULES } from './rules';
import type { LevelDef } from './types';
import type { SimState } from './engine';

export type HintStepType = 'wait' | 'move' | 'pickup' | 'deliver';

export interface HintStep {
  type: HintStepType;
  ticks: number;
  atTick: number;
  text: string;
  targetCell?: string;
  cardIds?: string[];
}

export interface HintPlan {
  steps: HintStep[];
  totalTicks: number;
  goal: 'deliver-all' | 'reach-home';
  note?: string;
}

interface PState {
  cell: string;
  carried: string; // 排序后的卡片 id 拼接
  tick: number;
  wet: number;
}

interface Node extends PState {
  key: string;
  cost: number;
}

function keyOf(s: PState): string {
  return `${s.cell}|${s.carried}|${s.tick}|${s.wet}`;
}

function carriedList(joined: string): string[] {
  return joined === '' ? [] : joined.split(',').sort();
}

/**
 * 到达即拾件：搜索中走到有 loose 卡片的格子，自动把该格卡片并入携带集合
 * （与 UI 的「拾件」按钮同语义，拾件本身不花时间）。返回新的携带串与新拾卡片。
 */
function autoPickup(
  level: LevelDef,
  cell: string,
  carriedJoined: string,
): { carried: string; picked: string[] } {
  const have = new Set(carriedList(carriedJoined));
  const picked: string[] = [];
  for (const p of level.postcards) {
    if (p.cell === cell && !have.has(p.id)) {
      have.add(p.id);
      picked.push(p.id);
    }
  }
  return { carried: [...have].sort().join(','), picked };
}

/** 与引擎一致的途中安全判断：逐刻检查路面与目标格 */
function traversalSafe(
  level: LevelDef,
  from: string,
  to: string,
  heavy: boolean,
  startTick: number,
  duration: number,
): boolean {
  const edge = findEdge(level, from, to);
  if (!edge) return false;
  for (let k = 1; k <= duration; k++) {
    const tau = startTick + k;
    if (!edgeUsableAt(level, edge, heavy, tau)) return false;
    if (!cellDryAt(level, to, tau)) return false;
  }
  return true;
}

function makeSimAt(level: LevelDef, cell: string, carried: string[], tick: number, wet: number): SimState {
  const sim = createSimulation(level);
  sim.tick = tick;
  sim.cellId = cell;
  sim.carried = [...carried];
  for (const id of carried) delete sim.loose[id];
  sim.wetTicks = wet;
  return sim;
}

const MAX_STATES = 60000;

/**
 * 时间相关路线搜索（Dijkstra）。
 * 状态空间 = 格子 × 携带集合 × 时刻 × 连续受淹刻；动作只有两种：
 *   - 等 1 刻（受淹规则与引擎一致，会排除损毁 / 被困状态）
 *   - 走到相邻格（仅当整段移动在当前潮时下都不会被打断才展开）
 * 因此提示永远是「按当前潮时与携带状态真的能走完」的方案，不是静态连通。
 */
export function planHint(
  level: LevelDef,
  opts: { cell: string; carried: string[]; tick: number; wet: number; goal: 'deliver-all' | 'reach-home' },
): HintPlan | null {
  const horizon = opts.tick + RULES.HINT_HORIZON;
  const allCards = level.postcards.map((p) => p.id).sort().join(',');

  const start: Node = {
    cell: opts.cell,
    carried: [...opts.carried].sort().join(','),
    tick: opts.tick,
    wet: opts.wet,
    key: '',
    cost: 0,
  };
  start.key = keyOf(start);

  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; step: HintStep }>();
  const settled = new Set<string>();
  dist.set(start.key, 0);
  const queue: Node[] = [start];
  let goalKey: string | null = null;

  const pop = (): Node | undefined => {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].cost < queue[best].cost) best = i;
    return queue.splice(best, 1)[0];
  };

  const relax = (ns: Node, parentKey: string, step: HintStep): void => {
    const known = dist.get(ns.key);
    if (known !== undefined && ns.cost >= known) return;
    dist.set(ns.key, ns.cost);
    prev.set(ns.key, { from: parentKey, step });
    queue.push(ns);
  };

  while (queue.length > 0 && settled.size < MAX_STATES) {
    const cur = pop()!;
    if (settled.has(cur.key)) continue;
    settled.add(cur.key);
    const curDist = dist.get(cur.key)!;

    const isGoal =
      opts.goal === 'reach-home'
        ? cur.cell === level.home
        : cur.cell === level.home && cur.carried === allCards;
    if (isGoal) {
      goalKey = cur.key;
      break;
    }
    if (cur.tick >= horizon) continue;

    const carried = carriedList(cur.carried);
    const sim = makeSimAt(level, cur.cell, carried, cur.tick, cur.wet);
    const heavy = carriesHeavy(sim);
    const light = carriesLight(sim);
    const originDry = cellDryAt(level, cur.cell, cur.tick);

    // 动作 1：等 1 刻
    {
      const nextTick = cur.tick + 1;
      const nextDry = cellDryAt(level, cur.cell, nextTick);
      const nextWet = nextDry ? 0 : cur.wet + 1;
      const ruined = light && !nextDry && nextWet >= RULES.LIGHT_RUIN_WET_TICKS;
      const stranded = !nextDry && nextWet >= RULES.STRANDED_WET_TICKS;
      if (!ruined && !stranded) {
        const ns: Node = { cell: cur.cell, carried: cur.carried, tick: nextTick, wet: nextWet, key: '', cost: curDist + 1 };
        ns.key = keyOf(ns);
        relax(ns, cur.key, { type: 'wait', ticks: 1, atTick: nextTick, text: '等 1 刻' });
      }
    }

    // 动作 2：整段安全的跨格
    const duration = moveDuration(sim);
    for (const edge of level.edges) {
      if (edge.a !== cur.cell && edge.b !== cur.cell) continue;
      const to = edge.a === cur.cell ? edge.b : edge.a;
      if (heavy && edge.height <= RULES.HEAVY_MIN_EDGE_HEIGHT) continue;
      if (!edgeUsableAt(level, edge, heavy, cur.tick)) continue;
      if (!cellDryAt(level, to, cur.tick)) continue;
      // 脚下已上水时只允许紧急撤离到干格（与引擎的应急移动一致）
      if (!originDry && !cellDryAt(level, to, cur.tick)) continue;
      if (!traversalSafe(level, cur.cell, to, heavy, cur.tick, duration)) continue;

      const nextTick = cur.tick + duration;
      const afterPickup = autoPickup(level, to, cur.carried);
      const ns: Node = { cell: to, carried: afterPickup.carried, tick: nextTick, wet: 0, key: '', cost: curDist + duration };
      ns.key = keyOf(ns);
      const step: HintStep = {
        type: 'move',
        ticks: duration,
        atTick: nextTick,
        targetCell: to,
        text: `走到${to}（${duration} 刻，t=${nextTick}）`,
      };
      relax(ns, cur.key, step);
    }
  }

  if (!goalKey) return null;

  // 回溯并合并连续等待；在路径上自动插入拾件 / 交件说明
  const raw: HintStep[] = [];
  let k = goalKey;
  while (k !== start.key) {
    const link = prev.get(k);
    if (!link) return null;
    raw.unshift(link.step);
    k = link.from;
  }

  const steps: HintStep[] = [];
  let cell = opts.cell;
  const have = new Set(opts.carried);
  for (const step of raw) {
    if (step.type === 'wait') {
      const last = steps[steps.length - 1];
      if (last && last.type === 'wait' && last.atTick === step.atTick - 1) {
        last.ticks += 1;
        last.atTick = step.atTick;
        last.text = `先等 ${last.ticks} 刻到 t=${step.atTick}`;
      } else {
        steps.push({ ...step, text: `先等 1 刻到 t=${step.atTick}` });
      }
    } else if (step.type === 'move') {
      cell = step.targetCell!;
      steps.push(step);
      const cardsHere = level.postcards.filter((p) => p.cell === cell && !have.has(p.id));
      if (cardsHere.length > 0) {
        for (const p of cardsHere) have.add(p.id);
        steps.push({
          type: 'pickup',
          ticks: 0,
          atTick: step.atTick,
          cardIds: cardsHere.map((p) => p.id),
          text: `在 ${cell} 拾${cardsHere.map((p) => p.label).join('、')}（t=${step.atTick}）`,
        });
      }
      if (cell === level.home && have.size > 0) {
        steps.push({ type: 'deliver', ticks: 0, atTick: step.atTick, cardIds: [...have], text: `回家交件（t=${step.atTick}）` });
      }
    }
  }

  return {
    steps,
    totalTicks: dist.get(goalKey) ?? 0,
    goal: opts.goal,
    note: opts.goal === 'deliver-all' ? '含取件与交件的全程方案' : '只保证回到家礁',
  };
}

/** 回程可行性探测：当前状态下视野内能否回家（不要求带齐卡片） */
export function canReturnHome(
  level: LevelDef,
  state: { cell: string; carried: string[]; tick: number; wet: number },
): boolean {
  return planHint(level, { ...state, goal: 'reach-home' }) !== null;
}
