export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 3): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export function formatSec(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}s`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${Math.round(value)}ms`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, sec);
  const minute = Math.floor(s / 60);
  const rest = s - minute * 60;
  return `${String(minute).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function frameFromPts(pts: number, fps = 30): number {
  return Math.max(0, Math.floor(pts * fps + 0.001));
}
