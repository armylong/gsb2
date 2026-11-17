/**
 * facemath.ts —— 立方体环境贴图方向约定与纯数学核心(不依赖 three.js)
 *
 * 统一约定(所有视图、纹理、读数都遵循同一约定):
 *   世界坐标系:右手系,X 右、Y 上、Z 朝向观察者(+Z 朝屏外)。
 *   六面以其法线(指向立方盒外侧)命名:+X / -X / +Y / -Y / +Z / -Z。
 *   每面使用规范基 (r, u, d):r = 纹理向右方向,u = 纹理向上方向,d = 面法线(朝外)。
 *   纹理坐标 (u, v) 均为 0..1,原点在左上角,u 向右、v 向下。
 *   面内网格 GRID×GRID,格子编号 idx = row*GRID + col(从左上角 0 开始)。
 *
 *   该约定与 WebGL 立方体贴图规范一致(three.js CubeTexture 的 px/nx/py/ny/pz/nz
 *   即此顺序),所以程序化纹理可直接用于真实反射,不存在"约定与渲染两张皮"。
 */

export type Vec3 = [number, number, number];
export type FaceId = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
export type Side = 'left' | 'right' | 'top' | 'bottom';
export const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];

export const GRID = 8;
export const FACE_ORDER: FaceId[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

export const FACE_LABEL: Record<FaceId, string> = {
  px: '+X 右面',
  nx: '-X 左面',
  py: '+Y 上面',
  ny: '-Y 下面',
  pz: '+Z 前面',
  nz: '-Z 后面',
};

/** 面的短符号名,用于图面标注 */
export const FACE_SHORT: Record<FaceId, string> = {
  px: '+X', nx: '-X', py: '+Y', ny: '-Y', pz: '+Z', nz: '-Z',
};

/** 每面的规范基:r = 纹理右方向,u = 纹理上方向,d = 面法线(朝外) */
interface FaceDef { id: FaceId; d: Vec3; r: Vec3; u: Vec3 }

const FACE_DEFS: Record<FaceId, FaceDef> = {
  px: { id: 'px', d: [1, 0, 0],  r: [0, 0, -1], u: [0, 1, 0] },
  nx: { id: 'nx', d: [-1, 0, 0], r: [0, 0, 1],  u: [0, 1, 0] },
  py: { id: 'py', d: [0, 1, 0],  r: [1, 0, 0],  u: [0, 0, -1] },
  ny: { id: 'ny', d: [0, -1, 0], r: [1, 0, 0],  u: [0, 0, 1] },
  pz: { id: 'pz', d: [0, 0, 1],  r: [1, 0, 0],  u: [0, 1, 0] },
  nz: { id: 'nz', d: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
};

export function faceDef(id: FaceId): FaceDef { return FACE_DEFS[id]; }
export function faceNormal(id: FaceId): Vec3 { return FACE_DEFS[id].d; }
export function faceUp(id: FaceId): Vec3 { return FACE_DEFS[id].u; }
export function faceRight(id: FaceId): Vec3 { return FACE_DEFS[id].r; }

/* ---------------- 基础向量运算 ---------------- */

export const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function vlen(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export const veq = (a: Vec3, b: Vec3, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
export const vfmt = (a: Vec3): string =>
  `(${a[0].toFixed(3)}, ${a[1].toFixed(3)}, ${a[2].toFixed(3)})`;

/* ---------------- 面 <-> 3D 方向 往返映射 ---------------- */

export interface FaceUV { face: FaceId; u: number; v: number }

/**
 * 规范面上 (u,v) 点对应的 3D 方向(单位向量,立方盒半径 1 的表面点)。
 * 纹理左上角 (0,0):沿 -r、-u;右下角 (1,1):沿 +r、+u。
 */
export function faceBasis(face: FaceId, u: number, v: number): Vec3 {
  const def = FACE_DEFS[face];
  return vnorm(vadd(vadd(def.d, vscale(def.r, u * 2 - 1)), vscale(def.u, v * 2 - 1)));
}

/** 3D 方向 -> 命中的规范面与纹理坐标(faceBasis 的逆运算) */
export function vectorToFace(dir: Vec3): FaceUV {
  const [x, y, z] = dir;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face: FaceId;
  let sc: number; // 主轴分量绝对值
  if (ax >= ay && ax >= az) { face = x > 0 ? 'px' : 'nx'; sc = ax; }
  else if (ay >= az) { face = y > 0 ? 'py' : 'ny'; sc = ay; }
  else { face = z > 0 ? 'pz' : 'nz'; sc = az; }
  const def = FACE_DEFS[face];
  const u = 0.5 + vdot(dir, def.r) / (2 * sc);
  const v = 0.5 + vdot(dir, def.u) / (2 * sc);
  return { face, u: clamp01(u), v: clamp01(v) };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 网格行列(0..GRID-1)与编号互转 */
export const cellIndex = (row: number, col: number): number => row * GRID + col;
export const cellRow = (idx: number): number => Math.floor(idx / GRID);
export const cellCol = (idx: number): number => idx % GRID;

/** 面内网格格子中心 -> 3D 方向 */
export function cellCenterDir(face: FaceId, row: number, col: number): Vec3 {
  const u = (col + 0.5) / GRID;
  const v = (row + 0.5) / GRID;
  return faceBasis(face, u, v);
}
/* ---------------- 反射 ---------------- */

/** 标准反射向量 R = I - 2(N·I)N(I 为入射方向,从表面指向相机) */
export function reflect(incident: Vec3, normal: Vec3): Vec3 {
  const n = vnorm(normal);
  const i = vnorm(incident);
  return vnorm(vsub(i, vscale(n, 2 * vdot(n, i))));
}

/* ---------------- 边与邻接关系 ---------------- */

export interface FaceEdge { face: FaceId; side: Side }

/** 规范面某条边的 3D 切线方向(沿纹理 u 增大或 v 增大的方向) */
export function sideTangent(face: FaceId, side: Side): Vec3 {
  const def = FACE_DEFS[face];
  return side === 'left' || side === 'right' ? def.u : def.r;
}

/** 边的稳定字符串键,用于邻接配对 */
export function edgeKey(e: FaceEdge): string { return `${e.face}:${e.side}`; }

/** 边上第 tick 个刻度(0..GRID)处的 3D 点(位于半径 1 的立方盒表面) */
export function edgePoint(e: FaceEdge, tick: number): Vec3 {
  const t = tick / GRID; // 0..1,沿"纹理坐标递增"方向
  const def = FACE_DEFS[e.face];
  let p: Vec3 = def.d;
  if (e.side === 'left') p = vadd(p, vscale(def.r, -1));
  if (e.side === 'right') p = vadd(p, vscale(def.r, 1));
  if (e.side === 'top') p = vadd(p, vscale(def.u, -1));
  if (e.side === 'bottom') p = vadd(p, vscale(def.u, 1));
  // 沿边移动:左右边沿 u 方向(v 变化),上下边沿 r 方向(u 变化)
  const tan = sideTangent(e.face, e.side);
  p = vadd(p, vscale(tan, (e.side === 'left' || e.side === 'right' ? t * 2 - 1 : t * 2 - 1)));
  return p;
}

/** 全部 24 条面边 */
export const ALL_EDGES: FaceEdge[] = FACE_ORDER.flatMap((face) =>
  SIDES.map((side) => ({ face, side })),
);

/**
 * 12 条共享边:每条记录两侧的面边。
 * 程序化推导:沿两条边逐刻度取 3D 点,点集相同即同一条立方体棱。
 */
export interface SharedEdge { id: number; a: FaceEdge; b: FaceEdge }

function pointSetKey(p: Vec3): string {
  return `${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])}`;
}

function edgeSignature(e: FaceEdge): string {
  const pts: string[] = [];
  for (let t = 0; t <= GRID; t++) pts.push(pointSetKey(edgePoint(e, t)));
  return [...new Set(pts)].sort().join('|');
}

function buildSharedEdges(): SharedEdge[] {
  const groups = new Map<string, FaceEdge[]>();
  for (const e of ALL_EDGES) {
    const sig = edgeSignature(e);
    const arr = groups.get(sig) ?? [];
    arr.push(e);
    groups.set(sig, arr);
  }
  const out: SharedEdge[] = [];
  let id = 0;
  for (const arr of groups.values()) {
    if (arr.length !== 2) throw new Error(`立方体棱配对异常:${arr.length} 条边同签名`);
    out.push({ id: ++id, a: arr[0], b: arr[1] });
  }
  // 稳定排序,便于读数对照
  return out.sort((s, t) => edgeKey(s.a).localeCompare(edgeKey(t.a))).map((s, i) => ({ ...s, id: i + 1 }));
}

export const SHARED_EDGES: SharedEdge[] = buildSharedEdges();

const edgeIndex = new Map<string, SharedEdge>();
for (const se of SHARED_EDGES) {
  edgeIndex.set(edgeKey(se.a), se);
  edgeIndex.set(edgeKey(se.b), se);
}

/** 查一条面边所属的共享边 */
export function sharedEdgeOf(e: FaceEdge): SharedEdge {
  const se = edgeIndex.get(edgeKey(e));
  if (!se) throw new Error(`找不到邻接边:${edgeKey(e)}`);
  return se;
}

/** 一条面边的对侧(相邻面上的对应边) */
export function neighborEdge(e: FaceEdge): FaceEdge {
  const se = sharedEdgeOf(e);
  return edgeKey(se.a) === edgeKey(e) ? se.b : se.a;
}

/**
 * 给定 3D 方向,找离它最近的共享棱(用于把反射射线附近的棱在展开图/3D 中高亮)。
 * 度量:方向与棱"中点方向"的夹角(即到整条棱的最小角距离),
 * 不能只比较两端点 —— 方向靠近立方体角点时多条棱会在端点打平。
 */
export function nearestSharedEdge(dir: Vec3): SharedEdge {
  const d = vnorm(dir);
  let best: SharedEdge = SHARED_EDGES[0];
  let bestScore = -Infinity;
  for (const se of SHARED_EDGES) {
    const mid = vnorm(edgePoint(se.a, GRID / 2));
    const score = vdot(d, mid);
    if (score > bestScore) { bestScore = score; best = se; }
  }
  return best;
}

/**
 * 两条邻边的刻度方向是否相反。
 * 共享一条棱时,两侧纹理沿棱的递增方向要么同向、要么反向;
 * 反向时 tick A 的对应刻度是 (GRID - tick)。这是"边缘两侧方向一致性"的关键读数。
 */
export function edgeTickReversed(a: FaceEdge, b: FaceEdge): boolean {
  return !veq(sideTangent(a.face, a.side), sideTangent(b.face, b.side));
}

/** 给定边上刻度 tick,返回相邻面边上的对应刻度 */
export function neighborTick(e: FaceEdge, tick: number): number {
  const n = neighborEdge(e);
  return edgeTickReversed(e, n) ? GRID - tick : tick;
}

/* ---------------- 单面错误变换(旋转 / 翻转) ---------------- */

export interface FaceTransform {
  /** 顺时针旋转的 90° 倍数:0 | 1 | 2 | 3,在翻转之后施加 */
  rot: 0 | 1 | 2 | 3;
  /** 水平镜像(沿竖直轴翻转) */
  flip: boolean;
}

export const IDENTITY_TRANSFORM: FaceTransform = { rot: 0, flip: false };
export type TransformMap = Record<FaceId, FaceTransform>;

export function identityTransforms(): TransformMap {
  return {
    px: { ...IDENTITY_TRANSFORM }, nx: { ...IDENTITY_TRANSFORM },
    py: { ...IDENTITY_TRANSFORM }, ny: { ...IDENTITY_TRANSFORM },
    pz: { ...IDENTITY_TRANSFORM }, nz: { ...IDENTITY_TRANSFORM },
  };
}

/** 规范坐标(显示错误前) -> 实际绘制坐标,坐标均为 0..1,原点左上 */
export function canonicalToDisplay(p: { u: number; v: number }, tr: FaceTransform): { u: number; v: number } {
  let { u, v } = p;
  if (tr.flip) u = 1 - u;
  for (let k = 0; k < tr.rot; k++) {
    const nu = 1 - v;
    const nv = u;
    u = nu; v = nv;
  }
  return { u, v };
}

/** 实际绘制坐标 -> 规范坐标(检查点读数用:看到的位置回溯到"本该是哪里") */
export function displayToCanonical(p: { u: number; v: number }, tr: FaceTransform): { u: number; v: number } {
  let { u, v } = p;
  // 逆向旋转(逆时针 90°)
  for (let k = 0; k < tr.rot; k++) {
    const nu = v;
    const nv = 1 - u;
    u = nu; v = nv;
  }
  if (tr.flip) u = 1 - u;
  return { u, v };
}

/** 显示态的一条边对应到规范面的哪条边 */
export function displaySideToCanonical(side: Side, tr: FaceTransform): Side {
  return pointToSide(displayToCanonical(sidePoint(side, GRID / 2), tr));
}

/** 边上某刻度(0..GRID)对应的面内 uv 点 */
export function sidePoint(side: Side, tick: number): { u: number; v: number } {
  const t = tick / GRID;
  switch (side) {
    case 'left': return { u: 0, v: t };
    case 'right': return { u: 1, v: t };
    case 'top': return { u: t, v: 0 };
    case 'bottom': return { u: t, v: 1 };
  }
}

/** uv 点落在哪条边;先按分量粗判,角点(同时落在两条边上)用最近边中点消歧 */
export function pointToSide(p: { u: number; v: number }): Side {
  const eps = 1e-9;
  const on: Side[] = [];
  if (p.u <= eps) on.push('left');
  if (p.u >= 1 - eps) on.push('right');
  if (p.v <= eps) on.push('top');
  if (p.v >= 1 - eps) on.push('bottom');
  if (on.length === 1) return on[0];
  if (on.length === 0) {
    // 不在边界上:取距离最近的边(理论上不会发生,防御性处理)
    return pointToSideNearest(p);
  }
  return pointToSideNearest(p, on);
}

function pointToSideNearest(p: { u: number; v: number }, candidates?: Side[]): Side {
  const mid: Record<Side, { u: number; v: number }> = {
    left: { u: 0, v: 0.5 }, right: { u: 1, v: 0.5 },
    top: { u: 0.5, v: 0 }, bottom: { u: 0.5, v: 1 },
  };
  const pool = candidates ?? SIDES;
  let best = pool[0];
  let bestD = Infinity;
  for (const s of pool) {
    const m = mid[s];
    const d = (p.u - m.u) ** 2 + (p.v - m.v) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/** uv 点在指定边上的刻度(0..GRID) */
export function tickOnSide(side: Side, p: { u: number; v: number }): number {
  return Math.round(((side === 'left' || side === 'right') ? p.v : p.u) * GRID);
}

/** 规范边 -> 变换后显示在哪条边(displaySideToCanonical 的逆) */
export function canonicalSideToDisplay(side: Side, tr: FaceTransform): Side {
  return pointToSide(canonicalToDisplay(sidePoint(side, GRID / 2), tr));
}
/**
 * 两个面在指定变换下,显示边 e 的刻度 tick 与邻面的对应刻度次序。
 * 严格走 显示→规范→邻面规范→邻面显示 的往返,不靠方向猜测。
 */
export interface TickPair { tickA: number; tickB: number; reversed: boolean }

export function displayTickCorrespondence(e: FaceEdge, tick: number, transforms: TransformMap): TickPair {
  const trA = transforms[e.face];
  // 边身份一律由"边中点的映射"确定(无角点歧义);角点只在已知边上取刻度
  const canonSideA = displaySideToCanonical(e.side, trA);
  const canonPointA = displayToCanonical(sidePoint(e.side, tick), trA);
  const canonTickA = tickOnSide(canonSideA, canonPointA);
  const canonEdgeA: FaceEdge = { face: e.face, side: canonSideA };
  const canonEdgeB = neighborEdge(canonEdgeA);
  const canonTickB = neighborTick(canonEdgeA, canonTickA);
  // 邻面:规范边刻度 -> 经其变换 -> 显示边(中点映射)与显示刻度(已知边上取坐标)
  const trB = transforms[canonEdgeB.face];
  const displaySideB = canonicalSideToDisplay(canonEdgeB.side, trB);
  const displayPointB = canonicalToDisplay(sidePoint(canonEdgeB.side, canonTickB), trB);
  const tickB = tickOnSide(displaySideB, displayPointB);
  // 两条显示边沿棱的 3D 切线是否反向(用于界面说明刻度方向)
  const reversed = !veq(sideTangent(e.face, e.side), sideTangent(canonEdgeB.face, displaySideB));
  return { tickA: tick, tickB, reversed };
}

/**
 * 带变换的环境命中:3D 反射方向 -> 实际看到的(面, 显示uv, 格子),
 * 以及"本该看到"的规范位置。两者不一致即说明该面被误转/误翻。
 */
export interface EnvironmentHit {
  face: FaceId;
  displayUV: { u: number; v: number };
  canonicalUV: { u: number; v: number };
  row: number;
  col: number;
  canonicalRow: number;
  canonicalCol: number;
  cellIdx: number;
  canonicalCellIdx: number;
  transform: FaceTransform;
  mismatched: boolean;
}

export function sampleEnvironment(dir: Vec3, transforms: TransformMap): EnvironmentHit {
  const target = vectorToFace(dir); // 物理反射真实命中的规范面与规范 uv
  const tr = transforms[target.face];
  // 纹理经过变换:规范内容出现在 displayUV
  const displayUV = canonicalToDisplay({ u: target.u, v: target.v }, tr);
  const col = clampCell(Math.floor(displayUV.u * GRID));
  const row = clampCell(Math.floor(displayUV.v * GRID));
  const cCol = clampCell(Math.floor(target.u * GRID));
  const cRow = clampCell(Math.floor(target.v * GRID));
  return {
    face: target.face,
    displayUV,
    canonicalUV: { u: target.u, v: target.v },
    row, col,
    canonicalRow: cRow, canonicalCol: cCol,
    cellIdx: cellIndex(row, col),
    canonicalCellIdx: cellIndex(cRow, cCol),
    transform: tr,
    mismatched: tr.rot !== 0 || tr.flip,
  };
}

const clampCell = (i: number): number => Math.min(GRID - 1, Math.max(0, i));

/** 边的展示色:12 条共享边各有固定 HSL 色,两侧面边同色 */
export function edgeColor(se: SharedEdge): string {
  return `hsl(${(se.id * 67) % 360} 85% 55%)`;
}

/** 每面底色(柔和、彼此不同,但不只靠颜色区分——另有文字/编号/箭头) */
export function faceTint(id: FaceId): string {
  const hues: Record<FaceId, number> = { px: 210, nx: 30, py: 120, ny: 280, pz: 0, nz: 180 };
  return `hsl(${hues[id]} 70% 88%)`;
}
