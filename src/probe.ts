// 观察点分析：屏幕像素 -> 地面世界足迹 -> 纹理 UV / 缩小层读数。
// 所有计算与 fragment shader 的 LOD 公式保持一致，读数跨砖接缝连续。
import { v3, type Vec3, mat4Invert, transformVec4, type Mat4 } from './gl-matrix';
import { TEX_BASE, TEX_LEVELS, TILE_WORLD } from './texture';
import type { OrbitCamera } from './camera';

export interface ProbeReading {
  valid: boolean;
  world: Vec3;
  eyeHeight: number;
  /** 连续 UV（不取模，跨砖后继续增长，读数连续）。 */
  uvCont: Vec2;
  /** 当前所在砖编号与砖内 UV。 */
  tile: [number, number];
  uvInTile: Vec2;
  /** 一个物理屏幕像素沿屏幕 x/y 方向跨过的世界尺寸。 */
  pxWorldX: number;
  pxWorldY: number;
  /** 一个物理屏幕像素折合第 0 级 texel 数（两个屏幕轴）。 */
  pxTexelX: number;
  pxTexelY: number;
  /** 与 shader 一致的连续 LOD 值。 */
  lambda: number;
  lodLo: number;
  lodHi: number;
  lodBlend: number;
  /** 足迹长短轴比（各向异性程度）与预计实际采样次数。 */
  anisoRatio: number;
  effectiveTaps: number;
  /** 观察点处沿屏幕 x 移动 0.5 个物理像素所需的世界位移。 */
  halfPxDelta: Vec3;
}

type Vec2 = [number, number];

function unprojectGround(invVP: Mat4, ndcX: number, ndcY: number): Vec3 | null {
  const near = transformVec4(invVP, ndcX, ndcY, -1, 1);
  const far = transformVec4(invVP, ndcX, ndcY, 1, 1);
  if (near[3] === 0 || far[3] === 0) return null;
  const p0: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
  const p1: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
  const dir = v3.sub(p1, p0);
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = -p0[1] / dir[1];
  if (t < 0) return null;
  return v3.add(p0, v3.scale(dir, t));
}

export function probeAt(
  cam: OrbitCamera,
  vp: Mat4,
  ndcX: number,
  ndcY: number,
  physW: number,
  physH: number,
  maxAniso: number,
  hwAnisoCap: number,
): ProbeReading | null {
  const invVP = mat4Invert(vp);
  const p = unprojectGround(invVP, ndcX, ndcY);
  if (!p) return null;

  const sx = 2 / physW; // 一个物理像素对应的 NDC 步长
  const sy = 2 / physH;
  const px = unprojectGround(invVP, ndcX - sx, ndcY);
  const px1 = unprojectGround(invVP, ndcX + sx, ndcY);
  const py = unprojectGround(invVP, ndcX, ndcY - sy);
  const py1 = unprojectGround(invVP, ndcX, ndcY + sy);
  if (!px || !px1 || !py || !py1) return null;

  // 相邻两像素交点距离 / 2 = 单像素世界跨度
  const pxWorldX = v3.len(v3.sub(px1, px)) / 2;
  const pxWorldY = v3.len(v3.sub(py1, py)) / 2;

  // UV = 世界坐标 / 每砖世界尺寸；REPEAT 下取模由硬件做，这里保留连续值
  const uvCont: Vec2 = [p[0] / TILE_WORLD, p[2] / TILE_WORLD];
  const tileX = Math.floor(uvCont[0]);
  const tileZ = Math.floor(uvCont[1]);
  const uvInTile: Vec2 = [uvCont[0] - tileX, uvCont[1] - tileZ];

  // 第 0 级：每 UV 单位 = TEX_BASE 个 texel
  const pxTexelX = (pxWorldX / TILE_WORLD) * TEX_BASE;
  const pxTexelY = (pxWorldY / TILE_WORLD) * TEX_BASE;

  // 与 fragment shader computedLod 相同：lambda = log2(长轴 texel 跨度)
  const lambda = Math.log2(Math.max(pxTexelX, pxTexelY));
  const clamped = Math.max(0, Math.min(TEX_LEVELS - 1, lambda));
  const lodLo = Math.floor(clamped);
  const lodHi = Math.min(TEX_LEVELS - 1, lodLo + 1);
  const lodBlend = clamped - lodLo;

  const anisoRatio = Math.max(pxTexelX, pxTexelY) / Math.max(1e-9, Math.min(pxTexelX, pxTexelY));
  const cap = hwAnisoCap > 1 ? Math.min(maxAniso, hwAnisoCap) : maxAniso;
  const effectiveTaps = Math.max(1, Math.min(cap, Math.round(anisoRatio)));
  // 0.5 物理像素的世界位移（沿屏幕 x），供亚像素对照位使用
  const halfPxDelta = v3.scale(v3.sub(px1, p), 0.5);

  return {
    valid: true,
    world: p,
    eyeHeight: cam.eye()[1],
    uvCont,
    tile: [tileX, tileZ],
    uvInTile,
    pxWorldX,
    pxWorldY,
    pxTexelX,
    pxTexelY,
    lambda,
    lodLo,
    lodHi,
    lodBlend,
    anisoRatio,
    effectiveTaps,
    halfPxDelta,
  };
}

/** 世界点投影到某个 pane 的 CSS 像素坐标（用于定位放大框）。 */
export function worldToCss(
  vp: Mat4,
  world: Vec3,
  cssW: number,
  cssH: number,
): [number, number] | null {
  const clip = transformVec4(vp, world[0], world[1], world[2], 1);
  if (clip[3] <= 0) return null;
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return [((ndcX + 1) / 2) * cssW, ((1 - ndcY) / 2) * cssH];
}

export function fmt(n: number, digits = 3): string {
  if (!isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return n.toExponential(2);
  return n.toFixed(digits);
}
