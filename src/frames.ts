import * as THREE from 'three';

/**
 * 沿路径的截面标架（平行传输标架 / rotation-minimizing frame）。
 * 法向在相邻采样点间只做"去切向分量"的平行传输，保证朝向连续、
 * 经过竖直段或空间弯曲时不会突然翻转。
 * 闭环时把整圈累积的扭转误差均匀分摊到每一环，使首尾标架精确对齐。
 */
export interface FrameSet {
  /** 采样点（闭环时不重复首尾点） */
  points: THREE.Vector3[];
  tangents: THREE.Vector3[];
  normals: THREE.Vector3[];
  binormals: THREE.Vector3[];
  /** 闭环时为对齐首尾而分摊的总扭转角（弧度）；开放路径为 0 */
  twistCorrection: number;
}

function initialNormal(t: THREE.Vector3): THREE.Vector3 {
  // 选与切向夹角最大的世界坐标轴，投影到切向的法平面上
  const ax = Math.abs(t.x), ay = Math.abs(t.y), az = Math.abs(t.z);
  const ref = ax <= ay && ax <= az
    ? new THREE.Vector3(1, 0, 0)
    : ay <= az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  return ref.sub(t.clone().multiplyScalar(ref.dot(t))).normalize();
}

/**
 * 精确平行传输：用把 tPrev 转到 tCur 的最小旋转（转轴为两切向的叉积）
 * 带动法向一起转。这是严格的旋转最小化传输——法平面之间的等距映射，
 * 不会像"投影+归一化"那样逐步引入虚假扭转。
 */
export function transportStep(prevN: THREE.Vector3, tPrev: THREE.Vector3, tCur: THREE.Vector3): THREE.Vector3 {
  const axis = tPrev.clone().cross(tCur);
  const sin = axis.length();
  if (sin < 1e-12) {
    // 切向平行（含反向）：最小旋转不改变（或绕法向转 180°，法向不变）
    return prevN.clone();
  }
  axis.divideScalar(sin);
  const angle = Math.atan2(sin, tPrev.dot(tCur));
  return rotateAround(prevN, axis, angle);
}

/** 绕轴 axis（单位向量）把 v 旋转 angle（罗德里格斯公式） */
function rotateAround(v: THREE.Vector3, axis: THREE.Vector3, angle: number): THREE.Vector3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return v.clone().multiplyScalar(c)
    .add(axis.clone().cross(v).multiplyScalar(s))
    .add(axis.clone().multiplyScalar(axis.dot(v) * (1 - c)));
}

/** 两单位向量绕轴的有符号夹角 */
export function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  return Math.atan2(a.clone().cross(b).dot(axis), a.dot(b));
}

export function computeFrames(points: THREE.Vector3[], closed: boolean): FrameSet {
  const n = points.length;
  if (n < 2) throw new Error('至少需要 2 个采样点');

  // --- 切向：中心差分 ---
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-20) t.set(1, 0, 0); // 退化时给任意方向，警告模块会报采样过近
    tangents.push(t.normalize());
  }

  // --- 法向：平行传输 ---
  const normals: THREE.Vector3[] = [initialNormal(tangents[0])];
  for (let i = 1; i < n; i++) {
    normals.push(transportStep(normals[i - 1], tangents[i - 1], tangents[i]));
  }

  // --- 闭环：把整圈扭转误差均匀分摊，使首尾标架一致 ---
  let twistCorrection = 0;
  if (closed) {
    // 从最后一环再传输回首环的切向平面，得到"自然"的首环法向预测值。
    // 平行传输是法平面之间的等距映射，与绕切向的旋转可交换，
    // 因此给第 i 环追加 mismatch*i/(n-1) 的扭转后，末环再传输回首环时精确对齐。
    const predicted = transportStep(normals[n - 1], tangents[n - 1], tangents[0]);
    const mismatch = signedAngle(predicted, normals[0], tangents[0]);
    twistCorrection = mismatch;
    for (let i = 1; i < n; i++) {
      normals[i] = rotateAround(normals[i], tangents[i], mismatch * (i / (n - 1)));
    }
  }

  const binormals = tangents.map((t, i) => t.clone().cross(normals[i]).normalize());

  return { points, tangents, normals, binormals, twistCorrection };
}
