import { Vec } from './geom.js';

/** 灯船:height 为灯笼桅顶高度(米),speed 为沿航路速度(px/s)。 */
export interface BoatDef {
  id: string;
  name: string;
  height: number;
  speed: number;
  color: string;
}

/** 一轮演出:船队沿指定航路通过;导览牌按剧本停在锚点,可在场次中途被挪走。 */
export interface RoundDef {
  name: string;
  routes: Record<string, Vec[]>; // boatId -> 航路折线
  signAnchor: number;            // 本轮开场时导览牌所在锚点
  signMove?: { t: number; anchor: number }; // 场中变化:演出到 t 秒时导览牌被搬到另一锚点
  duration: number;              // 秒
  keyMoments: { id: string; t: number; label: string }[];
}

export interface ParadeDef {
  id: string;
  name: string;
  boats: BoatDef[];
  rounds: RoundDef[];
}

export interface SeatHole { id: string; pos: Vec; row: number }

export interface Pillar { id: string; pos: Vec; r: number; height: number }

/** 导览牌:可在若干锚点间搬动,挡视线。 */
export interface SignDef { anchors: Vec[]; r: number; height: number }

export type Contract =
  | { kind: 'full'; boatId: string; minRatio: number }   // 每轮看到该船的时间占比 ≥ minRatio
  | { kind: 'moments'; boatId: string; moments: string[] }; // 关键时刻必须看见该船

export interface ViewerDef {
  id: string;
  name: string;
  eyeHeight: number;  // 米
  fovHalf: number;    // 弧度,可接受朝向半角
  contract: Contract;
}

/** 一把椅子:放在哪个座孔、朝向(弧度,0=+x,-PI/2=朝水)、坐着谁。 */
export interface Chair {
  id: string;
  holeId: string;
  facing: number;
  viewerId: string | null;
}

export interface Layout {
  chairs: Chair[];
}

export interface LevelDef {
  holes: SeatHole[];
  pillars: Pillar[];
  sign: SignDef;
  viewers: ViewerDef[];
  initialLayout: Layout;
  movesPerIntermission: number;
}
