/**
 * 温室传粉核心引擎：纯函数，无任何 DOM / 绘制依赖。
 * 给定同一个 Board，simulateTurn 永远产出相同的 TurnReport。
 */
import {
  Arrival,
  Board,
  Cell,
  ColorCode,
  COLOR_NONE,
  DIRECTION_VECTORS,
  Flower,
  FlowerTurnDetail,
  Panel,
  STABLE_TURNS,
  TraceStep,
  TurnReport,
  WIND_RANGE,
  Wind,
} from './types.js';

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function inBoard(board: Board, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < board.width && y < board.height;
}

export function flowerAt(board: Board, x: number, y: number): Flower | undefined {
  return board.flowers.find((f) => f.x === x && f.y === y);
}

export function panelAt(board: Board, x: number, y: number): Panel | undefined {
  return board.panels.find((p) => p.x === x && p.y === y);
}

/** 挡风板只能放在空地：不能压花，也不能与现有挡风板重叠 */
export function canPlacePanel(board: Board, x: number, y: number): boolean {
  return inBoard(board, x, y) && !flowerAt(board, x, y) && !panelAt(board, x, y);
}

/** 返回移动挡风板后的新棋盘（不修改原棋盘）；目标非法时抛错 */
export function movePanel(board: Board, panelId: string, target: Cell): Board {
  if (!canPlacePanel(board, target.x, target.y)) {
    throw new Error(`格 (${target.x},${target.y}) 不能放置挡风板`);
  }
  const next: Board = structuredClone(board);
  const panel = next.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error(`挡风板 ${panelId} 不存在`);
  panel.x = target.x;
  panel.y = target.y;
  return next;
}

/**
 * 计算一条风的飞行路径。
 * 逐格前进：遇到边界停止；遇到挡风板，在该格标记 blocked 并停止；
 * 否则记录该格并继续，直到达到该风种的飞行距离。
 */
export function computeTrace(board: Board, wind: Wind): TraceStep[] {
  const vector = DIRECTION_VECTORS[wind.dir];
  const range = WIND_RANGE[wind.kind];
  const steps: TraceStep[] = [];
  let x = wind.from.x;
  let y = wind.from.y;
  for (let i = 0; i < range; i += 1) {
    x += vector.dx;
    y += vector.dy;
    if (!inBoard(board, x, y)) break;
    const blocked = panelAt(board, x, y) !== undefined;
    steps.push({ x, y, blocked, hasFlower: flowerAt(board, x, y) !== undefined });
    if (blocked) break; // 花粉被挡在这一格，后续格子不受影响
  }
  return steps;
}

/**
 * 执行一轮：
 * 1. 每朵花“轮开始时的颜色”决定它发出什么花粉（先克隆，结算不影响本轮发射）；
 * 2. 沿每条风逐格传播，挡风板拦截、边界截断；
 * 3. 同一目标收到多个来源时，颜色按三原色集合取并集（按位或），
 *    来源数组按 sourceFlowerId 排序 —— 与遍历顺序无关；
 * 4. 每朵花依据本轮混合色更新“连续积累进度”。
 */
export function simulateTurn(board: Board, round: number): TurnReport {
  const start: Board = structuredClone(board); // 轮开始快照：发射颜色只看它
  const next: Board = structuredClone(board);

  const arrivalsByFlower = new Map<string, Arrival[]>();
  const traces: TurnReport['traces'] = [];

  for (const wind of start.winds) {
    const steps = computeTrace(start, wind);
    const source = flowerAt(start, wind.from.x, wind.from.y);
    const last = steps[steps.length - 1];
    let delivered = false;

    // 只在路径未被拦截、终点有花、且起点花当前带颜色时投递
    if (source && source.color !== COLOR_NONE && last && !last.blocked && last.hasFlower) {
      const target = flowerAt(start, last.x, last.y);
      if (target) {
        const arrival: Arrival = {
          flowerId: target.id,
          sourceFlowerId: source.id,
          sourceColor: source.color,
          windId: wind.id,
          steps: steps.map((s) => ({ ...s })),
        };
        const list = arrivalsByFlower.get(target.id) ?? [];
        list.push(arrival);
        arrivalsByFlower.set(target.id, list);
        delivered = true;
      }
    }
    traces.push({ windId: wind.id, steps, delivered });
  }

  const details: FlowerTurnDetail[] = [];

  // 花朵按 id 顺序结算，保证确定性
  for (const flower of [...next.flowers].sort((a, b) => a.id.localeCompare(b.id))) {
    const beforeColor = flower.color;
    const beforePendingColor = flower.pendingColor;
    const beforeProgress = flower.progress;
    const arrivals = (arrivalsByFlower.get(flower.id) ?? [])
      .slice()
      .sort((a, b) =>
        a.sourceFlowerId === b.sourceFlowerId
          ? a.windId.localeCompare(b.windId)
          : a.sourceFlowerId.localeCompare(b.sourceFlowerId),
      );
    const incomingColor: ColorCode = arrivals.reduce(
      (acc, arrival) => acc | arrival.sourceColor,
      COLOR_NONE,
    );

    let stabilized = false;
    if (incomingColor === COLOR_NONE) {
      // 空一轮：已积累的进度保留但衰减 1，不会一下子清零，更不会跳到目标色
      if (flower.progress > 0) {
        flower.progress -= 1;
        if (flower.progress === 0) flower.pendingColor = COLOR_NONE;
      }
    } else if (flower.pendingColor !== incomingColor) {
      // 换了颜色：旧进度作废，从新颜色的第 1 轮重新开始
      flower.pendingColor = incomingColor;
      flower.progress = 1;
    } else {
      // 同色连续到达：进度 +1，满 STABLE_TURNS 轮才稳定
      flower.progress = Math.min(STABLE_TURNS, flower.progress + 1);
      if (flower.progress >= STABLE_TURNS) {
        flower.color = flower.pendingColor;
        flower.pendingColor = COLOR_NONE;
        flower.progress = 0;
        stabilized = flower.color !== beforeColor;
      }
    }

    details.push({
      flowerId: flower.id,
      beforeColor,
      arrivals,
      incomingColor,
      beforePendingColor,
      beforeProgress,
      afterPendingColor: flower.pendingColor,
      afterProgress: flower.progress,
      afterColor: flower.color,
      stabilized,
    });
  }

  return { round, details, traces, board: next };
}
