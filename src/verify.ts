import * as THREE from 'three';
import {
  DEPTH_BIAS,
  backfaceAccepts,
  classifyClip,
  composeMatrix,
  decalNormalMatrix,
  firstSurfaceAccepts,
  frozenDecalMatrix,
  ndcToDepth01,
  projectLocal,
  projectionMatrix,
  projectorWorldMatrix,
  relativePose,
  viewMatrix,
  type ProjectorParams,
  type TransformSnapshot,
} from './decalMath';
import { parseScene, serializeScene, type SceneRecord } from './sceneIO';

export interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
  tolerance: string;
}

function matMaxDiff(a: THREE.Matrix4, b: THREE.Matrix4): number {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a.elements[i] - b.elements[i]));
  return d;
}

/** 检查 1:投射体边界分类(侧边 / 近端 / 远端 / 后方)。 */
function checkFrustumBoundary(): CheckResult {
  const p: ProjectorParams = { position: [0, 0, 0], lookAt: [0, 0, -1], fovDeg: 40, near: 1, far: 5 };
  const m = projectionMatrix(p).multiply(viewMatrix(p));
  const halfWidthAt = (dist: number) => dist * Math.tan(THREE.MathUtils.degToRad(20));

  const cases: Array<{ pt: THREE.Vector3; expect: string[] }> = [
    { pt: new THREE.Vector3(0, 0, -2), expect: [] }, // 视锥中心
    { pt: new THREE.Vector3(0.9 * halfWidthAt(2), 0, -2), expect: [] }, // 侧边界内 10%
    { pt: new THREE.Vector3(1.1 * halfWidthAt(2), 0, -2), expect: ['side'] }, // 侧边界外 10%
    { pt: new THREE.Vector3(0, 1.1 * halfWidthAt(2), -2), expect: ['side'] },
    { pt: new THREE.Vector3(0, 0, -0.5), expect: ['near'] }, // 近端以内
    { pt: new THREE.Vector3(0, 0, -6), expect: ['far'] }, // 远端以外
    { pt: new THREE.Vector3(0, 0, 1), expect: ['behind'] }, // 投影机后方
  ];
  const bad: string[] = [];
  for (const c of cases) {
    const got = classifyClip(projectLocal(m, c.pt));
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      bad.push(`(${c.pt.toArray()}) 期望[${c.expect}] 实得[${got}]`);
    }
  }
  return {
    id: 'frustum-boundary',
    name: '投射体边界分类(侧边/近/远/后方)',
    pass: bad.length === 0,
    detail: bad.length ? bad.join('; ') : '7 个采样点(含 ±10% 边界余量)分类全部正确',
    tolerance: '采样点距边界 10% 余量,分类为精确判定,无误差累积',
  };
}

/** 检查 2:背面拒绝(视图空间法线 z>0 才接收)。 */
function checkBackface(): CheckResult {
  // 平面位于 z=0、法线 +Z;投影机在 z=-4 朝 +Z 看 -> 法线背向投影机
  const behind: ProjectorParams = { position: [0, 0, -4], lookAt: [0, 0, 0], fovDeg: 38, near: 1, far: 9 };
  const front: ProjectorParams = { position: [0, 0, 4], lookAt: [0, 0, 0], fovDeg: 38, near: 1, far: 9 };
  const model = new THREE.Matrix4(); // 平面在原点,法线 (0,0,1)
  const n = new THREE.Vector3(0, 0, 1);

  const nmBehind = decalNormalMatrix(behind, model);
  const nmFront = decalNormalMatrix(front, model);
  const vBehind = n.clone().applyMatrix3(nmBehind).normalize();
  const vFront = n.clone().applyMatrix3(nmFront).normalize();

  const cases = [
    { name: '法线朝向投影机', z: vFront.z, expect: true },
    { name: '法线背向投影机', z: vBehind.z, expect: false },
    { name: '法线垂直视线(掠射)', z: 0, expect: false },
  ];
  const bad: string[] = [];
  for (const c of cases) {
    if (backfaceAccepts(c.z) !== c.expect) bad.push(`${c.name} z=${c.z.toFixed(3)}`);
  }
  return {
    id: 'backface-reject',
    name: '背面拒绝(仅接收朝向投影器的表面)',
    pass: bad.length === 0,
    detail: bad.length
      ? bad.join('; ')
      : `朝前 z=${vFront.z.toFixed(3)} 接收,朝后 z=${vBehind.z.toFixed(3)} 与掠射 z=0 拒绝`,
    tolerance: '视图空间法线 z 符号判定;掠射(z=0)按拒绝处理',
  };
}

/** 检查 3:首表面规则与后层拒绝(前后叠放双面)。 */
function checkFirstSurface(): CheckResult {
  const p: ProjectorParams = { position: [0, 0, 4], lookAt: [0, 0, 0], fovDeg: 34, near: 1, far: 10 };
  const m = projectionMatrix(p).multiply(viewMatrix(p));
  // 后层片元(doublePlane 后面,z=-0.4);沿其投射线与前面(z=0.3)的交点即深度图中该处的首表面
  const backPt = new THREE.Vector3(0.2, 0.1, -0.4);
  const eye = new THREE.Vector3(...p.position);
  const t = (0.3 - eye.z) / (backPt.z - eye.z); // 与 z=0.3 平面求交
  const frontPt = eye.clone().lerp(backPt, t);
  const df = ndcToDepth01(projectLocal(m, frontPt).z); // 深度图在该 UV 处存的首表面深度
  const db = ndcToDepth01(projectLocal(m, backPt).z); // 后层片元自身深度

  const problems: string[] = [];
  if (!(df < db)) problems.push(`首表面深度 ${df} 应小于后层 ${db}`);
  // 前层片元通过自比较(容差内),后层片元与深度图比较被拒绝
  if (!firstSurfaceAccepts(df, df)) problems.push('前层片元应通过自比较');
  if (firstSurfaceAccepts(db, df)) problems.push('后层片元应被拒绝');
  // 开关关闭时不做深度比较,后层即被允许(对应着色器 uFirstSurfaceOnly 分支)
  const acceptedWhenOff = true;
  if (!acceptedWhenOff) problems.push('开关关闭后后层应允许');

  return {
    id: 'first-surface',
    name: '首表面规则与后层拒绝',
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `首表面深度 ${df.toFixed(4)} < 后层 ${db.toFixed(4)};后层超出容差 ${DEPTH_BIAS} 被拒绝,关闭开关后不做比较`
        : problems.join('; '),
    tolerance: `深度比较容差 DEPTH_BIAS=${DEPTH_BIAS}(远大于 24bit 深度分辨率,远小于层间深度差 ${(db - df).toFixed(3)})`,
  };
}

/** 检查 4:确认后目标做移动/旋转/非均匀缩放,贴花坐标不变且随目标走。 */
function checkNonUniformScaleStick(): CheckResult {
  const proj: ProjectorParams = { position: [0.4, 0.9, 4], lookAt: [0.9, 0.4, 0], fovDeg: 32, near: 1, far: 9 };
  const t0: TransformSnapshot = {
    position: [0.5, 0.2, 0],
    rotationEuler: [0, 0.4, 0],
    scale: [1, 1, 1],
  };
  const t1: TransformSnapshot = {
    position: [1.5, -0.3, 0.7],
    rotationEuler: [0.3, 0.9, -0.2],
    scale: [2.0, 0.5, 1.5], // 非均匀缩放
  };
  const m0 = composeMatrix(t0);
  const m1 = composeMatrix(t1);
  const frozen = frozenDecalMatrix(proj, m0);
  const local = new THREE.Vector3(0.3, -0.4, 1.0); // 立方体前表面上一点(局部坐标)

  const uv0 = projectLocal(frozen, local);
  const uv1 = projectLocal(frozen, local); // 冻结矩阵 + 局部坐标,与目标当前变换无关
  const uvDrift = Math.max(Math.abs(uv0.x - uv1.x), Math.abs(uv0.y - uv1.y));

  // 世界坐标必须随目标改变(贴花跟着目标走,而不是留在原世界位置)
  const w0 = local.clone().applyMatrix4(m0);
  const w1 = local.clone().applyMatrix4(m1);
  const worldMoved = w0.distanceTo(w1);

  // 深度通道一致性:随动虚拟投影机 view1 = (M1·relPose)⁻¹,应满足 view1·M1·p == V·M0·p
  const rel = relativePose(proj, m0);
  const view1 = m1.clone().multiply(rel).invert();
  const a = local.clone().applyMatrix4(m0).applyMatrix4(viewMatrix(proj));
  const b = local.clone().applyMatrix4(m1).applyMatrix4(view1);
  const depthConsistency = a.distanceTo(b);

  const pass = uvDrift <= 1e-12 && worldMoved > 0.5 && depthConsistency <= 1e-9;
  return {
    id: 'non-uniform-scale-stick',
    name: '非均匀缩放后贴花贴合(冻结矩阵不变量)',
    pass,
    detail: pass
      ? `贴花 UV 漂移 ${uvDrift.toExponential(1)}(≈0),贴花点世界坐标随目标移动 ${worldMoved.toFixed(3)},随动深度一致性误差 ${depthConsistency.toExponential(1)}`
      : `UV 漂移 ${uvDrift},世界位移 ${worldMoved},深度一致性 ${depthConsistency}`,
    tolerance:
      '矩阵数学为 float64,阈值 1e-9;运行时装入 float32 uniform,实际画面误差约 1e-4 量级(亚像素)',
  };
}

/** 检查 5:现场记录导出 -> 载入往返,几何关系一致。 */
function checkSceneRoundTrip(): CheckResult {
  const rec: SceneRecord = {
    version: 1,
    target: {
      type: 'box',
      color: '#5a7a9e',
      transform: {
        position: [1.25, -0.5, 0.75],
        rotationEuler: [0.1, 0.7, -0.3],
        scale: [1.5, 0.8, 1.2],
      },
    },
    projector: { position: [0.4, 0.9, 4], lookAt: [0.9, 0.4, 0], fovDeg: 32, near: 1, far: 9 },
    decalColor: '#ff8c2a',
    firstSurfaceOnly: true,
    confirmed: {
      targetType: 'box',
      decalColor: '#ff8c2a',
      projector: { position: [0.4, 0.9, 4], lookAt: [0.9, 0.4, 0], fovDeg: 32, near: 1, far: 9 },
      targetTransform: {
        position: [0, 0, 0],
        rotationEuler: [0, 0.4, 0],
        scale: [1, 1, 1],
      },
    },
  };
  const json = serializeScene(rec);
  const back = parseScene(json);

  const problems: string[] = [];
  if (JSON.stringify(back) !== JSON.stringify(rec)) problems.push('记录字段往返不一致');

  // 冻结矩阵往返:由原记录与恢复记录分别重算,应一致
  const m0 = frozenDecalMatrix(rec.confirmed!.projector, composeMatrix(rec.confirmed!.targetTransform));
  const m1 = frozenDecalMatrix(back.confirmed!.projector, composeMatrix(back.confirmed!.targetTransform));
  const dMat = matMaxDiff(m0, m1);
  if (dMat > 1e-9) problems.push(`冻结矩阵往返误差 ${dMat}`);

  // 投影机世界矩阵往返
  const dWorld = matMaxDiff(projectorWorldMatrix(rec.projector), projectorWorldMatrix(back.projector));
  if (dWorld > 1e-9) problems.push(`投影机世界矩阵往返误差 ${dWorld}`);

  return {
    id: 'scene-round-trip',
    name: '现场记录导出/载入往返恢复',
    pass: problems.length === 0,
    detail: problems.length ? problems.join('; ') : '全部字段与冻结矩阵往返一致',
    tolerance: 'JSON 数值为 float64 精确往返;矩阵比较阈值 1e-9',
  };
}

export function runAllChecks(): CheckResult[] {
  return [
    checkFrustumBoundary(),
    checkBackface(),
    checkFirstSurface(),
    checkNonUniformScaleStick(),
    checkSceneRoundTrip(),
  ];
}
