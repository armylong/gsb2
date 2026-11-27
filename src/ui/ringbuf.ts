/**
 * 固定容量的滚动环形缓冲，保存最近若干秒的逐样本（降采样后）数据。
 * 单生产者（音频消息回调）单消费者（rAF 绘图），均在主线程，无需锁。
 */
export class RingBuffer {
  readonly capacity: number;
  private data: Float32Array;
  private head = 0;
  private filled = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  push(src: Float32Array) {
    const n = src.length;
    if (n >= this.capacity) {
      this.data.set(src.subarray(n - this.capacity));
      this.head = 0;
      this.filled = this.capacity;
      return;
    }
    const first = this.capacity - this.head;
    if (n <= first) {
      this.data.set(src, this.head);
    } else {
      this.data.set(src.subarray(0, first), this.head);
      this.data.set(src.subarray(first), 0);
    }
    this.head = (this.head + n) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + n);
  }

  /** 按时间先后把当前内容拷出（最旧 → 最新） */
  snapshot(): Float32Array {
    const out = new Float32Array(this.filled);
    if (this.filled < this.capacity) {
      out.set(this.data.subarray(0, this.filled));
      return out;
    }
    const first = this.capacity - this.head;
    out.set(this.data.subarray(this.head), 0);
    out.set(this.data.subarray(0, this.head), first);
    return out;
  }

  get length(): number {
    return this.filled;
  }

  clear() {
    this.head = 0;
    this.filled = 0;
    this.data.fill(0);
  }
}

/** 一组同名多通道环形缓冲 */
export class MultiRing {
  private rings: RingBuffer[];
  constructor(channels: number, capacity: number) {
    this.rings = Array.from({ length: channels }, () => new RingBuffer(capacity));
  }
  push(blocks: Float32Array[]) {
    blocks.forEach((b, i) => this.rings[i].push(b));
  }
  snapshots(): Float32Array[] {
    return this.rings.map((r) => r.snapshot());
  }
  clear() {
    this.rings.forEach((r) => r.clear());
  }
}
