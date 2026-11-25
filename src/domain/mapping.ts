export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function xToTime(x: number, width: number, durationSec: number): number {
  if (!(width > 0) || !(durationSec > 0)) return 0;
  return clamp(x / width, 0, 1) * durationSec;
}

export function timeToX(time: number, width: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return clamp(time, 0, durationSec) / durationSec * width;
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '0.000';
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function distanceToBoundary(time: number, duration: number): { edge: 'start' | 'end' | 'inside'; distance: number } {
  if (time <= 0) return { edge: 'start', distance: time };
  if (time >= duration) return { edge: 'end', distance: duration - time };
  return { edge: 'inside', distance: Math.min(time, duration - time) };
}
