import { PointHash, distanceSq, v3 } from './math';
import type { EdgeInfo, EdgeKey, MeshData, MeshValidation, OrientationIssue, TopologyReport, Vec3 } from './types';

/** 无向边 key：顶点编号小的在前。 */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function parseEdgeKey(key: string): EdgeKey {
  const [a, b] = key.split('_').map(Number);
  return { a: Math.min(a, b), b: Math.max(a, b) };
}

export interface MeshGraph {
  positions: number[];
  indices: number[];
  vertexCount: number;
  faceCount: number;
  points: Vec3[];
  /** key -> 边信息；键为 edgeKey(vertexA, vertexB) */
  edges: Map<string, EdgeInfo>;
  // 每个面 3 条边的 key（按面内顺序：v0v1, v1v2, v2v0）
  faceEdges: string[][];
  /** 每个面的有向边，键为 `${u}>${w}`，与面内顺序一致 */
  faceDirectedEdges: string[][];
  /** 顶点 -> 相邻面 */
  vertexFaces: number[][];
  /** 顶点 -> 相邻边 key */
  vertexEdges: string[][];
  /** 面法线（未归一化，长度 = 2*面积） */
  faceNormals: Vec3[];
  /** 面面积 */
  faceAreas: number[];
  /** 顶点法线（面积加权平均后归一化） */
  vertexNormals: Vec3[];
  /** 面所属的连通外壳（通过共享边连通） */
  faceShell: Int32Array;
  shellCount: number;
  /** 顶点所属外壳（-1 表示孤立顶点） */
  vertexShell: Int32Array;
  /** 被面引用的顶点数缓存 */
  _referenced?: number;
}

export function validateMesh(mesh: MeshData): MeshValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const positions = mesh.positions;
  if (!Array.isArray(positions)) {
    return { ok: false, errors: ['缺少顶点位置数组'], warnings };
  }
  if (positions.length % 3 !== 0) errors.push('顶点位置数组长度不是 3 的倍数');
  if (!Array.isArray(mesh.indices)) {
    return { ok: false, errors: [...errors, '缺少三角形索引数组'], warnings };
  }
  if (mesh.indices.length % 3 !== 0) errors.push('三角形索引数组长度不是 3 的倍数');
  const vertexCount = Math.floor(positions.length / 3);
  let badIndex = 0;
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    if (!Number.isInteger(v) || v < 0 || v >= vertexCount) {
      badIndex++;
      if (errors.length < 12) errors.push(`索引[${i}] = ${v} 越界（共 ${vertexCount} 个顶点）`);
    }
  }
  if (badIndex > 12) errors.push(`……共 ${badIndex} 个越界索引`);
  let degenerate = 0;
  for (let f = 0; f + 2 < mesh.indices.length; f += 3) {
    const a = mesh.indices[f];
    const b = mesh.indices[f + 1];
    const c = mesh.indices[f + 2];
    if (a === b || b === c || c === a) degenerate++;
  }
  if (degenerate > 0) warnings.push(`存在 ${degenerate} 个索引重复的退化三角形`);
  if (vertexCount === 0) warnings.push('网格没有顶点');
  if (mesh.indices.length === 0) warnings.push('网格没有三角形');
  return { ok: errors.length === 0, errors, warnings };
}

/** 从 MeshData 构建拓扑图。调用前应通过 validateMesh。 */
export function buildGraph(mesh: MeshData): MeshGraph {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const vertexCount = Math.floor(positions.length / 3);
  const faceCount = Math.floor(indices.length / 3);
  const points: Vec3[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    points[i] = v3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }

  const edges = new Map<string, EdgeInfo>();
  const faceEdges: string[][] = new Array(faceCount);
  const faceDirectedEdges: string[][] = new Array(faceCount);
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  const vertexEdgeSet: Set<string>[] = Array.from({ length: vertexCount }, () => new Set<string>());
  const faceNormals: Vec3[] = new Array(faceCount);
  const faceAreas: number[] = new Array(faceCount);

  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      // 不应发生（已校验），防御性跳过
      faceEdges[f] = [];
      faceDirectedEdges[f] = [];
      faceNormals[f] = v3();
      faceAreas[f] = 0;
      continue;
    }
    vertexFaces[a].push(f);
    vertexFaces[b].push(f);
    vertexFaces[c].push(f);
    const pa = points[a];
    const pb = points[b];
    const pc = points[c];
    const ab = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
    const ac = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
    const n = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    faceNormals[f] = n;
    faceAreas[f] = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) / 2;

    const keys = [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)];
    faceEdges[f] = keys;
    faceDirectedEdges[f] = [`${a}>${b}`, `${b}>${c}`, `${c}>${a}`];
    for (const k of keys) {
      let e = edges.get(k);
      if (!e) {
        const parsed = parseEdgeKey(k);
        e = { a: parsed.a, b: parsed.b, faces: [], cls: 'boundary', orientationConflict: false };
        edges.set(k, e);
      }
      e.faces.push(f);
      vertexEdgeSet[a].add(k);
      vertexEdgeSet[b].add(k);
      vertexEdgeSet[c].add(k);
    }
  }

  for (const e of edges.values()) {
    e.faces.sort((x, y) => x - y);
    e.cls = e.faces.length === 1 ? 'boundary' : e.faces.length === 2 ? 'manifold' : 'nonmanifold';
  }

  const vertexEdges: string[][] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) vertexEdges[v] = [...vertexEdgeSet[v]];

  const vertexNormals: Vec3[] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const f of vertexFaces[v]) {
      nx += faceNormals[f].x;
      ny += faceNormals[f].y;
      nz += faceNormals[f].z;
    }
    const len = Math.hypot(nx, ny, nz);
    vertexNormals[v] = len > 1e-15 ? { x: nx / len, y: ny / len, z: nz / len } : v3();
  }

  // 通过共享边求连通外壳
  const faceShell = new Int32Array(faceCount).fill(-1);
  let shellCount = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < faceCount; seed++) {
    if (faceShell[seed] !== -1) continue;
    faceShell[seed] = shellCount;
    stack.push(seed);
    while (stack.length) {
      const f = stack.pop()!;
      for (const k of faceEdges[f] ?? []) {
        const e = edges.get(k);
        if (!e) continue;
        for (const nf of e.faces) {
          if (faceShell[nf] === -1) {
            faceShell[nf] = shellCount;
            stack.push(nf);
          }
        }
      }
    }
    shellCount++;
  }
  const vertexShell = new Int32Array(vertexCount).fill(-1);
  for (let v = 0; v < vertexCount; v++) {
    const fs = vertexFaces[v];
    if (fs.length > 0) vertexShell[v] = faceShell[fs[0]];
  }

  return {
    positions,
    indices,
    vertexCount,
    faceCount,
    points,
    edges,
    faceEdges,
    faceDirectedEdges,
    vertexFaces,
    vertexEdges,
    faceNormals,
    faceAreas,
    vertexNormals,
    faceShell,
    shellCount,
    vertexShell,
  };
}

/**
 * 完整拓扑报告。
 * @param tol 几何重合容差。只影响 coincidentVertexGroups，不影响任何拓扑判定。
 */
export function analyzeGraph(g: MeshGraph, tol: number): TopologyReport {
  const boundaryEdges: EdgeInfo[] = [];
  const nonManifoldEdges: EdgeInfo[] = [];
  const orientationIssues: OrientationIssue[] = [];
  const directed = new Map<string, number[]>();

  for (const info of g.edges.values()) {
    if (info.cls === 'boundary') boundaryEdges.push(info);
    if (info.cls === 'nonmanifold') nonManifoldEdges.push(info);
    for (const f of info.faces) {
      for (const dk of g.faceDirectedEdges[f] ?? []) {
        if (edgeKey(...(dk.split('>').map(Number) as [number, number])) !== edgeKey(info.a, info.b)) continue;
        const arr = directed.get(dk);
        if (arr) arr.push(f);
        else directed.set(dk, [f]);
      }
    }
  }
  for (const [dk, faces] of directed) {
    const uniq = [...new Set(faces)];
    if (uniq.length < 2) continue;
    const [u, w] = dk.split('>').map(Number);
    orientationIssues.push({ edge: { a: Math.min(u, w), b: Math.max(u, w) }, faces: uniq });
  }
  orientationIssues.sort((x, y) => x.edge.a - y.edge.a || x.edge.b - y.edge.b);
  for (const issue of orientationIssues) {
    g.edges.get(edgeKey(issue.edge.a, issue.edge.b))!.orientationConflict = true;
  }

  const { coincidentVertexGroups, duplicateShellFaceCount } = coincidentAnalysis(g, tol);

  let degenerateFaceCount = 0;
  for (let f = 0; f < g.faceCount; f++) {
    if (g.faceAreas[f] <= 1e-14) degenerateFaceCount++;
  }

  return {
    vertexCount: g.vertexCount,
    referencedVertexCount: referencedCount(g),
    unusedVertexCount: g.vertexCount - referencedCount(g),
    faceCount: g.faceCount,
    edgeCount: g.edges.size,
    boundaryEdges,
    nonManifoldEdges,
    orientationIssues,
    coincidentVertexGroups,
    duplicateShellFaceCount,
    degenerateFaceCount,
    shellCount: g.shellCount,
  };
}

function referencedCount(g: MeshGraph): number {
  if (g._referenced === undefined) {
    const used = new Uint8Array(g.vertexCount);
    for (let f = 0; f < g.faceCount; f++) {
      used[g.indices[f * 3]] = 1;
      used[g.indices[f * 3 + 1]] = 1;
      used[g.indices[f * 3 + 2]] = 1;
    }
    let n = 0;
    for (let i = 0; i < used.length; i++) n += used[i];
    g._referenced = n;
  }
  return g._referenced;
}

/** 几何重合顶点组：坐标距离 <= tol 的顶点，即使索引不同。 */
function coincidentAnalysis(g: MeshGraph, tol: number): { coincidentVertexGroups: number[][]; duplicateShellFaceCount: number } {
  const parent = new Int32Array(g.vertexCount);
  for (let i = 0; i < g.vertexCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const union = (x: number, y: number) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[ry] = rx;
  };

  if (tol > 0 && g.vertexCount > 0) {
    const tol2 = tol * tol;
    const hash = new PointHash(g.points, Math.max(tol, 1e-9));
    for (let i = 0; i < g.vertexCount; i++) {
      for (const j of hash.query(g.points[i])) {
        if (j <= i) continue;
        if (distanceSq(g.points[i], g.points[j]) <= tol2) union(i, j);
      }
    }
  }
  const groupsMap = new Map<number, number[]>();
  for (let i = 0; i < g.vertexCount; i++) {
    const r = find(i);
    const arr = groupsMap.get(r);
    if (arr) arr.push(i);
    else groupsMap.set(r, [i]);
  }
  const coincidentVertexGroups: number[][] = [];
  for (const arr of groupsMap.values()) {
    if (arr.length >= 2) {
      arr.sort((a, b) => a - b);
      coincidentVertexGroups.push(arr);
    }
  }
  coincidentVertexGroups.sort((x, y) => x[0] - y[0]);

  // 完全重合（索引不同）的面：典型双层片的信号
  const dup = new Map<string, number>();
  for (let f = 0; f < g.faceCount; f++) {
    if (g.faceAreas[f] <= 1e-14) continue;
    const ids = [g.indices[f * 3], g.indices[f * 3 + 1], g.indices[f * 3 + 2]].map((v) => find(v));
    ids.sort((a, b) => a - b);
    const k = ids.join(',');
    dup.set(k, (dup.get(k) ?? 0) + 1);
  }
  let duplicateShellFaceCount = 0;
  for (const count of dup.values()) if (count >= 2) duplicateShellFaceCount += count;

  return { coincidentVertexGroups, duplicateShellFaceCount };
}

/**
 * 边界环 / 折线。返回顶点序列；若首尾相接则视为闭环（最后一顶点不与首顶点重复）。
 * 非流形边不计入。
 */
export function boundaryLoops(g: MeshGraph): number[][] {
  const adj = new Map<number, number[]>();
  for (const e of g.edges.values()) {
    if (e.cls !== 'boundary') continue;
    let la = adj.get(e.a);
    if (!la) adj.set(e.a, (la = []));
    la.push(e.b);
    let lb = adj.get(e.b);
    if (!lb) adj.set(e.b, (lb = []));
    lb.push(e.a);
  }
  const used = new Set<string>();
  const keyOf = (a: number, b: number) => edgeKey(a, b);
  const chains: number[][] = [];
  const endpoints: number[] = [];
  for (const [v, nbrs] of adj) if (nbrs.length === 1) endpoints.push(v);

  const walk = (start: number, first: number): number[] => {
    const chain: number[] = [start];
    let prev = start;
    let cur = first;
    used.add(keyOf(prev, cur));
    while (true) {
      chain.push(cur);
      const nbrs = adj.get(cur) ?? [];
      let next = -1;
      for (const n of nbrs) {
        if (n !== prev && !used.has(keyOf(cur, n))) {
          next = n;
          break;
        }
      }
      if (next === -1) break;
      used.add(keyOf(cur, next));
      prev = cur;
      cur = next;
      if (cur === start) break;
    }
    return chain;
  };

  for (const start of endpoints) {
    for (const nb of adj.get(start) ?? []) {
      if (used.has(keyOf(start, nb))) continue;
      chains.push(walk(start, nb));
    }
  }
  for (const [start, nbrs] of adj) {
    for (const nb of nbrs) {
      if (used.has(keyOf(start, nb))) continue;
      chains.push(walk(start, nb));
    }
  }
  return chains;
}

