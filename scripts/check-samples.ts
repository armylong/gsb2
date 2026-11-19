import { ITEMS } from '../src/core/items';
import { SAMPLES } from '../src/core/samples';
import { occupiedCells } from '../src/core/geometry';
import { cellKey } from '../src/core/geometry';

for (const sample of SAMPLES) {
  console.log(`\n=== ${sample.key} ===`);
  const byId = new Map(ITEMS.map((i) => [i.id, i]));
  const bagById = new Map(sample.world.bags.map((b) => [b.id, b]));
  const ids = sample.world.placements.map((p) => p.itemId);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) console.log('DUP IDS:', dup);
  const missing = ITEMS.map((i) => i.id).filter((id) => !ids.includes(id));
  if (missing.length) console.log('MISSING:', missing);
  const totalCells = ITEMS.reduce((n, i) => n + i.shape.length, 0);
  console.log('expected cells:', totalCells, 'placement count:', ids.length);
  for (const bag of sample.world.bags) {
    const owner = new Map<string, string>();
    for (const pl of sample.world.placements.filter((p) => p.bagId === bag.id)) {
      const item = byId.get(pl.itemId)!;
      for (const c of occupiedCells(item, pl)) {
        const k = cellKey(c);
        const b = bagById.get(bag.id)!;
        const oob = c.col < 0 || c.row < 0 || c.col >= b.cols || c.row >= b.rows;
        if (oob) console.log(`OOB: ${pl.itemId} at ${k} in ${bag.id}`);
        const prev = owner.get(k);
        if (prev) console.log(`OVERLAP in ${bag.id}: ${prev} vs ${pl.itemId} at ${k}`);
        else owner.set(k, pl.itemId);
      }
    }
    console.log(`${bag.id}: ${owner.size} cells occupied`);
  }
}
