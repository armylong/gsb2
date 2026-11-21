import { HEIGHT, WIDTH, compareKeys, inBounds, keyOf, parseKey } from './grid.ts';
import type { Medium } from './units.ts';

export type VentMedium = Medium | 'both';

export interface WallContent {
  kind: 'wall';
}

export interface SourceContent {
  kind: 'source';
  medium: Medium;
  /** 每轮排放量，mHU / mFU 整数。 */
  amount: number;
}

export interface VentContent {
  kind: 'vent';
  medium: VentMedium;
  open: boolean;
}

export type CellContent = WallContent | SourceContent | VentContent;

export interface ValveRecord {
  /** 规范化后：a 在 row-major 序中位于 b 之前。 */
  a: string;
  b: string;
  /** 是否允许 a -> b；反向仅在该边没有单向阀时允许。 */
  allowAtoB: boolean;
}

export const SOURCE_DEFAULT_AMOUNT: Record<Medium, number> = {
  heat: 6_000,
  fog: 4_000,
};

export function edgeKey(a: string, b: string): string {
  return compareKeys(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`;
}

function contentDescriptor(content: CellContent): string {
  switch (content.kind) {
    case 'wall':
      return 'wall';
    case 'source':
      return `src:${content.medium}:${content.amount}`;
    case 'vent':
      return `vent:${content.medium}:${content.open ? 'open' : 'shut'}`;
  }
}

/**
 * 布局 = “每格内容” + “每条边单向阀”的集合，不含任何编辑操作顺序。
 * getValves / sortedCells 都按固定顺序排序，serialize / hash 因此只由最终布局决定：
 * 同一布局无论以何种编辑顺序搭建，字符串、哈希和演算结果都完全一致。
 */
export class Layout {
  readonly width: number;
  readonly height: number;
  private readonly cells = new Map<string, CellContent>();
  private readonly valves = new Map<string, ValveRecord>();

  constructor(width = WIDTH, height = HEIGHT) {
    this.width = width;
    this.height = height;
  }

  clone(): Layout {
    const next = new Layout(this.width, this.height);
    for (const [key, content] of this.cells) next.cells.set(key, { ...content });
    for (const [key, valve] of this.valves) next.valves.set(key, { ...valve });
    return next;
  }

  getCell(x: number, y: number): CellContent | undefined {
    return this.cells.get(keyOf(x, y));
  }

  getCellByKey(key: string): CellContent | undefined {
    return this.cells.get(key);
  }

  isInBounds(x: number, y: number): boolean {
    return inBounds(x, y, this.width, this.height);
  }

  setCell(x: number, y: number, content: CellContent | null): this {
    if (!this.isInBounds(x, y)) throw new Error(`格子越界: ${x},${y}`);
    const key = keyOf(x, y);
    if (content === null) {
      this.cells.delete(key);
      return this;
    }
    if (content.kind === 'source') {
      if (!Number.isInteger(content.amount) || content.amount <= 0) {
        throw new Error('热源 / 雾源排放量必须是正整数（内部 m 单位）');
      }
    }
    this.cells.set(key, { ...content });
    return this;
  }

  removeCell(x: number, y: number): this {
    return this.setCell(x, y, null);
  }

  setValve(a: string, b: string, allowAtoB: boolean | null): this {
    const pa = parseKey(a);
    const pb = parseKey(b);
    if (Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) !== 1) {
      throw new Error('单向阀只能放在上下左右相邻的两格之间');
    }
    const key = edgeKey(a, b);
    if (allowAtoB === null) {
      this.valves.delete(key);
      return this;
    }
    const first = compareKeys(a, b) < 0 ? a : b;
    const second = first === a ? b : a;
    this.valves.set(key, { a: first, b: second, allowAtoB: first === a ? allowAtoB : !allowAtoB });
    return this;
  }

  getValve(a: string, b: string): ValveRecord | undefined {
    return this.valves.get(edgeKey(a, b));
  }

  getValves(): ValveRecord[] {
    return [...this.valves.values()].sort(
      (v1, v2) => compareKeys(v1.a, v2.a) || compareKeys(v1.b, v2.b),
    );
  }

  valvesAt(cell: string): ValveRecord[] {
    return this.getValves().filter((v) => v.a === cell || v.b === cell);
  }

  /** 墙不可通行；风口无论开关都可通行，开关只决定是否向界外释放。 */
  isPassable(x: number, y: number): boolean {
    return this.getCell(x, y)?.kind !== 'wall';
  }

  sortedCells(): Array<{ key: string; x: number; y: number; content: CellContent }> {
    return [...this.cells.entries()]
      .map(([key, content]) => {
        const { x, y } = parseKey(key);
        return { key, x, y, content };
      })
      .sort((c1, c2) => compareKeys(c1.key, c2.key));
  }

  /** 布局的规范序列化，是哈希的唯一输入。 */
  serialize(): string {
    const cells = this.sortedCells().map(
      ({ key, content }) => `${key}=${contentDescriptor(content)}`,
    );
    const valves = this.getValves().map(
      (valve) => `${valve.a}>${valve.b}:${valve.allowAtoB ? '1' : '0'}`,
    );
    return `layout-v1\ncells:${cells.join(';')}\nvalves:${valves.join(';')}`;
  }

  hash(): string {
    return fnv1a(this.serialize());
  }
}

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type Edit =
  | { kind: 'cell'; x: number; y: number; content: CellContent | null }
  | { kind: 'valve'; a: string; b: string; allowAtoB: boolean | null };

export function applyEdits(layout: Layout, edits: readonly Edit[]): Layout {
  for (const edit of edits) {
    if (edit.kind === 'cell') layout.setCell(edit.x, edit.y, edit.content);
    else layout.setValve(edit.a, edit.b, edit.allowAtoB);
  }
  return layout;
}

export function buildLayout(edits: readonly Edit[], width = WIDTH, height = HEIGHT): Layout {
  return applyEdits(new Layout(width, height), edits);
}

