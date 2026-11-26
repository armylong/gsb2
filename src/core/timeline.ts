import type {
  BarInfo,
  ClickEvent,
  ClickKind,
  Project,
  Segment,
} from './types';

let idCounter = 0;
export function makeId(prefix = 'seg'): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** 满小节的四分音符数: 拍号 6/8 => 3 个四分音符 */
export function barQuarters(meter: { numerator: number; denominator: number }): number {
  return (4 * meter.numerator) / meter.denominator;
}

export interface SegmentSpan {
  segment: Segment;
  qStart: number;
  qEnd: number;
}

/** 展开各段的 q 坐标区间。段与段首尾相接, 每段 = 其小节四分音符之和。 */
export function computeSegmentSpans(segments: Segment[]): SegmentSpan[] {
  let q = 0;
  return segments.map((segment) => {
    const full = barQuarters(segment.meter);
    const pickup = segment.pickupBeats > 0 ? segment.pickupBeats : 0;
    if (pickup > full) {
      throw new Error(`段「${segment.label}」的弱起拍数 ${pickup} 超过小节容量 ${full}`);
    }
    const total = full * (segment.bars - 1) + (pickup > 0 ? pickup : full);
    const span: SegmentSpan = { segment, qStart: q, qEnd: q + total };
    q += total;
    return span;
  });
}

/** 展开所有小节 (含弱起小节), 并给出显示用小节号 */
export function computeBars(segments: Segment[]): BarInfo[] {
  const bars: BarInfo[] = [];
  let q = 0;
  let displayNumber = 1;
  segments.forEach((segment, si) => {
    const full = barQuarters(segment.meter);
    const pickup = segment.pickupBeats > 0 ? segment.pickupBeats : 0;
    for (let b = 0; b < segment.bars; b++) {
      const isPickup = b === 0 && pickup > 0;
      const quarters = isPickup ? pickup : full;
      bars.push({
        index: bars.length,
        segmentId: segment.id,
        segmentIndex: si,
        barNumber: isPickup ? 0 : displayNumber,
        isPickup,
        qStart: q,
        qEnd: q + quarters,
        quarters,
        meter: segment.meter,
      });
      q += quarters;
      if (!isPickup) displayNumber += 1;
    }
  });
  return bars;
}

/** 恒定段: t(q) = (q-q0)/bpm * 60 */
function constantT(q: number, q0: number, t0: number, bpm: number): number {
  return t0 + ((q - q0) / bpm) * 60;
}

/**
 * 线性渐变段 (BPM 对 q 线性):
 *   bpm(q) = b0 + (b1-b0)(q-q0)/L
 *   t(q)  = t0 + 60L/(b1-b0) * ln(bpm(q)/b0)
 * b0 == b1 时退化为恒定公式。
 */
function rampT(q: number, q0: number, t0: number, L: number, b0: number, b1: number): number {
  if (Math.abs(b1 - b0) < 1e-9) {
    return t0 + ((q - q0) / b0) * 60;
  }
  const bpmAt = b0 + ((b1 - b0) * (q - q0)) / L;
  return t0 + ((60 * L) / (b1 - b0)) * Math.log(bpmAt / b0);
}

export class Timeline {
  readonly spans: SegmentSpan[];
  readonly bars: BarInfo[];
  readonly totalQ: number;

  constructor(project: Project) {
    this.spans = computeSegmentSpans(project.segments);
    this.bars = computeBars(project.segments);
    this.totalQ = this.spans.length ? this.spans[this.spans.length - 1].qEnd : 0;
  }

  private spanAt(q: number): SegmentSpan {
    const spans = this.spans;
    if (spans.length === 0) throw new Error('工程为空');
    // 末段终点也归入末段
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (q <= s.qEnd + 1e-9) return s;
    }
    return spans[spans.length - 1];
  }

  /** 四分音符坐标 -> 秒 (音频时间)。这是全应用唯一的 q→t 换算。 */
  qToTime(q: number): number {
    const span = this.spanAt(q);
    const { segment, qStart, qEnd } = span;
    const t0 = this.segmentStartTime(span);
    if (segment.mode === 'constant') {
      return constantT(q, qStart, t0, segment.bpmStart);
    }
    return rampT(q, qStart, t0, qEnd - qStart, segment.bpmStart, segment.bpmEnd);
  }

  /** 各段起点秒数: 前段终点时间即本段起点时间 (变速在边界处突变/渐变交接, 时间连续) */
  segmentStartTime(span: SegmentSpan): number {
    const idx = this.spans.indexOf(span);
    if (idx <= 0) return 0;
    const prev = this.spans[idx - 1];
    return this.qToTime(prev.qEnd);
  }

  /** 二分查找: 秒 -> q, 用于把播放头音频时间映射回表上拍点位置 */
  timeToQ(t: number): number {
    if (t <= 0) return 0;
    const totalT = this.totalTime;
    if (t >= totalT) return this.totalQ;
    let lo = 0;
    let hi = this.totalQ;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (this.qToTime(mid) < t) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  get totalTime(): number {
    return this.totalQ > 0 ? this.qToTime(this.totalQ) : 0;
  }

  barAt(q: number): BarInfo {
    const bars = this.bars;
    for (let i = 0; i < bars.length; i++) {
      if (q < bars[i].qEnd - 1e-9 || i === bars.length - 1) return bars[i];
    }
    return bars[bars.length - 1];
  }

  /**
   * 生成全时间线 (或 [qFrom, qTo] 区间) 的拍点/分拍事件。
   * q 网格由拍号决定, 与速度完全解耦: 渐变段中间开始也能精确落在拍点上。
   */
  buildEvents(qFrom = 0, qTo = this.totalQ): ClickEvent[] {
    const events: ClickEvent[] = [];
    const eps = 1e-9;
    for (const bar of this.bars) {
      if (bar.qEnd <= qFrom - eps || bar.qStart > qTo + eps) continue;
      const span = this.spans[bar.segmentIndex];
      const sub = Math.max(1, Math.round(span.segment.subdivision));
      const step = 1 / sub;
      const nSlots = Math.round(bar.quarters * sub);
      for (let k = 0; k <= nSlots; k++) {
        const q = bar.qStart + k * step;
        // 左闭右开: 右端点是下一区域的首拍, 绝不纳入 (防止边界拍多发)
        if (q < qFrom - eps || q >= qTo - eps) continue;
        const isWhole = k % sub === 0;
        const beatInBar = k / sub + 1;
        let kind: ClickKind;
        if (isWhole) {
          kind = k === 0 ? 'downbeat' : 'beat';
        } else {
          kind = 'sub';
        }
        events.push({
          q: roundQ(q),
          t: this.qToTime(q),
          kind,
          segmentId: bar.segmentId,
          barIndex: bar.index,
          beatInBar,
          isSegmentStart: Math.abs(q - span.qStart) < eps,
          isPickup: bar.isPickup,
          parentBeatQ: roundQ(bar.qStart + Math.floor(k / sub)),
        });
      }
    }
    // 相邻小节首尾是同一个 q, 去重并保留更"强"的类型与段首标记
    const byQ = new Map<number, ClickEvent>();
    for (const ev of events) {
      const prev = byQ.get(ev.q);
      if (!prev) {
        byQ.set(ev.q, ev);
      } else {
        const stronger = rank(ev.kind) > rank(prev.kind) ? ev : prev;
        byQ.set(ev.q, {
          ...stronger,
          isSegmentStart: prev.isSegmentStart || ev.isSegmentStart,
        });
      }
    }
    return [...byQ.values()].sort((a, b) => a.q - b.q);
  }
}

function rank(kind: ClickKind): number {
  return kind === 'downbeat' ? 3 : kind === 'beat' ? 2 : 1;
}

/** 避免 1/3 连音产生浮点垃圾, 保留 6 位小数 (1/64 分拍也够用) */
export function roundQ(q: number): number {
  return Math.round(q * 1e6) / 1e6;
}
