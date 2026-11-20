// 命令行验证:node dist/verify.js
// 覆盖:面积守恒、洞不被覆盖、环边都是网格边、点序无关、冲突检测。
import {
  Pt,
  Ring,
  Tri,
  expectedArea,
  findConflicts,
  pointInRing,
  pointInTri,
  triangulate,
} from './geometry.js';
import { doubleHoleSample, grooveSample, comboSample } from './samples.js';

declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

function centroid(t: Tri): Pt {
  return { x: (t.a.x + t.b.x + t.c.x) / 3, y: (t.a.y + t.b.y + t.c.y) / 3 };
}

function ringCentroid(r: Ring): Pt {
  return {
    x: r.reduce((s, p) => s + p.x, 0) / r.length,
    y: r.reduce((s, p) => s + p.y, 0) / r.length,
  };
}

function edgeKey(p: Pt, q: Pt): string {
  const a = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
  const b = `${q.x.toFixed(6)},${q.y.toFixed(6)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function meshChecks(name: string, outerIn: Ring, holesIn: Ring[]): { total: number; count: number } {
  const outer = outerIn.map((p) => ({ ...p }));
  const holes = holesIn.map((h) => h.map((p) => ({ ...p })));

  const conflicts = findConflicts(outer, holes);
  check(`${name}: 几何合法无冲突`, conflicts.length === 0, JSON.stringify(conflicts));

  const tris = triangulate(outer, holes);
  const n = outer.length + holes.reduce((s, h) => s + h.length, 0);
  const expectCount = n + 2 * holes.length - 2;
  check(`${name}: 三角形数量 = n+2h-2`, tris.length === expectCount, `${tris.length} vs ${expectCount}`);

  const total = tris.reduce((s, t) => s + t.area, 0);
  const exp = expectedArea(outer, holes);
  check(`${name}: 网格总面积 = |外环|-Σ|洞|`, Math.abs(total - exp) < 1e-6 * exp, `${total.toFixed(4)} vs ${exp.toFixed(4)}`);

  const centroidsOk = tris.every((t) => {
    const c = centroid(t);
    return pointInRing(c, outer) && holes.every((h) => !pointInRing(c, h));
  });
  check(`${name}: 所有三角形质心落在有效区域(外环内、洞外)`, centroidsOk);

  // 每条环边(含凹角边、洞边)都必须成为某个三角形的边
  const triEdges = new Set<string>();
  for (const t of tris) {
    triEdges.add(edgeKey(t.a, t.b));
    triEdges.add(edgeKey(t.b, t.c));
    triEdges.add(edgeKey(t.c, t.a));
  }
  let allBoundary = true;
  const rings = [outer, ...holes];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (!triEdges.has(edgeKey(r[i], r[(i + 1) % r.length]))) allBoundary = false;
    }
  }
  check(`${name}: 凹角边与洞边全部成为网格边界`, allBoundary);

  // 洞心不被任何三角形覆盖
  holes.forEach((h, i) => {
    const c = ringCentroid(h);
    const covered = tris.some((t) => pointInTri(c, t.a, t.b, t.c));
    check(`${name}: 洞${i + 1}中心未被网格覆盖`, !covered);
  });

  return { total, count: tris.length };
}

function rotate<T>(arr: T[], k: number): T[] {
  return arr.slice(k).concat(arr.slice(0, k));
}

// ---- 样例 1:细窄凹槽 ----
const groove = grooveSample();
const g1 = meshChecks('细窄凹槽', groove.outer, groove.holes);

// ---- 样例 2:双孔 ----
const dh = doubleHoleSample();
const d1 = meshChecks('双孔', dh.outer, dh.holes);

// ---- 样例 3:凹槽+双孔 ----
const cb = comboSample();
meshChecks('凹槽+双孔', cb.outer, cb.holes);

// ---- 点序无关:反转 + 旋转后,覆盖区域(总面积/三角形数)不变 ----
{
  const outer2 = rotate(groove.outer.slice().reverse(), 3);
  const g2 = meshChecks('细窄凹槽(交换点序)', outer2, []);
  check('点序无关: 凹槽总面积一致', Math.abs(g1.total - g2.total) < 1e-6, `${g1.total} vs ${g2.total}`);
  check('点序无关: 凹槽三角形数一致', g1.count === g2.count);
}
{
  const outer2 = rotate(dh.outer.slice().reverse(), 2);
  const holes2 = dh.holes.map((h, i) => rotate(h.slice().reverse(), i + 1));
  const d2 = meshChecks('双孔(交换点序)', outer2, holes2);
  check('点序无关: 双孔总面积一致', Math.abs(d1.total - d2.total) < 1e-6, `${d1.total} vs ${d2.total}`);
  check('点序无关: 双孔三角形数一致', d1.count === d2.count);
}

// ---- 冲突检测 ----
{
  const bowtie: Ring = [
    { x: 100, y: 100 },
    { x: 300, y: 300 },
    { x: 300, y: 100 },
    { x: 100, y: 300 },
  ];
  const c = findConflicts(bowtie, []);
  check('自交环(蝴蝶结)被检出', c.some((x) => x.kind === 'cross' && x.ringA === 0 && x.ringB === 0), JSON.stringify(c));
}
{
  const outer: Ring = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ];
  const holeOutside: Ring = [
    { x: 500, y: 100 },
    { x: 600, y: 100 },
    { x: 600, y: 200 },
    { x: 500, y: 200 },
  ];
  const c = findConflicts(outer, [holeOutside]);
  check('洞跑出外环被检出', c.some((x) => x.kind === 'hole-outside'), JSON.stringify(c));
}
{
  const outer: Ring = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ];
  const holeCrossing: Ring = [
    { x: 300, y: 100 },
    { x: 500, y: 100 },
    { x: 500, y: 200 },
    { x: 300, y: 200 },
  ];
  const c = findConflicts(outer, [holeCrossing]);
  check('洞边穿过外环被检出', c.some((x) => x.kind === 'cross' && x.ringA !== x.ringB), JSON.stringify(c));
}
{
  const outer: Ring = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ];
  const h1: Ring = [
    { x: 50, y: 50 },
    { x: 200, y: 50 },
    { x: 200, y: 200 },
    { x: 50, y: 200 },
  ];
  const h2: Ring = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 300 },
    { x: 100, y: 300 },
  ];
  const c = findConflicts(outer, [h1, h2]);
  check('洞与洞相交被检出', c.length > 0, JSON.stringify(c));
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
