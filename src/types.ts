export type PartId = 'wall' | 'lid';
export type TargetId = 'bulge' | 'dent' | 'pinch';

export interface TargetMeta {
  id: TargetId;
  label: string;
}

export const TARGETS: TargetMeta[] = [
  { id: 'bulge', label: '鼓起 Bulge' },
  { id: 'dent', label: '按凹 Dent' },
  { id: 'pinch', label: '捏窄 Pinch' },
];

export const PARTS: { id: PartId; label: string }[] = [
  { id: 'wall', label: '容器壁' },
  { id: 'lid', label: '盖子' },
];

/** 每个部件 × 每个目标的权重滑杆调节范围（下限, 上限） */
export const WEIGHT_RANGES: Record<PartId, Record<TargetId, [number, number]>> = {
  wall: {
    bulge: [-0.4, 1.2],
    dent: [-1.2, 0.4],
    pinch: [-1.2, 0.8],
  },
  lid: {
    bulge: [-0.5, 1.2],
    dent: [-1.2, 0.5],
    pinch: [-1.0, 0.8],
  },
};

/** 盖子开合角（度）与重力软垂幅度范围 */
export const HINGE_RANGE: [number, number] = [0, 110];
export const FLEX_RANGE: [number, number] = [0, 1];

/** 全部可序列化的权重状态：三种目标在两个部件上各自独立 */
export interface Weights {
  wall: Record<TargetId, number>;
  lid: Record<TargetId, number>;
  hingeDeg: number;
  flex: number;
}

export function zeroWeights(): Weights {
  return {
    wall: { bulge: 0, dent: 0, pinch: 0 },
    lid: { bulge: 0, dent: 0, pinch: 0 },
    hingeDeg: 0,
    flex: 0,
  };
}

export function cloneWeights(w: Weights): Weights {
  return {
    wall: { ...w.wall },
    lid: { ...w.lid },
    hingeDeg: w.hingeDeg,
    flex: w.flex,
  };
}

export function lerpWeights(a: Weights, b: Weights, t: number): Weights {
  return {
    wall: {
      bulge: a.wall.bulge + (b.wall.bulge - a.wall.bulge) * t,
      dent: a.wall.dent + (b.wall.dent - a.wall.dent) * t,
      pinch: a.wall.pinch + (b.wall.pinch - a.wall.pinch) * t,
    },
    lid: {
      bulge: a.lid.bulge + (b.lid.bulge - a.lid.bulge) * t,
      dent: a.lid.dent + (b.lid.dent - a.lid.dent) * t,
      pinch: a.lid.pinch + (b.lid.pinch - a.lid.pinch) * t,
    },
    hingeDeg: a.hingeDeg + (b.hingeDeg - a.hingeDeg) * t,
    flex: a.flex + (b.flex - a.flex) * t,
  };
}

/** 固定点（用户钉住的边缘/任意顶点） */
export interface PinSpec {
  part: PartId;
  /** 该部件网格内的顶点序号 */
  vertex: number;
}

export interface SavedConfig {
  version: 1;
  savedAt: string;
  meshParams: MeshParams;
  weights: Weights;
  pins: PinSpec[];
}

/** 基础网格生成参数：载入时必须一致，保证画面可复现 */
export interface MeshParams {
  radius: number;
  wallHeight: number;
  radialSeg: number;
  wallRings: number;
  lidRings: number;
  hemDepth: number;
  hemThickness: number;
}

export const DEFAULT_MESH_PARAMS: MeshParams = {
  radius: 1,
  wallHeight: 1.2,
  radialSeg: 64,
  wallRings: 16,
  lidRings: 8,
  hemDepth: 0.08,
  hemThickness: 0.03,
};
