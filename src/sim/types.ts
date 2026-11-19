import * as THREE from 'three';

/** 三类箱体材料 */
export type MaterialKind = 'penetrable' | 'reflective' | 'blocking';

/** 材料参数。阻力仅对可穿透材料生效。 */
export interface MaterialParams {
  kind: MaterialKind;
  /** 可穿透: 单位内部距离消耗的能量 (energy / 单位长度) */
  resistance: number;
  /** 可反弹: 每次反射扣除的能量比例, 0.2 表示扣 20% */
  reflectLossRatio: number;
  /** 可反弹: 允许的最大入射角 (与法线夹角, 度); 超过则不允许反射 */
  maxReflectAngleDeg: number;
}

/** 有厚度长方体(带旋转的 OBB) */
export interface BoxDef {
  id: string;
  name: string;
  position: THREE.Vector3;
  /** 欧拉角 (弧度), 顺序 XYZ */
  rotation: THREE.Euler;
  /** 全尺寸 (非半尺寸), 必须为正 */
  size: THREE.Vector3;
  material: MaterialParams;
}

/** 靶面: 无厚度矩形平面, 仅单面命中 (从法线一侧击中才算) */
export interface TargetDef {
  id: string;
  name: string;
  position: THREE.Vector3;
  /** 绕世界轴的旋转 (弧度, XYZ) */
  rotation: THREE.Euler;
  /** 全尺寸 */
  size: THREE.Vector2;
}

export type SceneObjectDef = BoxDef | TargetDef;

export function isBoxDef(o: SceneObjectDef): o is BoxDef {
  return (o as BoxDef).material !== undefined;
}

/** 一次发射的输入参数 */
export interface ShotParams {
  origin: THREE.Vector3;
  /** 单位方向向量, 内部会重新归一化 */
  direction: THREE.Vector3;
  initialEnergy: number;
  /** 最大射程 (世界单位, 包含材料内部路程) */
  maxRange: number;
  /** 最多交互次数 (需求固定上限 8) */
  maxInteractions: number;
  /** 最低能量: 低于该值立即结束 */
  minEnergy: number;
}

/** 交互类型 */
export type InteractionKind =
  | 'entry' // 进入可穿透材料
  | 'exit' // 穿出可穿透材料
  | 'stop-inside' // 能量耗尽, 停在材料内部
  | 'reflect' // 反弹
  | 'reflect-rejected' // 满足不了反弹角度/能量, 停在表面
  | 'blocked' // 完全阻挡
  | 'target-hit'; // 命中靶面

export interface Contact {
  kind: InteractionKind;
  objectId: string;
  objectName: string;
  point: THREE.Vector3;
  /** 接触面外法线 (指向射线来向一侧); 内部停点无接触面, 为 null */
  normal: THREE.Vector3 | null;
  /** 入射角 (入射方向与法线夹角, 度); 不适用时为 null */
  incidenceDeg: number | null;
}

export interface TrajectorySegment {
  index: number;
  /** flight = 空气中飞行段; inside = 材料内部段; reflection = 零长度反射节点 */
  type: 'flight' | 'inside' | 'reflection';
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** 段长度 (内部段即实际斜穿距离) */
  length: number;
  /** 段起点处能量 */
  energyBefore: number;
  /** 段终点处能量 */
  energyAfter: number;
  /** 该段是否在某个材料内部 */
  materialObjectId: string | null;
  /** 段终点处发生的交互, 最后一段无交互时为 null */
  endContact: Contact | null;
}

export type EndReason =
  | 'min-energy'
  | 'max-range'
  | 'max-interactions'
  | 'blocked'
  | 'target-hit'
  | 'reflect-rejected'
  | 'exhausted-inside';

export interface ShotResult {
  params: ShotParams;
  segments: TrajectorySegment[];
  contacts: Contact[];
  /** 实际发生的交互次数 (entry/exit 各算一次, 与 maxInteractions 对照) */
  interactionCount: number;
  totalDistance: number;
  remainingEnergy: number;
  endReason: EndReason;
  endPoint: THREE.Vector3;
}
