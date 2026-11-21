import type { Quaternion, Vector3 } from 'three';

/** 场景物件的形状。两种形状都通过“单位几何 + 尺寸”表达。 */
export type ShapeKind = 'box' | 'sphere';

/**
 * normal: 实心渲染
 * shell: 半透明外壳，便于看见嵌套在里面的物件
 * wire: 线框，用于并置展示（避免 z-fighting）
 */
export type RenderStyle = 'normal' | 'shell' | 'wire';

export interface SceneObject {
  id: number;
  label: string;
  kind: ShapeKind;
  /** 世界坐标中心 */
  position: Vector3;
  /** 世界坐标朝向 */
  quaternion: Quaternion;
  /** 世界坐标尺寸（盒体为三边长度，球体为三个轴向的直径） */
  size: Vector3;
  style: RenderStyle;
  color: number;
  /** 生成时的快照，供“复位”使用 */
  initial: {
    position: Vector3;
    quaternion: Quaternion;
    size: Vector3;
  };
}

export interface RaySpec {
  origin: Vector3;
  /** 必须是单位向量 */
  direction: Vector3;
  label: string;
  tag: string;
  /** 演示射线的净空走廊：生成随机物件时避开，避免挡住演示目标 */
  clearance?: { length: number; radius: number };
}

export interface Specials {
  nestedOuterId: number;
  nestedInnerId: number;
  insideId: number;
  tieIds: [number, number];
  /** 射线穿过其 AABB 角落、但精确求交不相交的球体 */
  aabbFalsePositiveId: number;
}

export interface GeneratedScene {
  seed: number;
  objects: SceneObject[];
  specials: Specials;
  /** 演示区域，生成随机物件时避开 */
  keepOut: Array<{ center: Vector3; radius: number }>;
  /** 固定的演示射线 */
  rays: RaySpec[];
}

export interface RawHit {
  objectId: number;
  /** 世界空间射线参数，t >= 0 */
  t: number;
  /** 射线起点位于该物件内部，命中距离按 0 处理 */
  inside: boolean;
}

export interface PickOutcome {
  hits: RawHit[];
  selected: RawHit | null;
  /** 与最近命中距离并列（<= TIE_EPS）的物件 */
  tieIds: number[];
  tieT: number | null;
  /** 参与精确求交的物件（加速路径中即“候选对象”） */
  candidateIds: number[];
  /** 射线命中包围盒的叶组 */
  visitedGroupIds: number[];
  /** 射线命中包围盒的全部节点（含内部节点） */
  visitedNodeIds: number[];
  /** 实际做射线-AABB 测试的节点数 */
  nodesTested: number;
  elapsedMs: number;
}

export interface ScenePick {
  ray: RaySpec;
  accelerated: PickOutcome;
  brute: PickOutcome;
  agree: boolean;
}

export interface CapBatchReport {
  capacity: number;
  groupCount: number;
  maxDepth: number;
  rayCount: number;
  mismatches: Array<{ ray: string; accelerated: number | null; brute: number | null }>;
  avgCandidates: number;
  maxCandidates: number;
  avgVisitedGroups: number;
  maxVisitedGroups: number;
  avgNodesTested: number;
  accelMs: number;
  bruteMs: number;
}
