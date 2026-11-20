/**
 * 权重与姿态的保存 / 恢复(纯数据层,不直接依赖 three.js)。
 * 同时提供 localStorage 持久化与 JSON 字符串导出/导入两种方式。
 */

import { BONE_COUNT } from './WeightModel';

export interface BonePose {
  /** 绕 Y 轴旋转角(度),在带所在平面内弯曲 */
  rotY: number;
  /** 绕 Z 轴旋转角(度),向带平面外弯曲 */
  rotZ: number;
}

export interface DebuggerState {
  version: 1;
  vertexCount: number;
  /** 扁平权重数组,长度 vertexCount * BONE_COUNT */
  weights: number[];
  /** 每根骨骼的姿态,长度 BONE_COUNT */
  poses: BonePose[];
  /** 每根骨骼的锁定状态,长度 BONE_COUNT */
  locked: boolean[];
  /** 最近使用的预设 id */
  presetId: string;
  savedAt: string;
}

export const STORAGE_KEY = 'skinning-weight-debugger:v1';

export function encodeState(
  weights: Float32Array | number[],
  poses: BonePose[],
  locked: boolean[],
  presetId: string,
): string {
  const state: DebuggerState = {
    version: 1,
    vertexCount: weights.length / BONE_COUNT,
    weights: Array.from(weights),
    poses: poses.map((p) => ({ rotY: p.rotY, rotZ: p.rotZ })),
    locked: [...locked],
    presetId,
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(state);
}

/** 解析并校验存档;不合法时抛出带中文说明的 Error */
export function decodeState(json: string): DebuggerState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('存档不是合法的 JSON');
  }
  const s = raw as Partial<DebuggerState>;
  if (!s || typeof s !== 'object') throw new Error('存档结构为空');
  if (s.version !== 1) throw new Error(`不支持的存档版本: ${String(s.version)}`);
  if (!Array.isArray(s.weights) || !Array.isArray(s.poses) || !Array.isArray(s.locked)) {
    throw new Error('存档缺少 weights / poses / locked 字段');
  }
  if (s.weights.length !== s.vertexCount! * BONE_COUNT) {
    throw new Error('存档权重长度与顶点数不匹配');
  }
  if (s.poses.length !== BONE_COUNT || s.locked.length !== BONE_COUNT) {
    throw new Error(`存档姿态/锁定数组长度应为 ${BONE_COUNT}`);
  }
  for (const w of s.weights) {
    if (typeof w !== 'number' || Number.isNaN(w) || w < 0 || w > 1) {
      throw new Error('存档中存在越界或非数值权重');
    }
  }
  return s as DebuggerState;
}

/** 校验恢复出的权重与当前网格顶点数一致 */
export function assertStateMatches(state: DebuggerState, vertexCount: number): void {
  if (state.vertexCount !== vertexCount) {
    throw new Error(`存档顶点数 ${state.vertexCount} 与当前网格 ${vertexCount} 不一致,拒绝恢复`);
  }
}

export function saveToLocalStorage(state: string): void {
  localStorage.setItem(STORAGE_KEY, state);
}

export function loadFromLocalStorage(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function clearLocalStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}
