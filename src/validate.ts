/**
 * 几何验证：纯数值检查，不依赖 DOM，可在 vitest 与页面内复用。
 *
 * 覆盖：
 * 1. 折叠过程中各面边长不变（刚性）
 * 2. 共享铰链边端点在任意进度一致
 * 3. 完全折叠时裁切边闭合
 * 4. 完全展开时共面且与展开网络位置一致
 * 5. 完全折叠时与目标实体全等、法线全部朝外（无反面/镜像）
 * 6. 直接拖动进度与逐帧连续播放结果一致
 * 7. 手动角度覆盖只影响下游分支，解除后精确恢复统一进度姿态（无累加）
 * 8. 裁切边在中间阶段不被当作铰链约束
 */
import * as THREE from 'three';
import type { BuiltModel, CheckEntry, FoldFace } from './types';
import { evaluateFold, newellNormal, rootAlignmentTransform, worldPoints } from './geometry';

/** 允许误差（长度单位与模型同量纲，模型边长约 2）。 */
export const TOLERANCE = {
  length: 1e-6,
  position: 1e-6,
  angle: 1e-6,
  /** 中间阶段裁切边“应处于分离状态”的最小分离量。 */
  cutFree: 1e-9,
};

const SAMPLES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

function edgeLength(points: THREE.Vector3[], i: number): number {
  return points[i].distanceTo(points[(i + 1) % points.length]);
}

function faceTargetEdgeLengths(face: FoldFace): number[] {
  return face.targetPoints.map((_, i) => edgeLength(face.targetPoints, i));
}

/** 找到某面内目标顶点 vid 的本地顶点序号。 */
function localIndex(model: BuiltModel, faceId: string, vid: number): number {
  const def = model.def.faces.find((f) => f.id === faceId)!;
  const idx = def.targetVertexIds.indexOf(vid);
  if (idx < 0) throw new Error(`面 ${faceId} 不含顶点 ${vid}`);
  return idx;
}

export interface ValidationReport {
  entries: CheckEntry[];
  pass: boolean;
}

export function validateModel(model: BuiltModel): ValidationReport {
  const entries: CheckEntry[] = [];

  // --- 1. 边长刚性：任意进度下各面边长等于目标边长 ---
  let maxLenErr = 0;
  let lenDetail = '';
  for (const p of SAMPLES) {
    const poses = evaluateFold(model, p);
    for (const face of model.faces) {
      const wp = worldPoints(face, poses.get(face.id)!);
      const target = faceTargetEdgeLengths(face);
      for (let i = 0; i < target.length; i++) {
        const err = Math.abs(edgeLength(wp, i) - target[i]);
        if (err > maxLenErr) {
          maxLenErr = err;
          lenDetail = `面 ${face.id}，进度 ${(p * 100).toFixed(0)}%`;
        }
      }
    }
  }
  entries.push({
    name: '面边长折叠中不变',
    detail: lenDetail,
    tolerance: TOLERANCE.length,
    actual: maxLenErr,
    pass: maxLenErr <= TOLERANCE.length,
  });

  // --- 2. 铰链边端点一致 ---
  let maxHingeErr = 0;
  let hingeDetail = '';
  for (const p of SAMPLES) {
    const poses = evaluateFold(model, p);
    for (const h of model.hingeEdges) {
      const parentFace = model.faceById.get(h.parent)!;
      const childFace = model.faceById.get(h.child)!;
      const pp = worldPoints(parentFace, poses.get(h.parent)!);
      const cp = worldPoints(childFace, poses.get(h.child)!);
      const pi = localIndex(model, h.parent, h.va);
      const pj = localIndex(model, h.parent, h.vb);
      const ci = localIndex(model, h.child, h.va);
      const cj = localIndex(model, h.child, h.vb);
      const err = Math.max(pp[pi].distanceTo(cp[ci]), pp[pj].distanceTo(cp[cj]));
      if (err > maxHingeErr) {
        maxHingeErr = err;
        hingeDetail = `铰链 ${h.parent}-${h.child}，进度 ${(p * 100).toFixed(0)}%`;
      }
    }
  }
  entries.push({
    name: '共享铰链边端点一致',
    detail: hingeDetail,
    tolerance: TOLERANCE.position,
    actual: maxHingeErr,
    pass: maxHingeErr <= TOLERANCE.position,
  });

  // --- 3. 完全折叠裁切边闭合（先做完整刚体对齐，再比较共享实体顶点） ---
  const folded = evaluateFold(model, 1);
  const rAlign = rootAlignmentTransform(model);
  const alignedAt = (faceId: string): THREE.Vector3[] =>
    worldPoints(model.faceById.get(faceId)!, folded.get(faceId)!).map((p) =>
      p.clone().applyMatrix4(rAlign),
    );
  let maxCutErr = 0;
  let cutDetail = '';
  for (const c of model.cutEdgePairs) {
    if (c.faces.length !== 2) {
      maxCutErr = Infinity;
      cutDetail = `边 ${c.key} 邻接面数=${c.faces.length}（闭合实体应为 2）`;
      break;
    }
    const [f1, f2] = c.faces;
    const p1 = alignedAt(f1);
    const p2 = alignedAt(f2);
    const err = Math.max(
      p1[localIndex(model, f1, c.va)].distanceTo(p2[localIndex(model, f2, c.va)]),
      p1[localIndex(model, f1, c.vb)].distanceTo(p2[localIndex(model, f2, c.vb)]),
    );
    if (err > maxCutErr) {
      maxCutErr = err;
      cutDetail = `裁切边 ${f1}↔${f2}（顶点 ${c.va}-${c.vb}）`;
    }
  }
  entries.push({
    name: '完全折叠裁切边闭合',
    detail: cutDetail,
    tolerance: TOLERANCE.position,
    actual: maxCutErr,
    pass: maxCutErr <= TOLERANCE.position,
  });

  // --- 4. 完全展开共面且与展开网络一致 ---
  const flat = evaluateFold(model, 0);
  let maxFlatErr = 0;
  let flatDetail = '';
  for (const face of model.faces) {
    const wp = worldPoints(face, flat.get(face.id)!);
    // 展开网络原始平面世界点：局部点经平面世界矩阵 F 还原
    const netWorld = face.flatLocalPoints.map((p) => p.clone().applyMatrix4(face.flatMatrix));
    for (let i = 0; i < wp.length; i++) {
      const err = wp[i].distanceTo(netWorld[i]);
      if (err > maxFlatErr) {
        maxFlatErr = err;
        flatDetail = `面 ${face.id} 顶点 ${i}`;
      }
      if (Math.abs(wp[i].z) > maxFlatErr) {
        maxFlatErr = Math.abs(wp[i].z);
        flatDetail = `面 ${face.id} 顶点 ${i} 偏离 z=0 平面`;
      }
    }
  }
  entries.push({
    name: '完全展开共面且位置一致',
    detail: flatDetail,
    tolerance: TOLERANCE.position,
    actual: maxFlatErr,
    pass: maxFlatErr <= TOLERANCE.position,
  });

  // --- 5a. 完全折叠与目标实体全等（完整刚体对齐后逐顶点比较） ---
  let maxCongruenceErr = 0;
  let congruenceDetail = '';
  for (const face of model.faces) {
    const wp = alignedAt(face.id);
    for (let i = 0; i < wp.length; i++) {
      const err = wp[i].distanceTo(face.targetPoints[i]);
      if (err > maxCongruenceErr) {
        maxCongruenceErr = err;
        congruenceDetail = `面 ${face.id} 顶点 ${i}`;
      }
    }
  }
  entries.push({
    name: '折叠结果与目标实体全等',
    detail: congruenceDetail,
    tolerance: TOLERANCE.position,
    actual: maxCongruenceErr,
    pass: maxCongruenceErr <= TOLERANCE.position,
  });

  // --- 5b. 法线全部朝外（实体质心在各面内侧），排除反面朝外/整片镜像 ---
  const solidCentroid = new THREE.Vector3();
  let count = 0;
  for (const face of model.faces) {
    for (const p of worldPoints(face, folded.get(face.id)!)) {
      solidCentroid.add(p);
      count++;
    }
  }
  solidCentroid.multiplyScalar(1 / count);
  let maxInsideSign = -Infinity;
  let normalDetail = '';
  for (const face of model.faces) {
    const wp = worldPoints(face, folded.get(face.id)!);
    const n = newellNormal(wp);
    const fc = wp.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).multiplyScalar(1 / wp.length);
    const side = n.dot(solidCentroid.clone().sub(fc)); // 必须为负（质心在面内侧）
    if (side > maxInsideSign) {
      maxInsideSign = side;
      normalDetail = `面 ${face.id} 的内侧符号值=${side.toExponential(2)}（应 < 0）`;
    }
  }
  entries.push({
    name: '面法线朝外（无反面/镜像）',
    detail: normalDetail,
    tolerance: 0,
    actual: maxInsideSign,
    pass: maxInsideSign < -1e-6,
  });

  // --- 6. 直接拖进度 vs 连续播放（逐帧求值到同一进度） ---
  let maxPlaybackErr = 0;
  let playbackDetail = '';
  for (const target of [0.23, 0.5, 0.77, 1]) {
    const direct = evaluateFold(model, target);
    const steps = 200;
    let played = direct;
    for (let i = 1; i <= steps; i++) {
      played = evaluateFold(model, (target * i) / steps);
    }
    for (const face of model.faces) {
      const a = worldPoints(face, direct.get(face.id)!);
      const b = worldPoints(face, played.get(face.id)!);
      for (let i = 0; i < a.length; i++) {
        const err = a[i].distanceTo(b[i]);
        if (err > maxPlaybackErr) {
          maxPlaybackErr = err;
          playbackDetail = `面 ${face.id}，目标进度 ${(target * 100).toFixed(0)}%`;
        }
      }
    }
  }
  entries.push({
    name: '拖动进度与连续播放一致',
    detail: playbackDetail,
    tolerance: TOLERANCE.position,
    actual: maxPlaybackErr,
    pass: maxPlaybackErr <= TOLERANCE.position,
  });

  // --- 7. 手动覆盖：仅下游变化，解除后精确恢复，重复设置不累加 ---
  const overrideChild = model.faces.find((f) => f.parentId !== null)!;
  const subtree = collectSubtree(model, overrideChild.id);
  const base = evaluateFold(model, 0.5);
  const manualAngle = overrideChild.targetAngle * 0.25;
  const overrides = new Map([[overrideChild.id, manualAngle]]);
  const manual = evaluateFold(model, 0.5, overrides);
  let maxIsolationErr = 0;
  let isolationDetail = '';
  for (const face of model.faces) {
    if (subtree.has(face.id)) continue;
    const a = worldPoints(face, base.get(face.id)!);
    const b = worldPoints(face, manual.get(face.id)!);
    for (let i = 0; i < a.length; i++) {
      const err = a[i].distanceTo(b[i]);
      if (err > maxIsolationErr) {
        maxIsolationErr = err;
        isolationDetail = `非下游面 ${face.id} 应保持原姿态`;
      }
    }
  }
  // 下游必须随手动角度运动
  let downstreamMoved = 0;
  for (const id of subtree) {
    const a = worldPoints(model.faceById.get(id)!, base.get(id)!);
    const b = worldPoints(model.faceById.get(id)!, manual.get(id)!);
    downstreamMoved = Math.max(
      downstreamMoved,
      ...a.map((p, i) => p.distanceTo(b[i])),
    );
  }
  // 再次设置相同手动角（模拟反复拖动）：绝对角度，结果不变
  const manual2 = evaluateFold(model, 0.5, new Map([[overrideChild.id, manualAngle]]));
  let repeatErr = 0;
  for (const id of subtree) {
    const a = worldPoints(model.faceById.get(id)!, manual.get(id)!);
    const b = worldPoints(model.faceById.get(id)!, manual2.get(id)!);
    repeatErr = Math.max(repeatErr, ...a.map((p, i) => p.distanceTo(b[i])));
  }
  // 解除覆盖：与统一姿态逐点相同
  const restored = evaluateFold(model, 0.5);
  let restoreErr = 0;
  for (const face of model.faces) {
    const a = worldPoints(face, base.get(face.id)!);
    const b = worldPoints(face, restored.get(face.id)!);
    restoreErr = Math.max(restoreErr, ...a.map((p, i) => p.distanceTo(b[i])));
  }
  entries.push({
    name: '手动角度仅影响下游且解除后恢复',
    detail: `${isolationDetail}；下游最大位移=${downstreamMoved.toExponential(2)}；重复设置误差=${repeatErr.toExponential(2)}；恢复误差=${restoreErr.toExponential(2)}`,
    tolerance: TOLERANCE.position,
    actual: Math.max(maxIsolationErr, repeatErr, restoreErr),
    pass:
      maxIsolationErr <= TOLERANCE.position &&
      repeatErr <= TOLERANCE.position &&
      restoreErr <= TOLERANCE.position &&
      downstreamMoved > 1e-3,
  });

  // --- 8. 裁切边中间阶段不被铰链拉住：50% 进度时所有裁切边对均处于分离状态 ---
  const mid = evaluateFold(model, 0.5);
  let minCutSeparation = Infinity;
  let cutFreeDetail = '';
  for (const c of model.cutEdgePairs) {
    const [f1, f2] = c.faces;
    const p1 = worldPoints(model.faceById.get(f1)!, mid.get(f1)!);
    const p2 = worldPoints(model.faceById.get(f2)!, mid.get(f2)!);
    const d = Math.max(
      p1[localIndex(model, f1, c.va)].distanceTo(p2[localIndex(model, f2, c.va)]),
      p1[localIndex(model, f1, c.vb)].distanceTo(p2[localIndex(model, f2, c.vb)]),
    );
    if (d < minCutSeparation) {
      minCutSeparation = d;
      cutFreeDetail = `最接近的裁切边对 ${f1}↔${f2}`;
    }
  }
  entries.push({
    name: '裁切边中间阶段未被拉住',
    detail: `${cutFreeDetail}，50% 进度下最小端点分离`,
    tolerance: TOLERANCE.cutFree,
    actual: minCutSeparation,
    pass: minCutSeparation > TOLERANCE.cutFree,
  });

  return { entries, pass: entries.every((e) => e.pass) };
}

function collectSubtree(model: BuiltModel, rootId: string): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const f of model.faces) if (f.parentId === id) stack.push(f.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 运行时指标：选中面的世界位置、铰链长度与闭合端点误差
// ---------------------------------------------------------------------------
export interface FaceMetrics {
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  hingeLength: number | null;
  /** 该面铰链边父子端点重合误差（根面为 null）。 */
  hingeError: number | null;
  /** 与该面相邻裁切边在当前进度下的最大端点分离。 */
  cutError: number;
  effectiveAngleDeg: number;
}

export function faceMetrics(
  model: BuiltModel,
  poses: ReturnType<typeof evaluateFold>,
  faceId: string,
): FaceMetrics {
  const face = model.faceById.get(faceId)!;
  const pose = poses.get(faceId)!;
  const wp = worldPoints(face, pose);
  const centroid = wp.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).multiplyScalar(1 / wp.length);
  const normal = newellNormal(wp);

  let hingeLength: number | null = null;
  let hingeError: number | null = null;
  if (face.parentId && face.parentEdge && face.childEdge) {
    const parent = model.faceById.get(face.parentId)!;
    const pp = worldPoints(parent, poses.get(face.parentId)!);
    const [i, j] = face.parentEdge;
    hingeLength = pp[i].distanceTo(pp[j]);
    const [ci, cj] = face.childEdge;
    hingeError = Math.max(wp[ci].distanceTo(pp[i]), wp[cj].distanceTo(pp[j]));
  }

  let cutError = 0;
  for (const c of model.cutEdgePairs) {
    if (!c.faces.includes(faceId)) continue;
    const other = c.faces.find((f) => f !== faceId)!;
    const op = worldPoints(model.faceById.get(other)!, poses.get(other)!);
    cutError = Math.max(
      cutError,
      wp[localIndex(model, faceId, c.va)].distanceTo(op[localIndex(model, other, c.va)]),
      wp[localIndex(model, faceId, c.vb)].distanceTo(op[localIndex(model, other, c.vb)]),
    );
  }

  return {
    centroid,
    normal,
    hingeLength,
    hingeError,
    cutError,
    effectiveAngleDeg: THREE.MathUtils.radToDeg(pose.effectiveAngle),
  };
}
