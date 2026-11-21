import type { SceneObject, RawHit, PickOutcome } from './types';
import {
  TIE_EPS,
  quatToMat3,
  rayBox,
  rayBoxObject,
  rayEllipsoid,
  transformedAabb,
  type BoxLike,
  type Vec3,
} from './geometry';

/**
 * 单件精确求交。返回 t >= 0，或 null。
 * - 起点严格在物件内部：返回 0，并标记 inside。
 * - 起点正好在表面：返回 0，不算 inside。
 */
export function intersectObject(
  obj: SceneObject,
  origin: Vec3,
  dir: Vec3,
): { t: number; inside: boolean } | null {
  const half = {
    x: obj.size.x / 2,
    y: obj.size.y / 2,
    z: obj.size.z / 2,
  };
  const rot = quatToMat3(obj.quaternion);
  const center = { x: obj.position.x, y: obj.position.y, z: obj.position.z };

  let t: number | null;
  if (obj.kind === 'box') {
    t = rayBoxObject(origin, dir, center, half, rot);
  } else {
    t = rayEllipsoid(origin, dir, center, half, rot);
  }
  if (t === null) return null;

  return { t, inside: pointInside(obj, origin, 1e-7) };
}

/** 点是否严格在物件内部（半轴各向内收 inset）。 */
export function pointInside(obj: SceneObject, p: Vec3, inset = 0): boolean {
  const rot = quatToMat3(obj.quaternion);
  const h = {
    x: Math.max(obj.size.x / 2 - inset, 1e-12),
    y: Math.max(obj.size.y / 2 - inset, 1e-12),
    z: Math.max(obj.size.z / 2 - inset, 1e-12),
  };
  const ox = p.x - obj.position.x;
  const oy = p.y - obj.position.y;
  const oz = p.z - obj.position.z;
  const mm = rot.m;
  const lx = mm[0] * ox + mm[3] * oy + mm[6] * oz;
  const ly = mm[1] * ox + mm[4] * oy + mm[7] * oz;
  const lz = mm[2] * ox + mm[5] * oy + mm[8] * oz;
  if (obj.kind === 'box') {
    return Math.abs(lx) < h.x && Math.abs(ly) < h.y && Math.abs(lz) < h.z;
  }
  const nx = lx / h.x;
  const ny = ly / h.y;
  const nz = lz / h.z;
  return nx * nx + ny * ny + nz * nz < 1;
}

/** 物件在世界空间的 AABB。 */
export function objectAabb(obj: SceneObject): BoxLike {
  const half = { x: obj.size.x / 2, y: obj.size.y / 2, z: obj.size.z / 2 };
  const rot = quatToMat3(obj.quaternion);
  return transformedAabb(
    { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    half,
    rot,
  );
}

/**
 * 统一裁决规则（加速路径与逐件路径共用，保证结果一致）：
 *
 * 1. 只保留 t >= 0 的命中。
 * 2. 起点在物件内部时该次命中 t = 0，并在结果里标记 inside
 *    —— 因此“从物体内部发出的射线”必然先命中该物体，除非有其它并列的 t=0。
 *    起点恰在表面时 inside = false，但仍是 t = 0 的接触命中。
 * 3. 按 t 升序；t 相同（|Δt| <= TIE_EPS）视为并列。
 * 4. 并列时按物件 id 升序，id 小者胜出 —— 与遍历顺序、分组划分、分组上限无关。
 * 5. 结果列表同样按 (t, id) 排序，便于逐条核对。
 */
export function resolveHits(raw: RawHit[]): {
  hits: RawHit[];
  selected: RawHit | null;
  tieIds: number[];
  tieT: number | null;
} {
  const hits = raw
    .filter((h) => h.t >= 0)
    .sort((a, b) => (a.t === b.t ? a.objectId - b.objectId : a.t - b.t));

  if (hits.length === 0) {
    return { hits, selected: null, tieIds: [], tieT: null };
  }
  const best = hits[0];
  const tieIds: number[] = [];
  for (const h of hits) {
    if (Math.abs(h.t - best.t) <= TIE_EPS) tieIds.push(h.objectId);
    else break;
  }
  // 已是 (t,id) 排序，best 就是 id 最小的并列者。
  return { hits, selected: best, tieIds, tieT: tieIds.length > 1 ? best.t : null };
}

// ---------------------------------------------------------------------------
// 空间分组（BVH）。叶节点即“分组”，分组上限 = 叶节点最多容纳的物件数。
// ---------------------------------------------------------------------------

export interface BvhNode {
  id: number;
  box: BoxLike;
  depth: number;
  isLeaf: boolean;
  children: BvhNode[];
  objectIds: number[];
  parent: BvhNode | null;
  /** 仅内部节点：划分轴 */
  axis?: 0 | 1 | 2;
}

export interface Bvh {
  root: BvhNode;
  nodes: BvhNode[];
  leaves: BvhNode[];
  maxDepth: number;
  capacity: number;
}

interface Entry {
  obj: SceneObject;
  box: BoxLike;
  center: Vec3;
}

export function buildBvh(
  objects: SceneObject[],
  maxLeafSize: number,
): Bvh {
  const capacity = Math.max(1, Math.floor(maxLeafSize));
  const entries: Entry[] = objects.map((obj) => {
    const box = objectAabb(obj);
    return {
      obj,
      box,
      center: {
        x: (box.min.x + box.max.x) / 2,
        y: (box.min.y + box.max.y) / 2,
        z: (box.min.z + box.max.z) / 2,
      },
    };
  });

  const nodes: BvhNode[] = [];
  const leaves: BvhNode[] = [];
  let nextId = 0;
  let maxDepth = 0;

  const unionBox = (items: Entry[]): BoxLike => {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const it of items) {
      min.x = Math.min(min.x, it.box.min.x);
      min.y = Math.min(min.y, it.box.min.y);
      min.z = Math.min(min.z, it.box.min.z);
      max.x = Math.max(max.x, it.box.max.x);
      max.y = Math.max(max.y, it.box.max.y);
      max.z = Math.max(max.z, it.box.max.z);
    }
    return { min, max };
  };

  const build = (
    items: Entry[],
    depth: number,
    parent: BvhNode | null,
  ): BvhNode => {
    maxDepth = Math.max(maxDepth, depth);
    const node: BvhNode = {
      id: nextId++,
      box: unionBox(items),
      depth,
      isLeaf: true,
      children: [],
      objectIds: items.map((it) => it.obj.id),
      parent,
    };
    nodes.push(node);

    if (items.length <= capacity) {
      leaves.push(node);
      return node;
    }

    // 沿质心分散最大的轴切分；用中位数保证两半平衡。
    let axis: 0 | 1 | 2 = 0;
    let bestSpread = -1;
    for (let a = 0; a < 3; a++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const it of items) {
        const v = a === 0 ? it.center.x : a === 1 ? it.center.y : it.center.z;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const spread = hi - lo;
      if (spread > bestSpread) {
        bestSpread = spread;
        axis = a as 0 | 1 | 2;
      }
    }

    const sorted = items.slice().sort((p, q) => {
      const pv = axis === 0 ? p.center.x : axis === 1 ? p.center.y : p.center.z;
      const qv = axis === 0 ? q.center.x : axis === 1 ? q.center.y : q.center.z;
      if (pv !== qv) return pv - qv;
      return p.obj.id - q.obj.id;
    });
    const mid = Math.floor(sorted.length / 2);
    const leftItems = sorted.slice(0, mid);
    const rightItems = sorted.slice(mid);

    // 极端情况下（所有质心重合）仍按 id 中位数拆开，保证进深有界。
    if (leftItems.length === 0 || rightItems.length === 0) {
      leftItems.push(...sorted.slice(0, 1));
      rightItems.length = 0;
      rightItems.push(...sorted.slice(1));
    }

    node.isLeaf = false;
    node.objectIds = [];
    node.axis = axis;
    const left = build(leftItems, depth + 1, node);
    const right = build(rightItems, depth + 1, node);
    node.children = [left, right];
    return node;
  };

  const root = build(entries, 0, null);
  return { root, nodes, leaves, maxDepth, capacity };
}

export interface AcceleratedPick {
  outcome: PickOutcome;
  /** 每个候选的分组 id，用于 UI 高亮 */
  candidateGroups: Map<number, number>;
}

export function pickWithBvh(
  bvh: Bvh,
  objectsById: Map<number, SceneObject>,
  origin: Vec3,
  dir: Vec3,
): AcceleratedPick {
  const t0 = performanceNow();
  const raw: RawHit[] = [];
  const visitedGroupIds: number[] = [];
  const visitedNodeIds: number[] = [];
  const candidateIds: number[] = [];
  const candidateGroups = new Map<number, number>();
  let nodesTested = 0;

  const stack: BvhNode[] = [bvh.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodesTested++;
    const span = rayBox(origin, dir, node.box);
    // 关键：起点在组内时 tEnter 可为负，只有完全在射线后方才剔除。
    if (!span || span[1] < 0) continue;
    visitedNodeIds.push(node.id);

    if (node.isLeaf) {
      visitedGroupIds.push(node.id);
      for (const id of node.objectIds) {
        const obj = objectsById.get(id);
        if (!obj) continue;
        // 候选 = 所在组被打到、因而进入窄相位求交的对象（无论是否真的相交）
        candidateIds.push(id);
        candidateGroups.set(id, node.id);
        const hit = intersectObject(obj, origin, dir);
        if (hit) {
          raw.push({ objectId: id, t: hit.t, inside: hit.inside });
        }
      }
    } else {
      for (const child of node.children) stack.push(child);
    }
  }

  const resolved = resolveHits(raw);
  const elapsedMs = performanceNow() - t0;
  return {
    outcome: {
      ...resolved,
      candidateIds,
      visitedGroupIds,
      visitedNodeIds,
      nodesTested,
      elapsedMs,
    },
    candidateGroups,
  };
}

/** 逐件求交基线：不做任何空间剪枝。 */
export function pickBrute(
  objects: SceneObject[],
  origin: Vec3,
  dir: Vec3,
): PickOutcome {
  const t0 = performanceNow();
  const raw: RawHit[] = [];
  const candidateIds: number[] = [];
  for (const obj of objects) {
    // 逐件基线没有剪枝：每个物件都是候选
    candidateIds.push(obj.id);
    const hit = intersectObject(obj, origin, dir);
    if (hit) {
      raw.push({ objectId: obj.id, t: hit.t, inside: hit.inside });
    }
  }
  const resolved = resolveHits(raw);
  return {
    ...resolved,
    candidateIds,
    visitedGroupIds: [],
    visitedNodeIds: [],
    nodesTested: objects.length,
    elapsedMs: performanceNow() - t0,
  };
}

/**
 * 命中一组射线时，加速路径与逐件路径是否给出同一选中物件
 * （并附上最近命中距离，便于核对“并列”是否也一致）。
 */
export function comparePick(
  a: PickOutcome,
  b: PickOutcome,
): boolean {
  const as = a.selected;
  const bs = b.selected;
  if (!as && !bs) return true;
  if (!as || !bs) return false;
  if (as.objectId !== bs.objectId) return false;
  if (Math.abs(as.t - bs.t) > TIE_EPS) return false;
  if (a.tieIds.join(',') !== b.tieIds.join(',')) return false;
  return true;
}

/** 更严格的对照：命中列表、距离、inside 标记、并列组都一致。 */
export function sameOutcome(a: PickOutcome, b: PickOutcome): boolean {
  if (a.hits.length !== b.hits.length) return false;
  for (let i = 0; i < a.hits.length; i++) {
    const ha = a.hits[i];
    const hb = b.hits[i];
    if (ha.objectId !== hb.objectId) return false;
    if (Math.abs(ha.t - hb.t) > TIE_EPS) return false;
    if (ha.inside !== hb.inside) return false;
  }
  return comparePick(a, b);
}

function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
