/**
 * 共享类型定义。
 * 坐标系：世界坐标单位为米，x 向右、y 向下（俯视图），原点在房间左上角。
 * 所有屏幕位置都通过 Camera 可逆地映射回房间坐标。
 */

/** 二维向量 */
export interface Vec2 {
  x: number;
  y: number;
}

/** RGB 颜色（线性空间，0~1），同时也是反照率 */
export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/** 墙段：线段 + 漫反射颜色（=反照率）+ 开关 */
export interface WallSegment {
  id: string;
  a: Vec2;
  b: Vec2;
  color: RGBColor;
  enabled: boolean;
}

/** 灯：双向均匀线光源 */
export interface Lamp {
  a: Vec2;
  b: Vec2;
  /** 发光强度（辐射亮度，2D 单位，任意但一致的相对单位） */
  power: number;
  /** 灯光颜色 */
  color: RGBColor;
}

/** 地面取样点（探针），世界坐标固定，不随缩放/平移漂移 */
export interface SamplePoint {
  id: string;
  pos: Vec2;
}

/** 整个可编辑场景 */
export interface World {
  /** 房间矩形（俯视图外轮廓，米） */
  room: { x: number; y: number; w: number; h: number };
  walls: WallSegment[];
  lamp: Lamp;
  samples: SamplePoint[];
}

/** 两档取样质量 */
export type Quality = 'quick' | 'dense';

export interface QualitySpec {
  key: Quality;
  label: string;
  /** 地面点每个方向的角度射线数（0~2π） */
  floorRays: number;
  /** 墙面照度：灯的子采样段数 */
  lampSamples: number;
  /** 热图网格间距（米） */
  grid: number;
}

/** RGB 照度（线性，相对单位） */
export interface IrradianceRGB {
  r: number;
  g: number;
  b: number;
}

/** 单条墙段对某个地面点的反射贡献 */
export interface WallContribution {
  wallId: string;
  /** 该墙命中射线累计的角宽度（弧度） */
  angle: number;
  /** 贡献照度（RGB） */
  irradiance: IrradianceRGB;
}

/** 探针射线（用于可视化） */
export interface ProbeRay {
  angle: number;
  kind: 'lamp' | 'wall' | 'none';
  /** 命中距离（无命中时到房间边界） */
  dist: number;
  wallId?: string;
}

/** 地面探针完整分析结果 */
export interface FloorAnalysis {
  pos: Vec2;
  direct: IrradianceRGB;
  reflected: IrradianceRGB;
  total: IrradianceRGB;
  contributions: WallContribution[];
  rays: ProbeRay[];
  raysUsed: number;
}

/** 热图一个格子的结果 */
export interface HeatCell {
  pos: Vec2;
  direct: IrradianceRGB;
  total: IrradianceRGB;
}

/** 热图结果 */
export interface HeatMap {
  cells: HeatCell[];
  nx: number;
  ny: number;
  grid: number;
  quality: Quality;
  /** 计算耗时（毫秒） */
  elapsedMs: number;
  /** total 的 99 分位亮度，用于自动曝光 */
  p99Luma: number;
}

/** 编辑工具 */
export type ToolMode = 'select' | 'wall' | 'point' | 'pan';
