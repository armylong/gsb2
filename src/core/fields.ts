// 程序生成的二维流速场。不模拟真实流体，只给出位置 -> 速度向量的解析公式，
// 便于用已知解析路径（匀速直线、刚体旋转圆）做本地检查。
import {
  Vec2,
  VelocityField,
  StopZone,
  Rect,
  pointInZone,
  pointInRect,
  clamp
} from './types.js';

/** 统一场景：1000 x 800，原点在中心，y 轴向下（与 canvas 一致） */
export const WORLD: Rect = { xmin: -500, xmax: 500, ymin: -400, ymax: 400 };
const SPEED_FLOOR = 1e-6;

function inWorld(p: Vec2): boolean {
  return pointInRect(p, WORLD);
}

/** 通用判定：在场景内且不在任何静止区里 */
function placeable(p: Vec2, zones: StopZone[]): boolean {
  return inWorld(p) && !zones.some((z) => pointInZone(p, z));
}

/* ---------------- 1. 绕中心打转（Lamb-Oseen 涡 + 微弱向心吸入） ---------------- */

const VORTEX_CORE_R = 28;
const VORTEX_GAMMA = 900; // 环量，决定切向速度尺度
const VORTEX_INWARD = 0.008; // 向心漂移系数，使流线为缓慢收紧的螺旋

function vortexVelocity(p: Vec2): Vec2 {
  const dx = p.x;
  const dy = p.y;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  // Lamb-Oseen：切向速度 Vθ = Γ/(2πr)·(1 − e^(−r²/rc²))，中心为 0、核外 ~1/r
  const tangential =
    (VORTEX_GAMMA / (2 * Math.PI * Math.max(r, 1e-9))) *
    (1 - Math.exp(-r2 / (VORTEX_CORE_R * VORTEX_CORE_R)));
  // 切向单位向量（顺时针：屏幕坐标下 (dy, -dx)/r）
  const tx = r > 1e-9 ? dy / r : 0;
  const ty = r > 1e-9 ? -dx / r : 0;
  // 向心（吸入）分量，让路径在有限长度内抵达涡核并触发「涡核停止」
  const inward = VORTEX_INWARD * r;
  const u = tangential * tx - (r > 1e-9 ? (inward * dx) / r : 0);
  const v = tangential * ty - (r > 1e-9 ? (inward * dy) / r : 0);
  return { x: u, y: v };
}

/* ---------------- 2. 从两侧汇入（向 x=0 汇聚，中间为停滞线） ---------------- */

const CONVERGE_STAG_R = 10;

function convergeVelocity(p: Vec2): Vec2 {
  // 二维汇聚（sink 型）：u=-k·x、v=-k'·y，两个分量都指向中心，
  // 左右来流沿内收曲线汇入中心停滞盘；停滞线 x=0 上仍有纵向速度，不会提前零速停笔。
  return { x: -0.9 * p.x, y: -0.25 * p.y };
}

/* ---------------- 3. 绕静止圆区（均匀来流 + 圆柱势流） ---------------- */

const CYL = { x: 0, y: 0, r: 90 };
const U_INF = 60;

function cylinderVelocity(p: Vec2): Vec2 {
  const dx = p.x - CYL.x;
  const dy = p.y - CYL.y;
  const r2 = dx * dx + dy * dy;
  const a2 = CYL.r * CYL.r;
  // 势流绕圆柱（来流沿 +x）：
  // u = U·(1 − a²(r²−2x²)/r⁴)，v = −U·a²·2xy/r⁴
  const u = U_INF * (1 - (a2 * (r2 - 2 * dx * dx)) / (r2 * r2));
  const v = U_INF * (-(a2 * 2 * dx * dy) / (r2 * r2));
  return { x: u, y: v };
}

/* ---------------- 检查专用：匀速直线来流（解析路径 = 直线） ---------------- */

function uniformVelocity(p: Vec2): Vec2 {
  void p;
  return { x: 60, y: 0 };
}

/* ---------------- 检查专用：刚体旋转（解析路径 = 正圆） ---------------- */

const RIGID_OMEGA = 0.08;

function rigidVelocity(p: Vec2): Vec2 {
  // 屏幕坐标下顺时针刚体旋转
  return { x: RIGID_OMEGA * p.y, y: -RIGID_OMEGA * p.x };
}

/* ---------------- 工厂与注册表 ---------------- */

export const FIELD_DEFS = {
  vortex: {
    id: 'vortex',
    label: '绕中心打转（螺旋涡）',
    desc: 'Lamb-Oseen 涡，切向速度核外按 1/r 衰减，叠加微弱向心吸入；路径收紧到涡核即停。',
    speedFloor: SPEED_FLOOR,
    zones: [{ kind: 'circle' as const, x: 0, y: 0, r: VORTEX_CORE_R }],
    velocity: vortexVelocity
  },
  converge: {
    id: 'converge',
    label: '从两侧汇入',
    desc: 'u=−0.9x、v=−0.25y 的 sink 型汇聚场，左右来流沿内收曲线汇入中心停滞盘。',
    speedFloor: SPEED_FLOOR,
    zones: [{ kind: 'circle' as const, x: 0, y: 0, r: CONVERGE_STAG_R }],
    velocity: convergeVelocity
  },
  cylinder: {
    id: 'cylinder',
    label: '绕静止圆区',
    desc: '均匀来流 + 圆柱势流解析解，圆内为无流速静止区，流线沿圆周绕行。',
    speedFloor: SPEED_FLOOR,
    zones: [{ kind: 'circle' as const, ...CYL }],
    velocity: cylinderVelocity
  },
  uniform: {
    id: 'uniform',
    label: '检查场：匀速直线',
    desc: '速度恒为 (60, 0)，解析路径是水平直线，用于检查偏离与停止位置。',
    speedFloor: SPEED_FLOOR,
    zones: [] as StopZone[],
    velocity: uniformVelocity
  },
  rigid: {
    id: 'rigid',
    label: '检查场：刚体旋转圆',
    desc: '角速度恒定的刚体旋转，解析路径是正圆，用于检查闭合判定与径向偏离。',
    speedFloor: SPEED_FLOOR,
    zones: [] as StopZone[],
    velocity: rigidVelocity
  }
};

export type FieldId = keyof typeof FIELD_DEFS;

export function createField(id: FieldId): VelocityField {
  const d = FIELD_DEFS[id];
  return {
    id: d.id,
    label: d.label,
    desc: d.desc,
    domain: WORLD,
    speedFloor: d.speedFloor,
    zones: d.zones,
    velocity: (p: Vec2) => d.velocity(p),
    isPlaceable: (p: Vec2) => placeable(p, d.zones)
  };
}

/** 刚体旋转参数导出，供检查模块计算解析圆路径 */
export const RIGID_PARAMS = { omega: RIGID_OMEGA };
export const UNIFORM_PARAMS = { u: 60, v: 0 };
export { VORTEX_CORE_R, CYL, CONVERGE_STAG_R };

/** 把任意点夹回场景内（用于 UI 层边界保护） */
export function clampToWorld(p: Vec2): Vec2 {
  return {
    x: clamp(p.x, WORLD.xmin + 1, WORLD.xmax - 1),
    y: clamp(p.y, WORLD.ymin + 1, WORLD.ymax - 1)
  };
}
