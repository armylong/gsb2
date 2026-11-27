import { Mat4, Vec2, Vec3, Vec4, transformVec4 } from './math3d';

// 长方形板，铺在 y=0 平面，中心在原点。X 方向 10 格、Z 方向 7 格。
export const BOARD_W = 10;
export const BOARD_D = 7;
export const COLS = 10;
export const ROWS = 7;

export type Diagonal = 'A' | 'B';

export interface BoardCorner {
  pos: Vec3;
  uv: Vec2;
}

// 角点编号：
// 0 ---- 1   (z = -D/2)
// |      |
// 3 ---- 2   (z = +D/2)
export function buildCorners(): BoardCorner[] {
  const hw = BOARD_W / 2;
  const hd = BOARD_D / 2;
  return [
    { pos: [-hw, 0, -hd], uv: [0, 0] },
    { pos: [hw, 0, -hd], uv: [1, 0] },
    { pos: [hw, 0, hd], uv: [1, 1] },
    { pos: [-hw, 0, hd], uv: [0, 1] },
  ];
}

// 两种三角剖分（顶点索引对应 buildCorners 的编号）
export function triangleIndexSets(d: Diagonal): [number, number, number][] {
  return d === 'A'
    ? [
        [0, 1, 2],
        [0, 2, 3],
      ]
    : [
        [0, 1, 3],
        [1, 2, 3],
      ];
}

export function diagonalEndpointIndices(d: Diagonal): [number, number] {
  return d === 'A' ? [0, 2] : [1, 3];
}

// 世界坐标 (x, 0, z) -> 纹理 uv；板外返回 null
export function worldToBoardUV(p: Vec3): Vec2 | null {
  const u = (p[0] + BOARD_W / 2) / BOARD_W;
  const v = (p[2] + BOARD_D / 2) / BOARD_D;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u, v];
}

export function cellOfUV(uv: Vec2): { col: number; row: number } {
  return {
    col: Math.min(COLS - 1, Math.floor(uv[0] * COLS)),
    row: Math.min(ROWS - 1, Math.floor(uv[1] * ROWS)),
  };
}

// ---------------------------------------------------------------------------
// 程序生成的编号棋格纹理（2D canvas，再上传成 WebGL2 纹理）
// ---------------------------------------------------------------------------
export function makeCheckerCanvas(): HTMLCanvasElement {
  const cell = 100;
  const canvas = document.createElement('canvas');
  canvas.width = COLS * cell;
  canvas.height = ROWS * cell;
  const ctx = canvas.getContext('2d')!;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const dark = (c + r) % 2 === 0;
      ctx.fillStyle = dark ? '#c98a5e' : '#f2e2c8';
      ctx.fillRect(c * cell, r * cell, cell, cell);

      // 内边框，让每个格子的轮廓在透视下也清楚
      ctx.strokeStyle = 'rgba(60,40,25,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(c * cell + 2, r * cell + 2, cell - 4, cell - 4);

      // 编号：棋格序号 + (列,行)
      const id = r * COLS + c;
      ctx.fillStyle = dark ? '#fff4e6' : '#5b3a22';
      ctx.font = 'bold 30px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`#${id}`, c * cell + 10, r * cell + 8);
      ctx.font = '22px ui-monospace, monospace';
      ctx.fillText(`${c},${r}`, c * cell + 10, r * cell + 44);

      // 格子中心一个小圆点，方便观察扭曲
      ctx.beginPath();
      ctx.arc(c * cell + cell / 2, r * cell + cell / 2, 7, 0, Math.PI * 2);
      ctx.fillStyle = dark ? 'rgba(255,255,255,.85)' : 'rgba(90,58,34,.8)';
      ctx.fill();
    }
  }

  // 外框
  ctx.strokeStyle = '#2b1d12';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  return canvas;
}

// ---------------------------------------------------------------------------
// Clip space 几何：Sutherland–Hodgman 对 6 个视锥平面裁剪，再扇形三角化
// ---------------------------------------------------------------------------
export interface ClipVertex {
  clip: Vec4; // x,y,z,w
  uv: Vec2;
}
export type ClipTriangle = [ClipVertex, ClipVertex, ClipVertex];
export interface Segment {
  a: Vec2; // NDC
  b: Vec2;
}
export interface ClippedGeometry {
  triangles: ClipTriangle[];
  edges: Segment[]; // 所有输出三角形的边（NDC）
  diagonal: Segment[]; // 实际使用的对角线（裁剪后，NDC），可能为空
}

type Plane = 'l' | 'r' | 'b' | 't' | 'n' | 'f';

// 各平面的有符号“内侧距离”，>=0 表示在内侧
function signedDistance(p: ClipVertex, plane: Plane): number {
  const [x, y, z, w] = p.clip;
  switch (plane) {
    case 'l': return x + w;
    case 'r': return w - x;
    case 'b': return y + w;
    case 't': return w - y;
    case 'n': return z + w;
    case 'f': return w - z;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function intersectVertex(i: ClipVertex, j: ClipVertex, plane: Plane): ClipVertex {
  const di = signedDistance(i, plane);
  const dj = signedDistance(j, plane);
  const t = di / (di - dj);
  return {
    clip: [
      lerp(i.clip[0], j.clip[0], t),
      lerp(i.clip[1], j.clip[1], t),
      lerp(i.clip[2], j.clip[2], t),
      lerp(i.clip[3], j.clip[3], t),
    ],
    uv: [lerp(i.uv[0], j.uv[0], t), lerp(i.uv[1], j.uv[1], t)],
  };
}

function clipPolygonToPlane(poly: ClipVertex[], plane: Plane): ClipVertex[] {
  if (poly.length === 0) return poly;
  const out: ClipVertex[] = [];
  for (let k = 0; k < poly.length; k++) {
    const cur = poly[k];
    const prev = poly[(k + poly.length - 1) % poly.length];
    const curIn = signedDistance(cur, plane) >= 0;
    const prevIn = signedDistance(prev, plane) >= 0;
    if (curIn) {
      if (!prevIn) out.push(intersectVertex(prev, cur, plane));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersectVertex(prev, cur, plane));
    }
  }
  return out;
}

const PLANES: Plane[] = ['l', 'r', 'b', 't', 'n', 'f'];

function clipTriangle(tri: ClipTriangle): ClipVertex[] {
  let poly: ClipVertex[] = [tri[0], tri[1], tri[2]];
  for (const plane of PLANES) {
    poly = clipPolygonToPlane(poly, plane);
    if (poly.length === 0) break;
  }
  return poly;
}

function toNDC(v: ClipVertex): Vec2 {
  return [v.clip[0] / v.clip[3], v.clip[1] / v.clip[3]];
}

function pushEdgeUnique(edges: Segment[], a: Vec2, b: Vec2) {
  const key = (p: Vec2) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const ka = key(a);
  const kb = key(b);
  if (edges.some((e) => {
    const ea = key(e.a);
    const eb = key(e.b);
    return (ea === ka && eb === kb) || (ea === kb && eb === ka);
  })) {
    return;
  }
  edges.push({ a, b });
}

// 把一条世界空间端点连成的线段在 clip space 做同样的裁剪（用于画对角线）
function clipWorldSegment(viewProj: Mat4, pa: Vec3, pb: Vec3): Segment[] {
  const va: ClipVertex = {
    clip: transformVec4(viewProj, pa[0], pa[1], pa[2]),
    uv: [0, 0],
  };
  const vb: ClipVertex = {
    clip: transformVec4(viewProj, pb[0], pb[1], pb[2]),
    uv: [0, 0],
  };
  let poly: ClipVertex[] = [va, vb];
  for (const plane of PLANES) poly = clipPolygonToPlane(poly, plane);
  const segs: Segment[] = [];
  for (let k = 1; k < poly.length; k++) {
    segs.push({ a: toNDC(poly[k - 1]), b: toNDC(poly[k]) });
  }
  return segs;
}

export function buildClippedGeometry(
  viewProj: Mat4,
  corners: BoardCorner[],
  diagonal: Diagonal
): ClippedGeometry {
  const clipCorners: ClipVertex[] = corners.map((c) => ({
    clip: transformVec4(viewProj, c.pos[0], c.pos[1], c.pos[2]),
    uv: c.uv,
  }));

  const triangles: ClipTriangle[] = [];
  const edges: Segment[] = [];

  for (const [i, j, k] of triangleIndexSets(diagonal)) {
    const poly = clipTriangle([clipCorners[i], clipCorners[j], clipCorners[k]]);
    // 凸多边形扇形三角化
    for (let n = 1; n < poly.length - 1; n++) {
      const tri: ClipTriangle = [poly[0], poly[n], poly[n + 1]];
      triangles.push(tri);
      const p0 = toNDC(tri[0]);
      const p1 = toNDC(tri[1]);
      const p2 = toNDC(tri[2]);
      pushEdgeUnique(edges, p0, p1);
      pushEdgeUnique(edges, p1, p2);
      pushEdgeUnique(edges, p2, p0);
    }
  }

  const [d0, d1] = diagonalEndpointIndices(diagonal);
  const diagonalSegs = clipWorldSegment(
    viewProj,
    corners[d0].pos,
    corners[d1].pos
  );

  return { triangles, edges, diagonal: diagonalSegs };
}

// 世界点 -> NDC；相机后方或 w<=0 返回 null
export function projectToNDC(viewProj: Mat4, p: Vec3): Vec2 | null {
  const c = transformVec4(viewProj, p[0], p[1], p[2]);
  if (c[3] <= 1e-6) return null;
  return [c[0] / c[3], c[1] / c[3]];
}
