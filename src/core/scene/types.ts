import type { FillRule, VectorPath } from '../geometry/path';
import type { Mat3 } from '../geometry/matrix';

export type MaskKey = 'A' | 'B';
export type LayerKey = 'content' | MaskKey;

export interface ContentShape {
  id: string;
  label: string;
  path: VectorPath;
  rule: FillRule;
  color: string;
  /** 绘制/命中排序, 数值越大越靠上 */
  z: number;
}

export interface MaskLayer {
  key: MaskKey;
  label: string;
  path: VectorPath;
  rule: FillRule;
  /** 本层局部坐标 -> 父空间 (A 的父空间是场景根, B 的父空间是 A) */
  matrix: Mat3;
  color: string;
}

export interface SceneModel {
  /** 内容自身变换: 内容局部坐标 -> 场景根 */
  contentMatrix: Mat3;
  shapes: ContentShape[];
  masks: Record<MaskKey, MaskLayer>;
}

export type ViewMode = 'outline' | 'maskA' | 'maskB' | 'final';
