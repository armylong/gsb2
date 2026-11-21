import { cloneLevel, nodeById, resetLevelState, type Level } from './model';
import { tick, type Direction, type TickIntent, type TickReport } from './sim';

export interface OpIntent {
  toggles: string[];
  move: Direction | null;
}

export interface Operation {
  id: string;
  intent: OpIntent;
  /** 创建时生成的可读标签; 重放时节点可能改名, 但保留历史描述 */
  label: string;
}

export interface ReplayState {
  level: Level;
  reports: TickReport[];
  cursor: number;
}

export const EMPTY_OP_INTENT: OpIntent = { toggles: [], move: null };

export function toTickIntent(intent: OpIntent): TickIntent {
  return { toggleSwitchIds: [...intent.toggles], move: intent.move };
}

export function operationFromIntent(level: Level, intent: OpIntent, id?: string): Operation {
  return { id: id ?? makeOpId(), intent: cloneIntent(intent), label: describeIntent(level, intent) };
}

export function cloneIntent(intent: OpIntent): OpIntent {
  return { toggles: [...intent.toggles], move: intent.move };
}

export function describeIntent(level: Level, intent: OpIntent): string {
  const parts: string[] = [];
  for (const id of intent.toggles) {
    const node = nodeById(level, id);
    if (!node || node.kind !== 'switch') {
      parts.push(`开关 ${id} 已不存在`);
      continue;
    }
    const to = node.value === 'on' ? 'OFF' : 'ON';
    parts.push(`${node.name} → ${to}`);
  }
  if (intent.move) parts.push(`角色移动 ${directionLabel(intent.move)}`);
  if (parts.length === 0) return '空推进（无输入，等待 1 步）';
  return parts.join(' + ');
}

function directionLabel(direction: Direction): string {
  switch (direction) {
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'left':
      return '←';
    case 'right':
      return '→';
  }
}

let opCounter = 0;
export function makeOpId(): string {
  opCounter += 1;
  return `op-${opCounter}`;
}

export function resetOpIdCounter(): void {
  opCounter = 0;
}

export function applyOperation(level: Level, operation: Operation): { level: Level; report: TickReport } {
  const result = tick(level, toTickIntent(operation.intent));
  return { level: result.level, report: result.report };
}

/** 从基线按顺序重放, limit 省略表示重放到末尾. 返回最后一步与逐步报告. */
export function replayOperations(
  base: Level,
  operations: Operation[],
  limit = operations.length,
): ReplayState {
  let level = resetLevelState(base);
  const reports: TickReport[] = [];
  const count = Math.max(0, Math.min(limit, operations.length));
  for (let index = 0; index < count; index += 1) {
    const operation = operations[index];
    if (!operation) continue;
    const result = applyOperation(level, operation);
    level = result.level;
    reports.push(result.report);
  }
  return { level, reports, cursor: count };
}

/**
 * 接线 / 节点配置变更后, 静态基线更新, 运行时从第 0 步开始;
 * 已保存的操作列表原样保留, 由调用者决定何时重放.
 */
export function rebaseLevel(base: Level, edit: (base: Level) => void): Level {
  const next = cloneLevel(base);
  edit(next);
  return resetLevelState(next);
}

export function doorSummary(report: TickReport): string {
  if (report.doors.length === 0) return '—';
  return report.doors
    .map((door) => `${door.name}:${door.passable ? 'OPEN' : 'CLOSED'}${door.openedAt !== null ? `@${door.openedAt}` : ''}`)
    .join(' / ');
}

export function lampSummary(report: TickReport): string {
  if (report.lamps.length === 0) return '—';
  return report.lamps.map((lamp) => `${lamp.name}:${lamp.on ? 'ON' : 'OFF'}`).join(' / ');
}
