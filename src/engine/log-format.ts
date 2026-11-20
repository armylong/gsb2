import type { LogEntry, MachineConfig } from './types';

/** 事件记录 → 可读文本, 供 UI 与验证脚本共用。 */
export function describeLogEntry(entry: LogEntry, config: MachineConfig): string {
  const stateName = (id: string) => config.states.find((s) => s.id === id)?.name ?? id;
  switch (entry.type) {
    case 'reset':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 重置 → ${stateName(
        entry.stateId,
      )} (速度=${entry.speed}, 受击=${entry.hurt ? '是' : '否'}, 待处理攻击=${entry.pendingAttacks})`;
    case 'input':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 输入 ${entry.action}: ${entry.detail}`;
    case 'state-enter':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} ${entry.initial ? '初始进入' : '进入'} ${
        entry.stateName
      } (${entry.stateId})${entry.transitionId ? ` via ${entry.transitionId}` : ''}`;
    case 'transition':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 过渡 ${entry.transitionId} [${
        entry.from
      } → ${entry.to}] 优先级=${entry.priority} 次序=${entry.orderIndex} 实际进度=${entry.atProgress.toFixed(
        3,
      )}${entry.waitForProgress ? ` (等待阈值 ${entry.progress})` : ''}${
        entry.consumedAttack ? ' 消耗攻击触发' : ''
      }`;
    case 'event':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 实际事件 ${entry.kind}:${
        entry.eventName
      } (${entry.eventId}) 状态=${stateName(entry.stateId)} 局部=${entry.localTimeMs}ms 圈=${
        entry.loopIndex
      }`;
    case 'window':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 窗口 ${
        entry.action === 'open' ? '开启' : '关闭'
      } 来源=${entry.reason === 'event' ? `事件 ${entry.eventId}` : '切出状态'} 状态=${stateName(
        entry.stateId,
      )}`;
    case 'interrupt':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 中断 ${entry.from} → ${
        entry.to
      } 跳过事件=[${entry.skippedEventIds.join(', ')}]${
        entry.forcedWindowClose ? ' 强制关闭窗口' : ''
      }`;
    case 'loop':
      return `#${entry.seq} t=${entry.atMs}ms tick=${entry.tick} 循环 ${stateName(
        entry.stateId,
      )} → 第 ${entry.loopIndex} 圈`;
    default:
      return '';
  }
}

export function collectEvents(log: readonly LogEntry[]) {
  return log.filter((e): e is Extract<LogEntry, { type: 'event' }> => e.type === 'event');
}

export function collectTransitions(log: readonly LogEntry[]) {
  return log.filter((e): e is Extract<LogEntry, { type: 'transition' }> => e.type === 'transition');
}

export function collectWindows(log: readonly LogEntry[]) {
  return log.filter((e): e is Extract<LogEntry, { type: 'window' }> => e.type === 'window');
}
