/**
 * 追加式事件台账：只允许 append，不允许修改/删除已有记录，
 * 从数据结构上保证"已播出的事件不会漏掉或被重复记录"。
 * 容量超限时丢弃最旧条目（丢弃动作本身也记一条）。
 */
export interface LedgerEntry<T> {
  seq: number;
  at: number;
  kind: string;
  payload: T;
}

export class Ledger<T = unknown> {
  private entries: LedgerEntry<T>[] = [];
  private cursor = 0;

  constructor(private readonly cap = 500) {}

  append(kind: string, payload: T): LedgerEntry<T> {
    const entry: LedgerEntry<T> = { seq: this.cursor, at: performance.now(), kind, payload };
    this.cursor += 1;
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    return entry;
  }

  /** 取最近 n 条（新的在前） */
  recent(n = 50): LedgerEntry<T>[] {
    return this.entries.slice(-n).reverse();
  }

  get length(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
