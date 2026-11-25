/**
 * 按键序列模型。
 *
 * 序列由带精确时刻（秒）的事件组成，时刻可重复（同一时刻按下+松开，
 * 即零时长音），事件按时刻排序后逐采样调度，所以暂停后重新试听时
 * 各触发点完全一致。
 */
import type { TimbreParams } from './types';

export type SequenceEventType = 'noteOn' | 'noteOff' | 'paramChange';

export interface SequenceEvent {
  id: string;
  /** 相对序列起点的时刻（秒） */
  time: number;
  type: SequenceEventType;
  /** noteOn 的力度 [0,1]，其他事件忽略 */
  velocity?: number;
  /** 仅 paramChange：目标参数 */
  params?: TimbreParams;
  /** 仅 paramChange：pending=下一次 noteOn 生效；live=当前声音平滑过渡 */
  mode?: 'pending' | 'live';
}

export interface KeySequence {
  name: string;
  events: SequenceEvent[];
}

let idCounter = 0;
export function nextEventId(): string {
  idCounter += 1;
  return `ev-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 事件按时刻排序；同时刻固定按 noteOn → noteOff → paramChange 处理。 */
export function sortedEvents(events: SequenceEvent[]): SequenceEvent[] {
  const order: Record<SequenceEventType, number> = {
    noteOn: 0,
    noteOff: 1,
    paramChange: 2,
  };
  return [...events].sort((a, b) =>
    a.time !== b.time ? a.time - b.time : order[a.type] - order[b.type],
  );
}

/** 序列最后一个事件的时刻。 */
export function lastEventTime(seq: KeySequence): number {
  return seq.events.reduce((m, e) => Math.max(m, e.time), 0);
}
