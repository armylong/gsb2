/**
 * 预设测试点：针对默认规则，在确定性地形上搜索"刚好卡在两层边界"的位置。
 * 纯函数模块，验证脚本会复用同一批 finder 做断言。
 */
import { Heightfield } from './heightfield';
import { LayerRule, cloneDefaults } from './rules';

export interface PresetPoint {
  x: number;
  z: number;
}

export interface Preset {
  label: string;
  /** 在高度场上搜索目标点 */
  find(hf: Heightfield): PresetPoint;
  /** 若提供，跳转前先把规则替换成这套（用于回退演示） */
  rulesOverride?: LayerRule[];
  note: string;
}

/** 全地形扫描，返回使代价最小的点 */
function scan(hf: Heightfield, cost: (x: number, z: number) => number, step = 1.5): PresetPoint {
  const half = hf.size / 2 - 6;
  let best = { x: 0, z: 0 };
  let bestCost = Infinity;
  for (let z = -half; z <= half; z += step) {
    for (let x = -half; x <= half; x += step) {
      const c = cost(x, z);
      if (c < bestCost) {
        bestCost = c;
        best = { x, z };
      }
    }
  }
  return best;
}

/** 回退演示专用规则：草/岩之间留出坡度缺口，雪线抬高 */
export function makeGapRules(): LayerRule[] {
  const r = cloneDefaults();
  r[0].slopeMax = 15; r[0].slopeFeather = 2;  // 草：>17° 不覆盖
  r[1].slopeMin = 30; r[1].slopeFeather = 2;  // 岩：<28° 不覆盖
  r[2].heightMin = 60;                         // 雪：抬高到谷壁之上
  return r;
}

export const PRESETS: Preset[] = [
  {
    label: 'P1 草↔雪 高度边界 (h≈20, 缓坡)',
    note: '默认规则下草 heightMax=20、雪 heightMin=20，此处两者覆盖率都≈1，归一化后由优先级分配',
    find: (hf) =>
      scan(hf, (x, z) => {
        const s = hf.slopeDeg(x, z);
        if (s > 12) return 1e6 + s;
        return Math.abs(hf.height(x, z) - 20);
      }),
  },
  {
    label: 'P2 草↔岩 坡度边界 (slope≈26°, 低海拔)',
    note: '草 slopeMax=28、岩 slopeMin=26，此处两者覆盖率都≈1，高度上雪不覆盖',
    find: (hf) =>
      scan(hf, (x, z) => {
        const h = hf.height(x, z);
        if (h > 24) return 1e6 + h;
        return Math.abs(hf.slopeDeg(x, z) - 26);
      }),
  },
  {
    label: 'P3 岩↔雪 高海拔陡坡 (h>30, slope 30~50°)',
    note: '高海拔 + 陡坡：草不覆盖，岩与雪重叠，雪优先级 3 > 岩 2',
    find: (hf) =>
      scan(hf, (x, z) => {
        const h = hf.height(x, z);
        const s = hf.slopeDeg(x, z);
        if (h < 30) return 1e6 - h;
        return Math.abs(s - 40);
      }),
  },
  {
    label: 'P4 无覆盖回退演示 (应用缺口规则, slope≈22°)',
    note: '应用缺口规则后，坡度 17~28° 且高度 <60 的区域无任何层覆盖 → 显式回退（品红棋盘）',
    rulesOverride: makeGapRules(),
    find: (hf) =>
      scan(hf, (x, z) => {
        const h = hf.height(x, z);
        if (h > 20) return 1e6 + h;
        return Math.abs(hf.slopeDeg(x, z) - 22);
      }),
  },
];
