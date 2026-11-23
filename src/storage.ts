/**
 * 展开配置的持久化
 * - 自动保存: 编辑后防抖写入 localStorage, 重新打开页面恢复同一画面(进度/视角/翻盖角度)
 * - 文件: 导出 JSON 便于分享, 导入时做 schema 校验
 */
import type { EditorConfig, SavedSession } from './types';

const STORAGE_KEY = 'flip-cover-explode-editor:session:v1';

export function saveSession(session: SavedSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (err) {
    console.warn('自动保存失败', err);
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    return validateSession(parsed) ? parsed : null;
  } catch (err) {
    console.warn('读取已保存会话失败', err);
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}

/** 导入文件 / 恢复会话前的结构校验, 坏数据直接拒绝而不是让渲染崩溃 */
export function validateConfig(input: unknown): input is EditorConfig {
  if (typeof input !== 'object' || input === null) return false;
  const cfg = input as Record<string, unknown>;
  if (!Array.isArray(cfg.parts)) return false;
  const ids = new Set<string>();
  for (const item of cfg.parts) {
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return false;
    if (ids.has(p.id)) return false;
    ids.add(p.id);
    if (p.parentId !== null && typeof p.parentId !== 'string') return false;
    if (!isVec3(p.position)) return false;
    if (p.step !== null && typeof p.step === 'object') {
      const s = p.step as Record<string, unknown>;
      if (s.phase !== 0 && s.phase !== 1) return false;
      if (typeof s.start !== 'number' || typeof s.end !== 'number' || s.start >= s.end) return false;
      if (s.start < 0 || s.end > 1) return false;
      if (!isVec3(s.dir) || typeof s.distance !== 'number' || s.distance < 0) return false;
    }
  }
  // parentId 必须指向已声明的零件
  for (const item of cfg.parts) {
    const p = item as { parentId: string | null };
    if (p.parentId !== null && !ids.has(p.parentId)) return false;
  }
  if (cfg.collisionIgnore !== undefined) {
    if (!Array.isArray(cfg.collisionIgnore)) return false;
    for (const ig of cfg.collisionIgnore as unknown[]) {
      const pair = ig as Record<string, unknown>;
      if (typeof pair.a !== 'string' || typeof pair.b !== 'string') return false;
    }
  }
  return true;
}

function validateSession(input: unknown): input is SavedSession {
  if (typeof input !== 'object' || input === null) return false;
  const s = input as Record<string, unknown>;
  if (typeof s.progress !== 'number' || s.progress < 0 || s.progress > 1) return false;
  if (typeof s.lidAngle !== 'number') return false;
  if (!validateConfig(s.config)) return false;
  const cam = s.camera as Record<string, unknown> | undefined;
  if (!cam || !isVec3(cam.position) || !isVec3(cam.target) || typeof cam.zoom !== 'number') {
    return false;
  }
  return true;
}

export function downloadConfig(config: EditorConfig): void {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.name || 'explode-config'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
