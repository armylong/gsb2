// 光束模拟:沿四方向传播、同色段合并、分束、有限步内收敛并标出循环
import { Board, DX, DY } from './model.js';

export interface SimResult {
  /** 光段 -> 颜色位。光段 = (格子, 方向),同方向穿过的光自然合并颜色 */
  segMask: Map<number, number>;
  /** 接收板格子 key -> 实际收到的颜色位 */
  receiverMask: Map<string, number>;
  /** 处于封闭反射回路中的光段 */
  loopSegs: Set<number>;
  /** 处于封闭反射回路中的格子 key */
  loopCells: Set<string>;
  /** 反向边:状态 -> 前驱状态列表(用于从接收板回看来源) */
  rev: Map<number, number[]>;
  /** 每个格子上出现过的状态(用于接收板回看入口) */
  statesByCell: Map<string, number[]>;
  steps: number;
  truncated: boolean;
}

export interface TraceResult {
  segs: Set<number>;
  sources: Set<string>; // 发光块格子 key
}

const MAX_STEPS = 200000;

// 反射表:'/' 与 '\'
const SLASH = [1, 0, 3, 2]; // N<->E, S<->W
const BACK = [3, 2, 1, 0];  // N<->W, S<->E
const reflect = (orient: number, d: number): number => (orient === 0 ? SLASH[d] : BACK[d]);

export function simulate(board: Board): SimResult {
  const W = board.w, H = board.h;
  const segMask = new Map<number, number>();
  const receiverMask = new Map<string, number>();
  const rev = new Map<number, number[]>();
  const statesByCell = new Map<string, number[]>();
  const seen = new Set<number>();
  const fwd = new Map<number, number[]>();

  // 状态编码:((格子 * 4 + 方向) * 8 + 颜色位)。状态空间有限,必然有限步内收敛
  const SK = (cell: number, d: number, m: number) => (cell * 4 + d) * 8 + m;

  const queue: number[] = [];
  for (const [ck, p] of board.pieces) {
    if (p.type !== 'emitter') continue;
    const [x, y] = ck.split(',').map(Number);
    queue.push(SK(y * W + x, p.rot & 3, p.color & 7));
  }

  let steps = 0, truncated = false;
  let head = 0;
  while (head < queue.length) {
    if (++steps > MAX_STEPS) { truncated = true; break; }
    const s = queue[head++];
    if (seen.has(s)) continue;
    seen.add(s);

    const m = s & 7, d = (s >> 3) & 3, cell = s >> 5;
    const x = cell % W, y = (cell / W) | 0;
    const ck = `${x},${y}`;

    segMask.set(cell * 4 + d, (segMask.get(cell * 4 + d) ?? 0) | m);
    let list = statesByCell.get(ck);
    if (!list) statesByCell.set(ck, (list = []));
    list.push(s);

    const p = board.pieces.get(ck);
    let outDirs: number[];
    if (!p) outDirs = [d];
    else switch (p.type) {
      case 'emitter':
        // 沿发光块朝向穿行的光视为从块内射出,直接通过;其它方向被块体吸收
        outDirs = d === (p.rot & 3) ? [d] : [];
        break;
      case 'blocker':
        outDirs = [];
        break;
      case 'receiver':
        receiverMask.set(ck, (receiverMask.get(ck) ?? 0) | m);
        outDirs = [];
        break;
      case 'mirror':
        outDirs = [reflect(p.rot & 1, d)];
        break;
      case 'splitter':
        // 分束:一路直行,一路按镜面方向反射,两路都保留全部组成颜色
        outDirs = [d, reflect(p.rot & 1, d)];
        break;
    }

    for (const nd of outDirs) {
      const nx = x + DX[nd], ny = y + DY[nd];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; // 射出房间,消失
      const ns = SK(ny * W + nx, nd, m);
      let fl = fwd.get(s);
      if (!fl) fwd.set(s, (fl = []));
      fl.push(ns);
      let rl = rev.get(ns);
      if (!rl) rev.set(ns, (rl = []));
      rl.push(s);
      if (!seen.has(ns)) queue.push(ns);
    }
  }

  // Tarjan 强连通分量:大小 > 1 的分量即封闭反射回路
  const loopSegs = new Set<number>();
  const loopCells = new Set<string>();
  {
    const index = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    let counter = 0;
    const strongconnect = (v: number): void => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of fwd.get(v) ?? []) {
        if (!index.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== v);
        if (scc.length > 1 || (fwd.get(v) ?? []).includes(v)) {
          for (const st of scc) {
            const d = (st >> 3) & 3, cell = st >> 5;
            loopSegs.add(cell * 4 + d);
            loopCells.add(`${cell % W},${(cell / W) | 0}`);
          }
        }
      }
    };
    for (const s of seen) if (!index.has(s)) strongconnect(s);
  }

  return { segMask, receiverMask, loopSegs, loopCells, rev, statesByCell, steps, truncated };
}

/** 从接收板沿当前结果回看:返回相关光段与来源发光块 */
export function traceReceiver(res: SimResult, board: Board, cellKey: string): TraceResult {
  const W = board.w;
  const segs = new Set<number>();
  const sources = new Set<string>();
  const visited = new Set<number>();
  const stack = [...(res.statesByCell.get(cellKey) ?? [])];
  while (stack.length) {
    const s = stack.pop()!;
    if (visited.has(s)) continue;
    visited.add(s);
    const d = (s >> 3) & 3, cell = s >> 5;
    segs.add(cell * 4 + d);
    const preds = res.rev.get(s);
    if (!preds || preds.length === 0) {
      // 没有前驱:光束起点,即某个发光块
      const key = `${cell % W},${(cell / W) | 0}`;
      if (board.pieces.get(key)?.type === 'emitter') sources.add(key);
    } else {
      for (const q of preds) stack.push(q);
    }
  }
  return { segs, sources };
}
