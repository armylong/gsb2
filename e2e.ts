/**
 * 端到端模拟：不依赖浏览器，按用户在三个现场中的真实操作顺序驱动 World，
 * 打印每步的连通块/碎片/格数，作为人工验收脚本（npm run e2e）。
 */
import { World } from './src/core/World';
import { buildScene } from './src/core/scenes';
import { rectCells } from './src/core/shapes';

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function snapshot(world: World): void {
  const comps = [...world.labeling.sizes.entries()]
    .map(([id, n]) => `#${id}(${n}格,${world.labeling.grounded.has(id) ? '接地' : '悬空'})`)
    .join(' ');
  const frags = world.fragments.map((f) => `F${f.id}(${f.size}格,drop=${f.drop})`).join(' ');
  console.log(
    `静态块[${comps || '无'}] 碎片[${frags || '无'}] ` +
      `静态=${world.staticCount} 碎片格=${world.fragmentCount} 总=${world.totalCells} ` +
      `挖=${world.removedCount} 补=${world.addedCount}`,
  );
}

line('现场 1：切断桥梁');
{
  const w = new World(buildScene('bridge'));
  snapshot(w);
  w.edit([{ x: 20, y: 12 }], 'dig');
  console.log('挖断桥格 (20,12) 后：');
  snapshot(w);
  w.settle();
  console.log('快进落地后：');
  snapshot(w);
}

line('现场 2：多块同时掉落');
{
  const w = new World(buildScene('multi'));
  snapshot(w);
  // 三根细柱中心 x=6/19/32，在 y=12 一次矩形横扫
  const cut = rectCells({ x0: 0, y0: 12, x1: 39, y1: 12 });
  w.edit(cut, 'dig');
  console.log('一次矩形切断三根细柱后：');
  snapshot(w);
  w.settle();
  console.log('全部落地后：');
  snapshot(w);
}

line('现场 3：仅对角接触');
{
  const w = new World(buildScene('diagonal'));
  snapshot(w);
  w.edit(
    Array.from({ length: 13 }, (_, i) => ({ x: 28, y: 10 + i })),
    'dig',
  );
  console.log('挖掉右侧细柱后：');
  snapshot(w);
  w.settle();
  console.log('碎片落地后：');
  snapshot(w);
}

line('守恒校验：随机挖补序列');
{
  const w = new World(buildScene('multi'));
  let expected = w.totalCells;
  for (let i = 0; i < 20; i++) {
    const x = (i * 7) % w.width;
    const y = 5 + ((i * 3) % 12);
    const mode = i % 2 === 0 ? 'dig' : 'fill';
    const r = w.edit([{ x, y }], mode);
    expected = expected - r.removed + r.added;
    if (i % 5 === 4) w.settle();
    if (w.totalCells !== expected) {
      throw new Error(`第 ${i} 步守恒破裂：期望 ${expected}，实际 ${w.totalCells}`);
    }
  }
  console.log(`20 步挖补 + 落地后总格数一致：${w.totalCells}（期望 ${expected}）`);
}

console.log('\n端到端模拟全部通过。');
