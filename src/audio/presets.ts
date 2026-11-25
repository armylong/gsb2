/**
 * 内置检查示例。每个示例带自己的音色快照，载入即得到可复现的场景。
 */
import type { TimbreParams } from './types';
import { DEFAULT_TIMBRE } from './types';
import type { KeySequence } from './sequence';
import { nextEventId } from './sequence';

export interface Preset {
  id: string;
  description: string;
  timbre: TimbreParams;
  sequence: KeySequence;
}

const on = (time: number, velocity = 1) => ({
  id: nextEventId(),
  time,
  type: 'noteOn' as const,
  velocity,
});
const off = (time: number) => ({ id: nextEventId(), time, type: 'noteOff' as const });

function timbre(overrides: Partial<TimbreParams['envelope']> = {}): TimbreParams {
  return {
    ...DEFAULT_TIMBRE,
    envelope: { ...DEFAULT_TIMBRE.envelope, ...overrides },
  };
}

export const PRESETS: Preset[] = [
  {
    id: 'staccato',
    description: '断音：在起音/衰减途中就松开，验证提前松键的 release 从当前电平起步',
    timbre: timbre({ attack: 0.25, decay: 0.3, sustain: 0.5, release: 0.3 }),
    sequence: {
      name: '断音（提前松开）',
      events: [on(0.2, 0.9), off(0.42)],
    },
  },
  {
    id: 'full-sustain',
    description: '保持后松开：完整走完 attack→decay→sustain，再进 release',
    timbre: timbre({ attack: 0.08, decay: 0.18, sustain: 0.45, release: 0.35 }),
    sequence: {
      name: '保持后松开',
      events: [on(0.2, 0.9), off(1.1)],
    },
  },
  {
    id: 'retrigger',
    description: '刚松开又按下：release 途中重新 noteOn，从当前电平重新起音',
    timbre: timbre({ attack: 0.06, decay: 0.2, sustain: 0.4, release: 0.5 }),
    sequence: {
      name: '刚松开又按下',
      events: [on(0.2, 0.9), off(0.55), on(0.68, 0.9), off(1.3)],
    },
  },
  {
    id: 'soft-long-loud-short',
    description:
      '弱长音接强短音：弱力度长音保持中，强力度短音再触发；验证不同力度的叠加与重触发',
    timbre: timbre({ attack: 0.05, decay: 0.25, sustain: 0.5, release: 0.4 }),
    sequence: {
      name: '弱长音接强短音',
      events: [
        on(0.2, 0.3), // 弱长音按下
        on(0.95, 1.0), // 保持中强音再触发
        off(1.12), // 短音松开（单声部即进入 release）
        off(1.5), // 长音逻辑松开点
      ],
    },
  },
  {
    id: 'zero-segments',
    description:
      '零时长验证：attack=0、release=0 的瞬时包络，外加同一时刻按下+松开的零长度音',
    timbre: timbre({ attack: 0, decay: 0.12, sustain: 0.6, release: 0 }),
    sequence: {
      name: '零时长段与零长度音',
      events: [
        on(0.2, 1),
        off(0.2), // 零长度音：同一采样内 noteOn→noteOff
        on(0.55, 1),
        off(1.0),
      ],
    },
  },
];
