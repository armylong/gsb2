/** 二维向量 / 矩形等基础类型 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LimitReason =
  | 'MIN_ZOOM'
  | 'MAX_ZOOM'
  | 'PAN_LIMIT_X'
  | 'PAN_LIMIT_Y';

/** 运动路径的关键帧 */
export interface PathKey {
  t: number; // 世界时间(秒)
  x: number;
  y: number;
}

/** 角色(简单几何形状) */
export interface Actor {
  id: string;
  name: string;
  color: string;
  shape: 'circle' | 'square' | 'triangle';
  radius: number;
  path: PathKey[];
  loop: boolean;
}

/** 运行时角色状态 */
export interface ActorState {
  id: string;
  x: number;
  y: number;
  /** 本 tick 内是否被用户拖动(拖动时路径不推进) */
  dragging: boolean;
}

/** 镜头可调参数 */
export interface CameraConfig {
  /** 安全区: 距离屏幕四边的比例边距, 0~0.4 */
  safeMargin: { x: number; y: number };
  /** 缩放范围, 单位: 世界单位 / 逻辑像素 */
  minZoom: number;
  maxZoom: number;
  /** 镜头中心允许活动的世界范围(平移范围) */
  panBounds: Rect;
  /** 平滑系数 0~1, 1 = 无平滑(硬切) */
  smoothing: number;
  /** per-tick: 每固定步长吃同样比例(不同帧率会发散); exp: 帧率无关指数平滑 */
  smoothingMode: 'per-tick' | 'exp';
}

/** 单个角色的裁切诊断 */
export interface ClipInfo {
  actorId: string;
  /** 超出视口的边, 未超出则为空数组 */
  sides: Array<'left' | 'right' | 'top' | 'bottom'>;
}

/** 每 tick 的镜头快照 —— 回放与确定性校验都基于它 */
export interface Snapshot {
  t: number;
  actors: Array<{ id: string; x: number; y: number }>;
  camera: {
    cx: number;
    cy: number;
    zoom: number;
    desiredCx: number;
    desiredCy: number;
    desiredZoom: number;
    view: Rect; // 视口在世界中的矩形
    followIds: string[];
    clips: ClipInfo[];
    limits: LimitReason[];
  };
}
