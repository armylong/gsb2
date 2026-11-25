import type { Cue, SimState, TimelineItem } from './types';

const CUE_TONE: Record<Cue['kind'], TimelineItem['tone']> = {
  health: 'warn',
  lock: 'lock',
  align: 'info',
  catchup: 'info',
};

function cueTitle(cue: Cue): string {
  if (cue.label) return cue.label;
  if (cue.kind === 'health') {
    const health = cue.health === 'ok' ? '恢复' : cue.health === 'stalled' ? '停顿' : '掉线';
    return `${cue.route} 路${health}`;
  }
  if (cue.kind === 'lock') return cue.lock === 'auto' ? '取消锁定' : `锁定 ${cue.lock} 路`;
  if (cue.kind === 'align') return `${cue.route} 路跳转对齐`;
  return `${cue.route} 路快进追赶`;
}

export function buildTimelineItems(cues: Cue[], state: SimState): TimelineItem[] {
  const cueItems: TimelineItem[] = cues.map((cue, index) => ({
    key: cue.id ?? `cue-${index}`,
    at: cue.at,
    category: 'cue',
    tone: cue.kind === 'health' && cue.health === 'offline' ? 'error' : CUE_TONE[cue.kind],
    title: cueTitle(cue),
    detail:
      cue.kind === 'health' && cue.recovery
        ? cue.recovery === 'ff'
          ? '恢复策略：4× 快进追赶'
          : '恢复策略：硬跳转到当前内容时间'
        : undefined,
  }));

  const switchItems: TimelineItem[] = state.switches.map(record => ({
    key: record.id,
    at: record.at,
    category: 'switch',
    tone: record.to === null ? 'error' : record.reason.includes('lock') ? 'lock' : 'success',
    title: record.title,
    detail:
      record.deltaBeforeMs === undefined
        ? record.rule
        : `Δ前 ${Math.round(record.deltaBeforeMs)}ms → Δ后 ${Math.round(record.deltaAfterMs ?? 0)}ms`,
    switchId: record.id,
  }));

  return [...cueItems, ...switchItems].sort((a, b) => {
    if (Math.abs(a.at - b.at) > 0.001) return a.at - b.at;
    // At the same timestamp show the decision after its triggering cue.
    if (a.category !== b.category) return a.category === 'cue' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}
