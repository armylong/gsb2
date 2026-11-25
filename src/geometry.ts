import * as THREE from 'three';

/**
 * 样板几何。
 * 每个顶点额外携带两个物体空间属性：
 *   aTanU — 参数 U 方向的切向量（弯曲样板：横向；球：经线方向）
 *   aTanV — 参数 V 方向的切向量（弯曲样板：竖向；球：纬线方向）
 * 方向场（直线/环形）在着色器里由这些切向量 + 物体空间位置解析得到，
 * 不依赖 UV，因此球没有接缝、环纹绕整圈连续。
 */

const TAN_U = 'aTanU';
const TAN_V = 'aTanV';

/** 弯曲样板：把一块平板弯成圆柱面的一段，开口朝 +Z */
export function createCurvedPanel(
  width = 2.2,
  height = 1.6,
  bendRadius = 2.6,
  segU = 96,
  segV = 48,
): THREE.BufferGeometry {
  const halfArc = width / (2 * bendRadius);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tanU: number[] = [];
  const tanV: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= segV; j++) {
    const v = j / segV;
    const y = (v - 0.5) * height;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const theta = (u - 0.5) * 2 * halfArc;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      // 圆柱轴沿 Y，板面在 x-z 平面内弯曲；取负号使开口朝向 +Z
      const x = bendRadius * sin;
      const z = bendRadius * (1 - cos);
      positions.push(x, y, z);
      // 外法线（朝开口方向 +Z）
      normals.push(sin, 0, cos);
      uvs.push(u, v);
      // dP/dtheta = (R cos, 0, R sin)，归一化即参数 U 切向
      tanU.push(cos, 0, sin);
      tanV.push(0, 1, 0);
    }
  }

  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + 1;
      const c = a + (segU + 1);
      const d = c + 1;
      // CCW 绕序，正面朝向法线（开口 +Z 方向）
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute(TAN_U, new THREE.Float32BufferAttribute(tanU, 3));
  geo.setAttribute(TAN_V, new THREE.Float32BufferAttribute(tanV, 3));
  geo.setIndex(indices);
  // 自定义几何必须显式计算包围体，否则 boundingSphere 为 null 会被视锥剔除误裁
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** 球体：在标准 SphereGeometry 上补物体空间解析切向量，避免 UV 接缝问题 */
export function createGrainSphere(radius = 0.62, widthSeg = 96, heightSeg = 64): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, widthSeg, heightSeg);
  const pos = geo.getAttribute('position');
  const tanU = new Float32Array(pos.count * 3);
  const tanV = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n = p.clone().multiplyScalar(1 / radius); // 球面法线 = 归一化位置

    // 纬线切向（参数 U，方位角方向）：(-z, 0, x)/sqrt(x²+z²)，两极退化
    let tU: THREE.Vector3;
    const horiz = Math.hypot(p.x, p.z);
    if (horiz < 1e-6) {
      tU = new THREE.Vector3(1, 0, 0); // 极点回退，着色器中按位置解析的方向场不直接依赖该值
    } else {
      tU = new THREE.Vector3(-p.z / horiz, 0, p.x / horiz);
    }

    // 经线切向（参数 V，向南）：up × tU 在极点保持有限
    const tV = new THREE.Vector3().crossVectors(up, tU);
    if (tV.lengthSq() < 1e-10) tV.set(0, -1, 0);
    tV.normalize();

    tanU[i * 3] = tU.x;
    tanU[i * 3 + 1] = tU.y;
    tanU[i * 3 + 2] = tU.z;
    tanV[i * 3] = tV.x;
    tanV[i * 3 + 1] = tV.y;
    tanV[i * 3 + 2] = tV.z;

    // 防止未使用变量告警（n 用于校验思路说明）
    void n;
  }

  geo.setAttribute(TAN_U, new THREE.BufferAttribute(tanU, 3));
  geo.setAttribute(TAN_V, new THREE.BufferAttribute(tanV, 3));
  return geo;
}
