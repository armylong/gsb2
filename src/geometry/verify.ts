import { BuildSuccess } from './types';
import { branchGeomOf, MARKING_CONSTANTS } from './mesh';
import { branchFarCorners } from './outline';
import {
  containsPoint,
  dist,
  findSelfIntersection,
  signedArea,
} from './util';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function triNormalY(positions: Float32Array, ia: number, ib: number, ic: number): number {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  const ux = positions[b] - positions[a];
  const uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a];
  const vz = positions[c + 2] - positions[a + 2];
  return uz * vx - ux * vz;
}

/** 对构建结果做完整几何核验 */
export function verifyBuild(r: BuildSuccess): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. 边界闭合与简单性
  {
    const n = r.outline.length;
    let minEdge = Infinity;
    for (let i = 0; i < n; i++) {
      minEdge = Math.min(minEdge, dist(r.outline[i], r.outline[(i + 1) % n]));
    }
    const selfHit = findSelfIntersection(r.outline);
    const area = signedArea(r.outline);
    const ok = n >= 3 && minEdge > 1e-7 && !selfHit && area > 0.5;
    checks.push({
      name: '边界闭合与简单性',
      ok,
      detail: ok
        ? `${n} 个边界点，逆时针面积 ${area.toFixed(2)}，最短边 ${minEdge.toFixed(4)}，无自交`
        : `边界异常：点数 ${n}，最短边 ${minEdge.toFixed(6)}，面积 ${area.toFixed(3)}${selfHit ? '，存在自交' : ''}`,
    });
  }

  // 2. 三角形面积与朝向
  {
    const triCount = r.indices.length / 3;
    let minArea = Infinity;
    let sumArea = 0;
    let badNormal = 0;
    for (let i = 0; i < r.indices.length; i += 3) {
      const ny = triNormalY(r.positions, r.indices[i], r.indices[i + 1], r.indices[i + 2]);
      if (ny <= 0) badNormal++;
      const area = Math.abs(ny) / 2;
      minArea = Math.min(minArea, area);
      sumArea += area;
    }
    const polyArea = signedArea(r.outline);
    const relErr = Math.abs(sumArea - polyArea) / polyArea;
    const ok = triCount > 0 && minArea > 1e-9 && badNormal === 0 && relErr < 1e-4;
    checks.push({
      name: '三角形面积与朝向',
      ok,
      detail: ok
        ? `${triCount} 个三角形，最小面积 ${minArea.toFixed(6)}，全部法线 +Y，面积和与轮廓误差 ${(relErr * 100).toFixed(5)}%`
        : `三角形 ${triCount} 个，最小面积 ${minArea.toFixed(8)}，反向 ${badNormal} 个，面积误差 ${(relErr * 100).toFixed(4)}%`,
    });
  }

  // 3. 网格接缝与流形性：边界边必须恰好等于轮廓边，内部边恰好被两个三角形共享
  {
    const edgeCount = new Map<string, number>();
    const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (let i = 0; i < r.indices.length; i += 3) {
      const t = [r.indices[i], r.indices[i + 1], r.indices[i + 2]];
      for (let k = 0; k < 3; k++) {
        const kk = key(t[k], t[(k + 1) % 3]);
        edgeCount.set(kk, (edgeCount.get(kk) ?? 0) + 1);
      }
    }
    let boundary = 0;
    let interior = 0;
    let bad = 0;
    const boundaryKeys = new Set<string>();
    for (const [k, c] of edgeCount) {
      if (c === 1) {
        boundary++;
        boundaryKeys.add(k);
      } else if (c === 2) interior++;
      else bad++;
    }
    const n = r.outline.length;
    let outlineEdgesCovered = 0;
    for (let i = 0; i < n; i++) {
      if (boundaryKeys.has(key(i, (i + 1) % n))) outlineEdgesCovered++;
    }
    const ok = bad === 0 && boundary === n && outlineEdgesCovered === n;
    checks.push({
      name: '分支接缝与流形性',
      ok,
      detail: ok
        ? `单一连续网格：边界边 ${boundary} 条与轮廓完全吻合，内部边 ${interior} 条均成对共享，无裂缝与 T 形接头`
        : `边界边 ${boundary}/${n}，轮廓边命中 ${outlineEdgesCovered}/${n}，异常边 ${bad}`,
    });
  }

  // 4. 分支端帽：每个分支的末端角点必须是轮廓顶点（分支真正连出路口）
  {
    const missing: string[] = [];
    for (const br of r.branches) {
      const far = branchFarCorners({ id: br.id, angleDeg: br.angleDeg, width: br.width, length: br.length });
      for (const fc of far) {
        const found = r.outline.some((p) => dist(p, fc) < 1e-4);
        if (!found) {
          missing.push(br.label);
          break;
        }
      }
    }
    const ok = missing.length === 0;
    checks.push({
      name: '分支端帽暴露',
      ok,
      detail: ok
        ? `${r.branches.length} 个分支的末端角点均为轮廓顶点，接缝完整`
        : `分支 ${missing.join('、')} 末端未暴露在轮廓上`,
    });
  }

  // 5. 停止线区域：在路口边界之外、道路范围之内、路面之上
  {
    const problems: string[] = [];
    let stopCount = 0;
    for (const br of r.branches) {
      const quad = r.markingQuads.find((q) => q.kind === 'stop' && q.branchLabel === br.label);
      if (!quad) {
        problems.push(`分支${br.label} 缺少停止线`);
        continue;
      }
      stopCount++;
      const g = branchGeomOf(br.angleDeg, br.width, br.length);
      if (br.stopT - MARKING_CONSTANTS.STOP_HALF_THICK < br.tClear + 0.2) {
        problems.push(`分支${br.label} 停止线距路口边界过近`);
      }
      if (br.stopT + MARKING_CONSTANTS.STOP_HALF_THICK > br.length - 0.1) {
        problems.push(`分支${br.label} 停止线超出道路末端`);
      }
      for (const c of quad.corners) {
        if (!containsPoint(r.outline, c)) problems.push(`分支${br.label} 停止线角点跑出路面`);
        const along = c.x * g.d.x + c.y * g.d.y;
        const lateral = Math.abs(c.x * g.n.x + c.y * g.n.y);
        if (along < -1e-6 || along > br.length + 1e-6) problems.push(`分支${br.label} 停止线纵向越界`);
        if (lateral > g.h + 1e-6) problems.push(`分支${br.label} 停止线横向超出路宽`);
      }
    }
    const ok = problems.length === 0;
    checks.push({
      name: '停止线所在区域',
      ok,
      detail: ok
        ? `${stopCount} 条停止线均位于路口边界外、道路范围内，未穿越交叉口中央`
        : problems.slice(0, 3).join('；'),
    });
  }

  // 6. 中心标线范围：全部在路口边界外、道路内
  {
    const problems: string[] = [];
    let dashCount = 0;
    for (const q of r.markingQuads) {
      if (q.kind !== 'dash') continue;
      dashCount++;
      const br = r.branches.find((b) => b.label === q.branchLabel);
      if (!br) continue;
      const g = branchGeomOf(br.angleDeg, br.width, br.length);
      for (const c of q.corners) {
        if (!containsPoint(r.outline, c)) problems.push(`分支${q.branchLabel} 标线跑出路面`);
        const along = c.x * g.d.x + c.y * g.d.y;
        if (along < br.tClear - 1e-6) problems.push(`分支${q.branchLabel} 标线伸入路口中央`);
        if (along > br.length + 1e-6) problems.push(`分支${q.branchLabel} 标线超出道路末端`);
      }
    }
    const ok = problems.length === 0;
    checks.push({
      name: '中心标线范围',
      ok,
      detail: ok
        ? `${dashCount} 段中心虚线均在路口边界外、道路范围内`
        : [...new Set(problems)].slice(0, 3).join('；'),
    });
  }

  return checks;
}
