import type { CaptionWindow, RejectReason, Verdict } from './types';

const pad = (value: number, length = 2) => String(Math.trunc(value)).padStart(length, '0');

/** 回放/媒体时钟：m:ss.s，够用又不喧宾夺主。 */
export function clock(seconds: number, decimals = 1): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const fixed = rest.toFixed(decimals);
  return `${pad(minutes)}:${Number(fixed) < 10 ? '0' : ''}${fixed}`;
}

/** WebVTT 时间戳：HH:MM:SS.mmm。 */
export function vttTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export const reasonLabel: Record<RejectReason, string> = {
  'duplicate-event': '重复事件',
  'duplicate-revision': '同序号冲突',
  'stale-revision': '旧修订迟到',
  'after-final': '确认后到达',
};

export const verdictLabel: Record<Verdict, string> = {
  accepted: '已生效',
  rejected: '未采用',
  pending: '未到达',
};

export const windowLabel: Record<CaptionWindow, string> = {
  onscreen: '在屏',
  upcoming: '未进画面',
  ended: '已离开',
  unavailable: '尚未收到',
};

export function kindLabel(kind: 'revision' | 'final'): string {
  return kind === 'final' ? '结束标记' : '修订';
}
