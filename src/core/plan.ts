import type { BatchPlan, DrawGroup } from './batching';

/** 把批次计划转成渲染器要的连续段列表。 */
export function groupsFromPlan(plan: BatchPlan): DrawGroup[] {
  return plan.batches.map((b) => ({
    first: b.first,
    count: b.count,
    blend: b.blend,
  }));
}

/** 每个绘制位次的批次着色 RGB。 */
export function batchColorBuffer(plan: BatchPlan): Float32Array {
  const out = new Float32Array(plan.paintOrder.length * 3);
  for (let rank = 0; rank < plan.paintOrder.length; rank++) {
    const batch = plan.batchOfSprite[plan.paintOrder[rank]!]!;
    const hue = (0.61803398875 * batch) % 1;
    const [r, g, b] = hslToRgb(hue, 0.68, 0.58);
    out[rank * 3] = r;
    out[rank * 3 + 1] = g;
    out[rank * 3 + 2] = b;
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 1) + 1) % 1;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}
