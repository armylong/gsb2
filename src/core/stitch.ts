import type { MeshData, TopologyReport, Vec3 } from './types';
import { analyzeGraph, boundaryLoops, buildGraph, edgeKey, type MeshGraph } from './topology';
import { PointHash, distance, distanceSq } from './math';

/* ------------------------------------------------------------------ *
 * 边界链
 * ------------------------------------------------------------------ */

export interface BoundaryChain {
  /** 稳定 id */
  id: string;
  /** 沿边界有序的顶点编号 */
  vertices: number[];
  /** 相邻顶点之间的边界边 key；闭环会包含首尾边 */
  edgeKeys: string[];
  closed: boolean;
  /** 世界空间总长 */
  length: number;
}

/**
 * 从一组边界边中提取连通链。
 * 只接受确实属于 boundary 的边；分叉处会被截断（非流形边界不进入缝合流程）。
 */
export function buildChains(g: MeshGraph, selectedEdgeKeys: Iterable<string>): BoundaryChain[] {
  const keys = [...new Set(selectedEdgeKeys)].filter((k) => g.edges.get(k)?.cls === 'boundary');
  if (keys.length === 0) return [];
  const adj = new Map<number, Set<number>>();
  for (const k of keys) {
    const [a, b] = k.split('_').map(Number);
    let sa = adj.get(a);
    if (!sa) adj.set(a, (sa = new Set()));
    sa.add(b);
    let sb = adj.get(b);
    if (!sb) adj.set(b, (sb = new Set()));
    sb.add(a);
  }
  const used = new Set<string>();

  const walk = (start: number, firstNext: number): number[] => {
    const path = [start];
    let prev = start;
    let cur = firstNext;
    used.add(edgeKey(prev, cur));
    while (true) {
      path.push(cur);
      if (cur === start) break;
      const nexts = [...(adj.get(cur) ?? [])].filter((n) => !used.has(edgeKey(cur, n)));
      if (nexts.length !== 1) break;
      const next = nexts[0];
      used.add(edgeKey(cur, next));
      prev = cur;
      cur = next;
      void prev;
    }
    return path;
  };

  const chains: BoundaryChain[] = [];
  const endpoints = [...adj.entries()].filter(([, nbrs]) => nbrs.size === 1).map(([v]) => v);
  endpoints.sort((a, b) => a - b);
  for (const start of endpoints) {
    for (const nb of [...(adj.get(start) ?? [])].sort((a, b) => a - b)) {
      if (used.has(edgeKey(start, nb))) continue;
      const chain = finalizeChain(g, walk(start, nb), false);
      if (chain) chains.push(chain);
    }
  }
  // 剩余的是闭环（或分叉截断后的片段）
  for (const start of [...adj.keys()].sort((a, b) => a - b)) {
    for (const nb of [...(adj.get(start) ?? [])].sort((a, b) => a - b)) {
      if (used.has(edgeKey(start, nb))) continue;
      const chain = finalizeChain(g, walk(start, nb), true);
      if (chain) chains.push(chain);
    }
  }
  return chains;
}

function finalizeChain(g: MeshGraph, path: number[], mayClosed: boolean): BoundaryChain | null {
  let vertices = path.slice();
  // 闭环行走会回到起点，去掉重复的起点
  if (vertices.length >= 3 && vertices[vertices.length - 1] === vertices[0]) {
    vertices = vertices.slice(0, -1);
  }
  if (vertices.length < 2) return null;
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  const closed =
    mayClosed &&
    vertices.length >= 3 &&
    g.edges.get(edgeKey(last, first))?.cls === 'boundary' &&
    path.length === vertices.length + 1;

  if (closed) {
    let mi = 0;
    for (let i = 1; i < vertices.length; i++) if (vertices[i] < vertices[mi]) mi = i;
    vertices = [...vertices.slice(mi), ...vertices.slice(0, mi)];
    if (vertices[vertices.length - 1] < vertices[1]) {
      vertices = [vertices[0], ...vertices.slice(1).reverse()];
    }
  } else if (vertices[vertices.length - 1] < vertices[0]) {
    vertices.reverse();
  }

  const edgeKeys: string[] = [];
  let len = 0;
  for (let i = 0; i + 1 < vertices.length; i++) {
    edgeKeys.push(edgeKey(vertices[i], vertices[i + 1]));
    len += distance(g.points[vertices[i]], g.points[vertices[i + 1]]);
  }
  if (closed) {
    edgeKeys.push(edgeKey(vertices[vertices.length - 1], vertices[0]));
    len += distance(g.points[vertices[vertices.length - 1]], g.points[vertices[0]]);
  }
  const id = `${closed ? 'c' : 'o'}:${vertices[0]}-${vertices[vertices.length - 1]}#${vertices.length}`;
  return { id, vertices, edgeKeys, closed, length: len };
}

/* ------------------------------------------------------------------ *
 * 对应点候选与冲突
 * ------------------------------------------------------------------ */

export interface Candidate {
  a: number;
  b: number;
  distance: number;
}

export type ConflictKind = 'missing' | 'ambiguous' | 'crossing' | 'chain';
export type ChainSide = 'A' | 'B';

export interface StitchConflict {
  kind: ConflictKind;
  side: ChainSide;
  vertex?: number;
  candidates?: { a: number; b: number }[];
  message: string;
}

export interface StitchSession {
  chainA: BoundaryChain;
  chainB: BoundaryChain;
  tol: number;
  candidates: Candidate[];
  /** 被剔除的候选 id（candidateId） */
  excluded: Set<string>;
  /** 被明确跳过的顶点（允许留下自由边） */
  skipped: Set<number>;
  /** 会话级错误，例如两段链共用顶点 */
  issues: string[];
}

export function candidateId(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function createSession(
  g: MeshGraph,
  chainA: BoundaryChain,
  chainB: BoundaryChain,
  tol: number,
): StitchSession {
  const issues: string[] = [];
  if (chainA.id === chainB.id) issues.push('两段边界不能是同一条链');
  if (chainA.closed || chainB.closed) issues.push('闭环边界不能直接缝合（请框选开口的边界段）');
  const setA = new Set(chainA.vertices);
  const shared = chainB.vertices.filter((v) => setA.has(v));
  if (shared.length > 0) issues.push(`两段边界共用顶点 v${shared.slice(0, 6).join(', v')}，请重新框选`);
  const candidates = buildCandidates(g, chainA, chainB, tol);
  return { chainA, chainB, tol, candidates, excluded: new Set(), skipped: new Set(), issues };
}

export function buildCandidates(g: MeshGraph, chainA: BoundaryChain, chainB: BoundaryChain, tol: number): Candidate[] {
  if (tol <= 0) return [];
  const tol2 = tol * tol;
  const bSet = new Set(chainB.vertices);
  const bVerts = chainB.vertices;
  const hash = new PointHash(
    bVerts.map((v) => g.points[v]),
    Math.max(tol, 1e-9),
  );
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const a of chainA.vertices) {
    for (const j of hash.query(g.points[a])) {
      const b = bVerts[j];
      if (!bSet.has(b) || b === a) continue;
      const id = candidateId(a, b);
      if (seen.has(id)) continue;
      const d2 = distanceSq(g.points[a], g.points[b]);
      if (d2 > tol2) continue;
      // 已经共享拓扑连接的顶点不算候选
      if (g.edges.has(edgeKey(a, b))) continue;
      seen.add(id);
      out.push({ a, b, distance: Math.sqrt(d2) });
    }
  }
  out.sort((x, y) => x.a - y.a || x.b - y.b);
  return out;
}

export function activeCandidates(s: StitchSession): Candidate[] {
  return s.candidates.filter(
    (c) => !s.excluded.has(candidateId(c.a, c.b)) && !s.skipped.has(c.a) && !s.skipped.has(c.b),
  );
}

export interface PairingResult {
  pairs: { a: number; b: number; distance: number }[];
  conflicts: StitchConflict[];
  ready: boolean;
}

/**
 * 计算最终配对。
 * 规则：除被跳过的顶点外，两段链上的每个顶点必须恰好有一个未剔除候选；且配对顺序不交叉。
 * 任何不满足的情况都保留为冲突（不静默丢弃），由用户剔除候选或跳过顶点。
 */
export function resolvePairing(s: StitchSession): PairingResult {
  const conflicts: StitchConflict[] = [];
  if (s.issues.length > 0) {
    for (const message of s.issues) conflicts.push({ kind: 'chain', side: 'A', message });
    return { pairs: [], conflicts, ready: false };
  }
  const active = activeCandidates(s);
  const byVertex = new Map<number, Candidate[]>();
  const push = (v: number, c: Candidate) => {
    const arr = byVertex.get(v);
    if (arr) arr.push(c);
    else byVertex.set(v, [c]);
  };
  for (const c of active) {
    push(c.a, c);
    push(c.b, c);
  }
  const checkSide = (chain: BoundaryChain, side: ChainSide) => {
    for (const v of chain.vertices) {
      if (s.skipped.has(v)) continue;
      const cand = byVertex.get(v) ?? [];
      if (cand.length === 0) {
        conflicts.push({
          kind: 'missing',
          side,
          vertex: v,
          message: `${side} 段顶点 v${v} 在容差 ${s.tol.toFixed(4)} 内没有对应点`,
        });
      } else if (cand.length > 1) {
        conflicts.push({
          kind: 'ambiguous',
          side,
          vertex: v,
          candidates: cand.map((c) => ({ a: c.a, b: c.b })),
          message: `${side} 段顶点 v${v} 有 ${cand.length} 个候选（距离 ${cand
            .map((c) => c.distance.toFixed(4))
            .join(' / ')}），请剔除多余的候选`,
        });
      }
    }
  };
  checkSide(s.chainA, 'A');
  checkSide(s.chainB, 'B');
  if (conflicts.length > 0) return { pairs: [], conflicts, ready: false };

  const pairs = active.map((c) => ({ a: c.a, b: c.b, distance: c.distance }));
  const crossing = findCrossing(s, pairs);
  if (crossing) {
    conflicts.push(crossing);
    return { pairs: [], conflicts, ready: false };
  }
  return { pairs, conflicts, ready: pairs.length > 0 };
}

function findCrossing(
  s: StitchSession,
  pairs: { a: number; b: number; distance: number }[],
): StitchConflict | null {
  const posB = new Map<number, number>();
  s.chainB.vertices.forEach((v, i) => posB.set(v, i));
  const posA = new Map<number, number>();
  s.chainA.vertices.forEach((v, i) => posA.set(v, i));
  const sorted = [...pairs].sort((x, y) => posA.get(x.a)! - posA.get(y.a)!);
  const seq = sorted.map((p) => posB.get(p.b)!);
  let incBreaks = 0;
  let decBreaks = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] <= seq[i - 1]) incBreaks++;
    if (seq[i] >= seq[i - 1]) decBreaks++;
  }
  if (incBreaks === 0 || decBreaks === 0) return null;
  const inc = longestMonotonic(seq, true);
  const dec = longestMonotonic(seq, false);
  const keep = inc.length >= dec.length ? inc : dec;
  const keepIdx = new Set(keep);
  const bad = sorted.filter((_, i) => !keepIdx.has(i));
  return {
    kind: 'crossing',
    side: 'A',
    candidates: bad.map((p) => ({ a: p.a, b: p.b })),
    message: `配对在链上交叉（${bad.length} 组），继续合并会让面片翻折；请剔除冲突候选`,
  };
}

function longestMonotonic(seq: number[], increasing: boolean): number[] {
  const n = seq.length;
  const dp = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const ok = increasing ? seq[j] < seq[i] : seq[j] > seq[i];
      if (ok && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (dp[i] > dp[best]) best = i;
  const out: number[] = [];
  let cur = best;
  while (cur !== -1) {
    out.push(cur);
    cur = prev[cur];
  }
  return out.reverse();
}

/**
 * 建议剔除：按距离从近到远做一次全局“一对一”贪心匹配，
 * 每个顶点最多保留一个候选，返回应剔除的候选 id。
 * 这只是建议——缺失点 / 交叉仍需用户确认，工具不会自动写入。
 */
export function suggestExclusions(s: StitchSession): string[] {
  const active = [...activeCandidates(s)].sort(
    (x, y) => x.distance - y.distance || x.a - y.a || x.b - y.b,
  );
  const taken = new Set<number>();
  const keep = new Set<string>();
  for (const c of active) {
    if (taken.has(c.a) || taken.has(c.b)) continue;
    taken.add(c.a);
    taken.add(c.b);
    keep.add(candidateId(c.a, c.b));
  }
  return active.map((c) => candidateId(c.a, c.b)).filter((id) => !keep.has(id));
}

/* ------------------------------------------------------------------ *
 * 焊接（保持原始顶点编号不压缩，便于撤销与追溯）
 * ------------------------------------------------------------------ */

export interface WeldResult {
  mesh: MeshData;
  /** 旧顶点 -> 代表点（自反） */
  representative: Int32Array;
  /** 被焊接掉的顶点编号（不压缩，仍保留位置数据） */
  weldedAway: number[];
  /** 因索引重合而删除的面 */
  removedFaces: number[];
  /** 每个面合并后 / 合并前的面积比 */
  areaRatio: number[];
  /** 合并后每个面的面积 */
  afterAreas: number[];
  /** 每个被焊掉的顶点到代表点的距离 */
  displacement: Float64Array;
  /** 引用了被焊掉顶点的面 */
  affectedFaces: number[];
  maxDisplacement: number;
}

/**
 * 按配对焊接顶点。
 * 代表点取编号较小者，顶点数组保持原长度与顺序（被合并的顶点成为未引用顶点），
 * 因此顶点编号关系在合并前后可追溯，撤销也能逐位恢复。
 */
export function weldByPairs(g: MeshGraph, pairs: { a: number; b: number }[]): WeldResult {
  const n = g.vertexCount;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const t = parent[x];
      parent[x] = r;
      x = t;
    }
    return r;
  };
  const union = (x: number, y: number) => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    if (rx < ry) parent[ry] = rx;
    else parent[rx] = ry;
  };
  for (const p of pairs) {
    if (p.a >= 0 && p.a < n && p.b >= 0 && p.b < n) union(p.a, p.b);
  }
  const representative = new Int32Array(n);
  for (let i = 0; i < n; i++) representative[i] = find(i);

  const removedFaces: number[] = [];
  const areaRatio = new Array<number>(g.faceCount).fill(1);
  const afterAreas = new Array<number>(g.faceCount).fill(0);
  const affected = new Set<number>();
  const outIndices: number[] = [];
  for (let f = 0; f < g.faceCount; f++) {
    const oa = g.indices[f * 3];
    const ob = g.indices[f * 3 + 1];
    const oc = g.indices[f * 3 + 2];
    const a = representative[oa];
    const b = representative[ob];
    const c = representative[oc];
    if (oa !== a || ob !== b || oc !== c) affected.add(f);
    if (a === b || b === c || c === a) {
      removedFaces.push(f);
      continue;
    }
    outIndices.push(a, b, c);
    const pa = g.points[a];
    const pb = g.points[b];
    const pc = g.points[c];
    const ux = pb.x - pa.x;
    const uy = pb.y - pa.y;
    const uz = pb.z - pa.z;
    const vx = pc.x - pa.x;
    const vy = pc.y - pa.y;
    const vz = pc.z - pa.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    afterAreas[f] = area;
    areaRatio[f] = g.faceAreas[f] > 1e-15 ? area / g.faceAreas[f] : 1;
  }

  const displacement = new Float64Array(n);
  const weldedAway: number[] = [];
  let maxDisplacement = 0;
  for (let i = 0; i < n; i++) {
    if (representative[i] === i) continue;
    const d = distance(g.points[i], g.points[representative[i]]);
    displacement[i] = d;
    weldedAway.push(i);
    if (d > maxDisplacement) maxDisplacement = d;
  }

  return {
    mesh: { positions: g.positions.slice(), indices: outIndices },
    representative,
    weldedAway,
    removedFaces,
    areaRatio,
    afterAreas,
    displacement,
    affectedFaces: [...affected].sort((x, y) => x - y),
    maxDisplacement,
  };
}

/* ------------------------------------------------------------------ *
 * 写入前预览 / 校验
 * ------------------------------------------------------------------ */

export interface CheckItem {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface StitchSettings {
  tol: number;
  /** 合并后三角形面积不得低于原面积的比例 */
  minAreaRatio: number;
  /** 两侧面法线点积低于该值视为反向（把两层焊死） */
  maxOppositeNormalDot: number;
  /** 配对位移中沿法线的比例超过该值，视为“层叠焊合” */
  maxNormalOffsetRatio: number;
}

export const DEFAULT_SETTINGS: StitchSettings = {
  tol: 0.01,
  minAreaRatio: 0.05,
  maxOppositeNormalDot: -0.5,
  maxNormalOffsetRatio: 0.6,
};

export interface StitchPreview {
  canApply: boolean;
  checks: CheckItem[];
  conflicts: StitchConflict[];
  pairs: { a: number; b: number; distance: number }[];
  weld?: WeldResult;
  after?: TopologyReport;
  afterGraph?: MeshGraph;
  before: TopologyReport;
  affectedFaces: number[];
  weldedVertices: number[];
  skippedVertices: number[];
  maxDisplacement: number;
  removedFaces: number[];
  delta: {
    vertices: number;
    faces: number;
    boundaryEdges: number;
    nonManifoldEdges: number;
    orientationIssues: number;
    shells: number;
  };
  blockedReasons: string[];
}

export function previewStitch(
  g: MeshGraph,
  session: StitchSession,
  settings: StitchSettings,
  beforeReport: TopologyReport,
): StitchPreview {
  const pairing = resolvePairing(session);
  const checks: CheckItem[] = [];
  const skipped = [...session.skipped].sort((x, y) => x - y);

  checks.push(
    pairing.ready
      ? {
          id: 'matching',
          label: '对应点配对',
          status: 'pass',
          detail: `唯一配对 ${pairing.pairs.length} 组，无缺失 / 歧义 / 交叉`,
        }
      : {
          id: 'matching',
          label: '对应点配对',
          status: 'fail',
          detail: `${pairing.conflicts.length} 个冲突未解决，本组不能写入`,
        },
  );

  if (skipped.length > 0) {
    checks.push({
      id: 'skipped',
      label: '跳过的顶点',
      status: 'warn',
      detail: `${skipped.length} 个顶点被明确跳过（v${skipped.slice(0, 6).join(', v')}${
        skipped.length > 6 ? '…' : ''
      }），缝合后这些位置仍会留下自由边`,
    });
  }

  const preview: StitchPreview = {
    canApply: false,
    checks,
    conflicts: pairing.conflicts,
    pairs: pairing.pairs,
    before: beforeReport,
    affectedFaces: [],
    weldedVertices: [],
    skippedVertices: skipped,
    maxDisplacement: 0,
    removedFaces: [],
    delta: {
      vertices: 0,
      faces: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      orientationIssues: 0,
      shells: 0,
    },
    blockedReasons: [],
  };
  if (!pairing.ready) {
    preview.blockedReasons = ['配对未就绪：请处理冲突（剔除候选或跳过顶点）'];
    return preview;
  }

  const weld = weldByPairs(g, pairing.pairs);
  const afterGraph = buildGraph(weld.mesh);
  const after = analyzeGraph(afterGraph, settings.tol);

  // 1) 压扁 / 退化
  if (weld.removedFaces.length > 0) {
    checks.push({
      id: 'collapse',
      label: '三角形压扁',
      status: 'fail',
      detail: `${weld.removedFaces.length} 个三角形合并后三个角落到同一顶点（索引重合），该组不能写入`,
    });
  } else {
    let worstFace = -1;
    let worstRatio = Infinity;
    for (let f = 0; f < g.faceCount; f++) {
      if (g.faceAreas[f] <= 1e-15) continue;
      if (weld.areaRatio[f] < worstRatio) {
        worstRatio = weld.areaRatio[f];
        worstFace = f;
      }
    }
    if (worstFace >= 0 && worstRatio < settings.minAreaRatio) {
      checks.push({
        id: 'collapse',
        label: '三角形压扁',
        status: 'fail',
        detail: `面 ${worstFace} 面积会降到原来的 ${(worstRatio * 100).toFixed(1)}%（阈值 ${(
          settings.minAreaRatio * 100
        ).toFixed(0)}%），会把三角形压扁`,
      });
    } else if (worstFace >= 0 && worstRatio < 0.5) {
      checks.push({
        id: 'collapse',
        label: '三角形压扁',
        status: 'warn',
        detail: `最差面 ${worstFace} 面积保留 ${(worstRatio * 100).toFixed(1)}%，形变明显但未触发阈值`,
      });
    } else {
      checks.push({ id: 'collapse', label: '三角形压扁', status: 'pass', detail: '没有三角形被压扁或索引退化' });
    }
  }

  // 2) 新增非流形边
  const beforeNonmanifold = new Set(beforeReport.nonManifoldEdges.map((e) => edgeKey(e.a, e.b)));
  const newNonmanifold = after.nonManifoldEdges.filter((e) => !beforeNonmanifold.has(edgeKey(e.a, e.b)));
  if (newNonmanifold.length > 0) {
    const sample = newNonmanifold
      .slice(0, 4)
      .map((e) => `v${e.a}—v${e.b}(${e.faces.length} 面)`)
      .join('、');
    checks.push({
      id: 'manifold',
      label: '边的邻面数',
      status: 'fail',
      detail: `会新增 ${newNonmanifold.length} 条超过 2 个邻面的边：${sample}${
        newNonmanifold.length > 4 ? '…' : ''
      }，该组不能写入`,
    });
  } else {
    checks.push({ id: 'manifold', label: '边的邻面数', status: 'pass', detail: '没有新增超过 2 个邻面的边' });
  }

  // 3) 新增朝向冲突
  const beforeOri = new Set(beforeReport.orientationIssues.map((o) => edgeKey(o.edge.a, o.edge.b)));
  const newOri = after.orientationIssues.filter((o) => !beforeOri.has(edgeKey(o.edge.a, o.edge.b)));
  if (newOri.length > 0) {
    const sample = newOri
      .slice(0, 4)
      .map((o) => `v${o.edge.a}—v${o.edge.b}`)
      .join('、');
    checks.push({
      id: 'orientation',
      label: '面朝向',
      status: 'fail',
      detail: `会新增 ${newOri.length} 处朝向冲突：${sample}${
        newOri.length > 4 ? '…' : ''
      }（两侧面绕向相同），该组不能写入`,
    });
  } else if (beforeReport.orientationIssues.length > 0) {
    checks.push({
      id: 'orientation',
      label: '面朝向',
      status: 'warn',
      detail: `没有新增朝向冲突；但网格原本已有 ${beforeReport.orientationIssues.length} 处，需要在合并后单独处理`,
    });
  } else {
    checks.push({ id: 'orientation', label: '面朝向', status: 'pass', detail: '没有新增朝向冲突' });
  }

  // 4) 贴层 / 双层片：配对位移方向与法线的关系
  const layer = analyzeLayers(g, session, pairing.pairs, settings);
  checks.push(layer.check);

  // 5) 新增重合面
  const beforeDup = duplicateFaceCount(g);
  const afterDup = duplicateFaceCount(afterGraph);
  if (afterDup > beforeDup) {
    checks.push({
      id: 'duplicate',
      label: '重合面',
      status: 'fail',
      detail: `合并后会新增 ${afterDup - beforeDup} 个完全重合的三角形（零体积夹层），该组不能写入`,
    });
  } else {
    checks.push({ id: 'duplicate', label: '重合面', status: 'pass', detail: '没有产生新的完全重合三角形' });
  }

  // 6) 自由边变化（信息项）
  const afterBoundary = after.boundaryEdges.length;
  const beforeBoundary = beforeReport.boundaryEdges.length;
  checks.push({
    id: 'boundary-count',
    label: '自由边',
    status: afterBoundary < beforeBoundary ? 'pass' : 'warn',
    detail: `${beforeBoundary} → ${afterBoundary} 条自由边（另有 ${skipped.length} 个顶点被跳过）`,
  });

  const blockedReasons = checks.filter((c) => c.status === 'fail').map((c) => c.label);
  preview.canApply = blockedReasons.length === 0;
  preview.checks = checks;
  preview.weld = weld;
  preview.after = after;
  preview.afterGraph = afterGraph;
  preview.affectedFaces = weld.affectedFaces;
  preview.weldedVertices = weld.weldedAway;
  preview.maxDisplacement = weld.maxDisplacement;
  preview.removedFaces = weld.removedFaces;
  preview.delta = {
    vertices: after.referencedVertexCount - beforeReport.referencedVertexCount,
    faces: after.faceCount - beforeReport.faceCount,
    boundaryEdges: after.boundaryEdges.length - beforeReport.boundaryEdges.length,
    nonManifoldEdges: after.nonManifoldEdges.length - beforeReport.nonManifoldEdges.length,
    orientationIssues: after.orientationIssues.length - beforeReport.orientationIssues.length,
    shells: after.shellCount - beforeReport.shellCount,
  };
  preview.blockedReasons = blockedReasons;
  return preview;
}

interface LayerAnalysis {
  check: CheckItem;
  worstDot: number;
  worstNormalRatio: number;
  worstDistance: number;
}

function analyzeLayers(
  g: MeshGraph,
  session: StitchSession,
  pairs: { a: number; b: number; distance: number }[],
  settings: StitchSettings,
): LayerAnalysis {
  const posB = new Map<number, number>();
  session.chainB.vertices.forEach((v, i) => posB.set(v, i));
  const pairOfA = new Map<number, { a: number; b: number; distance: number }>();
  for (const p of pairs) pairOfA.set(p.a, p);

  let worstDot = 2;
  let worstRatio = 0;
  let worstDistance = 0;
  let worstText = '';
  let overlapping = false;

  for (let i = 0; i + 1 < session.chainA.vertices.length; i++) {
    const a0 = session.chainA.vertices[i];
    const a1 = session.chainA.vertices[i + 1];
    const p0 = pairOfA.get(a0);
    const p1 = pairOfA.get(a1);
    if (!p0 || !p1) continue;
    const j0 = posB.get(p0.b);
    const j1 = posB.get(p1.b);
    if (j0 === undefined || j1 === undefined || Math.abs(j0 - j1) !== 1) continue;
    const eA = g.edges.get(edgeKey(a0, a1));
    const eB = g.edges.get(edgeKey(p0.b, p1.b));
    if (!eA || !eB || eA.cls !== 'boundary' || eB.cls !== 'boundary') continue;
    const na = g.faceNormals[eA.faces[0]];
    const nb = g.faceNormals[eB.faces[0]];
    const la = Math.hypot(na.x, na.y, na.z);
    const lb = Math.hypot(nb.x, nb.y, nb.z);
    if (la < 1e-15 || lb < 1e-15) continue;
    const dot = (na.x * nb.x + na.y * nb.y + na.z * nb.z) / (la * lb);
    const d = averageOffset(g, a0, a1, p0.b, p1.b);
    const dist = Math.hypot(d.x, d.y, d.z);
    const nx = (na.x / la + nb.x / lb) / 2;
    const ny = (na.y / la + nb.y / lb) / 2;
    const nz = (na.z / la + nb.z / lb) / 2;
    const nl = Math.hypot(nx, ny, nz);
    const ratio = dist > 1e-9 && nl > 1e-9 ? Math.abs((d.x * nx + d.y * ny + d.z * nz) / nl) / dist : 0;
    if (dot < worstDot) {
      worstDot = dot;
      worstText = `v${a0}—v${a1} ↔ v${p0.b}—v${p1.b}`;
    }
    if (ratio > worstRatio) worstRatio = ratio;
    if (dist > worstDistance) worstDistance = dist;
    if (dist <= Math.max(1e-9, settings.tol * 0.25)) {
      // 位移几乎为零：直接看两侧相邻面是否在空间上互相覆盖
      const cA = faceCentroid(g, eA.faces[0]);
      const cB = faceCentroid(g, eB.faces[0]);
      if (distance(cA, cB) <= Math.max(1e-9, settings.tol * 0.25) && dot > 0.95) overlapping = true;
    }
  }

  if (worstDot === 2) {
    return {
      check: {
        id: 'layers',
        label: '贴层/双层片',
        status: 'warn',
        detail: '无法沿链找到成对的相邻边，贴层检查未执行；请确认两段边界方向/长度对应',
      },
      worstDot,
      worstNormalRatio: worstRatio,
      worstDistance,
    };
  }

  const normalDeg = (Math.acos(Math.max(-1, Math.min(1, worstDot))) * 180) / Math.PI;
  if (worstDot < settings.maxOppositeNormalDot) {
    return {
      check: {
        id: 'layers',
        label: '贴层/双层片',
        status: 'fail',
        detail: `对应边界 ${worstText} 两侧面方向相反（夹角 ${normalDeg.toFixed(0)}°，点积 ${worstDot.toFixed(
          3,
        )}），会把本来分开的两层焊死，该组不能写入`,
      },
      worstDot,
      worstNormalRatio: worstRatio,
      worstDistance,
    };
  }
  if (overlapping) {
    return {
      check: {
        id: 'layers',
        label: '贴层/双层片',
        status: 'fail',
        detail: `两段边界几乎完全重合且相邻面互相覆盖（${worstText}），属于贴合的双层片而不是裂口，该组不能写入`,
      },
      worstDot,
      worstNormalRatio: worstRatio,
      worstDistance,
    };
  }
  if (worstRatio > settings.maxNormalOffsetRatio && worstDistance > 1e-9) {
    return {
      check: {
        id: 'layers',
        label: '贴层/双层片',
        status: 'fail',
        detail: `配对位移的 ${(worstRatio * 100).toFixed(0)}% 沿法线方向（最大间距 ${worstDistance.toFixed(
          4,
        )}），看起来是在焊合层叠面，而不是连接同一张面的裂口，该组不能写入`,
      },
      worstDot,
      worstNormalRatio: worstRatio,
      worstDistance,
    };
  }
  if (worstRatio > 0.35 || worstDot < 0.2) {
    return {
      check: {
        id: 'layers',
        label: '贴层/双层片',
        status: 'warn',
        detail: `最差对应边 ${worstText}：法线点积 ${worstDot.toFixed(3)}，沿法线位移占比 ${(
          worstRatio * 100
        ).toFixed(0)}%，请确认是真实接缝`,
      },
      worstDot,
      worstNormalRatio: worstRatio,
      worstDistance,
    };
  }
  return {
    check: {
      id: 'layers',
      label: '贴层/双层片',
      status: 'pass',
      detail: '两侧面朝向一致，配对位移沿切向，不是贴合的层叠面',
    },
    worstDot,
    worstNormalRatio: worstRatio,
    worstDistance,
  };
}

function averageOffset(g: MeshGraph, a0: number, a1: number, b0: number, b1: number): Vec3 {
  const ma = {
    x: (g.points[a0].x + g.points[a1].x) / 2,
    y: (g.points[a0].y + g.points[a1].y) / 2,
    z: (g.points[a0].z + g.points[a1].z) / 2,
  };
  const mb = {
    x: (g.points[b0].x + g.points[b1].x) / 2,
    y: (g.points[b0].y + g.points[b1].y) / 2,
    z: (g.points[b0].z + g.points[b1].z) / 2,
  };
  return { x: mb.x - ma.x, y: mb.y - ma.y, z: mb.z - ma.z };
}

function faceCentroid(g: MeshGraph, f: number): Vec3 {
  const a = g.points[g.indices[f * 3]];
  const b = g.points[g.indices[f * 3 + 1]];
  const c = g.points[g.indices[f * 3 + 2]];
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
}

function duplicateFaceCount(g: MeshGraph): number {
  const map = new Map<string, number>();
  for (let f = 0; f < g.faceCount; f++) {
    if (g.faceAreas[f] <= 1e-15) continue;
    const ids = [g.indices[f * 3], g.indices[f * 3 + 1], g.indices[f * 3 + 2]].sort((a, b) => a - b);
    const key = ids.join(',');
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  let count = 0;
  for (const n of map.values()) if (n >= 2) count += n;
  return count;
}

/** 凸包/包围盒内的边界边，供屏幕框选在测试中复用。要求两个端点都在框内。 */
export function boundaryEdgeKeysWithin(g: MeshGraph, min: Vec3, max: Vec3): string[] {
  const inside = (p: Vec3) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z;
  const keys: string[] = [];
  for (const [k, e] of g.edges) {
    if (e.cls !== 'boundary') continue;
    if (inside(g.points[e.a]) && inside(g.points[e.b])) keys.push(k);
  }
  return keys.sort();
}

/* ------------------------------------------------------------------ *
 * 边界环与“有意保留的洞”
 * ------------------------------------------------------------------ */

export interface BoundaryLoopView {
  key: string;
  vertices: number[];
  edges: string[];
  closed: boolean;
  preserved: boolean;
  length: number;
}

export function boundaryLoopViews(g: MeshGraph, preserved: Set<string>): BoundaryLoopView[] {
  const loops = boundaryLoops(g);
  return loops.map((vertices) => {
    const key = [...new Set(vertices)].sort((a, b) => a - b).join(',');
    const edges: string[] = [];
    let length = 0;
    for (let i = 0; i + 1 < vertices.length; i++) {
      edges.push(edgeKey(vertices[i], vertices[i + 1]));
      length += distance(g.points[vertices[i]], g.points[vertices[i + 1]]);
    }
    const closed = vertices.length >= 3 && g.edges.get(edgeKey(vertices[vertices.length - 1], vertices[0]))?.cls === 'boundary';
    if (closed) {
      edges.push(edgeKey(vertices[vertices.length - 1], vertices[0]));
      length += distance(g.points[vertices[vertices.length - 1]], g.points[vertices[0]]);
    }
    return { key, vertices, edges, closed, preserved: preserved.has(key), length };
  });
}
