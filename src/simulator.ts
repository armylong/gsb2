// 窄桥多车预约调度引擎（纯逻辑，不依赖 DOM，可单测）
//
// 模型：离散网格 + 按步推进。每一步开始时在「时间扩展图」上重新预约未来 horizon 步：
//   - 顶点预约 vertex[(x,y,t)]：同一时刻一个格子只能被一台车占用
//   - 边预约 edge[(a,b,t)]：禁止两台车在同一步迎面交换（a→b 与 b→a）
//
// 桥梁是单向临界区，用方向状态机管理：
//   桥在每个时刻只有一个通行方向。第一台成功预约桥面的车「获得桥权」，
//   同方向车可跟随，对向车必须退到专属等待格停泊，等桥完全清空后才放行。
//   车在等待格上只停泊、不探上主路，从根上避免让行振荡与桥头互锁。
// 上桥前必须一次性预约「桥头 → 整段桥面 → 出口」，任何一段拿不到就不许上桥。

export type CellType = 'road' | 'bridge' | 'wait';
export type Strategy = 'strict' | 'aging' | 'fcfs';
export type CarStatus = 'running' | 'done' | 'failed';

export interface Cell {
  x: number;
  y: number;
  type: CellType;
  closed?: boolean;
}

export interface CarConfig {
  id: string;
  label: string;
  color: string;
  start: { x: number; y: number };
  goal: { x: number; y: number };
  priority: number; // 数字越大优先级越高
  siding?: { x: number; y: number } | null; // 上桥受阻时的专属等待格
}

export type PlanMoveType = 'move' | 'wait';

export interface PlanStep {
  type: PlanMoveType;
  from: { x: number; y: number };
  to: { x: number; y: number };
  note?: string;
}

export interface CarRuntime extends CarConfig {
  pos: { x: number; y: number };
  status: CarStatus;
  waitCount: number;
  queueSeniority: number; // 排队资历：等待/退避累加，朝目标取得进展清零
  visitHistory: string[]; // 最近访问格子，用于振荡检测
  plan: PlanStep[];
  failReason?: string;
}

export interface SimEvent {
  tick: number;
  level: 'info' | 'warn' | 'fail';
  text: string;
}

export interface SimConfig {
  width: number;
  height: number;
  cells: Cell[];
  cars: CarConfig[];
  horizon: number;
  strategy: Strategy;
  maxWait: number;
}

const DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 },
];

export const key = (x: number, y: number) => `${x},${y}`;
const vkey = (x: number, y: number, t: number) => `${x},${y},${t}`;
const ekey = (ax: number, ay: number, bx: number, by: number, t: number) =>
  `${ax},${ay}>${bx},${by}@${t}`;
const samePos = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x === b.x && a.y === b.y;

// 老化权重：每积累一份排队资历，有效优先级 +1.5
const AGING_WEIGHT = 1.5;
const DEADLOCK_IDLE_TICKS = 3;
type BridgeDir = 'east' | 'west' | null;

export class Simulator {
  readonly width: number;
  readonly height: number;
  readonly grid: (Cell | null)[][];
  cars: CarRuntime[];
  horizon: number;
  strategy: Strategy;
  readonly maxWait: number;
  tick = 0;
  events: SimEvent[] = [];
  private vertexRes = new Map<string, string>();
  private edgeRes = new Map<string, string>();
  private idleTicks = 0;
  // 桥梁当前放行方向。一旦确定就保持，直到：
  //   (a) 桥面上没有车，且 (b) 没有任何该方向的车在桥头等待/接近，
  // 才允许切换，避免桥短暂清空时方向翻转、把没过完桥的同方向车队截断。
  private bridgeDirection: BridgeDir = null;

  constructor(cfg: SimConfig) {
    this.width = cfg.width;
    this.height = cfg.height;
    this.horizon = cfg.horizon;
    this.strategy = cfg.strategy;
    this.maxWait = cfg.maxWait;
    this.grid = Array.from({ length: cfg.height }, () =>
      Array.from({ length: cfg.width }, () => null as Cell | null),
    );
    for (const c of cfg.cells) this.grid[c.y][c.x] = { ...c };
    this.cars = cfg.cars.map((c) => ({
      ...c,
      siding: c.siding ?? null,
      pos: { ...c.start },
      status: 'running',
      waitCount: 0,
      queueSeniority: 0,
      visitHistory: [key(c.start.x, c.start.y)],
      plan: [],
    }));
    this.planAll();
  }

  log(level: SimEvent['level'], text: string) {
    this.events.push({ tick: this.tick, level, text });
    if (this.events.length > 300) this.events.shift();
  }

  inBounds(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cellAt(x: number, y: number): Cell | null {
    if (!this.inBounds(x, y)) return null;
    return this.grid[y][x];
  }

  isPassable(x: number, y: number) {
    const c = this.cellAt(x, y);
    return !!c && !c.closed;
  }

  private manhattan(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  private neighbors(p: { x: number; y: number }): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const d of DIRS) {
      const nx = p.x + d.dx;
      const ny = p.y + d.dy;
      if (this.isPassable(nx, ny)) out.push({ x: nx, y: ny });
    }
    return out;
  }

  bfs(
    start: { x: number; y: number },
    goal: { x: number; y: number },
    blocked: Set<string> = new Set(),
  ): { x: number; y: number }[] | null {
    if (samePos(start, goal)) return [start];
    const prev = new Map<string, { x: number; y: number } | null>();
    const q: { x: number; y: number }[] = [start];
    prev.set(key(start.x, start.y), null);
    while (q.length) {
      const cur = q.shift()!;
      if (samePos(cur, goal)) {
        const path: { x: number; y: number }[] = [];
        let n: { x: number; y: number } | undefined = cur;
        while (n) {
          path.unshift(n);
          n = prev.get(key(n.x, n.y)) ?? undefined;
        }
        return path;
      }
      for (const nb of this.neighbors(cur)) {
        const k = key(nb.x, nb.y);
        if (prev.has(k) || blocked.has(k)) continue;
        prev.set(k, cur);
        q.push(nb);
      }
    }
    return null;
  }

  // 桥面格子（按地图顺序）
  private bridgeCells(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++)
        if (this.cellAt(x, y)?.type === 'bridge') out.push({ x, y });
    return out;
  }

  // 桥的朝向：桥面共线则为横向，否则纵向
  private bridgeAxis(): { horizontal: boolean; line: number } | null {
    const bc = this.bridgeCells();
    if (!bc.length) return null;
    const horizontal = bc.every((c) => c.y === bc[0].y);
    return { horizontal, line: horizontal ? bc[0].y : bc[0].x };
  }

  // 车要过这座桥的行驶方向
  private carBridgeDir(car: CarRuntime): BridgeDir {
    const axis = this.bridgeAxis();
    if (!axis) return null;
    if (axis.horizontal) return car.goal.x > car.pos.x ? 'east' : 'west';
    return car.goal.y > car.pos.y ? 'east' : 'west';
  }

  // 车是否已经完全通过桥面（当前位置与目标在桥的同一侧，即已离开来车侧）
  private hasCrossedBridge(car: CarRuntime): boolean {
    const axis = this.bridgeAxis();
    const bc = this.bridgeCells();
    if (!axis || !bc.length) return true;
    const min = axis.horizontal ? Math.min(...bc.map((c) => c.x)) : Math.min(...bc.map((c) => c.y));
    const max = axis.horizontal ? Math.max(...bc.map((c) => c.x)) : Math.max(...bc.map((c) => c.y));
    const onRoad = axis.horizontal
      ? car.pos.y === axis.line && car.goal.y === axis.line
      : car.pos.x === axis.line && car.goal.x === axis.line;
    if (!onRoad) return false;
    const p = axis.horizontal ? car.pos.x : car.pos.y;
    const g = axis.horizontal ? car.goal.x : car.goal.y;
    // 目标在西侧：通过意味着已到 min 以西；目标在东侧：已到 max 以东
    if (g < min) return p <= min;
    if (g > max) return p >= max;
    return true;
  }

  // 从 entry 开始的整段桥面 + 出口格
  private bridgeSection(entry: { x: number; y: number }): { x: number; y: number }[] {
    const section: { x: number; y: number }[] = [];
    const startCell = this.cellAt(entry.x, entry.y);
    if (!startCell || startCell.type !== 'bridge') return section;
    let dir = DIRS[0];
    if (this.cellAt(entry.x, entry.y - 1)?.type === 'bridge') dir = DIRS[3];
    else if (this.cellAt(entry.x, entry.y + 1)?.type === 'bridge') dir = DIRS[1];
    else if (this.cellAt(entry.x - 1, entry.y)?.type === 'bridge') dir = DIRS[2];
    let cur = { ...entry };
    while (this.cellAt(cur.x, cur.y)?.type === 'bridge') {
      section.push({ ...cur });
      cur = { x: cur.x + dir.dx, y: cur.y + dir.dy };
    }
    if (this.inBounds(cur.x, cur.y) && this.cellAt(cur.x, cur.y)) section.push(cur);
    return section;
  }

  private vertexFree(x: number, y: number, t: number, carId: string) {
    const owner = this.vertexRes.get(vkey(x, y, t));
    return !owner || owner === carId;
  }

  private edgeFree(
    a: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
    carId: string,
  ) {
    const owner = this.edgeRes.get(ekey(a.x, a.y, b.x, b.y, t));
    if (owner && owner !== carId) return false;
    const opp = this.edgeRes.get(ekey(b.x, b.y, a.x, a.y, t));
    return !opp || opp === carId;
  }

  private blockReason(
    a: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
    carId: string,
  ): string | null {
    if (!this.vertexFree(b.x, b.y, t, carId)) {
      const owner = this.vertexRes.get(vkey(b.x, b.y, t))!;
      return `t+${t - this.tick} 目标格 ${key(b.x, b.y)} 已被 ${owner} 预约（重占冲突）`;
    }
    if (!this.edgeFree(a, b, t, carId)) {
      return `t+${t - this.tick} 边 ${key(a.x, a.y)}→${key(b.x, b.y)} 存在迎面交换预约`;
    }
    return null;
  }

  private reserveStep(
    a: { x: number; y: number },
    b: { x: number; y: number },
    t: number,
    carId: string,
  ) {
    this.vertexRes.set(vkey(b.x, b.y, t), carId);
    this.edgeRes.set(ekey(a.x, a.y, b.x, b.y, t), carId);
  }

  // 干跑：从 startStep 起沿 route 逐格移动是否都可预约（不写入）
  private pathConflict(
    start: { x: number; y: number },
    route: { x: number; y: number }[],
    startStep: number,
    carId: string,
  ): string | null {
    let prev = start;
    for (let i = 0; i < route.length; i++) {
      const t = startStep + i;
      if (t > this.tick + this.horizon) {
        return `走廊共 ${route.length} 格，超出未来 ${this.horizon} 步预约视野，无法保证一次性通过`;
      }
      const r = this.blockReason(prev, route[i], t, carId);
      if (r) return r;
      prev = route[i];
    }
    return null;
  }

  private reserveRoute(
    start: { x: number; y: number },
    route: { x: number; y: number }[],
    startStep: number,
    carId: string,
  ) {
    let prev = start;
    for (let i = 0; i < route.length; i++) {
      this.reserveStep(prev, route[i], startStep + i, carId);
      prev = route[i];
    }
  }

  private reserveWait(car: CarRuntime, t: number, note?: string): PlanStep {
    const vk = vkey(car.pos.x, car.pos.y, t);
    if (!this.vertexRes.has(vk)) this.vertexRes.set(vk, car.id);
    return { type: 'wait', from: { ...car.pos }, to: { ...car.pos }, note };
  }

  // 前往专属等待格的下一步路径（禁止穿桥）；不可行返回 null
  private retreatStep(
    car: CarRuntime,
    from: { x: number; y: number },
  ): { x: number; y: number } | null {
    if (!car.siding || samePos(from, car.siding)) return null;
    const block = new Set<string>();
    for (const bc of this.bridgeCells()) block.add(key(bc.x, bc.y));
    const detour = this.bfs(from, car.siding, block);
    if (!detour || detour.length <= 1) return null;
    return detour[1];
  }

  // 为一台车规划整个 horizon
  private planCar(car: CarRuntime): PlanStep[] {
    const plan: PlanStep[] = [];
    let cur = { ...car.pos };
    let t = this.tick;
    const endTick = this.tick + this.horizon;

    while (t < endTick) {
      if (samePos(cur, car.goal)) {
        this.vertexRes.set(vkey(cur.x, cur.y, t + 1), car.id);
        plan.push({ type: 'wait', from: { ...cur }, to: { ...cur }, note: '已到达终点' });
        t++;
        continue;
      }

      const path = this.bfs(cur, car.goal);
      if (!path) {
        plan.push(this.reserveWait(car, ++t, '无可达路径（可能被封闭格阻挡）'));
        continue;
      }
      const next = path[1];

      // 路径含桥：处理临界区
      const bIdx = path.findIndex((p) => this.cellAt(p.x, p.y)?.type === 'bridge');
      if (bIdx >= 1) {
        const wantDir = this.carBridgeDir(car);
        const section = this.bridgeSection(path[bIdx]);
        const corridor = path.slice(1, bIdx).concat(section);

        // 方向状态机：桥已有对向通行权时，本车不能上桥
        const directionBlocked =
          this.bridgeDirection !== null && this.bridgeDirection !== wantDir;
        let block = directionBlocked
          ? `桥梁当前放行方向为 ${this.bridgeDirection}，与本车方向 ${wantDir} 冲突`
          : this.pathConflict(cur, corridor, t + 1, car.id);

        if (!block) {
          // 物理保险：桥出口缓冲格不能被「主路上的」对向车实体堵死（桥上无法倒车）。
          // 停在等待格里的对向车处于让行状态，不会堵口，不计入。
          const buffer = this.bridgeBuffer(path[bIdx]);
          if (buffer) {
            const blocker = this.cars.find(
              (c) =>
                c.id !== car.id &&
                c.status === 'running' &&
                samePos(c.pos, buffer) &&
                this.cellAt(c.pos.x, c.pos.y)?.type !== 'wait' &&
                this.carBridgeDir(c) &&
                this.carBridgeDir(c) !== wantDir,
            );
            if (blocker) {
              block = `桥出口缓冲格 ${key(buffer.x, buffer.y)} 被主路对向车 ${blocker.id} 实体占用，上桥将被困`;
            }
          }
        }

        if (block) {
          const parked = car.siding && samePos(cur, car.siding);
          if (parked) {
            plan.push(this.reserveWait(car, ++t, `等待格停泊：${block}`));
            continue;
          }
          const retreat = this.retreatStep(car, cur);
          if (retreat) {
            const r = this.blockReason(cur, retreat, t + 1, car.id);
            if (!r) {
              this.reserveStep(cur, retreat, t + 1, car.id);
              plan.push({ type: 'move', from: { ...cur }, to: { ...retreat } });
              cur = { ...retreat };
              t++;
              continue;
            }
          }
          plan.push(this.reserveWait(car, ++t, block));
          continue;
        }

        // 成功获得走廊：登记桥梁方向并一次性预约
        this.bridgeDirection = wantDir;
        this.reserveRoute(cur, corridor, t + 1, car.id);
        let cursor = cur;
        for (const c of corridor) {
          t++;
          plan.push({ type: 'move', from: { ...cursor }, to: { ...c } });
          cursor = c;
        }
        cur = { ...corridor[corridor.length - 1] };
        continue;
      }

      // 普通道路格
      const reason = this.blockReason(cur, next, t + 1, car.id);
      if (reason) {
        const retreat = this.retreatStep(car, cur);
        if (retreat) {
          const r = this.blockReason(cur, retreat, t + 1, car.id);
          if (!r) {
            this.reserveStep(cur, retreat, t + 1, car.id);
            plan.push({ type: 'move', from: { ...cur }, to: { ...retreat } });
            cur = { ...retreat };
            t++;
            continue;
          }
        }
        plan.push(this.reserveWait(car, ++t, reason));
        continue;
      }
      this.reserveStep(cur, next, t + 1, car.id);
      plan.push({ type: 'move', from: { ...cur }, to: { ...next } });
      cur = { ...next };
      t++;
    }
    return plan;
  }

  // 桥出口后的缓冲格
  private bridgeBuffer(entry: { x: number; y: number }): { x: number; y: number } | null {
    const startCell = this.cellAt(entry.x, entry.y);
    if (!startCell || startCell.type !== 'bridge') return null;
    let dir = DIRS[0];
    if (this.cellAt(entry.x, entry.y - 1)?.type === 'bridge') dir = DIRS[3];
    else if (this.cellAt(entry.x, entry.y + 1)?.type === 'bridge') dir = DIRS[1];
    else if (this.cellAt(entry.x - 1, entry.y)?.type === 'bridge') dir = DIRS[2];
    let cur = { ...entry };
    while (this.cellAt(cur.x, cur.y)?.type === 'bridge') {
      cur = { x: cur.x + dir.dx, y: cur.y + dir.dy };
    }
    const beyond = { x: cur.x + dir.dx, y: cur.y + dir.dy };
    return this.inBounds(beyond.x, beyond.y) && this.cellAt(beyond.x, beyond.y) ? beyond : null;
  }

  private score(car: CarRuntime): number {
    switch (this.strategy) {
      case 'strict':
        return car.priority;
      case 'aging':
        return car.priority + car.queueSeniority * AGING_WEIGHT;
      case 'fcfs':
        return car.queueSeniority * 1000 + car.priority;
    }
  }

  // 每周期重算预约。根据实体占位与待行车辆维护桥梁方向，再按优先级顺序规划。
  // 注意：bridgeDirection 是跨周期状态，不能在这里清零，否则方向持久化失效。
  planAll() {
    this.vertexRes.clear();
    this.edgeRes.clear();

    // 已结束车辆持续占位
    for (const car of this.cars) {
      if (car.status === 'running') continue;
      for (let t = this.tick + 1; t <= this.tick + this.horizon; t++) {
        this.vertexRes.set(vkey(car.pos.x, car.pos.y, t), car.id);
      }
    }

    // 桥梁方向决策（跨周期保持，避免桥短暂清空时翻转截断车队）：
    // 1) 桥上有车：方向锁定为该车方向，任何对向车禁止上桥；
    // 2) 桥为空但当前方向仍有车在桥头一格内逼近：保持方向，让车队连贯通过；
    // 3) 否则释放方向，由本轮规划中评分最高且最先成功预约走廊的车重新确立方向。
    const onBridgeCar = this.cars.find(
      (c) => c.status === 'running' && this.cellAt(c.pos.x, c.pos.y)?.type === 'bridge',
    );
    if (onBridgeCar) {
      this.bridgeDirection = this.carBridgeDir(onBridgeCar);
    } else if (this.bridgeDirection !== null) {
      const axis = this.bridgeAxis();
      const bc = this.bridgeCells();
      const min = axis!.horizontal
        ? Math.min(...bc.map((c) => c.x))
        : Math.min(...bc.map((c) => c.y));
      const max = axis!.horizontal
        ? Math.max(...bc.map((c) => c.x))
        : Math.max(...bc.map((c) => c.y));
      const approaching = this.cars.some((c) => {
        if (c.status !== 'running' || this.carBridgeDir(c) !== this.bridgeDirection) return false;
        if (this.hasCrossedBridge(c)) return false;
        const coord = axis!.horizontal ? c.pos.x : c.pos.y;
        const onLine = axis!.horizontal ? c.pos.y === axis!.line : c.pos.x === axis!.line;
        // 在来车侧、距桥头不超过 1 格且在主路上，视为正在逼近
        if (!onLine) return false;
        if (this.bridgeDirection === 'east') return coord >= min - 1 && coord < min;
        return coord <= max + 1 && coord > max;
      });
      if (!approaching) this.bridgeDirection = null;
    }

    const order = this.cars
      .filter((c) => c.status === 'running')
      .sort((a, b) => this.score(b) - this.score(a) || a.id.localeCompare(b.id));
    for (const car of order) car.plan = this.planCar(car);
  }

  get reservations(): { vertex: Map<string, string>; edge: Map<string, string> } {
    return { vertex: this.vertexRes, edge: this.edgeRes };
  }

  setClosed(x: number, y: number, closed: boolean): boolean {
    const c = this.cellAt(x, y);
    if (!c) return false;
    if (closed && this.cars.some((car) => samePos(car.pos, { x, y }) && car.status !== 'done'))
      return false;
    c.closed = closed;
    this.log(closed ? 'warn' : 'info', `格子 ${key(x, y)} 已${closed ? '封闭' : '解封'}`);
    // 预约整体作废重算：受影响车绕路，不受影响的车计划不变、继续执行
    this.planAll();
    return true;
  }

  setPriority(carId: string, priority: number) {
    const car = this.cars.find((c) => c.id === carId);
    if (!car) return;
    car.priority = priority;
    this.log('info', `${car.label} 优先级调整为 ${priority}，下一轮规划生效`);
    this.planAll();
  }

  setStrategy(strategy: Strategy) {
    this.strategy = strategy;
    this.log('info', `等待策略切换为 ${strategy}`);
    this.planAll();
  }

  setHorizon(h: number) {
    this.horizon = Math.max(1, Math.min(12, h));
    this.planAll();
  }

  get finished(): boolean {
    return this.cars.every((c) => c.status !== 'running');
  }

  // 推进一步：按规划优先级顺序执行 plan[0]，物理占位保险，再重算，检测饥饿/死锁/振荡
  step() {
    if (this.finished) return;
    this.tick++;
    let anyMoved = false;

    const occupied = new Map<string, string>();
    for (const car of this.cars) occupied.set(key(car.pos.x, car.pos.y), car.id);
    const moves = new Map<string, string>();
    const movedFrom = new Map<string, string>();

    const order = this.cars
      .filter((c) => c.status === 'running')
      .sort((a, b) => this.score(b) - this.score(a) || a.id.localeCompare(b.id));

    for (const car of order) {
      const mv = car.plan[0];
      const isWait = !mv || mv.type === 'wait' || samePos(mv.to, car.pos);
      if (isWait) {
        this.markWait(car, mv?.note);
        continue;
      }
      const toK = key(mv.to.x, mv.to.y);
      const fromK = key(car.pos.x, car.pos.y);
      const occupant = occupied.get(toK);
      if (occupant && occupant !== car.id) {
        this.log('warn', `${car.label} 物理占位拦截：${toK} 仍被 ${occupant} 占用`);
        this.markWait(car, `目标格 ${toK} 被 ${occupant} 实际占用`);
        continue;
      }
      if (movedFrom.get(toK) && moves.get(fromK) === movedFrom.get(toK)) {
        this.log('warn', `${car.label} 物理拦截：与 ${movedFrom.get(toK)} 迎面交换`);
        this.markWait(car, '迎面交换被拦截');
        continue;
      }
      occupied.delete(fromK);
      occupied.set(toK, car.id);
      moves.set(toK, car.id);
      movedFrom.set(fromK, car.id);
      const prevPos = { ...car.pos };
      car.pos = { ...mv.to };
      anyMoved = true;
      const before = this.manhattan(prevPos, car.goal);
      const after = this.manhattan(car.pos, car.goal);
      if (after < before) {
        car.waitCount = 0;
        car.queueSeniority = 0;
      } else {
        car.queueSeniority++;
      }
      car.visitHistory.push(key(car.pos.x, car.pos.y));
      if (car.visitHistory.length > 2 * this.maxWait + 4) car.visitHistory.shift();
      if (samePos(car.pos, car.goal)) {
        car.status = 'done';
        this.log('info', `${car.label} 到达终点 ${key(car.goal.x, car.goal.y)}`);
      }
    }

    // 振荡检测：近期历史中某个非等待格被高频重复访问，说明在主路上来回摆动。
    // 单纯停泊在等待格（等待格自身重复）不计入，那是正常让行。
    for (const car of this.cars) {
      if (car.status !== 'running' || car.visitHistory.length < this.maxWait) continue;
      const freq = new Map<string, number>();
      for (const p of car.visitHistory) {
        const [px, py] = p.split(',').map(Number);
        if (this.cellAt(px, py)?.type === 'wait') continue; // 等待格停泊不算振荡
        freq.set(p, (freq.get(p) ?? 0) + 1);
      }
      const maxFreq = freq.size ? Math.max(...freq.values()) : 0;
      if (maxFreq >= 4) {
        car.status = 'failed';
        car.failReason =
          `让行振荡：最近 ${car.visitHistory.length} 步在主路格子间反复移动（同一格经过 ${maxFreq} 次），` +
          `无法取得持续进展。当前受阻：${car.plan[0]?.note ?? '对向车流互相挡死'}`;
        this.log('fail', `${car.label} 失败：${car.failReason}`);
      }
    }

    this.idleTicks = anyMoved ? 0 : this.idleTicks + 1;
    if (!this.finished && this.idleTicks >= DEADLOCK_IDLE_TICKS) {
      for (const car of this.cars.filter((c) => c.status === 'running')) {
        car.status = 'failed';
        car.failReason =
          `全局死锁：连续 ${DEADLOCK_IDLE_TICKS} 步没有任何车移动。` +
          `当前受阻：${car.plan[0]?.note ?? '对向车流互相挡死'}`;
        this.log('fail', `${car.label} 失败：${car.failReason}`);
      }
    }

    this.planAll();
  }

  private markWait(car: CarRuntime, note?: string) {
    car.waitCount++;
    car.queueSeniority++;
    // 达到阈值时给一步宽限：若下一轮规划已经能移动（拿到通行权），就不判饥饿，
    // 避免「桥刚清空、车正要起步」的瞬间被误判
    if (car.waitCount >= this.maxWait) {
      const next = car.plan[0];
      const canMoveNext = !!next && next.type === 'move' && !samePos(next.to, car.pos);
      if (canMoveNext) {
        this.log('info', `${car.label} 等待 ${car.waitCount} 步后取得通行权，宽限放行`);
        return;
      }
      car.status = 'failed';
      car.failReason =
        `连续等待 ${car.waitCount} 步（弱车饥饿）。最后受阻原因：${note ?? '未知'}`;
      this.log('fail', `${car.label} 失败：${car.failReason}`);
    }
  }
}
