/**
 * 预置场景。
 * 所有正常场景基于同一块「主画面四边形」做双线性分割:
 * 两台投影机的四角都取自同一主平面的归一化坐标,
 * 因此同一幕布点经两台逆映射后必然对应同一测试图坐标(可严格对齐)。
 */
import { lerp, pt, validateQuad } from './geometry.ts';
import type { Point, ProjectorState, Quad } from './types.ts';

export const SCREEN_W = 1600;
export const SCREEN_H = 720;
export const OUT_W = 960;
export const OUT_H = 600;

/** 主画面四角(幕布坐标), 顺序 TL TR BR BL */
export interface MasterQuad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

/** 主平面双线性插值: (u,v) ∈ [0,1]² -> 幕布坐标 */
export function masterPoint(m: MasterQuad, u: number, v: number): Point {
  const top = { x: lerp(m.tl.x, m.tr.x, u), y: lerp(m.tl.y, m.tr.y, u) };
  const bot = { x: lerp(m.bl.x, m.br.x, u), y: lerp(m.bl.y, m.br.y, u) };
  return { x: lerp(top.x, bot.x, v), y: lerp(top.y, bot.y, v) };
}

/** 取主平面上矩形 [u0,u1]×[v0,v1] 对应的幕布四边形 */
export function masterSubQuad(
  m: MasterQuad,
  u0: number,
  u1: number,
  v0 = 0,
  v1 = 1,
): Quad {
  return [
    masterPoint(m, u0, v0),
    masterPoint(m, u1, v0),
    masterPoint(m, u1, v1),
    masterPoint(m, u0, v1),
  ];
}

/** 主平面(规整矩形) */
const flatMaster: MasterQuad = {
  tl: pt(120, 100),
  tr: pt(1480, 100),
  br: pt(1480, 580),
  bl: pt(120, 580),
};

/** 倾斜主平面(整体透视倾斜, 右窄左宽且整体旋转) */
const tiltedMaster: MasterQuad = {
  tl: pt(150, 140),
  tr: pt(1420, 70),
  br: pt(1330, 560),
  bl: pt(230, 620),
};

export interface Scenario {
  id: string;
  label: string;
  blendWidth: number;
  build: () => ProjectorState[];
}

function makeProjector(
  id: number,
  quad: Quad,
  crop: { u0: number; u1: number; v0?: number; v1?: number },
  brightness = 1,
): ProjectorState {
  const check = validateQuad(quad);
  if (!check.valid) throw new Error(`投影 ${id} 初始四边形非法: ${check.reason}`);
  return {
    id,
    name: `投影${id}`,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    quad: quad.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) as Quad,
    brightness,
    patternU0: crop.u0,
    patternU1: crop.u1,
    patternV0: crop.v0 ?? 0,
    patternV1: crop.v1 ?? 1,
  };
}

/**
 * 两台输出在主平面上的横向范围(总宽 1360)。
 * P1 覆盖 [0, 720], P2 覆盖 [640, 1360], 重叠 320(=80 主平面单位 × ... )
 * 即重叠段 u∈[640/1360, 720/1360], 交界中点恰为主平面中点。
 */
const P1_U1 = 720 / 1360;
const P2_U0 = 640 / 1360;

export const SCENARIOS: Scenario[] = [
  {
    id: 'normal',
    label: '正常横向拼接',
    blendWidth: 150,
    build: () => {
      // 两台几何区间与图案裁剪段完全一致, 重叠 80 主平面单位
      const q1 = masterSubQuad(flatMaster, 0, P1_U1);
      const q2 = masterSubQuad(flatMaster, P2_U0, 1);
      return [
        makeProjector(1, q1, { u0: 0, u1: P1_U1 }),
        makeProjector(2, q2, { u0: P2_U0, u1: 1 }),
      ];
    },
  },
  {
    id: 'diagonal',
    label: '斜向交叠(透视倾斜)',
    blendWidth: 150,
    build: () => {
      // 倾斜主平面上斜着交叠, 重叠带本身也是斜的
      const q1 = masterSubQuad(tiltedMaster, 0, P1_U1);
      const q2 = masterSubQuad(tiltedMaster, P2_U0, 1);
      return [
        makeProjector(1, q1, { u0: 0, u1: P1_U1 }, 0.95),
        makeProjector(2, q2, { u0: P2_U0, u1: 1 }, 1.05),
      ];
    },
  },
  {
    id: 'gap',
    label: '故意留缝',
    blendWidth: 150,
    build: () => {
      // 两台之间在主平面上留出 [0.47,0.55] 的空带(幕布上一条无人覆盖的缝)
      const q1 = masterSubQuad(flatMaster, 0, 0.47);
      const q2 = masterSubQuad(flatMaster, 0.55, 1);
      return [
        makeProjector(1, q1, { u0: 0, u1: 0.47 }),
        makeProjector(2, q2, { u0: 0.55, u1: 1 }),
      ];
    },
  },
  {
    id: 'edge',
    label: '仅共边(零重叠)',
    blendWidth: 150,
    build: () => {
      const q1 = masterSubQuad(flatMaster, 0, 0.5);
      const q2 = masterSubQuad(flatMaster, 0.5, 1);
      return [
        makeProjector(1, q1, { u0: 0, u1: 0.5 }),
        makeProjector(2, q2, { u0: 0.5, u1: 1 }),
      ];
    },
  },
];

export function buildScenario(id: string): { projectors: ProjectorState[]; blendWidth: number } {
  const s = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0];
  return { projectors: s.build(), blendWidth: s.blendWidth };
}
