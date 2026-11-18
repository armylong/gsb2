/**
 * 核心类型定义：纸模（多面体）定义、展开树、展开网络、折叠求解结果。
 *
 * 坐标系约定：
 * - 平面展开网络（net）放在 z = 0 平面，所有面的外法线朝 +Z，顶点逆时针排列。
 * - 三维目标实体（target）由各预设直接给出顶点坐标，同样按外法线逆时针排列。
 * - 折叠过程中，每个面作为刚体，子面绕与父面共享的铰链边旋转。
 */
import * as THREE from 'three';

/** 三维顶点列表（索引引用），目标实体与展开网络共用一套面-顶点索引语义。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 一个多边形面：顶点按外法线视角逆时针排列。 */
export interface FaceDef {
  /** 稳定 id，同时作为面编号展示。 */
  id: string;
  /** 目标实体上的顶点索引（逆时针，外法线朝外）。 */
  targetVertexIds: number[];
}

/** 展开树中的一条父子连接（铰链边）。 */
export interface TreeEdge {
  /** 父面 id。根面没有入边。 */
  parent: string;
  /** 子面 id。 */
  child: string;
  /** 共享边在父面 targetVertexIds 中的两个顶点索引（父面 CCW 遍历方向）。 */
  parentEdge: [number, number];
  /**
   * 共享边在子面 targetVertexIds 中的两个顶点索引。
   * 两个面均按外法线逆时针排列，因此子面对同一条边的 CCW 遍历方向与父面相反，
   * 即 childEdge[0] 对应的实体顶点 == parentEdge[1]，childEdge[1] == parentEdge[0]。
   */
  childEdge: [number, number];
}

/** 一个预设纸模的完整静态定义。 */
export interface PolyhedronDef {
  key: string;
  name: string;
  targetVertices: Vec3[];
  faces: FaceDef[];
  /** 生成树边，必须把所有面连成一棵以 rootFaceId 为根的树。 */
  tree: TreeEdge[];
  rootFaceId: string;
}

/** 展开网络中每个面的平面布局数据（z=0，外法线 +Z）。 */
export interface NetFace {
  id: string;
  /** 与 PolyhedronDef.faces 同序的顶点平面坐标。 */
  netPoints: THREE.Vector3[];
  /** 目标实体顶点坐标（计算用，同序）。 */
  targetPoints: THREE.Vector3[];
  parentId: string | null;
  /** 若为子面：父面内共享边顶点在父面 targetVertexIds 中的索引。 */
  parentEdge: [number, number] | null;
  /** 若为子面：本面内共享边顶点在本面 targetVertexIds 中的索引。 */
  childEdge: [number, number] | null;
  /**
   * 铰链边在平面网络中的世界坐标。
   * hingeA/hingeB 为父面视角的端点（parentEdge 方向）；
   * childHingeA/childHingeB 为子面自身视角（childEdge 方向，与父面反向），
   * 即子面做刚体旋转时真正的枢轴端点。
   */
  hingeA: THREE.Vector3 | null;
  hingeB: THREE.Vector3 | null;
  childHingeA: THREE.Vector3 | null;
  childHingeB: THREE.Vector3 | null;
}

/** 每个面的折叠求解数据：平面姿态、相对位姿、目标折叠角。 */
export interface FoldFace {
  id: string;
  parentId: string | null;
  /**
   * 平面网络顶点在【本面局部基】下的坐标（相对枢轴）。
   * 本面基 X 沿铰链（根面为世界 X）、Y = Z × X、Z = +Z，枢轴为原点。
   */
  flatLocalPoints: THREE.Vector3[];
  /** 平面网络中该面枢轴的世界坐标（根面为其第 0 顶点，子面为父视角铰链点 hingeA）。 */
  pivotFlat: THREE.Vector3;
  /** 平面态本面局部基的 X、Y 轴（世界单位向量）；Z 恒为 +Z。 */
  basisX: THREE.Vector3;
  basisY: THREE.Vector3;
  /** 平面世界矩阵 F_face = T(pivot) · R(basis)。 */
  flatMatrix: THREE.Matrix4;
  /**
   * 平面态本面相对父面的固定位姿（父面局部帧内）= F_parent⁻¹ · F_face。
   * 姿态组合 M_face = M_parent · flatRelative · Rx(θ)；根面为 null。
   */
  flatRelative: THREE.Matrix4 | null;
  /** 目标实体上的面顶点（世界目标坐标，同序）。 */
  targetPoints: THREE.Vector3[];
  /** 平面网络中铰链边端点（父面视角；根面为 null）。 */
  hingeA: THREE.Vector3 | null;
  hingeB: THREE.Vector3 | null;
  /** 平面网络中铰链边端点（子面自身视角；根面为 null）。 */
  childHingeA: THREE.Vector3 | null;
  childHingeB: THREE.Vector3 | null;
  /** 完全折叠（进度 1）时，子面相对父面绕铰链边的有符号折叠角（弧度）。 */
  targetAngle: number;
  parentEdge: [number, number] | null;
  childEdge: [number, number] | null;
}

/** 一条多边形边的端点（用目标顶点索引表示，无向）。 */
export type EdgeKey = string;

/** 构建完成的纸模：静态展开网络 + 折叠求解数据。 */
export interface BuiltModel {
  def: PolyhedronDef;
  faces: FoldFace[];
  faceById: Map<string, FoldFace>;
  /** 所有铰链边（树边），key 为 "minVid-maxVid"（目标顶点索引）。 */
  hingeEdges: { key: EdgeKey; va: number; vb: number; parent: string; child: string }[];
  /** 所有裁切边（面的边中不是铰链的边），按目标顶点索引配对。 */
  cutEdgePairs: { key: EdgeKey; va: number; vb: number; faces: string[] }[];
  /** 目标实体上的顶点坐标（按索引）。 */
  targetVertices: THREE.Vector3[];
}

/** 验证用的容差与实测结果。 */
export interface CheckEntry {
  name: string;
  detail: string;
  tolerance: number;
  actual: number;
  pass: boolean;
}
