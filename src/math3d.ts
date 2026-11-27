// 最小化的向量 / 列主序 4x4 矩阵库（与 WebGL 约定一致）。

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Mat4 = Float32Array; // 长度 16，列主序

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// 标准 OpenGL 风格透视投影（右手、相机朝 -Z、NDC z∈[-1,1]）
export function mat4Perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

// lookAt，eye/center/up 都是世界坐标
export function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(center, eye)); // 相机 -Z
  const s = normalize(cross(f, up)); // 相机 +X
  const u = cross(s, f); // 相机 +Y
  const m = mat4Identity();
  m[0] = s[0]; m[4] = s[1]; m[8] = s[2];
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
  m[12] = -dot(s, eye);
  m[13] = -dot(u, eye);
  m[14] = dot(f, eye);
  return m;
}

export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function transformVec4(m: Mat4, x: number, y: number, z: number, w = 1): Vec4 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

// 列主序 4x4 求逆：内部转成行主序做 Gauss-Jordan 消元，再按列主序写回
export function invertMat4(a: Mat4): Mat4 {
  // row-major 4x4：A[r][c] = a[c*4+r]
  const A: number[][] = [];
  for (let r = 0; r < 4; r++) {
    A.push([a[r], a[4 + r], a[8 + r], a[12 + r]]);
  }
  const aug: number[][] = A.map((row, i) =>
    row.concat([i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0])
  );

  for (let col = 0; col < 4; col++) {
    // 选主元
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return mat4Identity();
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];

    const pivVal = aug[col][col];
    for (let k = 0; k < 8; k++) aug[col][k] /= pivVal;

    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let k = 0; k < 8; k++) aug[r][k] -= factor * aug[col][k];
    }
  }

  // 逆矩阵在右半部分（行主序），转回列主序
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[c * 4 + r] = aug[r][c + 4];
    }
  }
  return out;
}

export interface OrbitCamera {
  azimuthDeg: number; // 绕 Y
  elevationDeg: number; // 与板平面(XZ)的夹角
  distance: number;
  target: Vec3;
}

export function orbitEye(cam: OrbitCamera): Vec3 {
  const az = (cam.azimuthDeg * Math.PI) / 180;
  const el = (cam.elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  const d = cam.distance;
  return [
    cam.target[0] + d * ce * Math.sin(az),
    cam.target[1] + d * Math.sin(el),
    cam.target[2] + d * ce * Math.cos(az),
  ];
}

// 俯仰接近 90° 时换一个参考上方向，避免退化
export function orbitUp(cam: OrbitCamera): Vec3 {
  return cam.elevationDeg > 89.5 ? [0, 0, -1] : [0, 1, 0];
}

// 把 NDC 坐标反投影成世界空间射线
export function ndcToRay(
  invViewProj: Mat4,
  ndcX: number,
  ndcY: number
): { origin: Vec3; dir: Vec3 } {
  const near = transformVec4(invViewProj, ndcX, ndcY, -1, 1);
  const far = transformVec4(invViewProj, ndcX, ndcY, 1, 1);
  const p0: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
  const p1: Vec3 = [far[0] / far[3], far[1] / far[3], far[2] / far[3]];
  return { origin: p0, dir: normalize(sub(p1, p0)) };
}

// 射线与 y=0 平面求交，返回交点；射线与平面平行或落在相机后方返回 null
export function rayPlaneY0(origin: Vec3, dir: Vec3): Vec3 | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = -origin[1] / dir[1];
  if (t <= 0) return null;
  return [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t];
}
