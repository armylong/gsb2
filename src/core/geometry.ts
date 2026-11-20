/**
 * 演示几何体：一个平面，左半区 UV 正常，右半区 UV 水平镜像
 * （模拟「同一张贴图镜像铺到模型另一侧」）。
 * 可选在接缝处插入退化 UV 条带（u 被压平为常数，det = 0），
 * 用于演示「标出退化坐标区域」。
 */
import {
  frameFromTriangle,
  v3,
  DEGENERATE_DET_EPS,
  type TangentFrame,
  type Vec2,
  type Vec3,
} from './tangentSpace';

export interface MirroredPlaneData {
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  /** vec3，世界空间切线 */
  tangents: Float32Array;
  /** 每顶点手性 +1 / -1 */
  handedness: Float32Array;
  /** 1 = 退化坐标顶点（相邻三角形 UV 雅可比 ≈ 0） */
  degenerate: Float32Array;
  /** 0 = 左区，1 = 右区（对照模式用） */
  region: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

export interface BuildOptions {
  segX?: number; // 每半区横向分段，默认 48
  segY?: number; // 纵向分段，默认 24
  degenerateBand?: boolean; // 是否在接缝插入退化条带
  bandWidth?: number; // 退化条带宽度，默认 0.16
}

export function buildMirroredPlane(opts: BuildOptions = {}): MirroredPlaneData {
  const segX = opts.segX ?? 48;
  const segY = opts.segY ?? 24;
  const band = opts.degenerateBand ?? false;
  const bandW = opts.bandWidth ?? 0.16;

  const nx = segX * 2 + 1; // 总列数（左右两半）
  const ny = segY + 1;
  const count = nx * ny;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const region = new Float32Array(count);

  const X0 = -2, X1 = 2, Y0 = -1, Y1 = 1;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const x = X0 + ((X1 - X0) * i) / (nx - 1);
      const y = Y0 + ((Y1 - Y0) * j) / (ny - 1);
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = 0;

      const t = (x - X0) / (X1 - X0); // 0..1 全宽
      let u: number;
      if (band && Math.abs(x) < bandW / 2) {
        u = 0.5; // 退化条带：u 压平为常数 → det = 0
      } else if (x <= 0) {
        u = 2 * t; // 左半区：u 0→1
      } else {
        u = 2 - 2 * t; // 右半区：u 1→0（镜像）
      }
      const v = (y - Y0) / (Y1 - Y0);
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
      region[idx] = x <= 0 ? 0 : 1;
    }
  }

  const quadsX = nx - 1, quadsY = ny - 1;
  const indices = new Uint32Array(quadsX * quadsY * 6);
  let k = 0;
  for (let j = 0; j < quadsY; j++) {
    for (let i = 0; i < quadsX; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }

  // 每顶点累加切线 / 手性 / 退化标记
  const normals = new Float32Array(count * 3);
  const tangents = new Float32Array(count * 3);
  const handedness = new Float32Array(count).fill(1);
  const degenerate = new Float32Array(count);
  const handSet = new Uint8Array(count);

  const getP = (vi: number): Vec3 => [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]];
  const getUV = (vi: number): Vec2 => [uvs[vi * 2], uvs[vi * 2 + 1]];

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const frame = frameFromTriangle(getP(i0), getP(i1), getP(i2), getUV(i0), getUV(i1), getUV(i2));
    for (const vi of [i0, i1, i2]) {
      if (frame === null) {
        degenerate[vi] = 1;
        continue;
      }
      tangents[vi * 3] += frame.T[0];
      tangents[vi * 3 + 1] += frame.T[1];
      tangents[vi * 3 + 2] += frame.T[2];
      normals[vi * 3] += frame.N[0];
      normals[vi * 3 + 1] += frame.N[1];
      normals[vi * 3 + 2] += frame.N[2];
      if (!handSet[vi]) {
        handedness[vi] = frame.w;
        handSet[vi] = 1;
      }
      if (Math.abs(frame.det) < DEGENERATE_DET_EPS) degenerate[vi] = 1;
    }
  }
  // 归一化
  for (let vi = 0; vi < count; vi++) {
    const n = v3.normalize([normals[vi * 3], normals[vi * 3 + 1], normals[vi * 3 + 2]]);
    normals[vi * 3] = n[0]; normals[vi * 3 + 1] = n[1]; normals[vi * 3 + 2] = n[2];
    const t = v3.normalize([tangents[vi * 3], tangents[vi * 3 + 1], tangents[vi * 3 + 2]]);
    tangents[vi * 3] = t[0]; tangents[vi * 3 + 1] = t[1]; tangents[vi * 3 + 2] = t[2];
    if (v3.len(t) < 1e-6) degenerate[vi] = 1; // 完全无法定义切线
  }

  return { positions, uvs, normals, tangents, handedness, degenerate, region, indices, vertexCount: count };
}

/** 取离 (x, y) 最近顶点的切线框架与 UV（页面点选 / 验证脚本采样用） */
export function frameAtPoint(
  geo: MirroredPlaneData,
  x: number,
  y: number,
): { frame: TangentFrame; uv: Vec2; degenerate: boolean; region: 0 | 1; vertexIndex: number } {
  let best = 0, bestD = Infinity;
  for (let vi = 0; vi < geo.vertexCount; vi++) {
    const dx = geo.positions[vi * 3] - x;
    const dy = geo.positions[vi * 3 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = vi; }
  }
  const T: Vec3 = [geo.tangents[best * 3], geo.tangents[best * 3 + 1], geo.tangents[best * 3 + 2]];
  const N: Vec3 = [geo.normals[best * 3], geo.normals[best * 3 + 1], geo.normals[best * 3 + 2]];
  const w = (geo.handedness[best] >= 0 ? 1 : -1) as 1 | -1;
  const B = v3.scale(v3.cross(N, T), w);
  return {
    frame: { T, B, N, w, det: w }, // det 仅保留符号信息；精确 det 见三角形级计算
    uv: [geo.uvs[best * 2], geo.uvs[best * 2 + 1]],
    degenerate: geo.degenerate[best] > 0.5,
    region: (geo.region[best] >= 0.5 ? 1 : 0) as 0 | 1,
    vertexIndex: best,
  };
}
