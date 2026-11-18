/**
 * 纯几何运算：
 * - 平面展开网络的 BFS 布局（保持面朝向，不镜像、不重叠）
 * - 每条铰链边的目标折叠角求解（父面坐标系下的有符号角）
 * - 给定统一进度 / 手动覆盖角的刚体姿态求解
 *
 * 所有向量与矩阵均为 float64（THREE.Vector3 / Matrix4），不依赖渲染器，可在 node 下测试。
 */
import * as THREE from 'three';
import type {
  BuiltModel,
  EdgeKey,
  FoldFace,
  NetFace,
  PolyhedronDef,
  TreeEdge,
} from './types';

export const EPS = 1e-9;

export function edgeKey(va: number, vb: number): EdgeKey {
  return va < vb ? `${va}-${vb}` : `${vb}-${va}`;
}

export function toVector3(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

/** Newell 法：对任意凸/凹共面多边形求稳健法线（顶点逆时针时法线朝外）。 */
export function newellNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

export function centroid(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  return c.multiplyScalar(1 / points.length);
}

/** 把 v 投影到与单位轴 axis 垂直的平面上并归一化。 */
function perpInPlane(v: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  return v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
}

/**
 * 绕单位轴 axis 把向量 from 旋转到 to 的有符号角。
 * 先把两者投影到 axis 的垂直平面并归一化，再用点积（cos）与叉积·轴（sin）求 atan2。
 */
function signedAngleAboutAxis(
  from: THREE.Vector3,
  to: THREE.Vector3,
  axis: THREE.Vector3,
): number {
  const f = from.clone().addScaledVector(axis, -from.dot(axis));
  const t = to.clone().addScaledVector(axis, -to.dot(axis));
  if (f.lengthSq() < 1e-24 || t.lengthSq() < 1e-24) return 0;
  f.normalize();
  t.normalize();
  const cos = THREE.MathUtils.clamp(f.dot(t), -1, 1);
  const sin = new THREE.Vector3().crossVectors(f, t).dot(axis);
  return Math.atan2(sin, cos);
}

/** 线段相交（含共线重叠判定），用于展开图重叠自检。仅 z=0 平面使用。 */
function segmentsIntersect(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, p4: THREE.Vector3): boolean {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  const sdx = p3.x - p1.x;
  const sdy = p3.y - p1.y;
  if (Math.abs(denom) < EPS) {
    // 平行：检查共线重叠
    if (Math.abs(sdx * d1y - sdy * d1x) > EPS) return false;
    const t = d1x * d1x + d1y * d1y;
    if (t < EPS) return false;
    const t1 = (sdx * d1x + sdy * d1y) / t;
    const t2 = ((p4.x - p1.x) * d1x + (p4.y - p1.y) * d1y) / t;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    return hi > EPS && lo < 1 - EPS;
  }
  const t = (sdx * d2y - sdy * d2x) / denom;
  const u = (sdx * d1y - sdy * d1x) / denom;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS;
}

function pointInPolygon(p: THREE.Vector3, poly: THREE.Vector3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (Math.abs(a.x - p.x) < EPS && Math.abs(a.y - p.y) < EPS) return false;
    const intersect = a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * BFS 展开：把目标实体的面邻接树铺平到 z=0 平面。
 * 每个子面通过“绕铰链边旋转到父面所在平面”的等距映射放置，
 * 因此边长、面内朝向严格保持，外法线统一为 +Z，不会整片镜像。
 */
export function buildNet(def: PolyhedronDef): NetFace[] {
  const target = def.targetVertices.map(toVector3);
  const faceMap = new Map(def.faces.map((f) => [f.id, f]));
  const childrenOf = new Map<string, TreeEdge[]>();
  for (const e of def.tree) {
    const list = childrenOf.get(e.parent) ?? [];
    list.push(e);
    childrenOf.set(e.parent, list);
  }

  const net = new Map<string, NetFace>();

  // --- 根面：以 p0->p1 为平面 x 轴，外法线映射到 +Z ---
  const rootDef = faceMap.get(def.rootFaceId)!;
  const rootTarget = rootDef.targetVertexIds.map((i) => target[i]);
  const rootNormal = newellNormal(rootTarget);
  const e1 = rootTarget[1].clone().sub(rootTarget[0]).normalize();
  const e2 = new THREE.Vector3().crossVectors(rootNormal, e1).normalize(); // e1 × e2 = n
  const rootOrigin = rootTarget[0];
  const rootNet = rootTarget.map((p) => {
    const d = p.clone().sub(rootOrigin);
    return new THREE.Vector3(d.dot(e1), d.dot(e2), 0);
  });
  net.set(rootDef.id, {
    id: rootDef.id,
    netPoints: rootNet,
    targetPoints: rootTarget,
    parentId: null,
    parentEdge: null,
    childEdge: null,
    hingeA: null,
    hingeB: null,
    childHingeA: null,
    childHingeB: null,
  });

  const placeChild = (edge: TreeEdge) => {
    const parent = net.get(edge.parent)!;
    const childDef = faceMap.get(edge.child)!;
    const childTarget = childDef.targetVertexIds.map((i) => target[i]);

    const [paIdx, pbIdx] = edge.parentEdge;
    const [caIdx, cbIdx] = edge.childEdge;
    const pa = parent.targetPoints[paIdx];
    const pb = parent.targetPoints[pbIdx];
    const ca = childTarget[caIdx];
    const cb = childTarget[cbIdx];

    // 两个 CCW 面共享同一条边时遍历方向相反：ca==pb、cb==pa
    if (ca.distanceToSquared(pb) > EPS * EPS || cb.distanceToSquared(pa) > EPS * EPS) {
      throw new Error(`铰链 ${edge.parent}->${edge.child} 的边顶点顺序不符（CCW 面必须反向遍历共享边）`);
    }

    // 以父面 CCW 方向为铰链轴 d；父面内部垂直方向 wParent 满足 d × wParent = nParent
    const d = pb.clone().sub(pa).normalize();
    const parentHingeMid = pa.clone().add(pb).multiplyScalar(0.5);
    const wParent = perpInPlane(centroid(parent.targetPoints).sub(parentHingeMid), d);
    const nParent = newellNormal(parent.targetPoints);
    if (new THREE.Vector3().crossVectors(d, wParent).dot(nParent) < 1 - 1e-6) {
      throw new Error(`内部错误：父面 ${edge.parent} 的铰链基架手性不符`);
    }

    // 子面以自身 CCW 方向（-d）为轴，其内部垂直方向 wChild 满足 (-d) × wChild = nChild
    const childHingeMid = ca.clone().add(cb).multiplyScalar(0.5);
    const wChild = perpInPlane(centroid(childTarget).sub(childHingeMid), d);
    const nChild = newellNormal(childTarget);
    if (new THREE.Vector3().crossVectors(d, wChild).dot(nChild) > -(1 - 1e-6)) {
      throw new Error(`内部错误：子面 ${edge.child} 的铰链基架手性不符`);
    }

    // 平面网络：父面铰链点与方向；子面铺在父面另一侧（平面内部方向 = -wParentFlat）
    const qA = parent.netPoints[paIdx].clone();
    const qB = parent.netPoints[pbIdx].clone();
    const dFlat = qB.clone().sub(qA).normalize();
    const wParentFlat = perpInPlane(
      centroid(parent.netPoints).sub(qA.clone().add(qB).multiplyScalar(0.5)),
      dFlat,
    );
    const wChildFlat = wParentFlat.clone().negate();

    // 等距映射（保持朝向，不镜像）。以子面自身 CCW 铰链起点 ca 为基准点：
    // ca 与父面 pb 是同一实体顶点，故平面位置 q(ca)=qB，q(cb)=qA。
    // 子面两个基向量及其平面像：
    //   铰链轴 (-d)        -> (-dFlat)
    //   内部方向 wChild    -> (-wParentFlat)（铺在父面另一侧）
    // 两组基各自右手且 (-dFlat)×(-wParentFlat)=+Z，故映射保持手性、法线恒为 +Z。
    //   q(v) = qB + ((v-ca)·(-d))(-dFlat) + ((v-ca)·wChild)(-wParentFlat)
    const negD = d.clone().negate();
    const negDFlat = dFlat.clone().negate();
    const childNet = childTarget.map((v) => {
      const dv = v.clone().sub(ca);
      return qB
        .clone()
        .addScaledVector(negDFlat, dv.dot(negD))
        .addScaledVector(wChildFlat, dv.dot(wChild));
    });

    // 朝向校验：平面外法线必须为 +Z（逆时针），否则说明数据/映射出错
    const flatNormal = newellNormal(childNet);
    if (flatNormal.z < 0.999999) {
      throw new Error(`展开 ${edge.child} 失败：平面法线为 ${flatNormal.toArray()}`);
    }

    const face: NetFace = {
      id: childDef.id,
      netPoints: childNet,
      targetPoints: childTarget,
      parentId: edge.parent,
      parentEdge: [...edge.parentEdge] as [number, number],
      childEdge: [...edge.childEdge] as [number, number],
      hingeA: qA,
      hingeB: qB,
      // 子面自身视角的枢轴端点（childEdge 方向，与父面反向）
      childHingeA: childNet[caIdx].clone(),
      childHingeB: childNet[cbIdx].clone(),
    };
    net.set(childDef.id, face);
  };

  // BFS 逐层铺放
  const queue: string[] = [def.rootFaceId];
  const visited = new Set<string>([def.rootFaceId]);
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of childrenOf.get(id) ?? []) {
      if (visited.has(edge.child)) {
        throw new Error(`展开树存在环或重复子面：${edge.child}`);
      }
      placeChild(edge);
      visited.add(edge.child);
      queue.push(edge.child);
    }
  }
  if (visited.size !== def.faces.length) {
    throw new Error('展开树未覆盖全部面');
  }

  const faces = [...net.values()];
  assertNoOverlap(faces);
  return faces;
}

/** 展开图重叠自检：非共享边之间不允许相交，顶点不允许落在其它面内部。 */
function assertNoOverlap(faces: NetFace[]): void {
  const allEdges: { a: THREE.Vector3; b: THREE.Vector3; face: string }[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.netPoints.length; i++) {
      allEdges.push({
        a: f.netPoints[i],
        b: f.netPoints[(i + 1) % f.netPoints.length],
        face: f.id,
      });
    }
  }
  // 两个不同面的边若两端点都重合（方向可相反），就是同一条铰链边，跳过相交判断。
  const isSharedHinge = (
    e1: { a: THREE.Vector3; b: THREE.Vector3 },
    e2: { a: THREE.Vector3; b: THREE.Vector3 },
  ): boolean =>
    (pointsCoincide(e1.a, e2.a) && pointsCoincide(e1.b, e2.b)) ||
    (pointsCoincide(e1.a, e2.b) && pointsCoincide(e1.b, e2.a));

  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      const e1 = allEdges[i];
      const e2 = allEdges[j];
      if (e1.face === e2.face) continue;
      if (isSharedHinge(e1, e2)) continue;
      if (segmentsIntersect(e1.a, e1.b, e2.a, e2.b)) {
        throw new Error(`预设展开图存在重叠：面 ${e1.face} 与 ${e2.face} 的边相交`);
      }
    }
  }
  for (const f of faces) {
    for (const g of faces) {
      if (f.id === g.id) continue;
      for (const p of f.netPoints) {
        if (pointInPolygon(p, g.netPoints)) {
          throw new Error(`预设展开图存在重叠：面 ${f.id} 的顶点落在面 ${g.id} 内`);
        }
      }
    }
  }
}

function pointsCoincide(a: THREE.Vector3, b: THREE.Vector3): boolean {
  return a.distanceToSquared(b) < EPS * EPS;
}

/**
 * 为每个面构造折叠求解数据（已在原型中对三个预设数值验证，平面/折叠误差 ~1e-15）。
 *
 * 刚体层级模型：
 *   - 枢轴 P：根面取第 0 顶点；子面取父面视角铰链点 hingeA（父子共用同一世界点）。
 *   - 本面平面基 (X_f, Y_f, +Z)：X_f 沿本面铰链轴（根面为世界 X），Y_f = Z × X_f。
 *   - 平面世界矩阵 F_face = T(P) · R(X_f,Y_f,+Z)；局部点 l = Rᵀ(w − P)，平面还原 w = F·l。
 *   - 平面态父子相对位姿 flatRelative = F_parent⁻¹ · F_face（恒定 SE(3)）。
 *
 * 折叠角 θ：绕【父面铰链轴 d】（目标实体坐标，父面 CCW 边方向）把父面外法线
 * nParent 旋转到子面外法线 nChild 的有符号角。平面态父子共面、法线相同（θ=0）。
 * 姿态组合：M_face = M_parent · flatRelative · Rx(θ)。
 * Rx 作用在本面局部帧（其 X 即铰链轴），θ 已按 d 与本面 X_f 的同向/反向换算符号。
 */
export function solveFoldAngles(netFaces: NetFace[]): FoldFace[] {
  const netMap = new Map(netFaces.map((f) => [f.id, f]));
  const result: FoldFace[] = [];
  const basisZ = new THREE.Vector3(0, 0, 1);

  const pivotWorldOf = (nf: NetFace): THREE.Vector3 =>
    nf.hingeA ? nf.hingeA.clone() : nf.netPoints[0].clone();

  for (const nf of netFaces) {
    const pivotFlat = pivotWorldOf(nf);
    let basisX = new THREE.Vector3(1, 0, 0);
    let basisY = new THREE.Vector3(0, 1, 0);
    let targetAngle = 0;

    if (nf.hingeA && nf.hingeB) {
      basisX = nf.hingeB.clone().sub(nf.hingeA).normalize();
      basisY = new THREE.Vector3().crossVectors(basisZ, basisX).normalize();
    }

    const basisMatrix = new THREE.Matrix4().makeBasis(
      basisX.clone(),
      basisY.clone(),
      basisZ.clone(),
    );
    const flatMatrix = new THREE.Matrix4()
      .makeTranslation(pivotFlat.x, pivotFlat.y, pivotFlat.z)
      .multiply(basisMatrix);

    // 本面局部平面点（枢轴原点、本面基坐标）
    const flatLocalPoints = nf.netPoints.map((p) => {
      const dv = p.clone().sub(pivotFlat);
      return new THREE.Vector3(dv.dot(basisX), dv.dot(basisY), dv.dot(basisZ));
    });

    let flatRelative: THREE.Matrix4 | null = null;
    if (nf.parentId && nf.parentEdge && nf.childEdge) {
      const parent = netMap.get(nf.parentId)!;
      const parentFace = result.find((f) => f.id === nf.parentId);
      if (!parentFace) throw new Error(`展开树顺序错误：父面 ${nf.parentId} 尚未求解`);

      // 平面态相对位姿：F_parent⁻¹ · F_face
      flatRelative = new THREE.Matrix4()
        .multiplyMatrices(parentFace.flatMatrix.clone().invert(), flatMatrix);

      // 折叠角：绕父面铰链轴 d（目标实体帧），把父面外法线转到子面外法线
      const [paIdx, pbIdx] = nf.parentEdge;
      const pa = parent.targetPoints[paIdx];
      const pb = parent.targetPoints[pbIdx];
      const d = pb.clone().sub(pa).normalize();
      const nParent = newellNormal(parent.targetPoints);
      const nChild = newellNormal(nf.targetPoints);
      const thetaAboutD = signedAngleAboutAxis(nParent, nChild, d);
      // Rx 绕本面平面局部 X_f 旋转。θ 的转轴符号必须在【同一平面帧】内判定：
      // 父面铰链边在父面平面网络中的方向（与目标轴 d 对应）对比本面 basisX，反向则角度取负。
      const parentFlatAxis = parent.netPoints[pbIdx]
        .clone()
        .sub(parent.netPoints[paIdx])
        .normalize();
      const s = Math.sign(parentFlatAxis.dot(basisX) || 1);
      targetAngle = s * thetaAboutD;
    }

    result.push({
      id: nf.id,
      parentId: nf.parentId,
      flatLocalPoints,
      pivotFlat,
      basisX: basisX.clone(),
      basisY: basisY.clone(),
      flatMatrix,
      flatRelative,
      targetPoints: nf.targetPoints,
      hingeA: nf.hingeA?.clone() ?? null,
      hingeB: nf.hingeB?.clone() ?? null,
      childHingeA: nf.childHingeA?.clone() ?? null,
      childHingeB: nf.childHingeB?.clone() ?? null,
      targetAngle,
      parentEdge: nf.parentEdge,
      childEdge: nf.childEdge,
    });
  }
  return result;
}

/** 构建一个预设纸模的全部静态数据。 */
export function buildModel(def: PolyhedronDef): BuiltModel {
  const netFaces = buildNet(def);
  const faces = solveFoldAngles(netFaces);
  const faceById = new Map(faces.map((f) => [f.id, f]));

  const hingeSet = new Set<EdgeKey>();
  const hingeEdges: BuiltModel['hingeEdges'] = [];
  for (const e of def.tree) {
    const parentFace = def.faces.find((f) => f.id === e.parent)!;
    const va = parentFace.targetVertexIds[e.parentEdge[0]];
    const vb = parentFace.targetVertexIds[e.parentEdge[1]];
    const key = edgeKey(va, vb);
    hingeSet.add(key);
    hingeEdges.push({ key, va, vb, parent: e.parent, child: e.child });
  }

  // 收集所有面边，非铰链即裁切边；闭合实体上每条裁切边恰好由两个面共享
  const cutMap = new Map<EdgeKey, { key: EdgeKey; va: number; vb: number; faces: string[] }>();
  for (const face of def.faces) {
    const ids = face.targetVertexIds;
    for (let i = 0; i < ids.length; i++) {
      const va = ids[i];
      const vb = ids[(i + 1) % ids.length];
      const key = edgeKey(va, vb);
      if (hingeSet.has(key)) continue;
      const entry = cutMap.get(key) ?? { key, va, vb, faces: [] };
      entry.faces.push(face.id);
      cutMap.set(key, entry);
    }
  }

  return {
    def,
    faces,
    faceById,
    hingeEdges,
    cutEdgePairs: [...cutMap.values()],
    targetVertices: def.targetVertices.map(toVector3),
  };
}

export interface FacePose {
  matrix: THREE.Matrix4;
  /** 该面铰链当前生效的折叠角（弧度），根面为 0。 */
  effectiveAngle: number;
}

/**
 * 刚体姿态求解（无状态，每次根据进度/覆盖角全量重算）。
 *
 *   M_root = F_root（平面世界矩阵）
 *   M_face = M_parent · flatRelative · Rx(生效折叠角)
 * flatRelative 是平面态父子固定相对位姿，Rx(θ) 在本面局部帧绕铰链轴折叠。
 * 平面态（θ=0）精确还原展开网络；整个子树随父面矩阵联动，多层连接不会脱离。
 *
 * @param overrides 子面 id -> 手动指定的绝对折叠角（弧度）；回到统一模式时删除键即可，
 *                  角度为绝对值，重复设置不会累加。
 */
export function evaluateFold(
  model: BuiltModel,
  progress: number,
  overrides: Map<string, number> = new Map(),
): Map<string, FacePose> {
  const poses = new Map<string, FacePose>();
  const clampP = THREE.MathUtils.clamp(progress, 0, 1);

  const resolve = (id: string): FacePose => {
    const cached = poses.get(id);
    if (cached) return cached;
    const face = model.faceById.get(id)!;
    if (!face.parentId) {
      const pose: FacePose = { matrix: face.flatMatrix.clone(), effectiveAngle: 0 };
      poses.set(id, pose);
      return pose;
    }
    const parentPose = resolve(face.parentId);
    const override = overrides.get(id);
    const effective = override ?? clampP * face.targetAngle;
    const rx = new THREE.Matrix4().makeRotationX(effective);
    const matrix = new THREE.Matrix4()
      .multiplyMatrices(parentPose.matrix, face.flatRelative!)
      .multiply(rx);
    const pose: FacePose = { matrix, effectiveAngle: effective };
    poses.set(id, pose);
    return pose;
  };

  for (const face of model.faces) resolve(face.id);
  return poses;
}

/** 取某面在指定姿态下的世界顶点。 */
export function worldPoints(face: FoldFace, pose: FacePose): THREE.Vector3[] {
  return face.flatLocalPoints.map((p) => p.clone().applyMatrix4(pose.matrix));
}

/** 取某面在指定姿态下的世界外法线（平面 +Z 经矩阵变换后的方向）。 */
export function worldNormal(pose: FacePose): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).transformDirection(pose.matrix).normalize();
}

/**
 * 求“折叠装配世界帧 -> 目标实体帧”的完整刚体变换（旋转 + 平移）。
 * 折叠结果与目标实体只差一个全局刚体运动（根面在展开时被任意放置所致）。
 * 先用根面第一条边方向与外法线构造旋转基，再用根面质心补平移，
 * 使折叠后的根面顶点与目标根面顶点逐点重合。三角形/多边形根面均适用。
 */
export function rootAlignmentTransform(model: BuiltModel): THREE.Matrix4 {
  const root = model.faces.find((f) => f.parentId === null)!;
  const flatBasis = new THREE.Matrix4().makeBasis(
    root.basisX,
    root.basisY,
    new THREE.Vector3(0, 0, 1),
  );
  const eTarget = root.targetPoints[1]
    .clone()
    .sub(root.targetPoints[0])
    .normalize();
  const nTarget = newellNormal(root.targetPoints);
  const yTarget = new THREE.Vector3().crossVectors(nTarget, eTarget).normalize();
  const targetBasis = new THREE.Matrix4().makeBasis(eTarget, yTarget, nTarget);
  const rotation = targetBasis.multiply(flatBasis.clone().invert());

  // 根面折叠质心（装配帧）经旋转后，应平移到目标根面质心
  const flatCentroid = root.flatLocalPoints
    .map((p) => p.clone().applyMatrix4(root.flatMatrix))
    .reduce((a, b) => a.clone().add(b), new THREE.Vector3())
    .multiplyScalar(1 / root.flatLocalPoints.length);
  const targetCentroid = root.targetPoints
    .reduce((a, b) => a.clone().add(b), new THREE.Vector3())
    .multiplyScalar(1 / root.targetPoints.length);
  const rotatedFlatCentroid = flatCentroid.clone().applyMatrix4(rotation);
  const translation = targetCentroid.clone().sub(rotatedFlatCentroid);

  return new THREE.Matrix4().makeTranslation(
    translation.x,
    translation.y,
    translation.z,
  ).multiply(rotation);
}

/** 仅旋转对齐（保留装配帧原点），用于只关心朝向/法线的场合。 */
export function rootAlignmentRotation(model: BuiltModel): THREE.Matrix4 {
  const root = model.faces.find((f) => f.parentId === null)!;
  const flatBasis = new THREE.Matrix4().makeBasis(
    root.basisX,
    root.basisY,
    new THREE.Vector3(0, 0, 1),
  );
  const eTarget = root.targetPoints[1]
    .clone()
    .sub(root.targetPoints[0])
    .normalize();
  const nTarget = newellNormal(root.targetPoints);
  const yTarget = new THREE.Vector3().crossVectors(nTarget, eTarget).normalize();
  const targetBasis = new THREE.Matrix4().makeBasis(eTarget, yTarget, nTarget);
  return targetBasis.multiply(flatBasis.invert());
}
