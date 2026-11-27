import type { RouteMode } from './dsp/kernel';

export interface Preset {
  id: 'same' | 'small' | 'sweep';
  name: string;
  freqs: [number, number];
  gains: [number, number];
  startPhase: [number, number];
  mode: RouteMode;
  description: string;
}

/** 三组课堂设置；startPhase 固定为 0，保证可在同样起点相位重复试听核对 */
export const PRESETS: Record<Preset['id'], Preset> = {
  same: {
    id: 'same',
    name: '相同频率',
    freqs: [440, 440],
    gains: [0.2, 0.2],
    startPhase: [0, 0],
    mode: 'split',
    description: '两路同频同相：包络恒定，拍动停止；相位差为水平直线。',
  },
  small: {
    id: 'small',
    name: '很小频差',
    freqs: [440, 442],
    gains: [0.2, 0.2],
    startPhase: [0, 0],
    mode: 'split',
    description: '2 Hz 频差 → 每秒 2 次拍；缓慢拉动 B 频率可看到拍变快/变慢。',
  },
  sweep: {
    id: 'sweep',
    name: '扫过另一路',
    freqs: [440, 432],
    gains: [0.2, 0.2],
    startPhase: [0, 0],
    mode: 'split',
    description: 'B 从 432 线性扫到 448，穿越 A=440：穿越点拍频为零，两侧拍频对称回升。',
  },
};

/** 扫频预设的轨迹：B 从 432→448，A 恒定 440 */
export const SWEEP_RANGE: [number, number] = [432, 448];
export const SWEEP_A = 440;
