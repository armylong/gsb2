/**
 * 建造规则引擎(纯逻辑, 无 DOM 依赖, 可单测)
 *
 * 术语:
 * - 格子 cell: 网格坐标 (x, y), y 向下递增, GROUND_Y 行为地面
 * - 构件 piece: 占据一到多个格子的实体, 有自重 / 承重方向 / 承重上限
 * - 接触边 contact: 两个不同构件的格子共用一条网格边, 按 (支撑者, 被撑者) 有向统计
 *
 * 承重方向约定: bearing[dir] 表示构件"接受从 dir 方位邻居传来的支撑"。
 * 例: bearing.south = true 表示接受下方邻居托举; 边只由被撑方单边决定,
 * 支撑方是否"愿意托"不影响这条边(它的 bearing 只决定它自己被谁撑)。
 *
 * 接地: 只有 foundation 且有格子与地面行接触才是接地种子;
 * 接地性沿接触边反向 BFS 传播, 承重环没有任何接地种子时整环判悬空。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 方位用"邻居相对自己的位置"命名: south 邻居在自己下方 */
export interface DirSet {
  north: boolean; // 接受北边(上方)邻居作为支撑来源
  south: boolean; // 接受南边(下方)邻居作为支撑来源
  west: boolean; // 接受西边(左侧)邻居作为支撑来源
  east: boolean; // 接受东边(右侧)邻居作为支撑来源
}

export type PieceKind = 'foundation' | 'pillar' | 'deck' | 'block';

export interface Piece {
  id: string;
  kind: PieceKind;
  name: string;
  cells: Pt[];
  weight: number; // 自重(整体, 非每格)
  capacity: number; // 承重上限: 允许穿过本构件传递给支持者的最大总负载; Infinity = 无限
  bearing: DirSet; // 承重方向: 接受哪些方向的邻居作为支撑来源
  color: string;
}

/** 一条有向接触边: supporter 沿一条网格边支撑 supported */
export interface Contact {
  id: string;
  supporterId: string;
  supportedId: string;
  dir: keyof DirSet; // supporter 相对 supported 的方位(负载从该方向进入 supported)
  cell: Pt; // supported 一侧的格子, 用于画箭头
}

export interface SupportSource {
  pieceId: string; // 支撑构件
  contactId: string;
  dir: keyof DirSet;
  cell: Pt;
  edgeLoad: number; // 该接触边分到的负载
}

export interface PieceRuntime {
  grounded: boolean; // 是否有通向地面的支撑链
  totalLoad: number; // 自重 + 上方传下来的负载(仅接地构件有意义)
  supportFrom: SupportSource[]; // 实际生效的支撑来源(已按承重方向过滤)
  overloaded: boolean; // totalLoad > capacity
  removedRound: number; // 超载级联中第几轮失效; -1 表示未失效
}

export interface Settlement {
  alive: PieceRuntime[]; // 结算后仍站立的构件
  fallen: Piece[]; // 掉落的构件(悬空或其支撑链断裂)
  overloaded: Piece[]; // 触发超载失效的构件
  contacts: Contact[];
  byId: Map<string, PieceRuntime>;
}

export interface RemovalPreview {
  target: Piece;
  /** 纯拓扑受影响范围(不考虑承重上限):
   *  直接失去一条支撑边的构件(可能仍站立, 只是冗余减少) + 彻底悬空的构件。 */
  topoAffected: Piece[];
  /** topoAffected 中仍能站立的(失去部分支撑来源但未悬空) */
  topoStillStanding: Piece[];
  /** 模拟真实结算后会掉落的构件(考虑承重上限与级联) */
  simulatedFallen: Piece[];
  /** 模拟结算后超载失效的构件 */
  simulatedOverloaded: Piece[];
  settlement: Settlement;
}

export const DIRS: { key: keyof DirSet; dx: number; dy: number }[] = [
  { key: 'north', dx: 0, dy: -1 },
  { key: 'south', dx: 0, dy: 1 },
  { key: 'west', dx: -1, dy: 0 },
  { key: 'east', dx: 1, dy: 0 },
];

export const allDirs = (): DirSet => ({ north: true, south: true, west: true, east: true });
/** 竖向承重构件: 只接受来自下方(south)邻居的支撑; 托举关系由被撑方的 south 边单边表达,
 *  不生成反向边, 避免"互相支撑"造成的负载正反馈。 */
export const verticalBearing = (): DirSet => ({
  north: false,
  south: true,
  west: false,
  east: false,
});

const key = (x: number, y: number) => `${x},${y}`;
const contactKey = (a: string, b: string, dir: keyof DirSet, x: number, y: number) =>
  `${a}>${b}:${dir}:${x},${y}`;

/** 计算当前构件集合的全部有向接触边。
 *  边的生成只取决于"被支撑方"是否接受来自该方位的负载; 支撑方的 bearing 只决定它自己被谁撑,
 *  不反向产生边 —— 这样两个同方向构件之间不会出现互相支撑的伪环。
 *  相邻格子对用 pairKey 去重, 保证每对格子至多处理一次。 */
export function computeContacts(pieces: Piece[]): Contact[] {
  const owner = new Map<string, Piece>();
  for (const p of pieces) {
    for (const c of p.cells) owner.set(key(c.x, c.y), p);
  }
  const contacts: Contact[] = [];
  const seenEdges = new Set<string>();
  const seenPairs = new Set<string>();
  const pairKey = (ax: number, ay: number, bx: number, by: number) => {
    const a = key(ax, ay);
    const b = key(bx, by);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  const pushContact = (
    supporter: Piece,
    supported: Piece,
    dir: keyof DirSet,
    cell: Pt,
  ) => {
    const ck = contactKey(supporter.id, supported.id, dir, cell.x, cell.y);
    if (seenEdges.has(ck)) return;
    seenEdges.add(ck);
    contacts.push({ id: ck, supporterId: supporter.id, supportedId: supported.id, dir, cell });
  };
  for (const p of pieces) {
    for (const c of p.cells) {
      for (const d of DIRS) {
        const nx = c.x + d.dx;
        const ny = c.y + d.dy;
        const n = owner.get(key(nx, ny));
        if (!n || n.id === p.id) continue;
        const pk = pairKey(c.x, c.y, nx, ny);
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        // 视角 1: n 在 p 的 d 方位, p 接受 d 方位 → n 支撑 p
        if (p.bearing[d.key]) pushContact(n, p, d.key, c);
        // 视角 2: p 在 n 的反方位, n 接受反方位 → p 支撑 n
        const opp = OPPOSITE[d.key];
        if (n.bearing[opp]) pushContact(p, n, opp, { x: nx, y: ny });
      }
    }
  }
  return contacts;
}

const OPPOSITE: Record<keyof DirSet, keyof DirSet> = {
  north: 'south',
  south: 'north',
  west: 'east',
  east: 'west',
};

/** 反向 BFS: 从接地构件出发, 沿"谁支撑了我"的接触边传播接地标记。
 *  闭合承重环若没有任何构件接地, 整个环都不会被标记 —— 即悬空。 */
export function computeGrounded(pieces: Piece[], contacts: Contact[], groundY: number): Set<string> {
  // 接地种子: 只有地基且与地面行接触才算接地; 普通构件必须站在地基(链)上
  const isGroundedPiece = (p: Piece) =>
    p.kind === 'foundation' && p.cells.some((c) => c.y + 1 >= groundY);
  const grounded = new Set<string>();
  const queue: string[] = [];
  for (const p of pieces) {
    if (isGroundedPiece(p)) {
      grounded.add(p.id);
      queue.push(p.id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    // 我接地了, 那么以我为支撑者的构件, 若它接受这条边, 也接地
    for (const ct of contacts) {
      if (ct.supporterId !== id || grounded.has(ct.supportedId)) continue;
      grounded.add(ct.supportedId);
      queue.push(ct.supportedId);
    }
  }
  return grounded;
}

/**
 * 完整结算(每轮):
 * 1. 算接触边与接地集合, 不接地的构件直接判悬空掉落并触发重算
 * 2. 接地构件上做负载分摊: 先 Tarjan 把互相支撑的承重环缩成 SCC, 分量依赖图是 DAG;
 *    每个构件把 (自重 + 入边负载之和) 均分到自己的有效出边 —— 多支撑共同承重规则:
 *    按有效接触边数量均分, 每条边份额 = 总负载 / 出边数; 无出边的接地构件把负载交给大地。
 *    环内接触边只展示份额, 不重复累计, 避免环上负载循环放大。
 * 3. 任一构件 totalLoad 超过 capacity 则失效移除, 回到第 1 步级联重算。
 */
export function settle(pieces: Piece[], groundY: number): Settlement {
  let active = new Map(pieces.map((p) => [p.id, p]));
  const overloaded: Piece[] = [];
  const fallenAcc: Piece[] = [];
  // 累积所有轮次的 runtime, 保证掉落/失效构件在 byId 中也有最后状态
  const runtimeAcc = new Map<string, PieceRuntime>();
  let lastContacts: Contact[] = [];
  let round = 0;

  while (true) {
    const activePieces = [...active.values()];
    const contacts = computeContacts(activePieces);
    lastContacts = contacts;
    const grounded = computeGrounded(activePieces, contacts, groundY);

    // 第一步: 悬空构件(到不了任何接地地基)本轮直接掉落, 并触发级联重算
    const floating = activePieces.filter((p) => !grounded.has(p.id));
    for (const p of floating) {
      // 仅在首次离场时记录, 避免覆盖之前轮次的有效 runtime
      if (!runtimeAcc.has(p.id)) {
        runtimeAcc.set(p.id, {
          grounded: false,
          totalLoad: p.weight,
          supportFrom: [],
          overloaded: false,
          removedRound: round,
        });
      }
      active.delete(p.id);
    }
    if (floating.length > 0) {
      fallenAcc.push(...floating);
      round++;
      if (round > pieces.length + 2) break;
      continue;
    }

    const incoming = new Map<string, Contact[]>(); // 支撑方视角: 我托住了谁(入到我身上的负载边)
    const outgoing = new Map<string, Contact[]>(); // 被撑方视角: 我的支撑来源(负载分发出去的边)
    for (const ct of contacts) {
      (incoming.get(ct.supporterId) ?? incoming.set(ct.supporterId, []).get(ct.supporterId)!).push(ct);
      (outgoing.get(ct.supportedId) ?? outgoing.set(ct.supportedId, []).get(ct.supportedId)!).push(ct);
    }

    // 负载计算(SCC 缩点 + DAG 传播):
    // 承重环(互相支撑的强连通分量)作为一个整体承担其全部自重, 沿分量的出边均分到支撑方;
    // 环内部的接触边不重复累计负载(仅标注份额), 避免环上循环放大。
    const load = new Map<string, number>();
    const edgeLoad = new Map<string, number>();
    for (const p of activePieces) load.set(p.id, p.weight);

    // Tarjan 求强连通分量
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let tick = 0;
    const strong = (v: string) => {
      index.set(v, tick);
      low.set(v, tick);
      tick++;
      stack.push(v);
      onStack.add(v);
      for (const ct of outgoing.get(v) ?? []) {
        const w = ct.supporterId;
        if (!index.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let u: string;
        do {
          u = stack.pop()!;
          onStack.delete(u);
          comp.push(u);
        } while (u !== v);
        sccs.push(comp);
      }
    };
    for (const p of activePieces) if (!index.has(p.id)) strong(p.id);

    const compOf = new Map<string, number>();
    sccs.forEach((comp, ci) => comp.forEach((id) => compOf.set(id, ci)));
    // 分量级出边(去重): 同一对分量之间的多条格子边合并统计, 按边数均分
    const compOut = new Map<number, Contact[]>();
    for (const p of activePieces) {
      const ci = compOf.get(p.id)!;
      const list = compOut.get(ci) ?? [];
      for (const ct of outgoing.get(p.id) ?? []) {
        if (compOf.get(ct.supporterId) !== ci) list.push(ct);
      }
      compOut.set(ci, list);
    }
    // 分量自重
    const compWeight = sccs.map((comp) =>
      comp.reduce((sum, id) => sum + (active.get(id)?.weight ?? 0), 0),
    );
    const compLoad = compWeight.slice();

    // 分量依赖图(支撑方所在分量)是 DAG, 逆拓扑: 从被撑方向支撑方累加
    const compDeps = new Map<number, Set<number>>();
    compOut.forEach((outs, ci) => {
      const deps = new Set<number>();
      outs.forEach((ct) => deps.add(compOf.get(ct.supporterId)!));
      compDeps.set(ci, deps);
    });
    const done = new Set<number>();
    const solveComp = (ci: number) => {
      if (done.has(ci)) return;
      for (const dep of compDeps.get(ci) ?? []) solveComp(dep);
      const outs = compOut.get(ci) ?? [];
      if (outs.length > 0) {
        const share = compLoad[ci] / outs.length;
        for (const ct of outs) {
          edgeLoad.set(ct.id, share);
          const dep = compOf.get(ct.supporterId)!;
          compLoad[dep] += share;
        }
      }
      done.add(ci);
    };
    sccs.forEach((_, ci) => solveComp(ci));

    // 把分量级总负载回写到每个构件:
    //  - 单节点分量: 节点负载 = 分量总负载(自重 + 外部入边分摊)
    //  - 环分量: 外部入流量先落在对应入口构件上, 环内边份额仅用于展示支撑来源, 不再向上累计
    for (const comp of sccs) {
      const ci = compOf.get(comp[0])!;
      const isRing = comp.length > 1;
      if (!isRing) {
        const id = comp[0];
        load.set(id, compLoad[ci]);
        continue;
      }
      for (const id of comp) {
        const externalIn = (incoming.get(id) ?? [])
          .filter((ct) => compOf.get(ct.supporterId) !== ci)
          .reduce((sum, ct) => sum + (edgeLoad.get(ct.id) ?? 0), 0);
        load.set(id, (active.get(id)?.weight ?? 0) + externalIn);
        const outs = outgoing.get(id) ?? [];
        const deg = outs.length;
        if (deg > 0) {
          const share = load.get(id)! / deg;
          for (const ct of outs) if (!edgeLoad.has(ct.id)) edgeLoad.set(ct.id, share);
        }
      }
    }

    const runtime = new Map<string, PieceRuntime>();
    for (const p of activePieces) {
      const ins = outgoing.get(p.id) ?? []; // 我的支撑来源边
      const rt: PieceRuntime = {
        grounded: true, // 走到这里的 active 构件全部接地
        totalLoad: load.get(p.id)!,
        supportFrom: ins.map((ct) => ({
          pieceId: ct.supporterId,
          contactId: ct.id,
          dir: ct.dir,
          cell: ct.cell,
          edgeLoad: edgeLoad.get(ct.id) ?? 0,
        })),
        overloaded: false,
        removedRound: -1,
      };
      runtime.set(p.id, rt);
      // 存活构件每轮刷新(负载会随级联变化); 已离场构件保留离场时的记录不被覆盖
      if (active.has(p.id)) runtimeAcc.set(p.id, rt);
    }

    // 超载判定: 超限构件本轮失效移除, 下一轮重新算接地与负载(级联)
    const failures = activePieces.filter(
      (p) => runtime.get(p.id)!.totalLoad > p.capacity + 1e-9,
    );
    if (failures.length === 0) break;
    for (const p of failures) {
      overloaded.push(p);
      runtime.get(p.id)!.overloaded = true;
      runtime.get(p.id)!.removedRound = round;
      active.delete(p.id);
    }
    round++;
    if (round > pieces.length + 2) break; // 保险, 正常每轮至少移除一个构件
  }

  return {
    alive: [...active.values()].map((p) => runtimeAcc.get(p.id)!),
    fallen: fallenAcc,
    overloaded,
    contacts: lastContacts,
    byId: runtimeAcc,
  };
}

/**
 * 拆除预览(不修改当前世界):
 * - topoAffected: 移除目标后, 仅按拓扑(支撑方向与接地性)判定的受影响构件
 * - 模拟结算: 在"目标已删除"的副本上跑 settle, 得到考虑承重上限的真实掉落集合
 */
export function previewRemoval(pieces: Piece[], targetId: string, groundY: number): RemovalPreview {
  const target = pieces.find((p) => p.id === targetId);
  if (!target) throw new Error(`构件不存在: ${targetId}`);
  const rest = pieces.filter((p) => p.id !== targetId);

  // 直接受影响: 原来以目标为支撑来源的构件(它的支撑来源集合会缩小)
  const beforeContacts = computeContacts(pieces);
  const directIds = new Set(
    beforeContacts.filter((ct) => ct.supporterId === targetId).map((ct) => ct.supportedId),
  );

  // 拓扑坍塌: 在无上限世界里结算一次(全部 capacity 设 Infinity), 掉落即拓扑悬空
  const uncapped = rest.map((p) => ({ ...p, capacity: Infinity }));
  const topoSettlement = settle(uncapped, groundY);
  const fallenIds = new Set(topoSettlement.fallen.map((p) => p.id));
  const topoAffected = rest.filter((p) => directIds.has(p.id) || fallenIds.has(p.id));
  const topoStillStanding = topoAffected.filter((p) => !fallenIds.has(p.id));

  const settlement = settle(rest, groundY);
  return {
    target,
    topoAffected,
    topoStillStanding,
    simulatedFallen: settlement.fallen,
    simulatedOverloaded: settlement.overloaded,
    settlement,
  };
}

/** 带撤销栈的世界状态 */
export class World {
  pieces: Piece[] = [];
  private undoStack: Piece[][] = [];
  onSettle?: (s: Settlement) => void;

  constructor(
    public readonly groundY: number,
    public readonly gridW: number,
  ) {}

  private snapshot() {
    this.undoStack.push(this.pieces.map((p) => ({ ...p, cells: [...p.cells], bearing: { ...p.bearing } })));
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.pieces = prev;
    return true;
  }

  /** 格子是否已被占用(放置时用) */
  occupied(x: number, y: number, ignoreId?: string): boolean {
    return this.pieces.some(
      (p) => p.id !== ignoreId && p.cells.some((c) => c.x === x && c.y === y),
    );
  }

  canPlace(cells: Pt[]): boolean {
    if (cells.length === 0) return false;
    const local = new Set(cells.map((c) => key(c.x, c.y)));
    if (local.size !== cells.length) return false;
    return cells.every(
      (c) =>
        c.x >= 0 &&
        c.x < this.gridW &&
        c.y >= 0 &&
        c.y < this.groundY &&
        !this.occupied(c.x, c.y),
    );
  }

  add(piece: Piece): boolean {
    if (!this.canPlace(piece.cells)) return false;
    this.snapshot();
    this.pieces.push(piece);
    return true;
  }

  /** 提交拆除: 删除目标并在同一次快照里应用级联结算, 返回结算与被移除的构件 */
  commitRemoval(targetId: string): { settlement: Settlement; removed: Piece[] } {
    this.snapshot();
    this.pieces = this.pieces.filter((p) => p.id !== targetId);
    const settlement = settle(this.pieces, this.groundY);
    const gone = new Set([
      ...settlement.fallen.map((p) => p.id),
      ...settlement.overloaded.map((p) => p.id),
    ]);
    const removed = this.pieces.filter((p) => gone.has(p.id));
    this.pieces = this.pieces.filter((p) => !gone.has(p.id));
    this.onSettle?.(settlement);
    return { settlement, removed };
  }

  pieceAt(x: number, y: number): Piece | undefined {
    return this.pieces.find((p) => p.cells.some((c) => c.x === x && c.y === y));
  }

  settle(): Settlement {
    return settle(this.pieces, this.groundY);
  }

  preview(targetId: string): RemovalPreview {
    return previewRemoval(this.pieces, targetId, this.groundY);
  }

  reset(pieces: Piece[]) {
    this.snapshot();
    this.pieces = pieces;
  }
}
