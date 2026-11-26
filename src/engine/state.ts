import { Board } from './board';
import type { LevelDef, Marker, ProbeAction, ProbeRecord, ProbeType, Direction, Cell } from '../types';

export type Mode = 'line' | 'adjacency' | 'mark-safe' | 'mark-void' | 'mark-unknown' | 'path';

export interface HintResult {
  cell: Cell;
  solid: 0 | 1;
  recordIds: number[];
}

const STORAGE_PREFIX = 'floor-probe/v1/';

interface Persisted {
  records: ProbeRecord[];
  markers: Record<string, Marker>;
  path: Cell[];
  direction: Direction;
  revealed: boolean;
}

export class GameState {
  readonly level: LevelDef;
  readonly board: Board;
  records: ProbeRecord[] = [];
  markers = new Map<string, Marker>();
  path: Cell[] = [];
  direction: Direction = 'right';
  /** 交卷后是否已揭开底图 */
  revealed = false;
  /** 当前在历史区选中的读数（用于在棋盘上重看覆盖区域），-1 表示不高亮 */
  selectedRecordId = -1;
  private nextId = 1;

  constructor(level: LevelDef) {
    this.level = level;
    this.board = new Board(level.rows);
    this.load();
  }

  // ---- 次数 ----
  used(type: ProbeType): number {
    return this.records.filter((r) => r.type === type).length;
  }
  remaining(type: ProbeType): number {
    const budget = type === 'line' ? this.level.lineBudget : this.level.adjacencyBudget;
    return budget - this.used(type);
  }

  // ---- 探头 ----
  canPlace(action: ProbeAction): { ok: boolean; reason?: string } {
    if (this.revealed) return { ok: false, reason: '已经交卷，重开后才能继续探测' };
    if (!this.board.isOpen(action.r, action.c))
      return { ok: false, reason: '探头只能放在非墙格上' };
    if (this.remaining(action.type) <= 0)
      return { ok: false, reason: action.type === 'line' ? '方向探头次数用完了' : '邻域探头次数用完了' };
    if (action.type === 'line' && !action.dir) return { ok: false, reason: '方向探头缺少方向' };
    return { ok: true };
  }

  place(action: ProbeAction): ProbeRecord {
    const check = this.canPlace(action);
    if (!check.ok) throw new Error(check.reason);
    const rec = this.board.probe(action, this.nextId++);
    this.records.push(rec);
    this.selectedRecordId = rec.id;
    this.save();
    return rec;
  }

  // ---- 标记（改标记不消耗探头） ----
  markerAt(r: number, c: number): Marker | undefined {
    return this.markers.get(`${r},${c}`);
  }

  setMarker(r: number, c: number, marker: Marker): void {
    if (!this.board.isOpen(r, c)) return;
    const key = `${r},${c}`;
    if (this.markers.get(key) === marker) this.markers.delete(key);
    else this.markers.set(key, marker);
    this.save();
  }

  clearMarker(r: number, c: number): void {
    this.markers.delete(`${r},${c}`);
    this.save();
  }

  // ---- 通路草稿（相邻格连成的路，允许回头/重复） ----
  togglePathCell(r: number, c: number): void {
    if (!this.board.isOpen(r, c)) return;
    const idx = this.path.findIndex((p) => p.r === r && p.c === c);
    if (idx >= 0) {
      // 点已在路上：截到该格（方便画错时回退），点末尾则相当于撤销最后一格
      this.path = this.path.slice(0, idx);
    } else {
      const last = this.path[this.path.length - 1];
      if (last && Math.abs(last.r - r) + Math.abs(last.c - c) !== 1) return; // 必须与路尾相邻
      this.path.push({ r, c });
    }
    this.save();
  }

  clearPath(): void {
    this.path = [];
    this.save();
  }

  // ---- 交卷 ----
  submit(): { ok: boolean; reason?: string } {
    const result = this.board.checkPath(this.path, this.level.entry, this.level.exit);
    this.revealed = true;
    this.save();
    return result;
  }

  /** 重开本关：保留同一张底图（关卡布局固定），只清掉玩家操作 */
  restart(): void {
    this.records = [];
    this.markers.clear();
    this.path = [];
    this.revealed = false;
    this.selectedRecordId = -1;
    this.nextId = 1;
    localStorage.removeItem(STORAGE_PREFIX + this.level.id);
  }

  // ---- 持久化 ----
  private save(): void {
    const data: Persisted = {
      records: this.records,
      markers: Object.fromEntries(this.markers),
      path: this.path,
      direction: this.direction,
      revealed: this.revealed,
    };
    localStorage.setItem(STORAGE_PREFIX + this.level.id, JSON.stringify(data));
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + this.level.id);
      if (!raw) return;
      const data = JSON.parse(raw) as Persisted;
      this.records = data.records ?? [];
      this.markers = new Map(Object.entries(data.markers ?? {}));
      this.path = data.path ?? [];
      this.direction = data.direction ?? 'right';
      this.revealed = data.revealed ?? false;
      this.nextId = this.records.reduce((m, r) => Math.max(m, r.id + 1), 1);
    } catch {
      // 存档损坏时按新开局处理
    }
  }
}
