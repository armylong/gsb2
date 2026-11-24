import * as THREE from 'three';

export interface CombParams {
  azimuthDeg: number; // 梳向方位角(度)
  tilt: number;       // 0 = 沿法线直立, 1 = 完全压倒贴面
}

export interface ClothPress {
  x: number; y: number;   // 布片局部坐标
  radius: number;
  strength: number;       // 0..1
}

export interface SpherePress {
  dir: THREE.Vector3;     // 物体空间方向(压痕中心)——球旋转时压痕跟着走
  angleDeg: number;       // 压痕角半径
  strength: number;
}

/** 兼容 a > b 的 smoothstep(从边缘向中心衰减用) */
function smoothstepAB(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function writeAttr(geo: THREE.BufferGeometry, dirs: Float32Array, lens: Float32Array) {
  geo.setAttribute('furDir', new THREE.BufferAttribute(dirs, 3));
  geo.setAttribute('furLen', new THREE.BufferAttribute(lens, 1));
}

/**
 * 布片(PlaneGeometry,局部 XY 平面,法线 +Z)毛方向场。
 * 全局梳向 + 一处径向压倒的压痕区(像被手掌抹过)。
 */
export function computeClothField(
  geo: THREE.BufferGeometry,
  comb: CombParams,
  press: ClothPress,
) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const dirs = new Float32Array(n * 3);
  const lens = new Float32Array(n);

  const az = (comb.azimuthDeg * Math.PI) / 180;
  const tx = Math.cos(az), ty = Math.sin(az);
  const tilt = comb.tilt;

  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i);

    // 基础方向: 法线(0,0,1) 与切向梳向的混合
    let dx = tx * tilt, dy = ty * tilt, dz = 1 - tilt;
    let len = 1;

    // 压痕: 径向外倒,并保留一点全局梳向
    const pdx = x - press.x, pdy = y - press.y;
    const dist = Math.hypot(pdx, pdy);
    const w = press.strength * smoothstepAB(press.radius, press.radius * 0.35, dist);
    if (w > 1e-4 && dist > 1e-5) {
      const rx = pdx / dist, ry = pdy / dist;
      const px = rx * 0.9 + tx * 0.1;
      const py = ry * 0.9 + ty * 0.1;
      dx = dx * (1 - w) + px * w;
      dy = dy * (1 - w) + py * w;
      dz = dz * (1 - w) + 0.08 * w;
      len = 1 - 0.45 * w; // 压倒区有效长度变短
    }

    const inv = 1 / Math.hypot(dx, dy, dz);
    dirs[i * 3] = dx * inv;
    dirs[i * 3 + 1] = dy * inv;
    dirs[i * 3 + 2] = dz * inv;
    lens[i] = len;
  }
  writeAttr(geo, dirs, lens);
}

/**
 * 圆球毛方向场(物体空间)。
 * 全局梳向投影到切面 + 一个绕压痕中心的漩涡状压倒区。
 * 因为写在物体空间,球体旋转时压痕严格跟着表面走。
 */
export function computeSphereField(
  geo: THREE.BufferGeometry,
  comb: CombParams,
  press: SpherePress,
) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const dirs = new Float32Array(n * 3);
  const lens = new Float32Array(n);

  const az = (comb.azimuthDeg * Math.PI) / 180;
  const C = new THREE.Vector3(Math.cos(az), 0, Math.sin(az)); // 物体空间梳向
  const tilt = comb.tilt;
  const pDir = press.dir.clone().normalize();
  const pAng = (press.angleDeg * Math.PI) / 180;

  const nv = new THREE.Vector3(), t = new THREE.Vector3(), swirl = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    nv.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();

    // 梳向在切平面上的投影
    t.copy(C).addScaledVector(nv, -C.dot(nv));
    if (t.lengthSq() < 1e-6) t.set(1, 0, 0).addScaledVector(nv, -nv.x);
    t.normalize();

    let dx = nv.x * (1 - tilt) + t.x * tilt;
    let dy = nv.y * (1 - tilt) + t.y * tilt;
    let dz = nv.z * (1 - tilt) + t.z * tilt;
    let len = 1;

    // 漩涡压痕: 绕压痕中心打圈并压倒
    const ang = Math.acos(Math.min(1, Math.max(-1, nv.dot(pDir))));
    const w = press.strength * smoothstepAB(pAng, pAng * 0.35, ang);
    if (w > 1e-4) {
      swirl.crossVectors(pDir, nv);
      if (swirl.lengthSq() > 1e-6) {
        swirl.normalize();
        dx = dx * (1 - w) + (swirl.x * 0.92 + nv.x * 0.08) * w;
        dy = dy * (1 - w) + (swirl.y * 0.92 + nv.y * 0.08) * w;
        dz = dz * (1 - w) + (swirl.z * 0.92 + nv.z * 0.08) * w;
        len = 1 - 0.5 * w;
      }
    }

    const inv = 1 / Math.hypot(dx, dy, dz);
    dirs[i * 3] = dx * inv;
    dirs[i * 3 + 1] = dy * inv;
    dirs[i * 3 + 2] = dz * inv;
    lens[i] = len;
  }
  writeAttr(geo, dirs, lens);
}
