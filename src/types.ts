/**
 * 全局类型定义
 *
 * 装配模型:
 * - 零件通过 parentId 形成树形层级(外壳 / 盖板 / 内支架 / 转轴 + 两组紧固件)
 * - 每个零件挂在自己父节点的 Object3D 下, 爆炸位移 dir 定义在「直接父节点」的局部空间
 * - 父节点移动时子零件整体跟随; 子零件自己的爆炸再沿局部 dir 叠加, 朝向保持不变
 */

/** 三维向量以普通数组持久化, 避免序列化 Map/Vector3 */
export type Vec3Tuple = [number, number, number];

/** 单个零件的爆炸步骤配置 */
export interface ExplodeStep {
  /** 所属展开段: 0 = 第一段, 1 = 第二段 */
  phase: 0 | 1;
  /** 段内起始进度 [0,1], 仅当 start < t <= end 时该零件正在动作 */
  start: number;
  /** 段内结束进度 [0,1] */
  end: number;
  /** 拉开方向(直接父节点的局部坐标轴方向), 内部会归一化 */
  dir: Vec3Tuple;
  /** 沿 dir 拉开的距离(世界单位) */
  distance: number;
}

/** 可编辑零件定义 */
export interface PartDef {
  id: string;
  /** 界面显示的中文名称 */
  name: string;
  /** 装配层级中的父零件 id; 顶层零件为 null */
  parentId: string | null;
  /** 装配位置下相对直接父节点的局部位置 */
  position: Vec3Tuple;
  /** 爆炸步骤; null 表示该零件不参与爆炸(如外壳) */
  step: ExplodeStep | null;
}

/** 干涉检测中被判定为物理配合/共拆关系、允许重叠的零件对 */
export interface CollisionIgnore {
  a: string;
  b: string;
}

/** 整套可持久化的展开配置 */
export interface EditorConfig {
  /** 配置 schema 版本, 便于以后迁移 */
  version: 1;
  /** 配置名称(内置预设 / 自定义) */
  name: string;
  parts: PartDef[];
  /** 物理配合面忽略表(铰链销轴与耳片等) */
  collisionIgnore: CollisionIgnore[];
}

/** 相机快照, 保存后重开能恢复同一视角 */
export interface CameraSnapshot {
  position: Vec3Tuple;
  target: Vec3Tuple;
  zoom: number;
}

/** 写入 localStorage 的完整会话 */
export interface SavedSession {
  version: 1;
  config: EditorConfig;
  /** 总进度 [0,1] */
  progress: number;
  /** 翻盖预览角度(弧度), 仅 progress=0 时可用 */
  lidAngle: number;
  camera: CameraSnapshot;
}

/** 一次干涉命中: 零件 moving 在进度区间内与 blocker 相交 */
export interface CollisionHit {
  moving: string;
  blocker: string;
  /** 全局总进度区间 [0,1] */
  rangeStart: number;
  rangeEnd: number;
}

/** 树节点上的零件元数据 key */
export const PART_ID_KEY = 'partId';
