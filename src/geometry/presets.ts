import { IntersectionParams } from './types';

export interface Preset {
  name: string;
  description: string;
  params: IntersectionParams;
}

export const PRESETS: Record<string, Preset> = {
  cross: {
    name: '等宽十字',
    description: '四岔，四路等宽正交',
    params: {
      cornerRadius: 1.5,
      branches: [
        { id: 'A', angleDeg: 0, width: 4, length: 20 },
        { id: 'B', angleDeg: 90, width: 4, length: 20 },
        { id: 'C', angleDeg: 180, width: 4, length: 20 },
        { id: 'D', angleDeg: 270, width: 4, length: 20 },
      ],
    },
  },
  tee: {
    name: '宽窄三岔',
    description: '三岔 T 型，主干宽、支路窄',
    params: {
      cornerRadius: 1.2,
      branches: [
        { id: 'A', angleDeg: 0, width: 6, length: 26 },
        { id: 'B', angleDeg: 90, width: 3, length: 16 },
        { id: 'C', angleDeg: 180, width: 6, length: 26 },
      ],
    },
  },
  skew: {
    name: '斜交四岔',
    description: '四岔斜交，宽度各异',
    params: {
      cornerRadius: 1.0,
      branches: [
        { id: 'A', angleDeg: 0, width: 4.5, length: 22 },
        { id: 'B', angleDeg: 70, width: 3, length: 18 },
        { id: 'C', angleDeg: 185, width: 4, length: 22 },
        { id: 'D', angleDeg: 255, width: 3.5, length: 18 },
      ],
    },
  },
};

export function defaultParams(): IntersectionParams {
  return structuredClone(PRESETS.cross.params);
}
