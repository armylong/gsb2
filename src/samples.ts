import { Ring } from './geometry.js';

export interface Sample {
  name: string;
  outer: Ring;
  holes: Ring[];
}

const P = (x: number, y: number) => ({ x, y });

/** 细窄凹槽:U 形外环,槽宽 40、深 420,考验凹角处的剖分。 */
export function grooveSample(): Sample {
  return {
    name: '细窄凹槽',
    outer: [
      P(180, 80),
      P(780, 80),
      P(780, 560),
      P(500, 560),
      P(500, 140),
      P(460, 140),
      P(460, 560),
      P(180, 560),
    ],
    holes: [],
  };
}

/**
 * 双孔:矩形外环 + 两个矩形洞。
 * 注意 hole1 故意按与外环相同的绕向给出,用来验证绕向规范化。
 */
export function doubleHoleSample(): Sample {
  return {
    name: '双孔',
    outer: [P(150, 80), P(810, 80), P(810, 560), P(150, 560)],
    holes: [
      [P(260, 200), P(260, 360), P(420, 360), P(420, 200)], // 与外环同向,需程序自动反转
      [P(540, 220), P(700, 220), P(700, 420), P(540, 420)],
    ],
  };
}

/** 凹槽 + 双孔组合,用于手工拖拽试验的起点。 */
export function comboSample(): Sample {
  const g = grooveSample();
  return {
    name: '凹槽+双孔',
    outer: g.outer,
    holes: [
      [P(240, 180), P(240, 300), P(360, 300), P(360, 180)],
      [P(600, 300), P(720, 300), P(720, 420), P(600, 420)],
    ],
  };
}
