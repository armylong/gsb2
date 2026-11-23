/**
 * 物理探针 v3：定稿样例目标点，验证水=玻璃内界面无偏折。
 */
import { traceRay, REAL_IOR, type IORSet, type TraceResult } from '../src/physics/tracer';
import { norm, sub, type V3 } from '../src/physics/vector';
import { PLANES } from '../src/physics/geometry';

function brief(r: TraceResult): string {
  const ev = r.events.map((e) => (e.kind === 'tir' ? 'TIR' : e.kind === 'refract' ? '折' : e.kind === 'ruler' ? '尺' : e.kind === 'blocked' ? '挡' : '出')).join('→');
  const read = r.reading ? `[${r.reading.x.toFixed(1)}, ${r.reading.y.toFixed(1)}]` : '—';
  const base = r.baseline?.reading ? `[${r.baseline.reading.x.toFixed(1)}, ${r.baseline.reading.y.toFixed(1)}]` : r.baseline?.status ?? '—';
  return `${r.status.padEnd(13)} ${ev.padEnd(14)} 实读${read} 基线${base}`;
}

const camOb: V3 = { x: 35, y: 12, z: 42 };
console.log('==== 斜视 (35,12,42) 瞄前玻璃各点，找落后标尺的水下目标 ====');
for (const tgt of [
  { x: -8, y: 6 }, { x: -4, y: 6 }, { x: 0, y: 6 }, { x: 4, y: 6 }, { x: 8, y: 6 },
  { x: -8, y: 9 }, { x: -4, y: 9 }, { x: 0, y: 9 }, { x: 4, y: 9 }, { x: 8, y: 9 },
  { x: 0, y: 4 }, { x: -6, y: 4 }, { x: 6, y: 4 },
]) {
  const target: V3 = { x: tgt.x, y: tgt.y, z: PLANES.frontOuter };
  const r = traceRay(camOb, norm(sub(target, camOb)), REAL_IOR);
  console.log(`瞄(${String(tgt.x).padStart(3)},${tgt.y}): ${brief(r)}`);
}

console.log('\n==== 正视 (0,10,60) 瞄 (8,11)：真实 / 水=玻璃 / 全1 三种对比 ====');
{
  const cam: V3 = { x: 0, y: 10, z: 60 };
  const target: V3 = { x: 8, y: 11, z: PLANES.frontOuter };
  const dir = norm(sub(target, cam));
  const rReal = traceRay(cam, dir, REAL_IOR);
  const rEq: IORSet = { air: 1, glass: 1.45, water: 1.45 };
  const r145 = traceRay(cam, dir, rEq);
  console.log('真实 n:   ', brief(rReal));
  console.log('水=玻璃:  ', brief(r145));
  console.log('全 1 基线:', brief(rReal.baseline!));
  console.log('\n水=玻璃时的折射事件（玻璃↔水界面 θI 应等于 θT）:');
  for (const e of r145.events) {
    if (e.kind === 'refract') console.log(`  ${e.surface}: ${e.medium1}→${e.medium2} θI=${e.thetaI?.toFixed(2)} θT=${e.thetaT?.toFixed(2)}`);
  }
}

console.log('\n==== 定稿斜视目标的完整事件表（取一个干净落尺点）====');
{
  const cam: V3 = { x: 35, y: 12, z: 42 };
  const target: V3 = { x: -4, y: 6, z: PLANES.frontOuter };
  const r = traceRay(cam, norm(sub(target, cam)), REAL_IOR);
  console.log(brief(r));
  r.events.forEach((e) => console.log('  ' + e.detail));
}
