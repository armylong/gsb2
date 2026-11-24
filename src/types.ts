import * as THREE from 'three';

/** 面板局部坐标的四条边 */
export type EdgeId = 'minU' | 'maxU' | 'minV' | 'maxV';

/** 一块矩形面板的完整定义：以 center 为原点，u/v 为面内正交单位轴，normal = u × v */
export interface PanelDef {
  id: string;
  label: string;
  center: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
  normal: THREE.Vector3;
  halfU: number;
  halfV: number;
  /** false = 禁止吸附隔板 */
  stickable: boolean;
  color: number;
  /** 仅隔板使用：沿 normal 方向的半厚度 */
  thicknessHalf?: number;
}

/** 公共边邻接关系：from 面板的 fromEdge 与 to 面板的 toEdge 是同一条物理边 */
export interface Adjacency {
  fromPanel: string;
  fromEdge: EdgeId;
  toPanel: string;
  toEdge: EdgeId;
}

export interface PanelCoords {
  u: number;
  v: number;
  /** 面上的投影点 */
  point: THREE.Vector3;
  inside: boolean;
}

export interface EdgeSegment {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** 单位方向，约定：U 边取 +vAxis，V 边取 +uAxis */
  dir: THREE.Vector3;
  mid: THREE.Vector3;
}

export type MoveMode = 'attached' | 'detached';

/** 一次换面的完整记录，暂停时可在 HUD 查看 */
export interface SwitchRecord {
  time: number;
  fromPanel: string;
  toPanel: string;
  edge: string;
  posBefore: THREE.Vector3;
  posAfter: THREE.Vector3;
  velBefore: THREE.Vector3;
  velAfter: THREE.Vector3;
  speedBefore: number;
  speedAfter: number;
  retention: number;
}

export interface GameEvent {
  time: number;
  kind: 'switch' | 'detach' | 'land' | 'void-reset' | 'block' | 'info' | 'pass' | 'fail';
  text: string;
}
