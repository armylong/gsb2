import { Grid } from './Grid';
import { labelComponents } from './connectivity';
import { Fragment } from './Fragment';
import { clipToBounds } from './shapes';
import type { Cell, ComponentLabeling, EditResult, Owner } from './types';

/** 单次归属变迁记录，供暂停时检查转出/并入前后的格子归属。 */
export interface TransitionRecord {
  tick: number;
  kind: 'detach' | 'merge';
  fragmentId: number;
  /** detach：转出前的静态格；merge：并入后的静态格（同形，y 不同）。 */
  cells: readonly Cell[];
  /** 该碎片包含的格数（每格只归属一个对象）。 */
  size: number;
}

export interface WorldSnapshot {
  version: 1;
  width: number;
  height: number;
  /** 静态实心布局（ASCII 行），只保存静态地形，不含下落中的碎片。 */
  rows: string[];
}

/** 每个仿真步的下落速度（格/步）。1.0 = 每步一格。 */
const FALL_SPEED = 1;

export class World {
  grid: Grid;
  fragments: Fragment[] = [];
  labeling: ComponentLabeling;
  tick = 0;

  /** 累计挖除/补入格数（统计面板用）。 */
  removedCount = 0;
  addedCount = 0;

  /** 归属变迁历史（保留最近 500 条）。 */
  transitions: TransitionRecord[] = [];
  private readonly maxTransitions = 500;
  private nextFragmentId = 1;

  constructor(grid: Grid) {
    this.grid = grid;
    // 载入即悬空的块立即转为碎片（仍保持静态网格标注供面板展示其来源划分）
    this.detachFloating();
    this.labeling = labelComponents(grid);
  }

  get width(): number {
    return this.grid.width;
  }

  get height(): number {
    return this.grid.height;
  }

  get staticCount(): number {
    return this.grid.countSolid();
  }

  get fragmentCount(): number {
    let n = 0;
    for (const f of this.fragments) n += f.size;
    return n;
  }

  /** 现存格总数 = 静态格 + 碎片格；挖减补增，其余时刻守恒。 */
  get totalCells(): number {
    return this.staticCount + this.fragmentCount;
  }

  // ---------------------------------------------------------------- 编辑

  /**
   * 圆形/矩形挖除与补入的统一入口。
   * - 仅作用于静态地形；被碎片占据的格不参与（补土会跳过，挖除碰不到）。
   * - 形状先按地图边界裁剪，越界部分只统计有效格。
   * - 空洞（空格）不会被当作实心：挖除只对实心格计数，补土只对空格计数。
   * 每次编辑后立即重判连通性，非接地块整体转出为碎片（单次标注，多块不漏）。
   */
  edit(rawCells: readonly Cell[], mode: 'dig' | 'fill'): EditResult {
    const affected = clipToBounds(rawCells, this.width, this.height);
    const fragmentBlocked = new Set<number>();
    for (const f of this.fragments) {
      for (const c of f.occupiedCells()) fragmentBlocked.add(c.y * this.width + c.x);
    }

    let removed = 0;
    let added = 0;
    for (const c of affected) {
      const key = c.y * this.width + c.x;
      if (fragmentBlocked.has(key)) continue; // 下落中的碎片格不参与挖补
      if (mode === 'dig') {
        if (this.grid.solid[c.y][c.x] === 1) {
          this.grid.solid[c.y][c.x] = 0;
          removed++;
        }
      } else {
        if (this.grid.solid[c.y][c.x] === 0) {
          this.grid.solid[c.y][c.x] = 1;
          added++;
        }
      }
    }
    this.removedCount += removed;
    this.addedCount += added;

    if (removed > 0 || added > 0) {
      this.detachFloating();
      this.relabel();
    }
    return { removed, added, affected };
  }

  /**
   * 基于当前网格做一次全量标注，把所有不接地连通块整体转出为碎片。
   * 关键：先标注全部块、再统一删除——同一次切割产生的多块一次性全部识别，
   * 不会因为先移走一块而改变 BFS 结果或漏掉另一块。
   */
  private detachFloating(): void {
    const labeling = labelComponents(this.grid);
    const floating: { id: number; cells: Cell[] }[] = [];

    for (let compId = 1; compId <= labeling.count; compId++) {
      if (labeling.grounded.has(compId)) continue;
      const cells: Cell[] = [];
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          if (labeling.compIdAt[y][x] === compId) cells.push({ x, y });
        }
      }
      floating.push({ id: compId, cells });
    }

    for (const block of floating) {
      for (const c of block.cells) this.grid.solid[c.y][c.x] = 0;
      const fragment = new Fragment(this.nextFragmentId++, block.cells, 0);
      this.fragments.push(fragment);
      this.pushTransition({
        tick: this.tick,
        kind: 'detach',
        fragmentId: fragment.id,
        cells: block.cells.map((c) => ({ ...c })),
        size: block.cells.length,
      });
    }
  }

  private relabel(): void {
    this.labeling = labelComponents(this.grid);
  }

  // ------------------------------------------------------------- 仿真推进

  /** 是否还有碎片在下落。 */
  get isSettled(): boolean {
    return this.fragments.every((f) => this.maxFreeShift(f) === 0);
  }

  /**
   * 单步推进：所有碎片各下落一格（保持原形、不旋转、碎片间不碰撞）。
   * 无法继续下落的碎片停住并整体并入静态网格——逐格写回，不穿透、不重叠。
   * 处理顺序按最低行从低到高，先并入的碎片成为后续碎片的静态支撑。
   * 暂停期间不会调用；继续运行时基于当前网格实时计算，不残留旧支撑判断。
   */
  step(): void {
    this.tick++;
    if (this.fragments.length === 0) return;

    // 先计算每个碎片本步位移（未停住的统一下落 FALL_SPEED）。
    const moves = new Map<Fragment, number>();
    for (const f of this.fragments) {
      const free = this.maxFreeShift(f);
      moves.set(f, free === 0 ? 0 : Math.min(FALL_SPEED, free));
    }

    for (const f of this.fragments) f.drop += moves.get(f)!;

    // 按当前最低行从低到高处理并入，保证先落地者先成为静态格。
    const order = [...this.fragments].sort((a, b) => a.bottom - b.bottom);
    const merged: Fragment[] = [];
    for (const f of order) {
      if (this.maxFreeShift(f) !== 0) continue;
      // 停住时 drop 必为整数：所有目标格当前应为空。
      const target = f.cells.map((c) => ({ x: c.x, y: c.y + f.drop }));
      for (const c of target) {
        if (!this.grid.inBounds(c.x, c.y) || this.grid.solid[c.y][c.x] === 1) {
          throw new Error(`碎片 ${f.id} 并入失败：目标格 (${c.x}, ${c.y}) 不可写入`);
        }
      }
      for (const c of target) this.grid.solid[c.y][c.x] = 1;
      merged.push(f);
      this.pushTransition({
        tick: this.tick,
        kind: 'merge',
        fragmentId: f.id,
        cells: target.map((c) => ({ ...c })),
        size: target.length,
      });
    }

    if (merged.length > 0) {
      const mergedIds = new Set(merged.map((f) => f.id));
      this.fragments = this.fragments.filter((f) => !mergedIds.has(f.id));
      this.relabel();
    }
  }

  /**
   * 碎片还能整体竖直移动多少个完整格而不与静态格/地图底界冲突。
   * 扫描 k = 1, 2, ... 直到任一目标格被占；返回最大合法整数位移。
   * 仅检查静态网格——碎片之间不做碰撞。
   */
  private maxFreeShift(f: Fragment): number {
    let k = 0;
    outer: while (true) {
      const next = k + 1;
      for (const c of f.cells) {
        const ny = c.y + f.drop + next;
        if (ny >= this.height) break outer; // 到底界
        if (this.grid.solid[ny][c.x] === 1) break outer; // 碰到静态格
      }
      k = next;
    }
    return k;
  }

  /** 连续推进直到所有碎片落地（测试用，也可供“快进”按钮使用）。 */
  settle(maxSteps = 10000): number {
    let n = 0;
    while (this.fragments.length > 0 && n < maxSteps) {
      this.step();
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------- 归属查询

  /**
   * 查询某格当前归属：空 / 静态（含连通块编号）/ 碎片（含碎片编号）。
   * 每格在任意时刻只返回唯一归属。
   */
  ownerAt(x: number, y: number): Owner {
    if (!this.grid.inBounds(x, y)) return { kind: 'empty' };
    if (this.grid.solid[y][x] === 1) {
      return { kind: 'static', componentId: this.labeling.compIdAt[y][x] };
    }
    for (const f of this.fragments) {
      for (const c of f.occupiedCells()) {
        if (c.x === x && c.y === y) return { kind: 'fragment', fragmentId: f.id };
      }
    }
    return { kind: 'empty' };
  }

  /** 命中的碎片 id（像素级拾取由渲染层换算后调用），无命中返回 null。 */
  fragmentAt(x: number, y: number): number | null {
    for (const f of this.fragments) {
      for (const c of f.occupiedCells()) {
        if (c.x === x && c.y === y) return f.id;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- 存取与重置

  /** 只保存静态布局；载入后重新标注，得到相同的连通块划分。 */
  serialize(): WorldSnapshot {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      rows: this.grid.toRows(),
    };
  }

  static fromSnapshot(snap: WorldSnapshot): World {
    if (snap.version !== 1) throw new Error('不支持的存档版本');
    const grid = Grid.fromRows(snap.rows);
    if (grid.width !== snap.width || grid.height !== snap.height) {
      throw new Error('存档尺寸与内容不一致');
    }
    return new World(grid);
  }

  /** 用给定静态布局重置：丢弃全部碎片、计数与历史。 */
  resetTo(grid: Grid): void {
    this.grid = grid;
    this.fragments = [];
    this.tick = 0;
    this.removedCount = 0;
    this.addedCount = 0;
    this.transitions = [];
    this.nextFragmentId = 1;
    this.relabel();
  }

  private pushTransition(record: TransitionRecord): void {
    this.transitions.push(record);
    if (this.transitions.length > this.maxTransitions) {
      this.transitions.splice(0, this.transitions.length - this.maxTransitions);
    }
  }
}
