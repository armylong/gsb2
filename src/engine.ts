// 争夺区控制权规则引擎(纯逻辑,不依赖 DOM,可在 node 与浏览器中运行)
//
// 核心规则:
//  1. 地图上有营地/前哨/阻断区/争夺区,两方单位落脚即标记格子。
//  2. 每回合从营地出发沿"已标记且无敌方单位占据"的格子做连通补给(BFS);
//     前哨断供后辐射权重从 3 降为 1。
//  3. 营地/前哨/单位按曼哈顿距离衰减向争夺区格子辐射势力,
//     汇总为控制值 = A方贡献 - B方贡献,每来源的贡献可追溯。
//  4. 控制值为 0 → 平局保留原控制方,占领进度清零;
//     同一方连续两回合领先 → 占领争夺区。
//  5. 支持撤回一轮:旧回合结果进入归档,便于微调路线后对照。

export type Faction = 'A' | 'B';
export type CellKind = 'normal' | 'blocked' | 'camp' | 'outpost' | 'contested';

export interface CellDef {
  x: number;
  y: number;
  kind: CellKind;
  owner: Faction | null; // 营地/前哨归属
  zone: string | null;   // 争夺区 id
}

export interface Unit {
  id: string;
  faction: Faction;
  x: number;
  y: number;
}

export interface Contribution {
  source: string;
  faction: Faction;
  amount: number;
}

export interface ZoneTurnReport {
  zone: string;
  controlValue: number;          // 正数偏 A,负数偏 B
  contributionsA: Contribution[];
  contributionsB: Contribution[];
  leader: Faction | null;        // null = 平局
  streak: number;                // 当前领先方已连续领先的回合数
  ownerBefore: Faction | null;
  ownerAfter: Faction | null;
  events: string[];
}

export interface TurnRecord {
  turn: number;
  zones: ZoneTurnReport[];
  suppliedOutposts: { A: string[]; B: string[] };
  events: string[];
}

interface ZoneState {
  owner: Faction | null;
  streak: number;
  lastLeader: Faction | null;
}

interface Snapshot {
  units: Unit[];
  marksA: string[];
  marksB: string[];
  zones: Record<string, ZoneState>;
  turn: number;
}

export const RANGE = 5;           // 势力辐射范围(曼哈顿距离)
export const WEIGHTS = { camp: 4, outpost: 3, outpostCut: 1, unit: 2 };
export const CAPTURE_STREAK = 2;  // 连续领先多少回合即占领

const key = (x: number, y: number): string => `${x},${y}`;

export class Game {
  width: number;
  height: number;
  cells = new Map<string, CellDef>();
  units: Unit[] = [];
  marks: Record<Faction, Set<string>> = { A: new Set(), B: new Set() };
  zones = new Map<string, ZoneState>();
  turn = 0;
  history: TurnRecord[] = [];
  archive: TurnRecord[] = []; // 撤回下来的旧结果,保留用于对照
  private snapshots: Snapshot[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  addCell(c: CellDef): void {
    this.cells.set(key(c.x, c.y), c);
    if (c.kind === 'contested' && c.zone && !this.zones.has(c.zone)) {
      this.zones.set(c.zone, { owner: null, streak: 0, lastLeader: null });
    }
  }

  cell(x: number, y: number): CellDef {
    return this.cells.get(key(x, y)) ?? { x, y, kind: 'normal', owner: null, zone: null };
  }

  addUnit(u: Unit): void {
    this.units.push(u);
  }

  mark(f: Faction, x: number, y: number): void {
    this.marks[f].add(key(x, y));
  }

  unitAt(x: number, y: number): Unit | undefined {
    return this.units.find((u) => u.x === x && u.y === y);
  }

  moveUnit(id: string, x: number, y: number): void {
    const u = this.units.find((u) => u.id === id);
    if (!u) throw new Error(`单位不存在: ${id}`);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throw new Error(`越界: (${x},${y})`);
    if (this.cell(x, y).kind === 'blocked') throw new Error(`阻断区不可进入: (${x},${y})`);
    if (this.cell(x, y).kind === 'camp' || this.cell(x, y).kind === 'outpost')
      throw new Error(`建筑格不可进入: (${x},${y})`);
    u.x = x;
    u.y = y;
  }

  /** 格子对 faction 是否可通行(用于补给连通):阻断区不可走;敌方单位站在格子上会切断补给 */
  private passable(x: number, y: number, f: Faction): boolean {
    const c = this.cell(x, y);
    if (c.kind === 'blocked') return false;
    const occ = this.unitAt(x, y);
    if (occ && occ.faction !== f) return false;
    if (c.kind === 'camp' || c.kind === 'outpost') return c.owner === f;
    return this.marks[f].has(key(x, y));
  }

  /** 从营地出发的连通补给集合(BFS),返回可通行的格子 key 集合 */
  suppliedSet(f: Faction): Set<string> {
    const seen = new Set<string>();
    const queue: Array<[number, number]> = [];
    for (const c of this.cells.values()) {
      if (c.kind === 'camp' && c.owner === f) {
        seen.add(key(c.x, c.y));
        queue.push([c.x, c.y]);
      }
    }
    while (queue.length > 0) {
      const [x, y] = queue.pop() as [number, number];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const k = key(nx, ny);
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height || seen.has(k)) continue;
        if (!this.passable(nx, ny, f)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  private sources(f: Faction, supplied: Set<string>) {
    const src: Array<{ name: string; weight: number; x: number; y: number }> = [];
    for (const c of this.cells.values()) {
      if (c.kind === 'camp' && c.owner === f) {
        src.push({ name: `${f}营地(${c.x},${c.y})`, weight: WEIGHTS.camp, x: c.x, y: c.y });
      }
      if (c.kind === 'outpost' && c.owner === f) {
        const ok = supplied.has(key(c.x, c.y));
        src.push({
          name: `${f}前哨(${c.x},${c.y})${ok ? '' : '[断供]'}`,
          weight: ok ? WEIGHTS.outpost : WEIGHTS.outpostCut,
          x: c.x,
          y: c.y,
        });
      }
    }
    for (const u of this.units) {
      if (u.faction === f) src.push({ name: `${f}单位${u.id}(${u.x},${u.y})`, weight: WEIGHTS.unit, x: u.x, y: u.y });
    }
    return src;
  }

  /** 结束当前回合:标记落点 → 计算补给 → 汇总控制值 → 应用平局保留/两回合占领规则 */
  endTurn(): TurnRecord {
    this.snapshots.push(this.snapshot());
    this.turn += 1;

    // 单位落脚即标记格子
    for (const u of this.units) this.marks[u.faction].add(key(u.x, u.y));

    const supA = this.suppliedSet('A');
    const supB = this.suppliedSet('B');
    const srcA = this.sources('A', supA);
    const srcB = this.sources('B', supB);

    const record: TurnRecord = {
      turn: this.turn,
      zones: [],
      suppliedOutposts: { A: this.outpostNames('A', supA), B: this.outpostNames('B', supB) },
      events: [],
    };

    for (const [zid, z] of this.zones) {
      const zoneCells = [...this.cells.values()].filter((c) => c.zone === zid);
      const cA = new Map<string, Contribution>();
      const cB = new Map<string, Contribution>();
      let sumA = 0;
      let sumB = 0;
      const acc = (map: Map<string, Contribution>, name: string, f: Faction, amount: number) => {
        const cur = map.get(name);
        if (cur) cur.amount += amount;
        else map.set(name, { source: name, faction: f, amount });
      };
      for (const cell of zoneCells) {
        for (const s of srcA) {
          const d = Math.abs(s.x - cell.x) + Math.abs(s.y - cell.y);
          if (d <= RANGE) {
            const a = s.weight * (RANGE + 1 - d);
            sumA += a;
            acc(cA, s.name, 'A', a);
          }
        }
        for (const s of srcB) {
          const d = Math.abs(s.x - cell.x) + Math.abs(s.y - cell.y);
          if (d <= RANGE) {
            const a = s.weight * (RANGE + 1 - d);
            sumB += a;
            acc(cB, s.name, 'B', a);
          }
        }
      }

      const cv = sumA - sumB;
      const leader: Faction | null = cv > 0 ? 'A' : cv < 0 ? 'B' : null;
      const ownerBefore = z.owner;
      const events: string[] = [];

      if (leader === null) {
        // 平局保留:控制方不变,占领进度清零
        z.streak = 0;
        z.lastLeader = null;
        events.push(`控制值持平(0),平局保留原控制方[${z.owner ?? '无人'}],占领进度清零`);
      } else {
        z.streak = leader === z.lastLeader ? z.streak + 1 : 1;
        z.lastLeader = leader;
        events.push(`${leader}方领先(控制值${cv > 0 ? '+' : ''}${cv}),连续第${z.streak}回合`);
        if (z.streak >= CAPTURE_STREAK && z.owner !== leader) {
          z.owner = leader;
          events.push(`★ ${leader}方连续${CAPTURE_STREAK}回合领先,占领争夺区${zid}`);
        }
      }

      record.zones.push({
        zone: zid,
        controlValue: cv,
        contributionsA: [...cA.values()].sort((a, b) => b.amount - a.amount),
        contributionsB: [...cB.values()].sort((a, b) => b.amount - a.amount),
        leader,
        streak: z.streak,
        ownerBefore,
        ownerAfter: z.owner,
        events,
      });
      for (const e of events) record.events.push(`[${zid}] ${e}`);
    }

    this.history.push(record);
    return record;
  }

  /** 撤回一轮:弹出最近回合结果存入归档(旧结果保留),状态回到该回合之前 */
  undo(): TurnRecord | null {
    const rec = this.history.pop();
    if (!rec) return null;
    this.archive.push(rec);
    const s = this.snapshots.pop();
    if (s) this.restore(s);
    return rec;
  }

  private outpostNames(f: Faction, supplied: Set<string>): string[] {
    const names: string[] = [];
    for (const c of this.cells.values()) {
      if (c.kind === 'outpost' && c.owner === f && supplied.has(key(c.x, c.y))) {
        names.push(`${f}前哨(${c.x},${c.y})`);
      }
    }
    return names;
  }

  private snapshot(): Snapshot {
    const zones: Record<string, ZoneState> = {};
    for (const [id, z] of this.zones) zones[id] = { ...z };
    return {
      units: this.units.map((u) => ({ ...u })),
      marksA: [...this.marks.A],
      marksB: [...this.marks.B],
      zones,
      turn: this.turn,
    };
  }

  private restore(s: Snapshot): void {
    this.units = s.units.map((u) => ({ ...u }));
    this.marks = { A: new Set(s.marksA), B: new Set(s.marksB) };
    this.zones = new Map(Object.entries(s.zones).map(([id, z]) => [id, { ...z }]));
    this.turn = s.turn;
  }
}
