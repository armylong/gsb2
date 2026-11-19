import { ITEMS } from '../src/core/items';
import { SAMPLES } from '../src/core/samples';
import { planDrop } from '../src/core/inventory';
import type { Placement } from '../src/core/types';

const sample = SAMPLES.find((s) => s.key === 'swap-fail')!;
const item = (id: string) => ITEMS.find((i) => i.id === id)!;
const placementOf = (id: string): Placement => sample.world.placements.find((p) => p.itemId === id)!;

function attempt(label: string, itemId: string, toBagId: string, anchor: { col: number; row: number }, rotation: 0 | 1 | 2 | 3) {
  const from = placementOf(itemId);
  const plan = planDrop(ITEMS, sample.world, {
    item: item(itemId),
    from,
    toBagId,
    anchor,
    rotation,
  });
  console.log(label, '=>', { kind: plan.kind, ok: plan.ok, swapWith: plan.swapWith, message: plan.message });
}

// (a) I01 横拖到 (0,0), 同时压 I04+I05
attempt('(a) multi-hit', 'I01', 'bag-a', { col: 0, row: 0 }, 0);
// (b) I02 旋转竖到 (7,0), 只撞 I11, 但 I11 回 bag-b (0,1) 放不下
attempt('(b) swap rollback', 'I02', 'bag-a', { col: 7, row: 0 }, 1);
// (c) I03 旋转 90° 变横条, 拖到 bag-a 的 I12 锚点 (0,3), 只撞 I12 一件
attempt('(c) swap success', 'I03', 'bag-a', { col: 0, row: 3 }, 1);

// l-fit: I10 旋转 90° 到 (4,0) 应成功
const lfit = SAMPLES.find((s) => s.key === 'l-fit')!;
const from = lfit.world.placements.find((p) => p.itemId === 'I10')!;
const lp = planDrop(ITEMS, lfit.world, {
  item: item('I10'),
  from,
  toBagId: 'bag-a',
  anchor: { col: 4, row: 0 },
  rotation: 1,
});
console.log('(lfit) I10 rotated into cavity =>', { kind: lp.kind, ok: lp.ok, message: lp.message });

// narrow: I02 横条上移撞墙 vs 旋转后 (3,0)
const narrow = SAMPLES.find((s) => s.key === 'narrow-slot')!;
const nfrom = narrow.world.placements.find((p) => p.itemId === 'I02')!;
const n1 = planDrop(ITEMS, narrow.world, { item: item('I02'), from: nfrom, toBagId: 'bag-a', anchor: { col: 0, row: 0 }, rotation: 0 });
console.log('(narrow) horizontal up =>', { ok: n1.ok, message: n1.message });
const n2 = planDrop(ITEMS, narrow.world, { item: item('I02'), from: nfrom, toBagId: 'bag-a', anchor: { col: 3, row: 0 }, rotation: 1 });
console.log('(narrow) rotated into slot =>', { ok: n2.ok, kind: n2.kind });
