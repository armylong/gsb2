import * as THREE from 'three';
import type { Adjacency, EdgeId, EdgeSegment, PanelCoords, PanelDef } from './types';

/**
 * 三块互成直角的可吸附面（地面 -> 竖直墙 -> 顶面），
 * 外加一块禁止吸附的隔板（竖在地面上的鳍片）。
 *
 * 约定：每个面板以 center 为原点，uAxis / vAxis 为面内正交单位轴，
 * 且 normal = uAxis × vAxis（右手系）。
 */
export const PANELS: PanelDef[] = [
  {
    id: 'floor',
    label: '地面 A（可吸附）',
    center: new THREE.Vector3(0, 0, 0),
    uAxis: new THREE.Vector3(1, 0, 0),
    vAxis: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    halfU: 5,
    halfV: 4,
    stickable: true,
    color: 0x2f6fb3,
  },
  {
    id: 'wall',
    label: '立墙 B（可吸附）',
    center: new THREE.Vector3(0, 3, 4),
    uAxis: new THREE.Vector3(1, 0, 0),
    vAxis: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 0, -1),
    halfU: 5,
    halfV: 3,
    stickable: true,
    color: 0x3a8f6d,
  },
  {
    id: 'ceiling',
    label: '顶面 C（可吸附）',
    center: new THREE.Vector3(0, 6, 6),
    uAxis: new THREE.Vector3(1, 0, 0),
    vAxis: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, -1, 0),
    halfU: 5,
    halfV: 2,
    stickable: true,
    color: 0x8f6a3a,
  },
  {
    id: 'barrier',
    label: '隔板 X（禁止吸附）',
    // 竖在地面 z≈1.5 处的鳍片：在路线（x=-3 中线）侧面，不挡外角但能正面拦截
    center: new THREE.Vector3(-2, 0.5, 1.5),
    uAxis: new THREE.Vector3(0, 0, -1),
    vAxis: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(1, 0, 0),
    halfU: 0.8,
    halfV: 0.5,
    stickable: false,
    color: 0xb34040,
    thicknessHalf: 0.08,
  },
];

/**
 * 两条公共边，对应路线上的两个外角：
 * 外角 1：地面 maxV 边 == 立墙 minV 边（y=0, z=4）
 * 外角 2：立墙 maxV 边 == 顶面 maxV 边（y=6, z=4）
 * 顶面 minV 边（z=8）没有邻接 —— 即“缺面”，跨出去会脱离并坠落。
 */
export const ADJACENCIES: Adjacency[] = [
  { fromPanel: 'floor', fromEdge: 'maxV', toPanel: 'wall', toEdge: 'minV' },
  { fromPanel: 'wall', fromEdge: 'minV', toPanel: 'floor', toEdge: 'maxV' },
  { fromPanel: 'wall', fromEdge: 'maxV', toPanel: 'ceiling', toEdge: 'maxV' },
  { fromPanel: 'ceiling', fromEdge: 'maxV', toPanel: 'wall', toEdge: 'maxV' },
];

export const PANEL_MAP: ReadonlyMap<string, PanelDef> = new Map(PANELS.map((p) => [p.id, p]));
const ADJ_MAP = new Map<string, Adjacency>(
  ADJACENCIES.map((a) => [`${a.fromPanel}:${a.fromEdge}`, a]),
);

export function getAdjacency(panelId: string, edge: EdgeId): Adjacency | undefined {
  return ADJ_MAP.get(`${panelId}:${edge}`);
}

/** 世界坐标投影到面板局部 (u, v) */
export function projectToPanel(point: THREE.Vector3, panel: PanelDef): PanelCoords {
  const d = point.clone().sub(panel.center);
  const u = d.dot(panel.uAxis);
  const v = d.dot(panel.vAxis);
  const onPlane = panel.center
    .clone()
    .addScaledVector(panel.uAxis, u)
    .addScaledVector(panel.vAxis, v);
  return {
    u,
    v,
    point: onPlane,
    inside: Math.abs(u) <= panel.halfU && Math.abs(v) <= panel.halfV,
  };
}

export function clampCoords(panel: PanelDef, u: number, v: number): { u: number; v: number } {
  return {
    u: THREE.MathUtils.clamp(u, -panel.halfU, panel.halfU),
    v: THREE.MathUtils.clamp(v, -panel.halfV, panel.halfV),
  };
}

export function coordsToWorld(panel: PanelDef, u: number, v: number, out = new THREE.Vector3()) {
  return out
    .copy(panel.center)
    .addScaledVector(panel.uAxis, u)
    .addScaledVector(panel.vAxis, v);
}

/** 取面板某条边的线段（端点 / 单位方向 / 中点） */
export function getEdge(panel: PanelDef, edge: EdgeId): EdgeSegment {
  const c = panel.center;
  let mid: THREE.Vector3;
  let dir: THREE.Vector3;
  let a: THREE.Vector3;
  let b: THREE.Vector3;
  switch (edge) {
    case 'minU':
      mid = c.clone().addScaledVector(panel.uAxis, -panel.halfU);
      dir = panel.vAxis.clone();
      a = mid.clone().addScaledVector(panel.vAxis, -panel.halfV);
      b = mid.clone().addScaledVector(panel.vAxis, panel.halfV);
      break;
    case 'maxU':
      mid = c.clone().addScaledVector(panel.uAxis, panel.halfU);
      dir = panel.vAxis.clone();
      a = mid.clone().addScaledVector(panel.vAxis, -panel.halfV);
      b = mid.clone().addScaledVector(panel.vAxis, panel.halfV);
      break;
    case 'minV':
      mid = c.clone().addScaledVector(panel.vAxis, -panel.halfV);
      dir = panel.uAxis.clone();
      a = mid.clone().addScaledVector(panel.uAxis, -panel.halfU);
      b = mid.clone().addScaledVector(panel.uAxis, panel.halfU);
      break;
    case 'maxV':
      mid = c.clone().addScaledVector(panel.vAxis, panel.halfV);
      dir = panel.uAxis.clone();
      a = mid.clone().addScaledVector(panel.uAxis, -panel.halfU);
      b = mid.clone().addScaledVector(panel.uAxis, panel.halfU);
      break;
  }
  return { a, b, dir: dir.clone().normalize(), mid };
}

/** 从某条边指向面板内部的单位方向 */
export function edgeInward(panel: PanelDef, edge: EdgeId): THREE.Vector3 {
  switch (edge) {
    case 'minU':
      return panel.uAxis.clone();
    case 'maxU':
      return panel.uAxis.clone().negate();
    case 'minV':
      return panel.vAxis.clone();
    case 'maxV':
      return panel.vAxis.clone().negate();
  }
}

/** 投影点到四条边的有符号距离（在面内），返回最近边 */
export function nearestEdge(
  panel: PanelDef,
  coords: PanelCoords,
): { edge: EdgeId; dist: number; segment: EdgeSegment } {
  const candidates: { edge: EdgeId; dist: number }[] = [
    { edge: 'minU', dist: coords.u + panel.halfU },
    { edge: 'maxU', dist: panel.halfU - coords.u },
    { edge: 'minV', dist: coords.v + panel.halfV },
    { edge: 'maxV', dist: panel.halfV - coords.v },
  ];
  candidates.sort((a, b) => a.dist - b.dist);
  const best = candidates[0];
  return { edge: best.edge, dist: best.dist, segment: getEdge(panel, best.edge) };
}

/** 圆盘起点（地面 A 上） */
export const START = {
  panelId: 'floor',
  u: -3,
  v: -2.5,
};

/** 脚本路线经过的世界坐标点（跨两个外角，终点接近缺面边） */
export const ROUTE_POINTS: THREE.Vector3[] = [
  new THREE.Vector3(-3, 0, -2.5),
  new THREE.Vector3(-3, 0, 3.1),
  new THREE.Vector3(-3, 0.9, 4),
  new THREE.Vector3(-3, 5.1, 4),
  new THREE.Vector3(-3, 6, 4.9),
  new THREE.Vector3(-3, 6, 7.55),
];

/** 缺面处的示意框（顶面 minV 边之外，本应有一块竖直面） */
export const MISSING_FRAME = {
  xHalf: 1.5,
  z: 8,
  y0: 6,
  y1: 7.5,
};
