import type { WeaveModel, YarnParams } from './weaveMath';

export interface Preset {
  id: string;
  label: string;
  desc: string;
  model: WeaveModel;
  yarn: YarnParams;
}

function makeModel(sizeW: number, sizeF: number, fill: (i: number, j: number) => number): WeaveModel {
  const matrix = new Uint8Array(sizeW * sizeF);
  for (let i = 0; i < sizeW; i++) {
    for (let j = 0; j < sizeF; j++) {
      matrix[i * sizeF + j] = fill(i, j);
    }
  }
  return { sizeW, sizeF, matrix };
}

const DEFAULT_WARP_COLORS = ['#c9504b', '#e8b64c', '#3f7d9e'];
const DEFAULT_WEFT_COLORS = ['#e8e2d4', '#8f9aa6'];

export const PRESETS: Preset[] = [
  {
    id: 'plain',
    label: '平纹 2×2',
    desc: '最基础组织，每根线交替上下，没有超过 1 根的浮线',
    model: makeModel(2, 2, (i, j) => ((i + j) % 2 === 0 ? 1 : 0)),
    yarn: {
      warp: { radius: 0.22, spacing: 0.62, colors: ['#c9504b', '#e8b64c'] },
      weft: { radius: 0.22, spacing: 0.62, colors: ['#e8e2d4', '#8f9aa6'] },
    },
  },
  {
    id: 'twill',
    label: '斜纹 4×4（2上2下）',
    desc: '右斜斜纹，每根经线连续压过 2 根纬线，斜向纹路清晰',
    model: makeModel(4, 4, (i, j) => {
      const k = (j - i + 4) % 4;
      return k < 2 ? 1 : 0;
    }),
    yarn: {
      warp: { radius: 0.2, spacing: 0.58, colors: DEFAULT_WARP_COLORS },
      weft: { radius: 0.2, spacing: 0.58, colors: DEFAULT_WEFT_COLORS },
    },
  },
  {
    id: 'float',
    label: '长浮线 6×6（含跨边界浮线）',
    desc: '第 0 根经线的上浮段横跨 j=4,5,0,1 —— 平铺后是一根连过 4 根纬线的完整浮线，专门用来核对循环接缝',
    model: makeModel(6, 6, (i, j) => {
      // 第 0 根经线：j=4,5,0,1 连续上浮（在循环边界处相接）
      if (i === 0) return j === 4 || j === 5 || j === 0 || j === 1 ? 1 : 0;
      // 第 3 根纬线：i=4,5,0 连续纬浮（同样跨边界）
      if (j === 3) return i === 4 || i === 5 || i === 0 ? 0 : 1;
      // 其余用斜纹底
      const k = (j - i + 6) % 6;
      return k < 3 ? 1 : 0;
    }),
    yarn: {
      warp: { radius: 0.19, spacing: 0.56, colors: DEFAULT_WARP_COLORS },
      weft: { radius: 0.19, spacing: 0.56, colors: DEFAULT_WEFT_COLORS },
    },
  },
  {
    id: 'uneven',
    label: '粗细不均 4×4',
    desc: '经线粗、纬线细且间距不同，核对粗细/间距独立调节与导出高度图',
    model: makeModel(4, 4, (i, j) => {
      const k = (j - i + 4) % 4;
      return k < 2 ? 1 : 0;
    }),
    yarn: {
      warp: { radius: 0.3, spacing: 0.78, colors: ['#b5463f', '#d99a3d'] },
      weft: { radius: 0.14, spacing: 0.44, colors: ['#e8e2d4'] },
    },
  },
];

export function defaultState(): { model: WeaveModel; yarn: YarnParams } {
  const p = PRESETS[1];
  return {
    model: { sizeW: p.model.sizeW, sizeF: p.model.sizeF, matrix: p.model.matrix.slice() },
    yarn: JSON.parse(JSON.stringify(p.yarn)) as YarnParams,
  };
}
