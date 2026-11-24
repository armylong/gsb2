export interface Vec2 {
  x: number;
  y: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 三角形：顶点是全局顶点数组的下标；color 为 0..1 的线性 RGB */
export interface Triangle {
  id: string;
  label: string;
  v: [number, number, number];
  color: RGB;
}

export type FillRule = "topleft" | "strict" | "inclusive";

export const FILL_RULE_LABEL: Record<FillRule, string> = {
  topleft: "左上规则（标准，公共边唯一归属）",
  strict: "严格 e>0（演示：边上咬出缺口）",
  inclusive: "全部 e>=0（演示：公共边被重复点亮）",
};

/** 屏幕坐标下的有向边，已按绕序归一化，使内部恒为 e>=0 */
interface NormEdge {
  /** 边函数系数：e(p) = A*px + B*py + C */
  A: number;
  B: number;
  C: number;
  /** 该边是否属于“顶边/左边”，顶/左边使用 e>=0，其余使用 e>0 */
  topLeft: boolean;
}

export interface SampleInfo {
  /** 采样点在像素格内的位置，0..1（相对像素左下角，x 向右 y 向上） */
  dx: number;
  dy: number;
  /** 覆盖该采样点的三角形 id（topleft 规则下至多 1 个） */
  owners: string[];
}

export interface PixelResult {
  px: number;
  py: number;
  /** 计算该像素时使用的填充规则 */
  rule: FillRule;
  /** 最终颜色（与背景混合后的 0..255 RGBA，alpha 恒为 255） */
  rgba: [number, number, number, number];
  samples: SampleInfo[];
  /** 被多个三角形同时占有的采样点个数 */
  conflictSamples: number;
  /** 落在公共边上、却没有任何三角形覆盖的采样点个数 */
  gapSamples: number;
  coverage: number; // 0..1
}

export interface RasterStats {
  /** 被覆盖（coverage>0）的像素数 */
  coveredPixels: number;
  /** 出现重复占用采样点的像素数 */
  conflictPixels: number;
  /** 公共边上出现漏采样点的像素数 */
  gapPixels: number;
  /** 每个三角形贡献的采样点总数（含公共边归属） */
  perTriangleSamples: Record<string, number>;
  /** 退化为线段/点而被跳过的三角形 id */
  degenerate: string[];
  /** 与绘制次序无关的覆盖指纹：每采样点归属集合 */
  fingerprint: string;
  /** 全画面平均最终颜色（0..255），用于平移时对照颜色变化 */
  averageColor: [number, number, number];
}

export interface RasterResult {
  pixels: PixelResult[];
  stats: RasterStats;
}

/** 采样模式：每个像素内的采样点（dx,dy ∈ [0,1)） */
export type SamplePattern = ReadonlyArray<readonly [number, number]>;

export const SAMPLE_PATTERNS: Record<string, SamplePattern> = {
  "1": [[0.5, 0.5]],
  // D3D 标准 4x 旋转栅格
  "4": [
    [0.125, 0.375],
    [0.375, 0.875],
    [0.625, 0.125],
    [0.875, 0.625],
  ],
  // 3x3 均匀栅格
  "9": [
    [1 / 6, 1 / 6],
    [0.5, 1 / 6],
    [5 / 6, 1 / 6],
    [1 / 6, 0.5],
    [0.5, 0.5],
    [5 / 6, 0.5],
    [1 / 6, 5 / 6],
    [0.5, 5 / 6],
    [5 / 6, 5 / 6],
  ],
  // 4x4 均匀栅格
  "16": buildGrid(4),
};

function buildGrid(n: number): SamplePattern {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out.push([(x + 0.5) / n, (y + 0.5) / n]);
    }
  }
  return out;
}

const EPS = 1e-7;
const DEGEN_EPS = 1e-9;

function buildEdges(verts: Vec2[], tri: Triangle): NormEdge[] | null {
  const p0 = verts[tri.v[0]];
  const p1 = verts[tri.v[1]];
  const p2 = verts[tri.v[2]];
  const area2 = edgeArea(p0, p1, p2);
  if (Math.abs(area2) < DEGEN_EPS) return null; // 退化：线段/点，不产生任何覆盖
  // area2>0 时三条边函数在内部点上为正，否则全部取反使内部恒为 e>=0
  const sign = area2 > 0 ? 1 : -1;
  return [
    normalizedEdge(p0, p1, sign),
    normalizedEdge(p1, p2, sign),
    normalizedEdge(p2, p0, sign),
  ];
}

function normalizedEdge(a: Vec2, b: Vec2, sign: number): NormEdge {
  const A = sign * (a.y - b.y);
  const B = sign * (b.x - a.x);
  const C = sign * (a.x * b.y - a.y * b.x);
  // y 向下的屏幕坐标，按归一化后的边方向判定（翻转绕序时 sign=-1，方向随之反转）：
  //  顶边 = 水平且朝右（B=0 且 A<0，等价 dx>0）；左边 = 沿边向下（B<0，等价 dy>0）
  const topLeft = (B === 0 && A < 0) || B < 0;
  return { A, B, C, topLeft };
}

function edgeArea(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function edgePasses(rule: FillRule, e: NormEdge, v: number): boolean {
  switch (rule) {
    case "strict":
      return v > EPS;
    case "inclusive":
      return v >= -EPS;
    case "topleft":
      return e.topLeft ? v >= -EPS : v > EPS;
  }
}

/** 点 p 是否在线段 ab 上（用于公共边漏检审计） */
function onSegment(p: Vec2, a: Vec2, b: Vec2, eps = 1e-6): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > eps) return false;
  const dot = (p.x - a.x) * (p.x - b.x) + (p.y - a.y) * (p.y - b.y);
  return dot <= eps;
}

export interface RasterInput {
  gridW: number;
  gridH: number;
  verts: Vec2[];
  triangles: Triangle[];
  pattern: SamplePattern;
  rule: FillRule;
  /** 每个三角形颜色的不透明度，用于混色演示 */
  alpha?: number;
  bg?: RGB;
}

export function rasterize(input: RasterInput): RasterResult {
  const { gridW, gridH, verts, triangles, pattern, rule } = input;
  const alpha = input.alpha ?? 0.75;
  const bg = input.bg ?? { r: 0.02, g: 0.03, b: 0.05 };

  // 每个三角形预计算归一化边；退化的直接跳过（绝不点亮一串像素）
  const edgeList: Array<{ tri: Triangle; edges: NormEdge[] }> = [];
  const degenerate: string[] = [];
  for (const tri of triangles) {
    const edges = buildEdges(verts, tri);
    if (edges === null) degenerate.push(tri.id);
    else edgeList.push({ tri, edges });
  }

  // 收集所有公共边（端点相同的无向边），供漏检审计
  const sharedEdges = collectSharedEdges(verts, triangles);

  const pixels: PixelResult[] = [];
  const perTriangleSamples: Record<string, number> = {};
  let coveredPixels = 0;
  let conflictPixels = 0;
  let gapPixels = 0;
  const fingerprintParts: string[] = [];

  for (let py = 0; py < gridH; py++) {
    for (let px = 0; px < gridW; px++) {
      const samples: SampleInfo[] = [];
      let r = 0;
      let g = 0;
      let b = 0;
      let conflictSamples = 0;
      let gapSamples = 0;
      let covered = 0;

      for (const [dx, dy] of pattern) {
        const sp: Vec2 = { x: px + dx, y: py + dy };
        const owners: string[] = [];
        for (const { tri, edges } of edgeList) {
          let inside = true;
          for (const e of edges) {
            const v = e.A * sp.x + e.B * sp.y + e.C;
            if (!edgePasses(rule, e, v)) {
              inside = false;
              break;
            }
          }
          if (inside) owners.push(tri.id);
        }
        if (owners.length > 0) covered++;
        if (owners.length > 1) conflictSamples++;
        if (
          owners.length === 0 &&
          sharedEdges.some(([a, c]) => onSegment(sp, a, c))
        ) {
          gapSamples++;
        }
        for (const id of owners) {
          perTriangleSamples[id] = (perTriangleSamples[id] ?? 0) + 1;
        }
        // 采样点颜色：多归属时做平均（用来肉眼看出“亮一道”）
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (const id of owners) {
          const t = triangles.find((q) => q.id === id)!;
          sr += t.color.r;
          sg += t.color.g;
          sb += t.color.b;
        }
        if (owners.length > 0) {
          const n = owners.length;
          r += (sr / n) * alpha;
          g += (sg / n) * alpha;
          b += (sb / n) * alpha;
        }
        if (owners.length > 0 || gapSamples > 0) {
          fingerprintParts.push(
            `${px},${py},${dx.toFixed(4)},${dy.toFixed(4)}:[${owners.join("|")}]`,
          );
        }
        samples.push({ dx, dy, owners });
      }

      const n = pattern.length;
      const cov = covered / n;
      const fr = bg.r * (1 - cov) + (r / n) + bg.r * (cov - (covered * alpha) / n);
      const fg = bg.g * (1 - cov) + (g / n) + bg.g * (cov - (covered * alpha) / n);
      const fb = bg.b * (1 - cov) + (b / n) + bg.b * (cov - (covered * alpha) / n);

      if (cov > 0) coveredPixels++;
      if (conflictSamples > 0) conflictPixels++;
      if (gapSamples > 0) gapPixels++;

      pixels.push({
        px,
        py,
        rule,
        rgba: [
          Math.round(fr * 255),
          Math.round(fg * 255),
          Math.round(fb * 255),
          255,
        ],
        samples,
        conflictSamples,
        gapSamples,
        coverage: cov,
      });
    }
  }

  // 只统计被覆盖像素的平均颜色，避免大面积背景把变化稀释掉
  const avg = [0, 0, 0];
  let avgN = 0;
  for (const p of pixels) {
    if (p.coverage > 0) {
      avg[0] += p.rgba[0];
      avg[1] += p.rgba[1];
      avg[2] += p.rgba[2];
      avgN++;
    }
  }

  return {
    pixels,
    stats: {
      coveredPixels,
      conflictPixels,
      gapPixels,
      perTriangleSamples,
      degenerate,
      fingerprint: fingerprintParts.sort().join(";"),
      averageColor: [
        avgN ? Math.round(avg[0] / avgN) : 0,
        avgN ? Math.round(avg[1] / avgN) : 0,
        avgN ? Math.round(avg[2] / avgN) : 0,
      ],
    },
  };
}

/** 找出三角形之间端点相同的公共边（顶点坐标比较） */
export function collectSharedEdges(
  verts: Vec2[],
  triangles: Triangle[],
): Array<[Vec2, Vec2]> {
  const key = (v: Vec2) => `${v.x.toFixed(6)},${v.y.toFixed(6)}`;
  const edgeMap = new Map<string, [Vec2, Vec2]>();
  const out: Array<[Vec2, Vec2]> = [];
  for (const t of triangles) {
    const pairs: Array<[number, number]> = [
      [t.v[0], t.v[1]],
      [t.v[1], t.v[2]],
      [t.v[2], t.v[0]],
    ];
    for (const [i, j] of pairs) {
      const a = verts[i];
      const b = verts[j];
      const ek = [key(a), key(b)].sort().join("~");
      if (edgeMap.has(ek)) out.push([a, b]);
      else edgeMap.set(ek, [a, b]);
    }
  }
  return out;
}

export function sameCoverage(a: RasterResult, b: RasterResult): boolean {
  return a.stats.fingerprint === b.stats.fingerprint;
}
