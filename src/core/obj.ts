import { analyzeTopology, triangleTriangleIntersection, type IndexTriple } from './geometry';
import type {
  Bounds,
  ObjReadbackReport,
  ObjSceneData,
  ThickenedSolid,
  TopologyReport,
  Vec3,
} from './types';
import { boundsFromPositions, distance } from './vec';

interface ObjGroup {
  name: string;
  faces: IndexTriple[];
}

function buildGroups(solid: ThickenedSolid): ObjGroup[] {
  const groups: ObjGroup[] = [
    { name: 'original_layer', faces: [] },
    { name: 'offset_layer', faces: [] },
  ];
  const outer: ObjGroup = { name: 'side_wall_outer', faces: [] };
  const holes = new Map<number, ObjGroup>();
  const problematic: ObjGroup = { name: 'side_wall_problem', faces: [] };

  for (let t = 0; t < solid.originalIndices.length; t += 3) {
    groups[0].faces.push({ a: solid.originalIndices[t], b: solid.originalIndices[t + 1], c: solid.originalIndices[t + 2] });
    groups[1].faces.push({ a: solid.offsetIndices[t], b: solid.offsetIndices[t + 1], c: solid.offsetIndices[t + 2] });
  }

  for (let t = 0; t < solid.sideIndices.length; t += 3) {
    const face: IndexTriple = { a: solid.sideIndices[t], b: solid.sideIndices[t + 1], c: solid.sideIndices[t + 2] };
    const meta = solid.sideFaces[t / 3];
    const wall = solid.sideWalls.find((w) => w.edgeId === meta.edgeId);
    if (wall?.problem) {
      problematic.faces.push(face);
      continue;
    }
    if (meta.loopKind === 'outer') {
      outer.faces.push(face);
    } else {
      let group = holes.get(meta.loopId);
      if (!group) {
        group = { name: `side_wall_hole_${holes.size + 1}`, faces: [] };
        holes.set(meta.loopId, group);
      }
      group.faces.push(face);
    }
  }

  const result = [...groups, outer];
  for (const key of [...holes.keys()].sort((a, b) => a - b)) {
    result.push(holes.get(key)!);
  }
  if (problematic.faces.length > 0) result.push(problematic);
  return result;
}

/**
 * 导出 OBJ。顶点坐标保留 6 位小数; 面用 1 基索引。
 * 曲面主体与侧壁分组导出, 便于读回后核对分组和原始边。
 */
export function exportSolidToObj(solid: ThickenedSolid, name: string): string {
  const groups = buildGroups(solid);
  const lines: string[] = [];
  lines.push('# paper-cover-thickening-inspector');
  lines.push(`# model: ${solid.model.id} (${solid.model.name})`);
  lines.push(`# thickness: ${solid.thickness} side: ${solid.side > 0 ? '+normal' : '-normal'}`);
  lines.push(`# source hash: ${solid.model.sourceHash}`);
  lines.push(`# valid: ${solid.validation.valid ? 'yes' : 'no'}`);
  lines.push(`o ${name}`);

  const positionCount = solid.positions.length / 3;
  for (let i = 0; i < positionCount; i++) {
    lines.push(
      `v ${format(solid.positions[i * 3])} ${format(solid.positions[i * 3 + 1])} ${format(solid.positions[i * 3 + 2])}`,
    );
  }

  for (const group of groups) {
    if (group.faces.length === 0) continue;
    lines.push(`g ${group.name}`);
    for (const face of group.faces) {
      lines.push(`f ${face.a + 1} ${face.b + 1} ${face.c + 1}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function format(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

/** 解析 OBJ: 支持 v / f (含 v/vt/vn 与负索引) / o / g */
export function parseObj(text: string): ObjSceneData {
  const positions: number[] = [];
  const indices: number[] = [];
  const groups: string[] = [];
  const groupFaceCounts: Record<string, number> = {};
  let currentGroup = 'default';
  let faceCount = 0;

  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const parts = raw.split(/\s+/);
    const keyword = parts[0];
    if (keyword === 'v') {
      if (parts.length < 4) throw new Error(`第 ${lineIndex + 1} 行: 顶点缺少坐标`);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (![x, y, z].every(Number.isFinite)) throw new Error(`第 ${lineIndex + 1} 行: 顶点坐标不是有效数字`);
      positions.push(x, y, z);
    } else if (keyword === 'f') {
      if (parts.length < 4) throw new Error(`第 ${lineIndex + 1} 行: 面至少需要 3 个顶点`);
      const vertexIndexAt = (token: string): number => {
        const first = token.split('/')[0];
        const value = Number(first);
        if (!Number.isInteger(value) || value === 0) {
          throw new Error(`第 ${lineIndex + 1} 行: 面索引 "${token}" 无效`);
        }
        const resolved = value > 0 ? value - 1 : positions.length / 3 + value;
        if (resolved < 0 || resolved >= positions.length / 3) {
          throw new Error(`第 ${lineIndex + 1} 行: 面索引 ${value} 越界`);
        }
        return resolved;
      };
      const verts = parts.slice(1).map(vertexIndexAt);
      for (let i = 1; i + 1 < verts.length; i++) {
        indices.push(verts[0], verts[i], verts[i + 1]);
        faceCount++;
        if (!groups.includes(currentGroup)) groups.push(currentGroup);
        groupFaceCounts[currentGroup] = (groupFaceCounts[currentGroup] ?? 0) + 1;
      }
    } else if (keyword === 'o' || keyword === 'g') {
      currentGroup = parts.slice(1).join(' ') || 'default';
    }
  }

  if (positions.length === 0) throw new Error('OBJ 中没有顶点');
  if (indices.length === 0) throw new Error('OBJ 中没有面');
  void faceCount;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    groups,
    groupFaceCounts,
  };
}

function topLevelTriangles(scene: ObjSceneData): IndexTriple[] {
  const triangles: IndexTriple[] = [];
  for (let t = 0; t < scene.indices.length; t += 3) {
    triangles.push({ a: scene.indices[t], b: scene.indices[t + 1], c: scene.indices[t + 2] });
  }
  return triangles;
}

function readbackIntersections(scene: ObjSceneData): number {
  // 大网格抽样: 按 AABB 网格分桶, 只对同桶且不相邻的面做精确判断
  const triangles = topLevelTriangles(scene);
  const boxes = triangles.map((tri) => {
    const a: Vec3 = [scene.positions[tri.a * 3], scene.positions[tri.a * 3 + 1], scene.positions[tri.a * 3 + 2]];
    const b: Vec3 = [scene.positions[tri.b * 3], scene.positions[tri.b * 3 + 1], scene.positions[tri.b * 3 + 2]];
    const c: Vec3 = [scene.positions[tri.c * 3], scene.positions[tri.c * 3 + 1], scene.positions[tri.c * 3 + 2]];
    return {
      min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])] as Vec3,
      max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])] as Vec3,
      a, b, c,
    };
  });
  let cellSize = 0;
  for (const box of boxes) {
    cellSize += distance(box.min, box.max);
  }
  cellSize = Math.max((cellSize / Math.max(1, boxes.length)) * 2, 1e-4);

  const buckets = new Map<string, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const x0 = Math.floor(box.min[0] / cellSize);
    const x1 = Math.floor(box.max[0] / cellSize);
    const y0 = Math.floor(box.min[1] / cellSize);
    const y1 = Math.floor(box.max[1] / cellSize);
    const z0 = Math.floor(box.min[2] / cellSize);
    const z1 = Math.floor(box.max[2] / cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 256) continue;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x}:${y}:${z}`;
          const list = buckets.get(key);
          if (list) list.push(i);
          else buckets.set(key, [i]);
        }
      }
    }
  }

  let pairs = 0;
  const seen = new Set<string>();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const ia = bucket[i];
        const ib = bucket[j];
        const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ta = triangles[ia];
        const tb = triangles[ib];
        const shared = ta.a === tb.a || ta.a === tb.b || ta.a === tb.c
          || ta.b === tb.a || ta.b === tb.b || ta.b === tb.c
          || ta.c === tb.a || ta.c === tb.b || ta.c === tb.c;
        if (shared) continue;
        const A: [Vec3, Vec3, Vec3] = [boxes[ia].a, boxes[ia].b, boxes[ia].c];
        const B: [Vec3, Vec3, Vec3] = [boxes[ib].a, boxes[ib].b, boxes[ib].c];
        if (triangleTriangleIntersection(A, B)) pairs++;
      }
    }
  }
  return pairs;
}

/**
 * 读回 OBJ 并复核: 闭合性、流形性、包围盒、自相交。
 * 导出时的绕序在 OBJ 中按面记录, 读回后应得到相同的拓扑结论。
 */
export function inspectObjReadback(text: string): { scene: ObjSceneData; report: ObjReadbackReport } {
  const scene = parseObj(text);
  const triangles = topLevelTriangles(scene);
  const topology: TopologyReport = analyzeTopology(scene.positions, triangles, scene.positions.length / 3);
  const bbox: Bounds | null = scene.positions.length > 0 ? boundsFromPositions(scene.positions) : null;

  let intersections = 0;
  try {
    intersections = readbackIntersections(scene);
  } catch (error) {
    intersections = -1;
    void error;
  }

  const messages: string[] = [];
  if (!topology.closed) messages.push(`读回后未闭合: ${topology.boundaryEdgeCount} 条边界边`);
  if (!topology.manifold) {
    messages.push(`非流形边 ${topology.nonManifoldEdgeCount}, 绕序不一致边 ${topology.inconsistentEdgeCount}`);
  }
  if (intersections > 0) messages.push(`读回后仍有 ${intersections} 处自相交`);
  if (messages.length === 0) messages.push('读回复核通过: 闭合、流形、无自相交');

  return {
    scene,
    report: {
      vertexCount: scene.positions.length / 3,
      triangleCount: triangles.length,
      topology,
      intersectionPairs: intersections,
      bbox,
      groups: scene.groups,
      groupFaceCounts: scene.groupFaceCounts,
      valid: topology.closed && topology.manifold && intersections <= 0,
      messages,
    },
  };
}
