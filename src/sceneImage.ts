import type { ScenePreset, Vec2, Vec3 } from './types';

/**
 * 程序生成场景图:已知虚拟相机(主点居中、方形像素)渲染
 * 地面双向网格(间距 1m) + 若干箱子。两个预设:明显斜视 / 接近正视。
 */

export const PRESETS: ScenePreset[] = [
  {
    key: 'oblique',
    label: '斜视视角(灭点都在图内附近)',
    width: 960, height: 720,
    focal: 850, camHeight: 1.7,
    yawDeg: 30, depressionDeg: 20,
    boxes: [
      { x: 2.0, z: 4.5, w: 0.9, d: 0.9, h: 0.9 },
      { x: -2.2, z: 3.2, w: 0.7, d: 1.1, h: 0.5 },
      { x: 0.6, z: 7.5, w: 1.2, d: 0.8, h: 1.2 },
    ],
  },
  {
    key: 'frontal',
    label: '接近正视(一组灭点极远,易触发警告)',
    width: 960, height: 720,
    focal: 1050, camHeight: 1.6,
    yawDeg: 2, depressionDeg: 7,
    boxes: [
      { x: 1.6, z: 5.0, w: 0.9, d: 0.9, h: 0.9 },
      { x: -1.8, z: 4.0, w: 0.7, d: 1.1, h: 0.5 },
      { x: 0.2, z: 8.0, w: 1.2, d: 0.8, h: 1.2 },
    ],
  },
];

type Mat3 = number[][];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 由朝向构造世界->相机旋转(与 calibration.ts 的约定一致) */
export function rotationFromYawDep(yawDeg: number, depDeg: number): Mat3 {
  const yaw = yawDeg * Math.PI / 180;
  const dep = depDeg * Math.PI / 180;
  const f: Vec3 = [Math.sin(yaw) * Math.cos(dep), -Math.sin(dep), Math.cos(yaw) * Math.cos(dep)];
  const down: Vec3 = [0, -1, 0];
  const r1 = norm3(cross3(down, f));       // 相机 x(右)
  const r2 = cross3(f, r1) as Vec3;        // 相机 y(下)
  return [r1, r2, f];
}

export function projectWith(
  P: Vec3, R: Mat3, camH: number, focal: number, W: number, H: number,
): Vec2 | null {
  const dx = P[0], dy = P[1] - camH, dz = P[2];
  const xc = R[0][0] * dx + R[0][1] * dy + R[0][2] * dz;
  const yc = R[1][0] * dx + R[1][1] * dy + R[1][2] * dz;
  const zc = R[2][0] * dx + R[2][1] * dy + R[2][2] * dz;
  if (zc <= 1e-6) return null;
  return { x: W / 2 + focal * xc / zc, y: H / 2 + focal * yc / zc };
}

/** 相机坐标系下裁剪到近平面后投影线段 */
function drawSegment3D(
  ctx: CanvasRenderingContext2D,
  A: Vec3, B: Vec3, R: Mat3, camH: number, focal: number, W: number, H: number,
) {
  const toCam = (P: Vec3): Vec3 => {
    const dx = P[0], dy = P[1] - camH, dz = P[2];
    return [
      R[0][0] * dx + R[0][1] * dy + R[0][2] * dz,
      R[1][0] * dx + R[1][1] * dy + R[1][2] * dz,
      R[2][0] * dx + R[2][1] * dy + R[2][2] * dz,
    ];
  };
  const NEAR = 0.05;
  let a = toCam(A), b = toCam(B);
  if (a[2] <= NEAR && b[2] <= NEAR) return;
  if (a[2] <= NEAR || b[2] <= NEAR) {
    const t = (NEAR - a[2]) / (b[2] - a[2]);
    const m: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), NEAR];
    if (a[2] <= NEAR) a = m; else b = m;
  }
  const pa = { x: W / 2 + focal * a[0] / a[2], y: H / 2 + focal * a[1] / a[2] };
  const pb = { x: W / 2 + focal * b[0] / b[2], y: H / 2 + focal * b[1] / b[2] };
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
  ctx.stroke();
}

export function generateSceneImage(preset: ScenePreset): HTMLCanvasElement {
  const { width: W, height: H, focal, camHeight } = preset;
  const R = rotationFromYawDep(preset.yawDeg, preset.depressionDeg);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;

  // 天空
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#9db8d6');
  sky.addColorStop(1, '#cfd8e0');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // 地面:地平线以下填充。地平线 = 相机 z 轴在图像中的轨迹
  const hl = { a: R[2][0], b: R[2][1], c: R[2][2] * focal - R[2][0] * W / 2 - R[2][1] * H / 2 };
  // 地平线与图像边界求交,构造下半部分多边形
  const pts: Vec2[] = [];
  const edges: [Vec2, Vec2][] = [
    [{ x: 0, y: 0 }, { x: W, y: 0 }],
    [{ x: W, y: 0 }, { x: W, y: H }],
    [{ x: W, y: H }, { x: 0, y: H }],
    [{ x: 0, y: H }, { x: 0, y: 0 }],
  ];
  for (const [e1, e2] of edges) {
    const d1 = hl.a * e1.x + hl.b * e1.y + hl.c;
    const d2 = hl.a * e2.x + hl.b * e2.y + hl.c;
    if (d1 * d2 < 0) {
      const t = d1 / (d1 - d2);
      pts.push({ x: e1.x + t * (e2.x - e1.x), y: e1.y + t * (e2.y - e1.y) });
    }
  }
  if (pts.length === 2) {
    // 地面在 hl 值为负的一侧(相机下方)
    const testY = H / 2 + 100;
    const groundSide = (hl.a * W / 2 + hl.b * testY + hl.c) < 0;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    // 沿边界走到地面一侧的角
    const corners: Vec2[] = [
      { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
    ];
    const groundCorners = corners.filter(
      (cn) => (hl.a * cn.x + hl.b * cn.y + hl.c < 0) === groundSide,
    );
    // 按边界顺序连接:简单做法——直接画一个大三角形覆盖地面侧
    for (const gc of groundCorners) ctx.lineTo(gc.x, gc.y);
    ctx.closePath();
    const gnd = ctx.createLinearGradient(0, Math.min(pts[0].y, pts[1].y), 0, H);
    gnd.addColorStop(0, '#b8a888');
    gnd.addColorStop(1, '#8a7a5e');
    ctx.fillStyle = gnd;
    ctx.fill();
  }

  // 地面网格(间距 1m):X 方向线(沿世界 X 走)与 Z 方向线
  const EXT = 14;
  ctx.lineWidth = 1.2;
  for (let k = -EXT; k <= EXT; k++) {
    // 沿 X 方向(世界 Z = k)
    ctx.strokeStyle = k === 0 ? 'rgba(180,60,60,0.85)' : 'rgba(70,55,35,0.55)';
    drawSegment3D(ctx, [-EXT, 0, k], [EXT, 0, k], R, camHeight, focal, W, H);
    // 沿 Z 方向(世界 X = k)
    ctx.strokeStyle = k === 0 ? 'rgba(60,60,160,0.85)' : 'rgba(70,55,35,0.55)';
    drawSegment3D(ctx, [k, 0, -EXT], [k, 0, EXT], R, camHeight, focal, W, H);
  }

  // 箱子:按深度排序画面
  interface Face { pts: Vec2[]; depth: number; shade: number }
  const faces: Face[] = [];
  for (const b of preset.boxes) {
    const c8: Vec3[] = [];
    for (const dy of [0, b.h])
      for (const dz of [-b.d / 2, b.d / 2])
        for (const dx of [-b.w / 2, b.w / 2])
          c8.push([b.x + dx, dy, b.z + dz]);
    // 面索引(按 c8 的生成顺序: y, z, x 递增)
    const idx = (y: number, z: number, x: number) => y * 4 + z * 2 + x;
    const faceDefs: { corners: number[]; shade: number }[] = [
      { corners: [idx(1, 0, 0), idx(1, 0, 1), idx(1, 1, 1), idx(1, 1, 0)], shade: 1.0 },  // 顶面
      { corners: [idx(0, 0, 0), idx(0, 0, 1), idx(1, 0, 1), idx(1, 0, 0)], shade: 0.75 }, // z- 面
      { corners: [idx(0, 1, 0), idx(0, 1, 1), idx(1, 1, 1), idx(1, 1, 0)], shade: 0.6 },  // z+ 面
      { corners: [idx(0, 0, 0), idx(0, 1, 0), idx(1, 1, 0), idx(1, 0, 0)], shade: 0.85 }, // x- 面
      { corners: [idx(0, 0, 1), idx(0, 1, 1), idx(1, 1, 1), idx(1, 0, 1)], shade: 0.68 }, // x+ 面
    ];
    for (const fd of faceDefs) {
      const pts2: Vec2[] = [];
      let ok = true;
      let depth = 0;
      for (const ci of fd.corners) {
        const p = projectWith(c8[ci], R, camHeight, focal, W, H);
        if (!p) { ok = false; break; }
        pts2.push(p);
        const dvec: Vec3 = [c8[ci][0], c8[ci][1] - camHeight, c8[ci][2]];
        depth += dvec[0] * R[2][0] + dvec[1] * R[2][1] + dvec[2] * R[2][2];
      }
      if (ok) faces.push({ pts: pts2, depth: depth / 4, shade: fd.shade });
    }
  }
  faces.sort((a, b) => b.depth - a.depth);
  for (const fa of faces) {
    const base = 150 * fa.shade;
    ctx.fillStyle = `rgb(${base | 0},${(base * 0.82) | 0},${(base * 0.6) | 0})`;
    ctx.beginPath();
    ctx.moveTo(fa.pts[0].x, fa.pts[0].y);
    for (let i = 1; i < fa.pts.length; i++) ctx.lineTo(fa.pts[i].x, fa.pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,10,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  return cv;
}
