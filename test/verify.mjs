// 无浏览器验证:用与 src/main.ts 相同的几何与 256 栅格,核对两个题面的解确实能过关。
const SCREEN_Z = 1000, VIEW = 320, MASK = 256;

const rectPoly = (w, h) => [
  { x: -w/2, y: -h/2 }, { x: w/2, y: -h/2 },
  { x: w/2, y: h/2 }, { x: -w/2, y: h/2 },
];
const circlePoly = (r, n = 28) => Array.from({length: n}, (_, i) => {
  const a = (i / n) * Math.PI * 2; return { x: Math.cos(a)*r, y: Math.sin(a)*r };
});
const starPoly = (outer, inner, points = 5) => Array.from({length: points*2}, (_, i) => {
  const r = i % 2 === 0 ? outer : inner;
  const a = -Math.PI/2 + (i * Math.PI) / points;
  return { x: Math.cos(a)*r, y: Math.sin(a)*r };
});
const moved = (poly, dx, dy) => poly.map(p => ({ x: p.x+dx, y: p.y+dy }));
const rotated = (poly, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return poly.map(p => ({ x: p.x*c - p.y*s, y: p.x*s + p.y*c }));
};
const scaled = (poly, k) => poly.map(p => ({ x: p.x*k, y: p.y*k }));

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x-a.x)*(pt.y-a.y))/(b.y-a.y)+a.x) inside = !inside;
  }
  return inside;
}

const shadowPoly = p => scaled(moved(rotated(p.verts, p.rot), p.x, p.y), SCREEN_Z/p.z);
const shadowHole = p => p.hole ? scaled(moved(rotated(p.hole, p.rot), p.x, p.y), SCREEN_Z/p.z) : null;

function score(puzzle, pieces) {
  let target=0, matched=0, missing=0, extra=0, holeTotal=0, holeBlocked=0;
  for (let j = 0; j < MASK; j++) for (let i = 0; i < MASK; i++) {
    const pt = { x: (i+0.5)/MASK*2*VIEW - VIEW, y: (j+0.5)/MASK*2*VIEW - VIEW };
    const inHole = puzzle.targetHole &&
      Math.hypot(pt.x - puzzle.targetHole.c.x, pt.y - puzzle.targetHole.c.y) <= puzzle.targetHole.r;
    const t = !inHole && puzzle.targetPolys.some(poly => pointInPoly(pt, poly));
    let s = false;
    for (const p of pieces) {
      if (pointInPoly(pt, shadowPoly(p))) {
        const h = shadowHole(p);
        if (!h || !pointInPoly(pt, h)) { s = true; break; }
      }
    }
    if (t) target++;
    if (t && s) matched++; else if (t) missing++; else if (s) extra++;
    if (inHole) { holeTotal++; if (s) holeBlocked++; }
  }
  const hitPct = matched/target, extraPct = extra/target;
  const holeOk = holeTotal === 0 || holeBlocked <= Math.max(2, holeTotal*0.05);
  return { hitPct: +(hitPct*100).toFixed(1), extraPct: +(extraPct*100).toFixed(1),
           holeBlocked, holeTotal, passed: hitPct >= 0.96 && extraPct <= 0.04 && holeOk };
}

const puzzles = [
  {
    name: '题一',
    targetPolys: [moved(rectPoly(220,60),0,-80), moved(rectPoly(220,60),0,80)],
    targetHole: { c: {x:0,y:0}, r: 16 },
  },
  {
    name: '题二',
    targetPolys: [moved(rotated(starPoly(105,45), Math.PI/12), 20, -10)],
    targetHole: { c: {x:20,y:-10}, r: 25 },
  },
];

// 题一正解:两片 110x30 在 z=500,摆到 (0,±40)
const p1solved = [
  { verts: rectPoly(110,30), hole: null, x: 0, y: -40, rot: 0, z: 500 },
  { verts: rectPoly(110,30), hole: null, x: 0, y: 40, rot: 0, z: 500 },
];
// 题一错误:一片横在中间盖住孔
const p1holeBlocked = [
  { verts: rectPoly(110,30), hole: null, x: 0, y: 0, rot: 0, z: 500 },
  { verts: rectPoly(110,30), hole: null, x: 0, y: -40, rot: 0, z: 500 },
];
// 题一初始(乱摆)
const p1start = [
  { verts: rectPoly(110,30), hole: null, x: -46, y: 14, rot: 0.6, z: 500 },
  { verts: rectPoly(110,30), hole: null, x: 38, y: -26, rot: -1.15, z: 500 },
];
// 题二正解:z=400, x=8, y=-4, rot=15°
const p2solved = [{ verts: starPoly(42,18), hole: circlePoly(10), x: 8, y: -4, rot: Math.PI/12, z: 400 }];
// 题二初始(深度不对)
const p2start = [{ verts: starPoly(42,18), hole: circlePoly(10), x: -34, y: 22, rot: 1.1, z: 620 }];
// 题二位置对但深度错(z=620,投影偏小)
const p2wrongDepth = [{ verts: starPoly(42,18), hole: circlePoly(10), x: 8, y: -4, rot: Math.PI/12, z: 620 }];
// 题二轻微偏移:命中仍不低,但孔被盖住一部分 → 必须判不过关
const p2holeCovered = [{ verts: starPoly(42,18), hole: circlePoly(10), x: 12, y: -4, rot: Math.PI/12, z: 400 }];

const cases = [
  ['题一 正解 → 应过关', puzzles[0], p1solved, true],
  ['题一 初始 → 不应过关', puzzles[0], p1start, false],
  ['题一 盖孔 → 不应过关且孔被遮', puzzles[0], p1holeBlocked, false],
  ['题二 正解 → 应过关', puzzles[1], p2solved, true],
  ['题二 初始 → 不应过关', puzzles[1], p2start, false],
  ['题二 仅深度错 → 不应过关', puzzles[1], p2wrongDepth, false],
  ['题二 偏移盖孔 → 命中高也不应过关', puzzles[1], p2holeCovered, false],
];

let fail = 0;
for (const [name, pz, pcs, expectPass] of cases) {
  const r = score(pz, pcs);
  const ok = r.passed === expectPass &&
    (name.includes('盖孔') || name.includes('偏移') ? r.holeBlocked > 0 : true);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  命中${r.hitPct}% 多影${r.extraPct}% 孔${r.holeBlocked}/${r.holeTotal} 过关=${r.passed}`);
}
process.exit(fail ? 1 : 0);
