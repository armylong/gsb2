import { fnv1a, hash2, mulberry32 } from './rng';
import { cellAt, Terrain, ZONE_LABEL } from './terrain';
import type { VegType } from './vegetation';

export interface Placement {
  x: number;
  y: number;
  type: string;
  /** 手工固定的位置，局部重算时保留 */
  pinned: boolean;
}

export interface Attempt {
  type: string;
  result: 'accepted' | 'rejected';
  /** 人类可读的接受/拒绝原因 */
  reason: string;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GapReport {
  /** 通过密度与地形检查、有放置需求的格子数（按种类累计） */
  demand: number;
  /** 实际放下的数量 */
  placed: number;
  /** 因间距/互斥放不下的缺口数 */
  gaps: number;
  /** 缺口明细（哪格哪种植被没放下） */
  gapCells: { x: number; y: number; type: string }[];
  /** 限制原因统计，按出现次数降序 */
  topConstraints: { reason: string; count: number }[];
}

export interface GenResult {
  placements: Placement[];
  /** key 为 "x,y"，记录该格每种植被的接受/拒绝原因 */
  decisions: Map<string, Attempt[]>;
  report: GapReport;
}

export function inRegion(x: number, y: number, r: Region): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 生成植被。
 * - region 缺省为全图；局部重算时只重算 region 内的格子。
 * - keep 为需要保留的放置（区域外全部 + 区域内手工固定），它们作为障碍物参与间距/互斥判定。
 */
export function generate(
  terrain: Terrain,
  types: VegType[],
  seedStr: string,
  opts: { region?: Region; keep?: Placement[] } = {},
): GenResult {
  const region: Region = opts.region ?? { x0: 0, y0: 0, x1: terrain.w - 1, y1: terrain.h - 1 };
  const placements: Placement[] = (opts.keep ?? []).map((p) => ({ ...p }));
  const decisions = new Map<string, Attempt[]>();
  const seedNum = fnv1a(seedStr);

  const occupied = new Set<string>(placements.map((p) => `${p.x},${p.y}`));

  const report: GapReport = { demand: 0, placed: 0, gaps: 0, gapCells: [], topConstraints: [] };
  const constraintCount = new Map<string, number>();

  const regionKey =
    (region.x0 * 73856093) ^ (region.y0 * 19349663) ^ (region.x1 * 83492791) ^ (region.y1 * 2971215073);

  const regionCells: { x: number; y: number }[] = [];
  for (let y = region.y0; y <= region.y1; y++)
    for (let x = region.x0; x <= region.x1; x++) regionCells.push({ x, y });

  types.forEach((type, ti) => {
    // 每种植物用独立的确定性洗牌顺序，避免系统性偏向
    const order = shuffled(regionCells, mulberry32((seedNum ^ regionKey ^ (ti * 7919 + 13)) >>> 0));

    for (const { x, y } of order) {
      const key = `${x},${y}`;
      const cell = cellAt(terrain, x, y);
      const attempts = decisions.get(key) ?? [];
      const push = (result: 'accepted' | 'rejected', reason: string) => {
        attempts.push({ type: type.id, result, reason });
        decisions.set(key, attempts);
      };

      if (!type.zones.includes(cell.zone)) {
        push('rejected', `地形不允许（${ZONE_LABEL[cell.zone]}）`);
        continue;
      }
      if (occupied.has(key)) {
        const occ = placements.find((p) => p.x === x && p.y === y);
        push('rejected', occ?.pinned ? '已被手工固定占用' : '该格已有植被');
        continue;
      }
      const density = type.density[cell.zone] ?? 0;
      const roll = hash2(seedNum, x, y, ti * 7919 + 13); // 与遍历顺序无关，便于复现
      if (roll >= density) {
        push('rejected', `密度未命中（${ZONE_LABEL[cell.zone]}密度 ${density}，掷出 ${roll.toFixed(2)}）`);
        continue;
      }

      // 到这里说明该格对该种类有放置需求
      report.demand++;

      let rejectedReason: string | null = null;
      for (const p of placements) {
        const d = chebyshev(x, y, p.x, p.y);
        if (p.type === type.id && d < type.minSpacing) {
          rejectedReason = `间距不足：离同类 ${type.name} 只有 ${d} 格（要求 ≥${type.minSpacing}）`;
          break;
        }
        const ex = type.excludes.find((e) => e.other === p.type);
        if (ex && d < ex.dist) {
          rejectedReason = `互斥：离 ${p.type} 只有 ${d} 格（要求 ≥${ex.dist}）`;
          break;
        }
      }

      if (rejectedReason) {
        push('rejected', rejectedReason);
        report.gaps++;
        report.gapCells.push({ x, y, type: type.id });
        const short = rejectedReason.split('：')[0];
        constraintCount.set(short, (constraintCount.get(short) ?? 0) + 1);
        continue;
      }

      placements.push({ x, y, type: type.id, pinned: false });
      occupied.add(key);
      report.placed++;
      push('accepted', `接受（${ZONE_LABEL[cell.zone]}密度 ${density}，掷出 ${roll.toFixed(2)}）`);
    }
  });

  report.topConstraints = [...constraintCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return { placements, decisions, report };
}
