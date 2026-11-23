// 风场：一个竖直暖气团（thermal）+ 一段水平侧风区，均支持边缘渐变过渡。
// 风场是纯位置函数、与帧率无关；重叠区直接向量相加，可看出合成后的风向与大小。
import { Vec2, clamp, smoothstep } from './vec';

export interface ThermalConfig {
  enabled: boolean;
  cx: number; // 中心 x（米）
  cy: number; // 中心 y（米）
  rx: number; // 水平半径（米）
  ry: number; // 竖直半径（米）
  strength: number; // 中心上升风速（米/秒）
  edge: number; // 边缘过渡带宽（米），0 = 硬边界
}

export interface CrosswindConfig {
  enabled: boolean;
  xStart: number;
  xEnd: number;
  yLow: number;
  yHigh: number;
  /** 水平风速（米/秒）：负 = 迎风（吹向 -x），正 = 顺风 */
  strength: number;
  edge: number; // 边缘过渡带宽（米）
}

export const DEFAULT_THERMAL: ThermalConfig = {
  enabled: true,
  cx: 118,
  cy: 78,
  rx: 30,
  ry: 62,
  strength: 7,
  edge: 16,
};

export const DEFAULT_CROSSWIND: CrosswindConfig = {
  enabled: true,
  xStart: 138,
  xEnd: 225,
  yLow: 15,
  yHigh: 110,
  strength: -4, // 默认迎风
  edge: 16,
};

/** 椭圆内按到边界的归一化距离做 smoothstep 渐变，边缘外为 0、中心为 1 */
function ellipseWeight(p: Vec2, cfg: ThermalConfig): number {
  const nx = (p.x - cfg.cx) / cfg.rx;
  const ny = (p.y - cfg.cy) / cfg.ry;
  const d = Math.hypot(nx, ny);
  if (d >= 1) return 0;
  if (cfg.edge <= 0) return 1;
  // d 从 1-edgeFrac 到 1 之间由 1 平滑降到 0
  const edgeFrac = clamp(cfg.edge / Math.max(cfg.rx, cfg.ry), 0, 1);
  return 1 - smoothstep(1 - edgeFrac, 1, d);
}

function boxWeight(p: Vec2, cfg: CrosswindConfig): number {
  const ex = cfg.edge;
  const ey = Math.max(2, cfg.edge * 0.5);
  const wx =
    smoothstep(cfg.xStart, cfg.xStart + ex, p.x) *
    (1 - smoothstep(cfg.xEnd - ex, cfg.xEnd, p.x));
  const wy =
    smoothstep(cfg.yLow, cfg.yLow + ey, p.y) *
    (1 - smoothstep(cfg.yHigh - ey, cfg.yHigh, p.y));
  return wx * wy;
}

export function thermalWind(p: Vec2, cfg: ThermalConfig): Vec2 {
  if (!cfg.enabled) return { x: 0, y: 0 };
  return { x: 0, y: cfg.strength * ellipseWeight(p, cfg) };
}

export function crossWind(p: Vec2, cfg: CrosswindConfig): Vec2 {
  if (!cfg.enabled) return { x: 0, y: 0 };
  return { x: cfg.strength * boxWeight(p, cfg), y: 0 };
}

/** 合成风（重叠区为两向量之和） */
export function sampleWind(p: Vec2, thermal: ThermalConfig, cross: CrosswindConfig): Vec2 {
  const a = thermalWind(p, thermal);
  const b = crossWind(p, cross);
  return { x: a.x + b.x, y: a.y + b.y };
}
