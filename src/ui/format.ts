import type { Vec3 } from '../scene/config';

export function luminance(rgb: Vec3): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function fmt(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 10000 || abs < 0.001)) {
    return value.toExponential(2);
  }
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(digits);
}

export function fmtDegrees(value: number): string {
  return `${value.toFixed(1)}°`;
}

export function clampTextWidth(value: string): string {
  return value.length > 18 ? value.slice(0, 17) + '…' : value;
}
