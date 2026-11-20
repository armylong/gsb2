import earcut from 'earcut';
import {
  BranchRuntime,
  BuildResult,
  BuildStats,
  GeometryData,
  IntersectionParams,
  MarkingQuad,
  Vec2,
} from './types';
import { buildOutline, branchFarCorners } from './outline';
import { branchLabel, validateParams } from './validate';
import {
  containsPoint,
  findSelfIntersection,
  pointOnBoundary,
  signedArea,
} from './util';

// 标线常量（单位与道路一致）
const STOP_HALF_THICK = 0.2; // 停止线半宽（沿线方向）
const STOP_INSET = 0.15; // 停止线距路缘的横向内缩
const CLEAR_STEP = 0.05; // 路口边界扫描步长
const STOP_MARGIN = 0.35; // 停止线距路口边界的余量
const END_MARGIN = 0.3; // 停止线距路端的最小余量
const DASH_LEN = 1.2;
const DASH_GAP = 0.9;
const DASH_HALF_W = 0.075;
const DASH_START_GAP = 0.7;
const DASH_END_MARGIN = 0.4;
const MARK_Y = 0.02; // 标线抬高，避免与路面深度冲突

interface BranchGeom {
  d: Vec2; // 中心线方向
  n: Vec2; // 左法向
  h: number; // 半宽
  L: number;
}

function branchGeom(angleDeg: number, width: number, length: number): BranchGeom {
  const th = (angleDeg * Math.PI) / 180;
  const d = { x: Math.cos(th), y: Math.sin(th) };
  return { d, n: { x: -d.y, y: d.x }, h: width / 2, L: length };
}

/**
 * 沿分支中心线扫描，求“路口边界”距离：截面两侧点（横向 ±(h-inset)）
 * 最后一次“未安全落在本路路面”的位置——即被其他分支/中心圆盘覆盖，
 * 或被路缘圆角切出实际轮廓之外。之后走廊完全进入本路范围。
 */
function computeTClear(
  g: BranchGeom,
  selfIndex: number,
  params: IntersectionParams,
  outline: Vec2[],
  diskRadius: number
): number {
  const lat = g.h - STOP_INSET;
  const others = params.branches.map((b, i) => ({ g: branchGeom(b.angleDeg, b.width, b.length), i }));
  const inCore = (p: Vec2): boolean => {
    if (diskRadius > 0 && p.x * p.x + p.y * p.y < diskRadius * diskRadius) return true;
    for (const o of others) {
      if (o.i === selfIndex) continue;
      const s = p.x * o.g.d.x + p.y * o.g.d.y;
      const u = p.x * o.g.n.x + p.y * o.g.n.y;
      if (s >= -1e-9 && s <= o.g.L + 1e-9 && Math.abs(u) <= o.g.h + 1e-9) return true;
    }
    return false;
  };
  let lastOutside = -1;
  for (let t = 0; t <= g.L; t += CLEAR_STEP) {
    for (const side of [1, -1]) {
      const p = {
        x: g.d.x * t + g.n.x * lat * side,
        y: g.d.y * t + g.n.y * lat * side,
      };
      if (!containsPoint(outline, p) || inCore(p)) {
        lastOutside = t;
        break;
      }
    }
  }
  return lastOutside < 0 ? 0 : lastOutside + CLEAR_STEP;
}

/** 确保所有三角形法线朝 +Y（从上方看逆时针） */
function fixWinding(positions: Float32Array, indices: Uint32Array): void {
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vz = positions[c + 2] - positions[a + 2];
    const ny = uz * vx - ux * vz;
    if (ny < 0) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
  }
}

class QuadBuilder {
  positions: number[] = [];
  indices: number[] = [];

  addQuad(c: Vec2, along: Vec2, halfLen: number, across: Vec2, halfWidth: number, y: number): Vec2[] {
    const corners: Vec2[] = [
      { x: c.x - along.x * halfLen - across.x * halfWidth, y: c.y - along.y * halfLen - across.y * halfWidth },
      { x: c.x + along.x * halfLen - across.x * halfWidth, y: c.y + along.y * halfLen - across.y * halfWidth },
      { x: c.x + along.x * halfLen + across.x * halfWidth, y: c.y + along.y * halfLen + across.y * halfWidth },
      { x: c.x - along.x * halfLen + across.x * halfWidth, y: c.y - along.y * halfLen + across.y * halfWidth },
    ];
    const base = this.positions.length / 3;
    for (const p of corners) this.positions.push(p.x, y, p.y);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return corners;
  }

  build(): GeometryData {
    const positions = new Float32Array(this.positions);
    const indices = new Uint32Array(this.indices);
    fixWinding(positions, indices);
    return { positions, indices };
  }
}

/** 构建道路网格与标线。参数非法时返回错误并指明分支，调用方保留上次有效结果。 */
export function buildIntersection(params: IntersectionParams): BuildResult {
  const errors = validateParams(params);
  if (errors.length > 0) return { ok: false, errors };

  let outline: Vec2[];
  let warnings: string[];
  let diskRadius: number;
  try {
    const result = buildOutline(params);
    outline = result.points;
    warnings = result.warnings;
    diskRadius = result.diskRadius;
  } catch {
    return {
      ok: false,
      errors: ['路口边界无法合理连接（布尔运算失败），请调整分支角度或宽度'],
    };
  }
  if (outline.length < 3 || signedArea(outline) < 0.5) {
    return { ok: false, errors: ['路口边界退化，无法形成有效区域，请调整分支宽度或角度'] };
  }
  const selfHit = findSelfIntersection(outline);
  if (selfHit) {
    return {
      ok: false,
      errors: [
        `路口边界在 (${selfHit.x.toFixed(2)}, ${selfHit.y.toFixed(2)}) 附近自交，宽度/角度组合无法合理连接`,
      ],
    };
  }

  // 逐分支检查与标线定位
  const branches: BranchRuntime[] = [];
  for (let i = 0; i < params.branches.length; i++) {
    const b = params.branches[i];
    const lb = branchLabel(i);
    const g = branchGeom(b.angleDeg, b.width, b.length);
    // 分支末端必须仍暴露在轮廓上，否则说明被相邻道路吞没
    const far = branchFarCorners(b);
    if (
      !pointOnBoundary(far[0], outline, 1e-4) ||
      !pointOnBoundary(far[1], outline, 1e-4)
    ) {
      return {
        ok: false,
        errors: [`分支${lb} 的末端被相邻道路覆盖，当前宽度/长度组合无法形成有效连接边界`],
      };
    }
    const tClear = computeTClear(g, i, params, outline, diskRadius);
    const stopT = tClear + STOP_MARGIN + STOP_HALF_THICK;
    const needLen = tClear + STOP_MARGIN + STOP_HALF_THICK * 2 + END_MARGIN;
    if (b.length < needLen) {
      return {
        ok: false,
        errors: [
          `分支${lb} 长度不足：路口边界延伸至 ${tClear.toFixed(2)}，停止线需要长度 ≥ ${needLen.toFixed(2)}`,
        ],
      };
    }
    const dashStart = stopT + STOP_HALF_THICK + DASH_START_GAP;
    const dashEnd = b.length - DASH_END_MARGIN;
    const dashCount =
      dashEnd - dashStart >= DASH_LEN
        ? Math.max(0, Math.floor((dashEnd - dashStart + DASH_GAP) / (DASH_LEN + DASH_GAP)))
        : 0;
    if (dashCount === 0) warnings.push(`分支${lb} 剩余空间不足，未生成中心标线`);
    branches.push({
      id: b.id,
      label: lb,
      angleDeg: b.angleDeg,
      width: b.width,
      length: b.length,
      tClear,
      stopT,
      dashStart,
      dashEnd,
      dashCount,
    });
  }

  // 三角剖分（earcut 成熟库，不重复造轮子）
  const flat: number[] = [];
  for (const p of outline) flat.push(p.x, p.y);
  const tri = earcut(flat);
  if (tri.length < 3) return { ok: false, errors: ['三角剖分失败：轮廓无法三角化'] };
  const positions = new Float32Array(outline.length * 3);
  outline.forEach((p, i) => {
    positions[3 * i] = p.x;
    positions[3 * i + 1] = 0;
    positions[3 * i + 2] = p.y;
  });
  const indices = new Uint32Array(tri);
  fixWinding(positions, indices);

  // 标线：停止线 + 中心虚线
  const stopBuilder = new QuadBuilder();
  const centerBuilder = new QuadBuilder();
  const markingQuads: MarkingQuad[] = [];
  branches.forEach((br) => {
    const g = branchGeom(br.angleDeg, br.width, br.length);
    const stopCenter = { x: g.d.x * br.stopT, y: g.d.y * br.stopT };
    const corners = stopBuilder.addQuad(
      stopCenter,
      g.d,
      STOP_HALF_THICK,
      g.n,
      g.h - STOP_INSET,
      MARK_Y
    );
    markingQuads.push({ branchLabel: br.label, kind: 'stop', corners });
    for (let k = 0; k < br.dashCount; k++) {
      const t0 = br.dashStart + k * (DASH_LEN + DASH_GAP);
      const tc = t0 + DASH_LEN / 2;
      if (tc + DASH_LEN / 2 > br.dashEnd) break;
      const c = { x: g.d.x * tc, y: g.d.y * tc };
      const dc = centerBuilder.addQuad(c, g.d, DASH_LEN / 2, g.n, DASH_HALF_W, MARK_Y);
      markingQuads.push({ branchLabel: br.label, kind: 'dash', corners: dc });
    }
  });

  // 统计
  const bboxMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bboxMin[k] = Math.min(bboxMin[k], positions[i + k]);
      bboxMax[k] = Math.max(bboxMax[k], positions[i + k]);
    }
  }
  const stats: BuildStats = {
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    bboxMin,
    bboxMax,
  };

  return {
    ok: true,
    positions,
    indices,
    outline,
    branches,
    centerMarkings: centerBuilder.build(),
    stopMarkings: stopBuilder.build(),
    markingQuads,
    warnings,
    stats,
  };
}

/** 供验证使用的分支几何 */
export function branchGeomOf(angleDeg: number, width: number, length: number): BranchGeom {
  return branchGeom(angleDeg, width, length);
}

export const MARKING_CONSTANTS = {
  STOP_HALF_THICK,
  STOP_INSET,
  STOP_MARGIN,
  END_MARGIN,
  DASH_HALF_W,
};
