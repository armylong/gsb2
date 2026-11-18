import type { AABB, Camera, EntityId, SortMode } from './types';
import { overlaps3D, polygonsIntersect, projectedCenterY, silhouettePolygon } from './geometry';

export interface OrderEntity {
  id: EntityId;
  box: AABB;
}

export interface Relation {
  before: EntityId;
  after: EntityId;
  reason: string;
}

export interface OrderResult {
  /** 实际采用的绘制顺序：先画 -> 后画（越靠后越在“前”）。 */
  order: EntityId[];
  /** 正确模式下由三维关系推出的有向边。 */
  relations: Relation[];
  /** 体积互相穿入的实体对（合法摆放下应为空）。 */
  interpenetrations: { a: EntityId; b: EntityId }[];
  /** 参与排序环（无法形成一致顺序）的实体。 */
  cycleEntities: EntityId[];
  /** 是否检测到冲突（环或穿入）。 */
  hasConflict: boolean;
  /** 对照模式下，违反正确关系的边（naive 结果 vs 正确关系）。 */
  naiveViolations: Relation[];
}

/**
 * 两个实体的前后判定（仅当屏幕剪影有面积重叠时才需要排先后）：
 * - 体积穿入：无合法先后，标为冲突。
 * - 水平占地重叠时只能沿 z 分离：z 小的先画。
 * - 水平占地不重叠但高度造成屏幕重叠：比较各自更靠近相机一侧的投影深度。
 */
function pairRelation(a: OrderEntity, b: OrderEntity, cam: Camera): Relation | { interpenetration: true } | null {
  const polyA = silhouettePolygon(a.box, cam);
  const polyB = silhouettePolygon(b.box, cam);
  if (!polygonsIntersect(polyA, polyB)) return null;

  if (overlaps3D(a.box, b.box)) return { interpenetration: true };

  const footprintOverlap =
    a.box.minX < b.box.maxX && b.box.minX < a.box.maxX && a.box.minY < b.box.maxY && b.box.minY < a.box.maxY;

  if (footprintOverlap) {
    // 不穿入且占地重叠 => 必然沿 z 轴严格分离
    if (a.box.maxZ <= b.box.minZ) {
      return { before: a.id, after: b.id, reason: `${a.id} 整体位于 ${b.id} 下方（z 分离，叠放）` };
    }
    return { before: b.id, after: a.id, reason: `${b.id} 整体位于 ${a.id} 下方（z 分离，叠放）` };
  }

  // 占地不重叠：比较南下角（x、y 更大、z 更小更靠近相机）的投影深度
  const cornerA = { x: a.box.maxX, y: a.box.maxY, z: a.box.minZ };
  const cornerB = { x: b.box.maxX, y: b.box.maxY, z: b.box.minZ };
  const depthA = cornerA.x + cornerA.y - 2 * cornerA.z;
  const depthB = cornerB.x + cornerB.y - 2 * cornerB.z;
  if (depthA < depthB) {
    return { before: a.id, after: b.id, reason: `${a.id} 远离相机一侧被 ${b.id} 遮挡（深度比较）` };
  }
  return { before: b.id, after: a.id, reason: `${b.id} 远离相机一侧被 ${a.id} 遮挡（深度比较）` };
}

export interface Graph {
  edges: Map<EntityId, Set<EntityId>>;
  indegree: Map<EntityId, number>;
  reasons: Map<string, string>;
}

function buildGraph(entities: OrderEntity[], cam: Camera): {
  graph: Graph;
  relations: Relation[];
  interpenetrations: { a: EntityId; b: EntityId }[];
} {
  const graph: Graph = {
    edges: new Map(entities.map((e) => [e.id, new Set()])),
    indegree: new Map(entities.map((e) => [e.id, 0])),
    reasons: new Map(),
  };
  const relations: Relation[] = [];
  const interpenetrations: { a: EntityId; b: EntityId }[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const r = pairRelation(entities[i], entities[j], cam);
      if (r === null) continue;
      if ('interpenetration' in r) {
        interpenetrations.push({ a: entities[i].id, b: entities[j].id });
        continue;
      }
      relations.push(r);
      if (!graph.edges.get(r.before)!.has(r.after)) {
        graph.edges.get(r.before)!.add(r.after);
        graph.indegree.set(r.after, (graph.indegree.get(r.after) ?? 0) + 1);
        graph.reasons.set(`${r.before}->${r.after}`, r.reason);
      }
    }
  }
  return { graph, relations, interpenetrations };
}

/** Tarjan 强连通分量：大小 > 1 的 SCC 即为排序环。 */
export function findCycleEntities(graph: Graph): EntityId[] {
  let index = 0;
  const indices = new Map<EntityId, number>();
  const lowlink = new Map<EntityId, number>();
  const onStack = new Set<EntityId>();
  const stack: EntityId[] = [];
  const cycles: EntityId[] = [];

  const strongConnect = (v: EntityId): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component: EntityId[] = [];
      let w: EntityId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) cycles.push(...component);
    }
  };

  for (const v of graph.edges.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }
  return cycles;
}

/** Kahn 拓扑排序；稳定规则：同层按 id 字典序。环上节点会被留在末尾。 */
export function topoSort(graph: Graph): { order: EntityId[]; remaining: EntityId[] } {
  const indegree = new Map(graph.indegree);
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: EntityId[] = [];
  while (queue.length > 0) {
    const v = queue.shift()!;
    order.push(v);
    for (const w of [...(graph.edges.get(v) ?? [])].sort()) {
      const d = (indegree.get(w) ?? 0) - 1;
      indegree.set(w, d);
      if (d === 0) {
        queue.push(w);
        queue.sort();
      }
    }
  }
  const remaining = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id).sort();
  return { order, remaining };
}

/** 对照排序：只按屏幕中心纵坐标，纵坐标小的先画；同值按 id。 */
export function naiveOrder(entities: OrderEntity[], cam: Camera): EntityId[] {
  return [...entities]
    .map((e) => ({ id: e.id, cy: projectedCenterY(e.box, cam) }))
    .sort((a, b) => (a.cy === b.cy ? a.id.localeCompare(b.id) : a.cy - b.cy))
    .map((e) => e.id);
}

export function computeOrder(entities: OrderEntity[], cam: Camera, mode: SortMode): OrderResult {
  const { graph, relations, interpenetrations } = buildGraph(entities, cam);
  const cycleEntities = findCycleEntities(graph);
  const { order: topo, remaining } = topoSort(graph);
  const correctOrder = [...topo, ...remaining];

  const naive = naiveOrder(entities, cam);
  const position = new Map(naive.map((id, i) => [id, i]));
  const naiveViolations: Relation[] = mode === 'naive'
    ? relations.filter((r) => (position.get(r.before) ?? 0) > (position.get(r.after) ?? 0))
    : [];

  return {
    order: mode === 'naive' ? naive : correctOrder,
    relations,
    interpenetrations,
    cycleEntities,
    hasConflict: cycleEntities.length > 0 || interpenetrations.length > 0,
    naiveViolations,
  };
}

/** 给定一组正确关系，求某个实体的直接前后依赖（供面板展示）。 */
export function dependenciesOf(id: EntityId, relations: Relation[]): {
  before: Relation[];
  after: Relation[];
} {
  return {
    before: relations.filter((r) => r.after === id),
    after: relations.filter((r) => r.before === id),
  };
}
