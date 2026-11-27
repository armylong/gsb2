import * as THREE from 'three';

/** 可绘制面 */
export type FaceId = 'ground' | 'stepTop' | 'stepFront';

export const FACE_LABEL: Record<FaceId, string> = {
  ground: '地面',
  stepTop: '台阶顶面',
  stepFront: '台阶正面',
};

export const FACE_ORDER: FaceId[] = ['ground', 'stepFront', 'stepTop'];

export interface SceneSpec {
  ground: { width: number; depth: number; cx: number; cz: number };
  step: { cx: number; cz: number; w: number; h: number; d: number };
  image: { cx: number; cy: number; cz: number; w: number; h: number };
}

export const DEFAULT_SPEC: SceneSpec = {
  // 有限大的地面:射线落到界外算"射出场景"
  ground: { width: 14, depth: 24, cx: 0, cz: -5 },
  // 矮台阶,位于观察点与目标图之间
  step: { cx: 0.9, cz: -2.2, w: 2.6, h: 0.6, d: 1.6 },
  // 立正的目标图(虚拟参考面,法线朝 +z)
  // 注意:竖直参考面上边缘必须低于观察点,否则投影会延伸到无穷远 —— 这是物理规律
  image: { cx: 0, cy: 1.3, cz: -3.2, w: 2.4, h: 2.6 },
};

/** 默认观察点:抬高视角(类似从二楼看台看),整幅图都能落在地面范围内 */
export const DEFAULT_EYE = new THREE.Vector3(0.3, 4.5, 6.0);
/** 遮挡示例观察点:压低后,台阶挡住图像下部,上部射出场景 */
export const OCCLUDED_EYE = new THREE.Vector3(0.1, 1.0, 4.5);

export function stepFrontZ(spec: SceneSpec): number {
  return spec.step.cz + spec.step.d / 2;
}

/** 生成参与投影计算的网格:地面 + 台阶(六面都参与遮挡判定) */
export function buildPaintMeshes(spec: SceneSpec): { ground: THREE.Mesh; step: THREE.Mesh } {
  const g = spec.ground;
  const groundGeo = new THREE.PlaneGeometry(g.width, g.depth)
    .rotateX(-Math.PI / 2)
    .translate(g.cx, 0, g.cz);
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshBasicMaterial());
  ground.name = 'ground';

  const s = spec.step;
  const stepGeo = new THREE.BoxGeometry(s.w, s.h, s.d).translate(s.cx, s.h / 2, s.cz);
  const step = new THREE.Mesh(stepGeo, new THREE.MeshBasicMaterial());
  step.name = 'step';

  return { ground, step };
}

/**
 * 判定一条命中属于哪张可绘制面。
 * 返回 null 表示命中了不可绘制的面(台阶侧面/背面/底面)。
 */
export function classifyHit(hit: THREE.Intersection): FaceId | null {
  if (hit.object.name === 'ground') return 'ground';
  if (hit.object.name === 'step' && hit.face) {
    const n = hit.face.normal; // 盒子局部坐标,轴对齐
    if (n.y > 0.9) return 'stepTop';
    if (n.z > 0.9) return 'stepFront';
    return null;
  }
  return null;
}

/** 面上的三维点 → 该面的二维坐标(米) */
export function facePoint2(face: FaceId, p: THREE.Vector3): [number, number] {
  switch (face) {
    case 'ground':
    case 'stepTop':
      return [p.x, p.z];
    case 'stepFront':
      return [p.x, p.y];
  }
}

/** 面的二维坐标(米) → 折回三维 */
export function facePoint3(face: FaceId, spec: SceneSpec, x2: number, y2: number): THREE.Vector3 {
  switch (face) {
    case 'ground':
      return new THREE.Vector3(x2, 0, y2);
    case 'stepTop':
      return new THREE.Vector3(x2, spec.step.h, y2);
    case 'stepFront':
      return new THREE.Vector3(x2, y2, stepFrontZ(spec));
  }
}

/** 面法线(用于绘制时沿法线微微抬起,避免 z-fighting) */
export function faceNormal(face: FaceId): THREE.Vector3 {
  switch (face) {
    case 'ground':
    case 'stepTop':
      return new THREE.Vector3(0, 1, 0);
    case 'stepFront':
      return new THREE.Vector3(0, 0, 1);
  }
}
