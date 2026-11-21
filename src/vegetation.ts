import type { Zone } from './terrain';

export interface Exclusion {
  /** 对方植被 id */
  other: string;
  /** 最小切比雪夫距离，小于该距离即互斥 */
  dist: number;
}

export interface VegType {
  id: string;
  name: string;
  color: string;
  /** 同种植被之间的最小切比雪夫距离 */
  minSpacing: number;
  /** 允许生长的地形分区 */
  zones: Zone[];
  /** 各分区的放置概率（密度），湿区/坡边/空地可不同 */
  density: Partial<Record<Zone, number>>;
  /** 跨种类互斥规则 */
  excludes: Exclusion[];
}

export interface Preset {
  label: string;
  terrainStyle: 'riverbank' | 'hills' | 'wetland';
  types: VegType[];
}

function baseTypes(): VegType[] {
  return [
    {
      id: 'tree',
      name: '树',
      color: '#1b4d1b',
      minSpacing: 3,
      zones: ['plain', 'clearing', 'slope'],
      density: { plain: 0.25, clearing: 0.35, slope: 0.1 },
      excludes: [{ other: 'shrub', dist: 2 }],
    },
    {
      id: 'shrub',
      name: '灌木',
      color: '#2e7d32',
      minSpacing: 2,
      zones: ['plain', 'slope', 'clearing', 'wet'],
      density: { plain: 0.3, slope: 0.25, clearing: 0.15, wet: 0.1 },
      excludes: [{ other: 'tree', dist: 2 }],
    },
    {
      id: 'flower',
      name: '花',
      color: '#e07ab8',
      minSpacing: 1,
      zones: ['clearing', 'plain'],
      density: { clearing: 0.5, plain: 0.1 },
      excludes: [],
    },
    {
      id: 'reed',
      name: '芦苇',
      color: '#d4c05a',
      minSpacing: 1,
      zones: ['wet'],
      density: { wet: 0.7 },
      excludes: [],
    },
  ];
}

/** 内置预设：默认 / 狭窄河岸 / 拥挤植被 */
export const PRESETS: Record<string, Preset> = {
  default: {
    label: '默认',
    terrainStyle: 'hills',
    types: baseTypes(),
  },
  riverbank: {
    label: '狭窄河岸',
    terrainStyle: 'riverbank',
    types: (() => {
      const t = baseTypes();
      t[3].density = { wet: 0.9 }; // 芦苇在湿区很密
      t[3].minSpacing = 1;
      return t;
    })(),
  },
  crowded: {
    label: '拥挤植被',
    terrainStyle: 'hills',
    types: (() => {
      const t = baseTypes();
      // 大间距 + 高密度 + 强互斥：必然放不满，用来演示缺口报告
      t[0].minSpacing = 4;
      t[0].density = { plain: 0.6, clearing: 0.7, slope: 0.3 };
      t[1].minSpacing = 3;
      t[1].density = { plain: 0.6, slope: 0.5, clearing: 0.4, wet: 0.3 };
      t[2].minSpacing = 2;
      t[2].density = { clearing: 0.7, plain: 0.3 };
      t[3].minSpacing = 2;
      t[3].density = { wet: 0.6 };
      return t;
    })(),
  },
};
