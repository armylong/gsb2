/**
 * 应用状态管理: 两台投影、场景、视图模式、探针、有效性快照。
 * 拖动手柄时先校验, 非法(自交/退化)则保留上次有效投影并记录异常。
 */
import { validateQuad } from '../core/geometry.ts';
import { buildScenario, SCREEN_W, SCREEN_H } from '../core/scenarios.ts';
import type { Point, ProjectorState, Quad, SettingsFile } from '../core/types.ts';

export type ViewMode = 'blend' | 'diff' | 'coverage';

export interface InvalidState {
  projectorId: number;
  reason: string;
}

export interface AppState {
  screenWidth: number;
  screenHeight: number;
  blendRatio: number;
  viewMode: ViewMode;
  renderScale: number;
  projectors: ProjectorState[];
  /** 每台投影上次通过校验的四边形(非法拖动时回退用) */
  validQuads: Quad[];
  invalid: InvalidState | null;
  probes: Point[];
  scenarioId: string;
  /** 导入核对模式: 投影 id -> 位图文件名 */
  importedBitmaps: Map<number, string>;
}

export function createInitialState(scenarioId = 'normal'): AppState {
  const { projectors, blendWidth } = buildScenario(scenarioId);
  return {
    screenWidth: SCREEN_W,
    screenHeight: SCREEN_H,
    // 场景给出的是像素带宽, 这里归一化比例(融合占重叠带比例), 默认整条带渐变
    blendRatio: clampBlend(blendWidth / 160),
    viewMode: 'blend',
    renderScale: 0.75,
    projectors,
    validQuads: projectors.map((p) => p.quad.map((q) => ({ ...q })) as Quad),
    invalid: null,
    probes: [],
    scenarioId,
    importedBitmaps: new Map(),
  };
}

export function clampBlend(v: number): number {
  return Math.min(1, Math.max(0.05, v));
}

/** 尝试更新某台投影的某个角点; 非法时保留上次有效投影并返回 false */
export function tryMoveCorner(state: AppState, projectorId: number, corner: number, next: Point): boolean {
  const st = state.projectors.find((p) => p.id === projectorId);
  if (!st) return false;
  const candidate = st.quad.map((p, i) => (i === corner ? { ...next } : { ...p })) as Quad;
  const check = validateQuad(candidate);
  if (!check.valid) {
    state.invalid = { projectorId, reason: check.reason ?? '四边形非法' };
    return false;
  }
  st.quad = candidate;
  state.validQuads[projectorId - 1] = candidate.map((p) => ({ ...p })) as Quad;
  state.invalid = null;
  return true;
}

/** 整体平移某台投影(拖动四边形内部) */
export function translateProjector(state: AppState, projectorId: number, dx: number, dy: number): boolean {
  const st = state.projectors.find((p) => p.id === projectorId);
  if (!st) return false;
  const candidate = st.quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;
  const check = validateQuad(candidate);
  if (!check.valid) {
    state.invalid = { projectorId, reason: check.reason ?? '四边形非法' };
    return false;
  }
  st.quad = candidate;
  state.validQuads[projectorId - 1] = candidate.map((p) => ({ ...p })) as Quad;
  state.invalid = null;
  return true;
}

export function setBrightness(state: AppState, projectorId: number, value: number): void {
  const st = state.projectors.find((p) => p.id === projectorId);
  if (st) st.brightness = Math.min(1.5, Math.max(0, value));
}

export function loadScenario(state: AppState, scenarioId: string): void {
  const fresh = createInitialState(scenarioId);
  state.projectors = fresh.projectors;
  state.validQuads = fresh.validQuads;
  state.blendRatio = fresh.blendRatio;
  state.invalid = null;
  state.probes = [];
  state.scenarioId = scenarioId;
  state.importedBitmaps.clear();
}

export function toSettingsFile(state: AppState, imageFiles: Record<number, string>): SettingsFile {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    screenWidth: state.screenWidth,
    screenHeight: state.screenHeight,
    patternWidth: 1600,
    patternHeight: 600,
    blendWidth: Math.round(state.blendRatio * 160),
    projectors: state.projectors.map((p) => ({
      id: p.id,
      name: p.name,
      outputWidth: p.outputWidth,
      outputHeight: p.outputHeight,
      quad: p.quad,
      brightness: p.brightness,
      patternU0: p.patternU0,
      patternU1: p.patternU1,
      patternV0: p.patternV0,
      patternV1: p.patternV1,
      imageFile: imageFiles[p.id] ?? `projector-${p.id}.png`,
    })),
  };
}

/** 应用导入的设置(四边形/亮度/裁剪), 同样走合法性校验 */
export function applySettings(state: AppState, settings: SettingsFile): string[] {
  const warnings: string[] = [];
  const next: ProjectorState[] = [];
  for (const sp of settings.projectors) {
    const check = validateQuad(sp.quad);
    if (!check.valid) {
      warnings.push(`投影${sp.id}: 导入四边形非法(${check.reason}), 已保留当前投影`);
      const existing = state.projectors.find((p) => p.id === sp.id);
      if (existing) next.push({ ...existing });
      continue;
    }
    next.push({
      id: sp.id,
      name: sp.name,
      outputWidth: sp.outputWidth,
      outputHeight: sp.outputHeight,
      quad: sp.quad,
      brightness: sp.brightness,
      patternU0: sp.patternU0,
      patternU1: sp.patternU1,
      patternV0: sp.patternV0,
      patternV1: sp.patternV1,
    });
  }
  if (next.length === 2) {
    state.projectors = next;
    state.validQuads = next.map((p) => p.quad.map((q) => ({ ...q })) as Quad);
    state.screenWidth = settings.screenWidth;
    state.screenHeight = settings.screenHeight;
    state.blendRatio = clampBlend((settings.blendWidth ?? 160) / 160);
    state.invalid = null;
    state.scenarioId = 'custom';
  }
  return warnings;
}
