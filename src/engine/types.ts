import type { Vec2 } from '../vec';

/** 玩家每一步的输入。 */
export interface Inputs {
  /** 舵：-1 左满舵，+1 右满舵，0 正舵。 */
  rudder: number;
  /** 帆索（调帆角）：0 收满，1 完全松出。 */
  sheet: number;
}

export interface WindState {
  /** 风吹去的方向（弧度，屏幕坐标，0=东，顺时针）。 */
  dir: number;
  /** 风速 m/s。 */
  speed: number;
}

/** 横向水流区：矩形带，内部流速恒定，边缘平滑过渡。 */
export interface CurrentZone {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 水流速度向量 m/s。 */
  velocity: Vec2;
  /** 边缘过渡宽度（米）。 */
  feather: number;
}

export interface Buoy {
  id: number;
  name: string;
  pos: Vec2;
  radius: number;
}

export interface Boat {
  pos: Vec2;
  /** 船头方向（弧度）。 */
  heading: number;
  /** 相对水体的速度 m/s。 */
  vel: Vec2;
  /** 角速度 rad/s。 */
  yawRate: number;
  /** 当前帆桁方向（弧度，世界坐标），会带惯性地跟到下风侧。 */
  boomAngle: number;
  /** 迎风失速因子 0~1：1 正常，0 完全失速（浮在风眼里）。 */
  fill: number;
  /** 最近一次过风时的累积动量，用于帮助完成换舷。 */
  tackMomentum: number;
  /** 风眼迟滞状态：进入内风眼置位，驶出外风眼才清除。 */
  inIronsHeld: boolean;
  /** 与浮标碰撞后用于平滑推出的剩余位移。 */
  contact: Vec2;
}

/** 一帧的中间观测量，供渲染与暂停面板使用。 */
export interface BoatReadout {
  apparentWind: Vec2;
  apparentSpeed: number;
  /** 表观风与船头的夹角，带符号，0=正对风。 */
  awa: number;
  /** 帆的攻角，带符号。 */
  aoa: number;
  sailForce: Vec2;
  sailForceMag: number;
  /** 帆桁相对中心线的带符号角度。 */
  boomOffset: number;
  /** 帆是否在飘（失速/抖动）。 */
  luffing: boolean;
  /** 横向漂移（leeway）速度分量。 */
  leeway: number;
  /** 对地速度。 */
  sog: number;
  /** 对水速度。 */
  stw: number;
  /** 实际运动方向（对地航向 COG，弧度）。 */
  cog: number;
  /** 迎风 VMG（向风眼方向的速度分量，正=向上风推进）。 */
  vmgUpwind: number;
  inNoGo: boolean;
  inIrons: boolean;
  /** 当前舷：'port' 左舷受风 / 'starboard' 右舷受风 / 'none'。 */
  tack: 'port' | 'starboard' | 'none';
  current: Vec2;
}

export interface GateSpec {
  /** 对应的浮标 id（起终点可为 null）。 */
  buoyId: number | null;
  /** 门线中心点。 */
  center: Vec2;
  /** 门线方向（航行前进方向，门线与它垂直）。 */
  legDir: Vec2;
  halfWidth: number;
  /** 必须从哪一侧过：port / starboard / null（不要求）。 */
  requiredSide: 'port' | 'starboard' | null;
  label: string;
}

export interface GateEvent {
  index: number;
  label: string;
  ok: boolean;
  reasons: string[];
  side: 'port' | 'starboard' | 'none';
  t: number;
}
