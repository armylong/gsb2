export interface Vec2 {
  x: number;
  y: number;
}

export type Vec3 = [number, number, number];

/** 标注线方向:X / Z 为地面两个互相垂直的方向,REF 为参考长度线 */
export type LineDir = 'X' | 'Z' | 'REF';

export interface MarkedLine {
  id: number;
  p1: Vec2; // 图像像素坐标
  p2: Vec2;
  dir: LineDir;
}

export interface PlacedBox {
  id: number;
  gx: number; // 世界地面坐标 (X)
  gz: number; // 世界地面坐标 (Z)
  w: number;  // 沿 X 尺寸 (m)
  d: number;  // 沿 Z 尺寸 (m)
  h: number;  // 高度 (m)
}

export interface ScenePreset {
  key: string;
  label: string;
  width: number;
  height: number;
  focal: number;        // 像素焦距
  camHeight: number;    // 相机离地高度 (m)
  yawDeg: number;       // 水平朝向
  depressionDeg: number;// 俯角
  boxes: { x: number; z: number; w: number; d: number; h: number }[];
}
