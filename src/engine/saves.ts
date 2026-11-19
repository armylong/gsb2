import type {
  CompatibilityResult,
  DialogueConfig,
  SaveRecord,
  SaveSnapshot,
  StorageLike,
} from './types';
import { deepClone, nodeById } from './state';

export const SAVE_STORAGE_KEY = 'grey-harbor-dialogue-debugger/saves/v1';

/** 配置指纹覆盖所有会影响存档解释的字段，顺序稳定。 */
export function configFingerprint(config: DialogueConfig): string {
  const canonical = JSON.stringify({
    schemaVersion: config.schemaVersion,
    id: config.id,
    title: config.title,
    subtitle: config.subtitle,
    entryNodeId: config.entryNodeId,
    variables: config.variables,
    nodes: config.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      speaker: node.speaker,
      text: node.text,
      terminal: node.terminal,
      choices: node.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        target: choice.target,
        when: choice.when ?? null,
        effects: choice.effects,
        lockedDisplay: choice.lockedDisplay,
      })),
    })),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${canonical.length}`;
}

export function createSave(
  name: string,
  snapshot: SaveSnapshot,
  config: DialogueConfig,
  now: Date = new Date(),
): SaveRecord {
  return {
    version: 1,
    id: `save-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || '未命名存档',
    savedAt: now.toISOString(),
    configFingerprint: configFingerprint(config),
    snapshot: deepClone(snapshot),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectUnknownKeys(
  catalog: DialogueConfig['variables'],
  bucket: Record<string, unknown>,
): string[] {
  const known = new Set(
    [...catalog.flags, ...catalog.stats, ...catalog.items].map((entry) => entry.key),
  );
  return Object.keys(bucket).filter((key) => !known.has(key));
}

/**
 * 载入前的兼容性检查。只要节点/选项/变量含义已改变就拒绝，
 * 由调用方保留当前现场，不会悄悄回到开头。
 */
export function checkCompatibility(
  save: SaveRecord,
  config: DialogueConfig,
): CompatibilityResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const fingerprint = configFingerprint(config);
  const configChanged = fingerprint !== save.configFingerprint;
  const snapshot = save.snapshot;

  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, configChanged, problems: ['存档内容损坏：缺少快照'], warnings };
  }
  if (!Array.isArray(snapshot.history) || typeof snapshot.nodeId !== 'string') {
    return { ok: false, configChanged, problems: ['存档内容损坏：历史或节点字段缺失'], warnings };
  }
  if (!isPlainObject(snapshot.state)) {
    return { ok: false, configChanged, problems: ['存档内容损坏：变量快照缺失'], warnings };
  }

  const targetNode = nodeById(config, snapshot.nodeId);
  if (!targetNode) {
    problems.push(`存档节点「${snapshot.nodeId}」在当前配置中已不存在`);
  }

  for (const entry of snapshot.history) {
    const node = nodeById(config, entry.nodeId);
    if (!node) {
      problems.push(`历史记录引用的节点「${entry.nodeId}」已不存在`);
      continue;
    }
    const choice = node.choices.find((entryChoice) => entryChoice.id === entry.choiceId);
    if (!choice) {
      problems.push(
        `节点「${node.title}」中的选项「${entry.choiceLabel}」(${entry.choiceId}) 已不存在`,
      );
      continue;
    }
    if (choice.target !== entry.targetNodeId) {
      problems.push(
        `选项「${entry.choiceLabel}」的目标已从「${entry.targetNodeId}」改为「${choice.target}」`,
      );
    }
  }

  const stateBuckets: Array<['flags' | 'stats' | 'items', Record<string, unknown>]> = [
    ['flags', snapshot.state.flags],
    ['stats', snapshot.state.stats],
    ['items', snapshot.state.items],
  ];
  for (const [bucketName, bucket] of stateBuckets) {
    if (!isPlainObject(bucket)) {
      problems.push(`存档变量字段「${bucketName}」缺失或损坏`);
      continue;
    }
    const unknown = collectUnknownKeys(config.variables, bucket);
    if (unknown.length > 0) {
      problems.push(`存档含当前配置未声明的变量：${unknown.join('、')}`);
    }
    for (const [key, value] of Object.entries(bucket)) {
      if (bucketName === 'flags' && typeof value !== 'boolean') {
        problems.push(`标记「${key}」的值不是布尔型`);
      }
      if (bucketName !== 'flags' && (typeof value !== 'number' || !Number.isFinite(value))) {
        problems.push(`数值「${key}」不是有限数字`);
      }
    }
  }

  for (const entry of snapshot.history) {
    if (!isPlainObject(entry.before) || !isPlainObject(entry.after)) {
      problems.push(`历史记录 #${entry.seq} 缺少选择前后的变量快照`);
    }
  }

  const deduped = Array.from(new Set(problems));
  if (configChanged && deduped.length === 0) {
    // 指纹不同但所有引用仍可解析：允许载入，仅提示。
    warnings.push('对话配置已变动，但存档引用的节点、选项与变量仍完整，已按当前配置继续。');
  }

  return { ok: deduped.length === 0, configChanged, problems: deduped, warnings };
}

export function readSaves(storage: StorageLike): SaveRecord[] {
  const raw = storage.getItem(SAVE_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSaveRecord);
  } catch {
    return [];
  }
}

function isSaveRecord(value: unknown): value is SaveRecord {
  if (!isPlainObject(value)) return false;
  return (
    value.version === 1 &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.configFingerprint === 'string' &&
    isPlainObject(value.snapshot)
  );
}

export function writeSaves(storage: StorageLike, saves: SaveRecord[]): void {
  storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(saves));
}

export function upsertSave(saves: SaveRecord[], save: SaveRecord): SaveRecord[] {
  return [save, ...saves.filter((entry) => entry.id !== save.id)];
}

export { deepClone };
