import { ConfigValidationError, parseConfig } from './validate';
import type { MachineConfig } from './types';

export interface ApplyResult {
  /** 应用成功时为新配置; 失败时原样返回 current, 保证已有配置不被破坏 */
  config: MachineConfig;
  applied: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 把外部 JSON 尝试应用到当前配置:
 * - 校验失败(缺失状态引用 / 非法时长 / 越界事件等)时整体拒绝, 返回原配置;
 * - 成功时返回规范化后的深拷贝, 调用方应重建状态机并从确定初态重跑。
 */
export function tryApplyConfig(current: MachineConfig, raw: unknown): ApplyResult {
  try {
    const { config, warnings } = parseConfig(raw);
    return { config, applied: true, errors: [], warnings };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return {
        config: current,
        applied: false,
        errors: error.errors,
        warnings: error.warnings,
      };
    }
    return {
      config: current,
      applied: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  }
}

export function tryApplyConfigText(current: MachineConfig, text: string): ApplyResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: current,
      applied: false,
      errors: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
  return tryApplyConfig(current, raw);
}

export function serializeConfig(config: MachineConfig): string {
  return JSON.stringify(config, null, 2);
}

export const STORAGE_KEY = 'anim-state-studio/config/v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 保存到本地存储; 存储不可用时返回错误而不是抛出。 */
export function saveToStorage(
  storage: StorageLike | null,
  config: MachineConfig,
): { ok: boolean; error: string | null } {
  if (!storage) return { ok: false, error: '本地存储不可用' };
  try {
    storage.setItem(STORAGE_KEY, serializeConfig(config));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 从本地存储读取; 校验失败时保留 current 并返回错误。 */
export function loadFromStorage(
  storage: StorageLike | null,
  current: MachineConfig,
): ApplyResult & { found: boolean } {
  if (!storage) {
    return {
      config: current,
      applied: false,
      errors: ['本地存储不可用'],
      warnings: [],
      found: false,
    };
  }
  let text: string | null = null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch (error) {
    return {
      config: current,
      applied: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
      found: false,
    };
  }
  if (!text) {
    return { config: current, applied: false, errors: ['尚无已保存配置'], warnings: [], found: false };
  }
  return { ...tryApplyConfigText(current, text), found: true };
}
