/** 场值发散色标：负(内部)=蓝，0=近白，正(外部)=红。 */
export function fieldColor(v: number, vmin: number, vmax: number): [number, number, number] {
  // 以 0 为中心归一化到 [-1, 1]
  const span = Math.max(Math.abs(vmin), Math.abs(vmax), 1e-9);
  const t = Math.max(-1, Math.min(1, v / span));
  if (t < 0) {
    const s = -t; // 0..1 越深越蓝
    return [Math.round(255 * (1 - s)), Math.round(255 * (1 - s)), 255];
  }
  const s = t;
  return [255, Math.round(255 * (1 - s)), Math.round(255 * (1 - s))];
}
