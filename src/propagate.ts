import { GameMap, STEP_TIME } from './map';

/** 声音进入某格时的行进方向(在源格为 null) */
export type Dir = 'N' | 'E' | 'S' | 'W';

export const DIRS: { d: Dir; dx: number; dy: number }[] = [
  { d: 'N', dx: 0, dy: -1 },
  { d: 'E', dx: 1, dy: 0 },
  { d: 'S', dx: 0, dy: 1 },
  { d: 'W', dx: -1, dy: 0 },
];

/** 行进方向的反方向 = 估计的声源方位 */
export const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export const DIR_CN: Record<Dir, string> = { N: '北', E: '东', S: '南', W: '西' };

export interface CellReach {
  /** 到达该格的绝对时刻 */
  time: number;
  /** 到达该格时的剩余强度 */
  intensity: number;
  /** 声音进入该格时的行进方向(源格为 null) */
  entry: Dir | null;
}

interface HeapItem {
  intensity: number;
  time: number;
  idx: number;
}

/** 二叉堆:剩余强度大者优先,同强度到达时刻早者优先 */
class Heap {
  private a: HeapItem[] = [];

  get size(): number {
    return this.a.length;
  }

  private static better(x: HeapItem, y: HeapItem): boolean {
    return x.intensity > y.intensity || (x.intensity === y.intensity && x.time < y.time);
  }

  push(item: HeapItem): void {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.better(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): HeapItem {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.better(a[l], a[m])) m = l;
        if (r < a.length && Heap.better(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function better(cand: CellReach, cur: CellReach | null): boolean {
  if (cur === null) return true;
  return cand.intensity > cur.intensity || (cand.intensity === cur.intensity && cand.time < cur.time);
}

/**
 * 从 (ox,oy) 以初始强度 intensity0、发声时刻 t0 传播声音。
 *
 * 规则:
 * - 只沿上下左右可通行格传播,墙完全阻断;
 * - 每格消耗固定强度与时间,关闭的门额外衰减强度;
 * - 每格只保留"剩余强度最大"的路线,同强度取到达更早者,不做多路叠加;
 * - 剩余强度耗尽(<=0)后不再继续传播。
 *
 * 返回与地图同尺寸的数组,不可达格为 null。
 * 由于每条边的强度消耗恒为正,按(强度降序, 时间升序)的 Dijkstra 可保证
 * 某格出堆时即为最优;出堆后仍可能用同强度更早到达的记录刷新方向。
 */
export function propagate(
  map: GameMap,
  ox: number,
  oy: number,
  intensity0: number,
  t0: number,
): (CellReach | null)[] {
  const n = map.w * map.h;
  const best: (CellReach | null)[] = new Array<CellReach | null>(n).fill(null);
  if (!map.passable(ox, oy) || intensity0 <= 0) return best;

  const heap = new Heap();
  const start: CellReach = { time: t0, intensity: intensity0, entry: null };
  best[map.idx(ox, oy)] = start;
  heap.push({ intensity: start.intensity, time: start.time, idx: map.idx(ox, oy) });

  while (heap.size > 0) {
    const cur = heap.pop();
    const curBest = best[cur.idx];
    // 过期堆元素:已被更优记录取代
    if (!curBest || curBest.intensity !== cur.intensity || curBest.time !== cur.time) continue;

    const cx = cur.idx % map.w;
    const cy = Math.floor(cur.idx / map.w);
    for (const { d, dx, dy } of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.passable(nx, ny)) continue;
      const remain = cur.intensity - map.enterCost(nx, ny);
      if (remain <= 0) continue; // 强度耗尽,不再传播
      const cand: CellReach = { time: cur.time + STEP_TIME, intensity: remain, entry: d };
      const ni = map.idx(nx, ny);
      if (better(cand, best[ni])) {
        best[ni] = cand;
        heap.push({ intensity: cand.intensity, time: cand.time, idx: ni });
      }
    }
  }
  return best;
}
