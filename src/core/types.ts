/** 共享类型定义(全部是可擦除语法, 同时供浏览器与 Node 使用) */

export interface Point {
  x: number;
  y: number;
}

/** 四边形四角, 固定顺序: 左上(0) 右上(1) 右下(2) 左下(3) */
export type Quad = [Point, Point, Point, Point];

export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 一台虚拟投影机的完整定位状态 */
export interface ProjectorState {
  id: number;
  name: string;
  /** 输出分辨率(即喂给真实投影机的画面尺寸) */
  outputWidth: number;
  outputHeight: number;
  /** 输出图四角在幕布坐标系中的落点 */
  quad: Quad;
  /** 整体亮度增益 0..1.5 */
  brightness: number;
  /**
   * 本机输出对应主测试图的归一化裁剪范围 [0,1]。
   * 两台在主平面上的裁剪段相邻/重叠, 才能保证幕布同一位置取到同一图案坐标。
   */
  patternU0: number;
  patternU1: number;
  patternV0: number;
  patternV1: number;
}

/** 可再导入的定位设置文件 */
export interface SettingsFile {
  version: 1;
  exportedAt: string;
  screenWidth: number;
  screenHeight: number;
  patternWidth: number;
  patternHeight: number;
  blendWidth: number;
  projectors: Array<{
    id: number;
    name: string;
    outputWidth: number;
    outputHeight: number;
    quad: Quad;
    brightness: number;
    patternU0: number;
    patternU1: number;
    patternV0: number;
    patternV1: number;
    imageFile: string;
  }>;
}

/** 某像素的覆盖信息(融合计算中间结果) */
export interface CoverageInfo {
  /** 各投影机在该像素的几何权重 0..1, 未覆盖为 0 */
  weights: [number, number];
  /** 该像素至少被一台覆盖 */
  covered: boolean;
  /** 两台同时覆盖(融合带) */
  overlap: boolean;
}

/** 探针采样结果 */
export interface ProbeResult {
  screen: Point;
  pattern: Point | null;
  coveredBy: number[];
  weights: [number, number];
  compositeGray: number | null;
  referenceGray: number | null;
  diff: number | null;
}
