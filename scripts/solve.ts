// 求解器:先为每个观众找单人可通关的(孔位,朝向),再随机组合并用完整仿真验证。
// 运行:npm run build && node dist/scripts/solve.js
import { level, paradeA, paradeB } from '../src/data.js';
import { simulate, layoutConflict } from '../src/sim.js';
import { Layout, ParadeDef } from '../src/model.js';

const F = -Math.PI / 2;
const FACINGS = [F, F - Math.PI / 4, F + Math.PI / 4, F - Math.PI / 2, F + Math.PI / 2, 0, Math.PI];
const chairIds = level.initialLayout.chairs.map(c => c.id);

interface Option { holeId: string; facing: number }

function soloOptions(parade: ParadeDef, viewerId: string): Option[] {
  const opts: Option[] = [];
  for (const h of level.holes) {
    for (const f of FACINGS) {
      const layout: Layout = { chairs: [{ id: 'solo', holeId: h.id, facing: f, viewerId }] };
      const r = simulate(level, parade, layout);
      if (r.viewers.find(v => v.viewerId === viewerId)!.ok) opts.push({ holeId: h.id, facing: f });
    }
  }
  return opts;
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solve(parade: ParadeDef, tries: number, seed: number): Layout | null {
  const perViewer = level.viewers.map(v => ({ id: v.id, opts: soloOptions(parade, v.id) }));
  for (const pv of perViewer) console.log(`  ${pv.id}: ${pv.opts.length} solo options`);
  if (perViewer.some(pv => pv.opts.length === 0)) return null;
  const rng = mulberry(seed);
  for (let i = 0; i < tries; i++) {
    const used = new Set<string>();
    const chairs = [];
    let bad = false;
    for (let k = 0; k < perViewer.length; k++) {
      const pv = perViewer[k];
      // 随机取一个不冲突的选项
      const shuffled = [...pv.opts].sort(() => rng() - 0.5);
      const pick = shuffled.find(o => !used.has(o.holeId));
      if (!pick) { bad = true; break; }
      used.add(pick.holeId);
      chairs.push({ id: chairIds[k], holeId: pick.holeId, facing: pick.facing, viewerId: pv.id });
    }
    if (bad) continue;
    const layout: Layout = { chairs };
    if (layoutConflict(layout)) continue;
    const r = simulate(level, parade, layout);
    if (r.viewers.every(v => v.ok)) {
      console.log(`  found after ${i + 1} combos`);
      return layout;
    }
  }
  return null;
}

for (const [name, parade] of [['A', paradeA], ['B', paradeB]] as const) {
  console.log(`solving parade ${name}...`);
  const l = solve(parade, 5000, 42);
  if (!l) { console.log('  NOT FOUND'); continue; }
  console.log(JSON.stringify(l.chairs.map(c => ({ id: c.id, holeId: c.holeId, facing: +c.facing.toFixed(4), viewerId: c.viewerId }))));
  const r = simulate(level, parade, l);
  for (const v of r.viewers) console.log(`  ${v.viewerId}: ${v.ok ? 'OK' : 'FAIL'} ${v.detail}`);
}
