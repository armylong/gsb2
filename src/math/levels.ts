import type { AABB } from './aabb';
import type { Vec3 } from './vector';

/** 检查路线航点（逐步检查入口用） */
export interface Waypoint {
  pos: Vec3;
  label: string;
}

export interface LevelDef {
  id: string;
  label: string;
  description: string;
  boxes: AABB[];
  spawn: Vec3;
  spawnYaw: number;
  waypoints: Waypoint[];
}

/** 以中心 + 尺寸构造 AABB */
function box(
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  name: string,
  isCeiling = false,
): AABB {
  return {
    min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
    max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
    name,
    isCeiling,
  };
}

/** 地面作为一个超薄大盒子，统一参与相机碰撞（防止镜头钻入地下） */
function ground(): AABB {
  return {
    min: { x: -60, y: -20, z: -60 },
    max: { x: 60, y: 0, z: 60 },
    name: '地面',
  };
}

const BOUND = 18;

/** 预设一：墙角 + 立柱（墙前缩近、贴墙滑动、斜掠墙边、墙角球体余量） */
function wallCornerLevel(): LevelDef {
  const boxes: AABB[] = [
    ground(),
    // L 形墙
    box(0, 1.5, -3, 12, 3, 0.5, '横墙'),
    box(-6, 1.5, -8.5, 0.5, 3, 11.5, '纵墙'),
    // 立柱与独立块
    box(3, 1.5, 2, 1, 3, 1, '方柱A'),
    box(-2.5, 1.5, 3.5, 0.8, 3, 0.8, '方柱B'),
    box(5.5, 1, 4.5, 1.6, 2, 1.6, '独立矮块'),
  ];
  return {
    id: 'corner',
    label: '预设 1 · 墙角 / 立柱',
    description: 'L 形墙角、方柱与独立矮块，验证墙前缩近、离墙回退、掠柱滑动与墙角球体余量。',
    boxes,
    spawn: { x: 0, y: 0, z: 5 },
    spawnYaw: 0,
    waypoints: [
      { pos: { x: 0, y: 0, z: 5 }, label: '起点（面向横墙）' },
      { pos: { x: 0, y: 0, z: -1.9 }, label: '逼近横墙，镜头应缩近' },
      { pos: { x: 4.5, y: 0, z: -1.9 }, label: '贴墙右滑至墙端' },
      { pos: { x: 4.5, y: 0, z: 2.6 }, label: '绕墙端转出' },
      { pos: { x: 3, y: 0, z: 3.3 }, label: '斜掠方柱A 边缘' },
      { pos: { x: -2.5, y: 0, z: 5.2 }, label: '退回开阔地，距离平滑恢复' },
    ],
  };
}

/** 预设二：狭道 + S 形错位块 + 窄门（缩到最小距离与受限提示） */
function narrowLevel(): LevelDef {
  const boxes: AABB[] = [
    ground(),
    // 主狭道：内宽 2.4m，长 16m
    box(-1.45, 1.5, -2, 0.5, 3, 16, '左墙'),
    box(1.45, 1.5, -2, 0.5, 3, 16, '右墙'),
    // S 形错位块（两侧各留约 1.7m 可通过）
    box(0.72, 1, -3, 0.55, 2, 1.4, '错位块A'),
    box(-0.72, 1, -6, 0.55, 2, 1.4, '错位块B'),
    // 尽头窄廊：内宽 0.64m（=2×相机半径），沿相机射线方向延伸 4m，
    // 球在槽心净距为 0、任何后退距离都贴墙 → 稳定触发受限
    box(-0.57, 1.5, -9, 0.5, 3, 4, '窄廊左墙'),
    box(0.57, 1.5, -9, 0.5, 3, 4, '窄廊右墙'),
    box(0, 2.6, -9, 1.64, 0.8, 4, '窄廊门梁'),
  ];
  return {
    id: 'narrow',
    label: '预设 2 · 狭道 / 窄门',
    description: '2.4m 狭道内 S 形错位块，尽头 0.64m 窄廊无法容纳最小相机距离，验证持续缩近与受限提示。',
    boxes,
    spawn: { x: 0, y: 0, z: 5.5 },
    spawnYaw: 0,
    waypoints: [
      { pos: { x: 0, y: 0, z: 5.5 }, label: '道口起点' },
      { pos: { x: 0, y: 0, z: -1.5 }, label: '进入狭道，距离被两侧墙压缩' },
      { pos: { x: -0.35, y: 0, z: -3.6 }, label: '左侧挤过错位块A' },
      { pos: { x: 0.4, y: 0, z: -5.4 }, label: '右侧挤过错位块B' },
      { pos: { x: 0, y: 0, z: -6.8 }, label: '逼近窄廊入口' },
      { pos: { x: 0, y: 0, z: -8.2 }, label: '进入窄廊（预期受限提示）' },
      { pos: { x: 0, y: 0, z: 4 }, label: '原路退出，距离平滑恢复' },
    ],
  };
}

/** 预设三：低顶通道（门梁、顶板、内部柱、更低区段） */
function lowCeilingLevel(): LevelDef {
  const boxes: AABB[] = [
    ground(),
    // 通道侧墙：内宽 2.8m
    box(-1.6, 1, -4, 0.4, 2, 12.4, '隧道左墙'),
    box(1.6, 1, -4, 0.4, 2, 12.4, '隧道右墙'),
    // 主顶板：底面 1.9m
    box(0, 2.1, -3.9, 3.6, 0.4, 12.2, '主顶板', true),
    // 入口门梁：底面 1.6m
    box(0, 1.75, 1.7, 2.8, 0.3, 0.5, '低门梁', true),
    // 内部立柱
    box(0.8, 1, -4.2, 0.6, 2, 0.6, '隧道内柱'),
    // 深处更低顶板：底面 1.55m
    box(0, 1.75, -8.7, 3.6, 0.4, 2.6, '低矮顶板', true),
  ];
  return {
    id: 'lowceiling',
    label: '预设 3 · 低顶通道',
    description: '1.6m 门梁、1.9m 顶板与 1.55m 低矮区段，俯仰观察时验证镜头与近裁剪面不穿顶。',
    boxes,
    spawn: { x: 0, y: 0, z: 5 },
    spawnYaw: 0,
    waypoints: [
      { pos: { x: 0, y: 0, z: 5 }, label: '通道外起点' },
      { pos: { x: 0, y: 0, z: 1.2 }, label: '低头穿过低门梁' },
      { pos: { x: 0, y: 0, z: -2.5 }, label: '主顶板下平视 / 俯仰检查' },
      { pos: { x: -0.6, y: 0, z: -4.5 }, label: '绕过隧道内柱' },
      { pos: { x: 0, y: 0, z: -8.6 }, label: '进入 1.55m 低矮区段' },
      { pos: { x: 0, y: 0, z: 4.5 }, label: '撤出通道，恢复期望距离' },
    ],
  };
}

export const LEVELS: LevelDef[] = [wallCornerLevel(), narrowLevel(), lowCeilingLevel()];

export function getLevel(id: string): LevelDef {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

export function clampToWorld(p: Vec3): void {
  p.x = Math.max(-BOUND, Math.min(BOUND, p.x));
  p.z = Math.max(-BOUND, Math.min(BOUND, p.z));
}
