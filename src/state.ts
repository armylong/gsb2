import type { Timeline } from './types';
import { MAX_FREQ, dbToGain } from './types';
import { defaultTimeline } from './presets';

export interface AppState {
  f0: number;
  noiseMix: number;
  duration: number;
  timeline: Timeline;
  /** 当前编辑的节点下标（0/1/2） */
  selectedNode: number;
  /** 试听/分析光标位置 0..1 */
  cursor: number;
  normalize: boolean;
  targetDb: number;
  masterDb: number;
  seed: number;
}

export function defaultState(): AppState {
  return {
    f0: 120,
    noiseMix: 0.05,
    duration: 1.6,
    timeline: defaultTimeline(),
    selectedNode: 0,
    cursor: 0.25,
    normalize: true,
    targetDb: -18,
    masterDb: 0,
    seed: 20261128,
  };
}

/** 极简发布订阅 store */
type Listener = () => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 用 mutator 修改状态后统一通知，UI 只在通知时重绘 */
  update(mutator: (s: AppState) => void): void {
    mutator(this.state);
    this.listeners.forEach((fn) => fn());
  }

  get targetRms(): number | null {
    return this.state.normalize ? dbToGain(this.state.targetDb) : null;
  }
}

export { MAX_FREQ };
