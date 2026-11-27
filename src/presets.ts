import type { FormantRegion, Timeline, VowelKey } from './types';

const f = (center: number, bandwidth: number, gain = 1): FormantRegion => ({ center, bandwidth, gain });

/**
 * 两组以上能听出差别的元音起点（参考 Peterson & Barney 成人男声均值，单位 Hz）。
 * /i/ 的 F2 很高，/a/ 的 F1 很高，/u/ 的 F2 很低，三者对比明显。
 */
export const VOWEL_PRESETS: Record<string, { label: string; formants: VowelKey['formants'] }> = {
  i: {
    label: '/i/（“衣”）',
    formants: [f(270, 70), f(2290, 90), f(3010, 140, 0.6)],
  },
  a: {
    label: '/a/（“啊”）',
    formants: [f(730, 90), f(1090, 100), f(2440, 140, 0.6)],
  },
  u: {
    label: '/u/（“乌”）',
    formants: [f(300, 70), f(870, 80), f(2240, 140, 0.5)],
  },
};

export const NODE_LABELS = ['起点', '拐点', '终点'];

function key(pos: number, label: string, vowel: keyof typeof VOWEL_PRESETS): VowelKey {
  return { pos, label, formants: VOWEL_PRESETS[vowel].formants.map((r: FormantRegion) => ({ ...r })) as VowelKey['formants'] };
}

export interface Example {
  name: string;
  description: string;
  f0: number;
  noiseMix: number;
  duration: number;
  middleEnabled: boolean;
  middlePos: number;
  keys: VowelKey[];
}

/** 例子 1：静止口形 —— 三个节点同为 /a/，共振位置不动 */
export function staticExample(): Example {
  return {
    name: '静止口形 /a/',
    description: '三个节点同为 /a/，全程只有稳定元音，没有口形运动。',
    f0: 120,
    noiseMix: 0.05,
    duration: 1.2,
    middleEnabled: true,
    middlePos: 0.5,
    keys: [key(0, NODE_LABELS[0], 'a'), key(0.5, NODE_LABELS[1], 'a'), key(1, NODE_LABELS[2], 'a')],
  };
}

/** 例子 2：口形渐变 —— /i/ 经拐点 /u/ 滑到 /a/，F1/F2 大幅摆动 */
export function glideExample(): Example {
  return {
    name: '口形渐变 /i/→/u/→/a/',
    description: '共振中心沿对数频率连续滑动，基频恒定，模拟口形从“衣”经“乌”到“啊”。',
    f0: 120,
    noiseMix: 0.05,
    duration: 1.6,
    middleEnabled: true,
    middlePos: 0.5,
    keys: [key(0, NODE_LABELS[0], 'i'), key(0.5, NODE_LABELS[1], 'u'), key(1, NODE_LABELS[2], 'a')],
  };
}

/** 例子 3：掺入气音 —— 静止 /a/ 但噪声比例高，演示无音高声源的混入与回读提示 */
export function breathyExample(): Example {
  return {
    name: '掺入气音的 /a/',
    description: '浊音之外混入 45% 白噪声，听感带气声；回读会提示峰清晰度下降。',
    f0: 110,
    noiseMix: 0.45,
    duration: 1.4,
    middleEnabled: false,
    middlePos: 0.5,
    keys: [key(0, NODE_LABELS[0], 'a'), key(0.5, NODE_LABELS[1], 'a'), key(1, NODE_LABELS[2], 'a')],
  };
}

export const EXAMPLES = [staticExample, glideExample, breathyExample];

export function defaultTimeline(): Timeline {
  return {
    middleEnabled: true,
    middlePos: 0.5,
    keys: [key(0, NODE_LABELS[0], 'i'), key(0.5, NODE_LABELS[1], 'u'), key(1, NODE_LABELS[2], 'a')],
  };
}
