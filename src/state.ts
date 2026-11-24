import type { FillRule, Triangle, Vec2 } from "./rasterizer.js";
import type { SAMPLE_PATTERNS } from "./rasterizer.js";

export const GRID_W = 18;
export const GRID_H = 18;

export type PatternKey = keyof typeof SAMPLE_PATTERNS;

export interface NamedVertex extends Vec2 {
  id: number;
  name: string;
}

export interface AppState {
  verts: NamedVertex[];
  triangles: Triangle[];
  patternKey: PatternKey;
  rule: FillRule;
  /** 半像素场景：base 顶点 + 全局平移 offset（像素单位） */
  baseVerts: Vec2[];
  offset: Vec2;
  cell: number; // 每个逻辑像素在屏幕上的边长（CSS px）
  selected: { px: number; py: number } | null;
  selectedVertex: number | null;
  /** 退化演示前保存的细三角形 D 点坐标 */
  thinBackup: Vec2 | null;
  showVerts: boolean;
  showGrid: boolean;
  showSamples: boolean;
}

let vid = 0;
function v(x: number, y: number, name: string): NamedVertex {
  return { id: vid++, x, y, name };
}

/**
 * 内置可复现场景：
 *  - 红/蓝两个三角形共享 (6,12)-(12,6) 斜边，斜边正好穿过若干像素中心
 *  - 一枚细长绿三角，宽约 0.4px，贴在斜边附近
 */
export function createInitialState(): AppState {
  vid = 0;
  const verts: NamedVertex[] = [
    v(6, 12, "A"), // 0 共享边端点
    v(12, 6, "B"), // 1 共享边端点
    v(6, 6, "C"), // 2
    v(12, 12, "D"), // 3
    v(14.2, 2.4, "E"), // 4 细三角
    v(14.6, 2.3, "F"), // 5 细三角
    v(15.4, 8.6, "G"), // 6 细三角
  ];

  const triangles: Triangle[] = [
    {
      id: "T1",
      label: "红三角 T1（左上侧）",
      v: [0, 1, 2],
      color: { r: 0.95, g: 0.28, b: 0.25 },
    },
    {
      id: "T2",
      label: "蓝三角 T2（右下侧）",
      v: [0, 3, 1],
      color: { r: 0.28, g: 0.5, b: 0.98 },
    },
    {
      id: "T3",
      label: "细三角 T3（独立）",
      v: [4, 5, 6],
      color: { r: 0.3, g: 0.9, b: 0.45 },
    },
  ];

  const baseVerts = verts.map((q) => ({ x: q.x, y: q.y }));

  return {
    verts,
    triangles,
    patternKey: "1",
    rule: "topleft",
    baseVerts,
    offset: { x: 0, y: 0 },
    cell: 34,
    selected: { px: 7, py: 7 },
    selectedVertex: null,
    thinBackup: null,
    showVerts: true,
    showGrid: true,
    showSamples: true,
  };
}

/** 以 baseVerts + offset 重建当前顶点（顶点拖拽会同时改 base） */
export function applyOffset(state: AppState): void {
  state.verts.forEach((vert, i) => {
    const base = state.baseVerts[i];
    vert.x = base.x + state.offset.x;
    vert.y = base.y + state.offset.y;
  });
}

export function setOffset(state: AppState, ox: number, oy: number): void {
  state.offset = {
    x: round4(ox),
    y: round4(oy),
  };
  applyOffset(state);
}

/** 拖拽顶点：同步修改 base，保证后续平移相对新位置进行 */
export function moveVertex(state: AppState, id: number, x: number, y: number): void {
  const nx = round4(x);
  const ny = round4(y);
  state.verts[id].x = nx;
  state.verts[id].y = ny;
  state.baseVerts[id] = {
    x: nx - state.offset.x,
    y: ny - state.offset.y,
  };
}

export function resetScene(state: AppState): void {
  const fresh = createInitialState();
  state.verts = fresh.verts;
  state.triangles = fresh.triangles;
  state.baseVerts = fresh.baseVerts;
  state.offset = { x: 0, y: 0 };
  state.thinBackup = null;
  state.selected = { px: 7, py: 7 };
  state.selectedVertex = null;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
