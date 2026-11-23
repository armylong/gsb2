import type { Vector3Tuple } from 'three';

/** 一个可独立采样的平面（局部参数化：p = origin + u*uAxis + v*vAxis） */
export interface SurfaceDef {
  id: string;
  label: string;
  group: 'floor' | 'wall' | 'occluder';
  /** 局部原点（u=0, v=0 处的世界坐标） */
  origin: Vector3Tuple;
  uAxis: Vector3Tuple;
  vAxis: Vector3Tuple;
  normal: Vector3Tuple;
  /** 局部 u 方向长度（世界单位） */
  width: number;
  /** 局部 v 方向长度（世界单位） */
  height: number;
  /** 反照率（线性 0..1） */
  baseColor: Vector3Tuple;
}

/** 场景几何描述：两面墙 + 地面 + 一个 AABB 遮挡体，足以从设置完全重建 */
export interface SceneConfig {
  room: { size: number; wallHeight: number };
  occluder: { min: Vector3Tuple; max: Vector3Tuple };
}

/** 采样设置（导出 JSON 的核心内容，同设置必须可重建同一贴图） */
export interface BakeSettings {
  atlasSize: number;
  texelsPerUnit: number;
  paddingPx: number;
  dilationPasses: number;
  rayBias: number;
  light: {
    position: Vector3Tuple;
    color: Vector3Tuple;
    intensity: number;
    radius: number;
    ambient: number;
  };
  scene: SceneConfig;
}

/** 打包结果中一个面在图集里的矩形（像素，左上角原点） */
export interface ChartRect {
  surfaceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  uv: { u0: number; v0: number; u1: number; v1: number };
}

export interface PackedAtlas {
  size: number;
  rects: ChartRect[];
  /** 装不下的面（正常演示参数下应为空） */
  overflow: string[];
}

export interface BakedLightmap {
  size: number;
  /** RGBA，sRGB 编码，每个元素 0..255 */
  rgba: Uint8ClampedArray;
  /** 每个纹素归属的面 id（padding 像素为 null），用于边缘扩张与边界统计 */
  owner: (string | null)[];
  rects: ChartRect[];
  /** 烘焙时实际使用的设置 */
  settings: BakeSettings;
  /** 线性空间下的面辐射度（0..1，含反照率），每纹素 RGB，供调试/差值模式使用 */
  linear: Float32Array;
  /** 阴影边界纹素（线性索引 -> true）：自身未遮挡但 8 邻域存在遮挡纹素 */
  boundary: boolean[];
  stats: {
    texelCount: number;
    boundaryCount: number;
    /** 在不同 bias 下翻转遮挡状态的边界纹素数：bias 敏感度（偏差指示） */
    biasSensitiveCount: number;
    /** 扩张后仍未填充的纹素总数（含图集闲置区域） */
    remainingHoles: number;
    /** 扩张后各 chart 的 padding 环带内仍未填充的纹素（真正的接缝缺陷） */
    paddingHoles: number;
    /** 烘焙耗时（毫秒） */
    bakeMs: number;
  };
}

/** 导出文件格式 */
export interface ExportBundle {
  version: 1;
  exportedAt: string;
  settings: BakeSettings;
  atlas: { size: number; rects: ChartRect[]; overflow: string[] };
  lightmap: {
    width: number;
    height: number;
    pngFile: string;
    /** 导出 RGBA 的 FNV-1a 校验和，回读 PNG 后可比对，避免在 JSON 里重复内嵌全部像素 */
    rgbaHash: string;
  };
  settingsHash: string;
}
