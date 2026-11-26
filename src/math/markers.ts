/**
 * 带面标记：所有标记以"材料坐标"（沿带的固定弧长位置）存储，
 * 走带时只改变全局走带偏移 phase，几何变更后按相对位置 u = s / L 重映射。
 * 因此标记永远跟着带材料走，不会黏在旧轮廓上。
 */
import type { BeltPath } from './belt';

export interface Marker {
  /** 材料坐标（当前带长下的弧长，范围 [0, length)） */
  s: number;
  kind: 'tick' | 'number' | 'arrow';
  /** 数字标记的编号 */
  label?: number;
  /** 选中态（全局只有一个） */
  selected?: boolean;
}

export interface MarkerSet {
  markers: Marker[];
  spacing: number;
  length: number;
  /** 选中刻度的稳定 id（编号），几何变更后仍能找回同一条 */
  selectedLabel: number | null;
}

/**
 * 按固定间距生成整套标记。
 * 刻度与数字每隔 spacing 一条；每 5 条用数字替代并加粗；
 * 箭头以 spacing * 3 为周期放在两刻度之间，前后不对称。
 */
export function generateMarkers(length: number, spacing: number, selectedLabel: number | null = null): MarkerSet {
  const markers: Marker[] = [];
  const count = Math.max(1, Math.floor(length / spacing));
  for (let k = 0; k < count; k++) {
    const s = k * spacing;
    const isNumber = k % 5 === 0;
    markers.push({
      s,
      kind: isNumber ? 'number' : 'tick',
      label: k,
      selected: isNumber ? k === selectedLabel : false,
    });
    if (k % 3 === 1) {
      markers.push({ s: s + spacing * 0.5, kind: 'arrow' });
    }
  }
  return { markers, spacing, length, selectedLabel };
}

/**
 * 几何变更：保持每条标记在整带上的相对位置 u（= s / L）不变，
 * 映射到新带长；同时重新选择与原选中编号相同的那条刻度。
 */
export function remapMarkers(old: MarkerSet, newLength: number, newSpacing: number): MarkerSet {
  const next = generateMarkers(newLength, newSpacing, old.selectedLabel);
  // 若间距未变且新带能容纳，编号即材料身份，直接沿用上面的选中；
  // 若间距变化，则按相对位置就近匹配旧的选中刻度。
  if (old.selectedLabel !== null) {
    const oldSelected = old.markers.find((m) => m.label === old.selectedLabel && m.kind !== 'arrow');
    if (oldSelected) {
      const u = oldSelected.s / old.length;
      const target = u * newLength;
      let best: Marker | undefined;
      let bestD = Infinity;
      for (const m of next.markers) {
        if (m.kind === 'arrow') continue;
        const d = Math.min(Math.abs(m.s - target), newLength - Math.abs(m.s - target));
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      if (best) {
        next.markers.forEach((m) => (m.selected = false));
        best.selected = true;
        next.selectedLabel = best.label ?? null;
      }
    }
  }
  return next;
}

/** 走带偏移 phase 下，某条标记当前的世界弧长位置 */
export function worldS(marker: Marker, phase: number, length: number): number {
  return (((marker.s + phase) % length) + length) % length;
}

/** 选中刻度到接缝（s = 0，即带长起点）的沿带距离（沿前进方向的弧长） */
export function selectedDistanceToSeam(set: MarkerSet, phase: number): number | null {
  const sel = set.markers.find((m) => m.selected);
  if (!sel) return null;
  const L = set.length;
  const ws = worldS(sel, phase, L);
  // 沿 s 增大方向走到接缝（0 / L 处）的距离
  return ws === 0 ? 0 : L - ws;
}

/** 接缝在当前走带偏移下的世界弧长恒为 0；返回接缝两侧采样所需信息由渲染层处理 */
export function seamWorldS(): number {
  return 0;
}

export function selectMarker(set: MarkerSet, label: number | null): MarkerSet {
  const markers = set.markers.map((m) => ({ ...m, selected: m.label === label && m.kind !== 'arrow' }));
  return { ...set, markers, selectedLabel: label };
}

export function findMarkerAtS(path: BeltPath, set: MarkerSet, s: number, tolerance: number): Marker | undefined {
  const L = path.length;
  let best: Marker | undefined;
  let bestD = tolerance;
  for (const m of set.markers) {
    if (m.kind === 'arrow') continue;
    const d = Math.min(Math.abs(m.s - s), L - Math.abs(m.s - s));
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}
