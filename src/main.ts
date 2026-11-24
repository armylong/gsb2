/**
 * 灯影拼摆 —— 剪影小谜题
 *
 * 模型:点光源位于原点 (0,0,0),幕布是 z = SCREEN_Z 的平面。
 * 每片薄片位于 z = piece.z 的平面上,有自己的平面坐标 (x, y) 与旋转 rot。
 * 从原点发出的射线把薄片透视投影到幕布上,投影即纯缩放 m = SCREEN_Z / z,
 * 因此改变深度会真实改变影子大小。
 *
 * 评分在幕布空间的像素遮罩上进行:所有薄片的投影画进同一张遮罩(天然并集,
 * 两片叠在同一区域不会重复计数),再与目标遮罩逐像素比较。
 */

// ---------------- 基本类型与常量 ----------------

type Vec = { x: number; y: number };

const SCREEN_Z = 1000;          // 幕布深度(灯在 0)
const VIEW = 320;               // 幕布视图半宽(幕布单位),即可见范围 [-320, 320]
const MASK = 256;               // 评分遮罩分辨率(MASK x MASK)
const HANDLE_DIST = 52;         // 旋转手柄离影子中心的距离(幕布单位)

interface Piece {
  id: number;
  name: string;
  color: string;
  verts: Vec[];      // 薄片自身坐标系下的多边形
  hole: Vec[] | null; // 薄片上的透光孔(偶奇填充)
  x: number; y: number; // 在自身平面上的位置
  rot: number;       // 弧度
  z: number;         // 深度
}

interface PuzzleDef {
  id: string;
  title: string;
  desc: string;
  zMin: number;
  zMax: number;
  pieces: Piece[];
  targetPolys: Vec[][];          // 幕布坐标系下的目标区域(可多块)
  targetHole: { c: Vec; r: number } | null; // 目标区里的透光小孔
}

// ---------------- 多边形工具 ----------------

function rectPoly(w: number, h: number): Vec[] {
  return [
    { x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 },
  ];
}

function circlePoly(r: number, n = 28): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function starPoly(outer: number, inner: number, points = 5): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function moved(poly: Vec[], dx: number, dy: number): Vec[] {
  return poly.map(p => ({ x: p.x + dx, y: p.y + dy }));
}

function rotated(poly: Vec[], a: number): Vec[] {
  const c = Math.cos(a), s = Math.sin(a);
  return poly.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

function scaled(poly: Vec[], k: number): Vec[] {
  return poly.map(p => ({ x: p.x * k, y: p.y * k }));
}

function pointInPoly(pt: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------- 题面 ----------------

function makePuzzles(): PuzzleDef[] {
  // 题一:两片矩形薄片拼成上下两道梁,中间留出透光孔。
  // 薄片 110x30,在 z=500 处放大 2 倍,幕布上为 220x60。
  const p1: PuzzleDef = {
    id: 'beams',
    title: '题一 · 双梁留孔',
    desc: '把两片薄板摆成上下两道横梁(虚线范围),正中间的透光小孔必须保持明亮——别让影子盖住它。',
    zMin: 300, zMax: 800,
    pieces: [
      { id: 0, name: '甲片', color: '#c2553a', verts: rectPoly(110, 30), hole: null,
        x: -46, y: 14, rot: 0.6, z: 500 },
      { id: 1, name: '乙片', color: '#3a6ea5', verts: rectPoly(110, 30), hole: null,
        x: 38, y: -26, rot: -1.15, z: 500 },
    ],
    targetPolys: [
      moved(rectPoly(220, 60), 0, -80),
      moved(rectPoly(220, 60), 0, 80),
    ],
    targetHole: { c: { x: 0, y: 0 }, r: 16 },
  };

  // 题二:一片带孔星形薄片,只有在 z=400(放大 2.5 倍)时影子才正好。
  // 正确摆法:z=400, x=8, y=-4, rot=15°。
  const starTarget = moved(rotated(starPoly(105, 45), Math.PI / 12), 20, -10);
  const p2: PuzzleDef = {
    id: 'star',
    title: '题二 · 远近得当',
    desc: '只有一片带孔星星,但影子现在的大小怎么都对不上虚线。星星转一转、挪一挪,更重要的是——把它放到合适的深度。',
    zMin: 250, zMax: 800,
    pieces: [
      { id: 0, name: '星片', color: '#7a4f9e', verts: starPoly(42, 18), hole: circlePoly(10),
        x: -34, y: 22, rot: 1.1, z: 620 },
    ],
    targetPolys: [starTarget],
    targetHole: { c: { x: 20, y: -10 }, r: 25 },
  };

  return [p1, p2];
}

// ---------------- 投影 ----------------

/** 薄片多边形 -> 薄片平面世界坐标 */
function worldVerts(p: Piece): Vec[] {
  return moved(rotated(p.verts, p.rot), p.x, p.y);
}

/** 薄片平面世界坐标 -> 幕布投影(灯在原点,纯透视缩放) */
function project(p: Piece, pts: Vec[]): Vec[] {
  return scaled(pts, SCREEN_Z / p.z);
}

function shadowPoly(p: Piece): Vec[] {
  return project(p, worldVerts(p));
}

function shadowHolePoly(p: Piece): Vec[] | null {
  return p.hole ? project(p, moved(rotated(p.hole, p.rot), p.x, p.y)) : null;
}

function centroid(pts: Vec[]): Vec {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

// ---------------- 遮罩评分 ----------------

const maskCanvas = document.createElement('canvas');
maskCanvas.width = MASK; maskCanvas.height = MASK;
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })!;

function toMask(v: number): number {
  return ((v + VIEW) / (2 * VIEW)) * MASK;
}

function tracePoly(ctx: CanvasRenderingContext2D, poly: Vec[]): void {
  ctx.moveTo(toMask(poly[0].x), toMask(poly[0].y));
  for (let i = 1; i < poly.length; i++) ctx.lineTo(toMask(poly[i].x), toMask(poly[i].y));
  ctx.closePath();
}

interface Score {
  target: number; shadow: number;
  matched: number; missing: number; extra: number;
  holeTotal: number; holeBlocked: number;
  missingC: Vec; extraC: Vec; // 质心(幕布坐标)
  hitPct: number; extraPct: number;
  passed: boolean;
}

function computeScore(puzzle: PuzzleDef, pieces: Piece[]): Score {
  // 影子并集遮罩:所有薄片画进同一张画布,重叠处仍是同一个像素,不会多算
  maskCtx.clearRect(0, 0, MASK, MASK);
  maskCtx.fillStyle = '#fff';
  for (const p of pieces) {
    maskCtx.beginPath();
    tracePoly(maskCtx, shadowPoly(p));
    const h = shadowHolePoly(p);
    if (h) tracePoly(maskCtx, h);
    maskCtx.fill('evenodd');
  }
  const shadowData = maskCtx.getImageData(0, 0, MASK, MASK).data;

  // 目标遮罩:目标多边形减去透光孔(孔不属于要覆盖的区域)
  maskCtx.clearRect(0, 0, MASK, MASK);
  maskCtx.beginPath();
  for (const poly of puzzle.targetPolys) tracePoly(maskCtx, poly);
  maskCtx.fill();
  if (puzzle.targetHole) {
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'destination-out';
    maskCtx.beginPath();
    maskCtx.arc(toMask(puzzle.targetHole.c.x), toMask(puzzle.targetHole.c.y),
      (puzzle.targetHole.r / (2 * VIEW)) * MASK, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
  }
  const targetData = maskCtx.getImageData(0, 0, MASK, MASK).data;

  let holeData: Uint8ClampedArray | null = null;
  if (puzzle.targetHole) {
    maskCtx.clearRect(0, 0, MASK, MASK);
    maskCtx.beginPath();
    maskCtx.arc(toMask(puzzle.targetHole.c.x), toMask(puzzle.targetHole.c.y),
      (puzzle.targetHole.r / (2 * VIEW)) * MASK, 0, Math.PI * 2);
    maskCtx.fill();
    holeData = maskCtx.getImageData(0, 0, MASK, MASK).data;
  }

  let target = 0, shadow = 0, matched = 0, missing = 0, extra = 0;
  let holeTotal = 0, holeBlocked = 0;
  let mx = 0, my = 0, ex = 0, ey = 0;
  const px2unit = (2 * VIEW) / MASK;
  for (let j = 0; j < MASK; j++) {
    for (let i = 0; i < MASK; i++) {
      const k = (j * MASK + i) * 4 + 3;
      const t = targetData[k] > 127, s = shadowData[k] > 127;
      if (t) target++;
      if (s) shadow++;
      if (t && s) matched++;
      else if (t && !s) { missing++; mx += i; my += j; }
      else if (!t && s) { extra++; ex += i; ey += j; }
      if (holeData && holeData[k] > 127) {
        holeTotal++;
        if (s) holeBlocked++;
      }
    }
  }
  const toUnit = (acc: number) => acc * px2unit - VIEW;
  const hitPct = target ? matched / target : 0;
  const extraPct = target ? extra / target : 0;
  const holeOk = holeTotal === 0 || holeBlocked <= Math.max(2, holeTotal * 0.05);
  return {
    target, shadow, matched, missing, extra, holeTotal, holeBlocked,
    missingC: missing ? { x: toUnit(mx / missing), y: toUnit(my / missing) } : { x: 0, y: 0 },
    extraC: extra ? { x: toUnit(ex / extra), y: toUnit(ey / extra) } : { x: 0, y: 0 },
    hitPct, extraPct,
    passed: hitPct >= 0.96 && extraPct <= 0.04 && holeOk,
  };
}

// ---------------- 应用状态 ----------------

const puzzles = makePuzzles();
let puzzle: PuzzleDef;
let pieces: Piece[] = [];
let selected = 0;
let checkMode = false;
let dirty = true;          // 遮罩需要重算
let lastScore: Score | null = null;
let solvedFlag = false;

function clonePieces(def: PuzzleDef): Piece[] {
  return def.pieces.map(p => ({ ...p, verts: p.verts.map(v => ({ ...v })),
    hole: p.hole ? p.hole.map(v => ({ ...v })) : null }));
}

function loadPuzzle(idx: number, tryRestore = true): void {
  puzzle = puzzles[idx];
  pieces = clonePieces(puzzle);
  selected = 0;
  checkMode = false;
  solvedFlag = false;
  btnCheck.classList.remove('active');
  document.querySelectorAll('#puzzle-bar button').forEach(b => b.classList.remove('active'));
  (idx === 0 ? btnP1 : btnP2).classList.add('active');
  elDesc.textContent = puzzle.desc;
  if (tryRestore && restore(true)) {
    setMessage('已恢复上次保存的摆法。');
  } else {
    setMessage('选择一片薄片开始摆弄。');
  }
  rebuildPieceList();
  dirty = true;
}

// ---------------- DOM ----------------

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const screenCv = el<HTMLCanvasElement>('screen');
const sctx = screenCv.getContext('2d')!;
const topCv = el<HTMLCanvasElement>('topview');
const tctx = topCv.getContext('2d')!;
const elDesc = el('puzzle-desc');
const elMsg = el('message');
const elHit = el('v-hit');
const elExtra = el('v-extra');
const elHole = el('v-hole');
const barHit = el('bar-hit');
const btnP1 = el<HTMLButtonElement>('btn-p1');
const btnP2 = el<HTMLButtonElement>('btn-p2');
const btnCheck = el<HTMLButtonElement>('btn-check');

function setMessage(text: string, win = false): void {
  elMsg.textContent = text;
  elMsg.classList.toggle('win', win);
}

// 幕布坐标 <-> 画布像素
function toCv(v: number): number { return ((v + VIEW) / (2 * VIEW)) * screenCv.width; }
function fromCv(px: number): number { return (px / screenCv.width) * 2 * VIEW - VIEW; }

function canvasPos(e: MouseEvent, cv: HTMLCanvasElement): Vec {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ---------------- 对齐吸附(轻量) ----------------

function snapTo(v: number, step: number, thresh: number): number {
  const r = Math.round(v / step) * step;
  return Math.abs(v - r) <= thresh ? r : v;
}
function snapPiece(p: Piece): void {
  p.x = snapTo(p.x, 2, 1.2);
  p.y = snapTo(p.y, 2, 1.2);
  p.rot = snapTo(p.rot, Math.PI / 36, Math.PI / 90); // 5° 档,2° 内吸附
  p.z = snapTo(p.z, 10, 4);
}

// ---------------- 保存 / 恢复 ----------------

function saveKey(): string { return 'shadow-puzzle:' + puzzle.id; }

function save(): void {
  const data = {
    pieces: pieces.map(p => ({ x: p.x, y: p.y, rot: p.rot, z: p.z })),
    solved: solvedFlag,
  };
  localStorage.setItem(saveKey(), JSON.stringify(data));
  setMessage(solvedFlag ? '已保存这个过关摆法。' : '已保存当前摆法。');
}

function restore(silent = false): boolean {
  const raw = localStorage.getItem(saveKey());
  if (!raw) {
    if (!silent) setMessage('本题还没有保存过摆法。');
    return false;
  }
  try {
    const data = JSON.parse(raw) as { pieces: { x: number; y: number; rot: number; z: number }[]; solved?: boolean };
    data.pieces.forEach((s, i) => {
      if (pieces[i]) Object.assign(pieces[i], { x: s.x, y: s.y, rot: s.rot, z: s.z });
    });
    dirty = true;
    return true;
  } catch {
    if (!silent) setMessage('保存的数据读不出来,已忽略。');
    return false;
  }
}

// ---------------- 提示:只说一处 ----------------

function regionWord(c: Vec): string {
  // 相对目标重心描述方位
  const all = puzzle.targetPolys.flat();
  const tc = centroid(all);
  const dx = c.x - tc.x, dy = c.y - tc.y;
  const ns = dy < -24 ? '偏上' : dy > 24 ? '偏下' : '';
  const ew = dx < -24 ? '偏左' : dx > 24 ? '偏右' : '';
  return ns + ew || '正中央';
}

function giveHint(): void {
  if (!lastScore) return;
  const s = lastScore;
  if (s.passed) { setMessage('已经拼好了,没有可提示的。', true); return; }
  const holeBad = s.holeTotal > 0 && s.holeBlocked > Math.max(2, s.holeTotal * 0.05);
  if (holeBad) {
    setMessage(`提示:幕布${regionWord(puzzle.targetHole!.c)}的透光孔被影子盖住了,挪开盖着它的那片。`);
  } else if (s.missing >= s.extra && s.missing > 0) {
    const pct = Math.round((s.missing / s.target) * 100);
    setMessage(`提示:幕布${regionWord(s.missingC)}还缺一块影(约 ${pct}%),把薄片往那边补。`);
  } else if (s.extra > 0) {
    const pct = Math.round((s.extra / s.target) * 100);
    setMessage(`提示:幕布${regionWord(s.extraC)}多出一截影(约 ${pct}%),那边的薄片收一收或换个深度。`);
  }
}

// ---------------- 绘制:幕布 ----------------

const diffCanvas = document.createElement('canvas');
diffCanvas.width = MASK; diffCanvas.height = MASK;
const diffCtx = diffCanvas.getContext('2d')!;

function rebuildDiff(s: Score): void {
  // 依据遮罩生成差异图:缺影红、多影橙、被盖的孔紫红
  maskCtx.clearRect(0, 0, MASK, MASK);
  maskCtx.fillStyle = '#fff';
  for (const p of pieces) {
    maskCtx.beginPath();
    tracePoly(maskCtx, shadowPoly(p));
    const h = shadowHolePoly(p);
    if (h) tracePoly(maskCtx, h);
    maskCtx.fill('evenodd');
  }
  const sd = maskCtx.getImageData(0, 0, MASK, MASK).data;
  maskCtx.clearRect(0, 0, MASK, MASK);
  maskCtx.beginPath();
  for (const poly of puzzle.targetPolys) tracePoly(maskCtx, poly);
  maskCtx.fill();
  if (puzzle.targetHole) {
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'destination-out';
    maskCtx.beginPath();
    maskCtx.arc(toMask(puzzle.targetHole.c.x), toMask(puzzle.targetHole.c.y),
      (puzzle.targetHole.r / (2 * VIEW)) * MASK, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
  }
  const td = maskCtx.getImageData(0, 0, MASK, MASK).data;
  let hd: Uint8ClampedArray | null = null;
  if (puzzle.targetHole) {
    maskCtx.clearRect(0, 0, MASK, MASK);
    maskCtx.beginPath();
    maskCtx.arc(toMask(puzzle.targetHole.c.x), toMask(puzzle.targetHole.c.y),
      (puzzle.targetHole.r / (2 * VIEW)) * MASK, 0, Math.PI * 2);
    maskCtx.fill();
    hd = maskCtx.getImageData(0, 0, MASK, MASK).data;
  }
  const img = diffCtx.createImageData(MASK, MASK);
  for (let k = 0; k < MASK * MASK; k++) {
    const a = k * 4;
    const t = td[a + 3] > 127, sh = sd[a + 3] > 127;
    const hole = hd ? hd[a + 3] > 127 : false;
    if (hole && sh) { img.data[a] = 176; img.data[a + 1] = 40; img.data[a + 2] = 120; img.data[a + 3] = 220; }
    else if (t && !sh) { img.data[a] = 214; img.data[a + 1] = 48; img.data[a + 2] = 39; img.data[a + 3] = 170; }
    else if (!t && sh) { img.data[a] = 230; img.data[a + 1] = 134; img.data[a + 2] = 30; img.data[a + 3] = 170; }
  }
  diffCtx.putImageData(img, 0, 0);
  void s;
}

function pathOnScreen(ctx: CanvasRenderingContext2D, poly: Vec[]): void {
  ctx.moveTo(toCv(poly[0].x), toCv(poly[0].y));
  for (let i = 1; i < poly.length; i++) ctx.lineTo(toCv(poly[i].x), toCv(poly[i].y));
  ctx.closePath();
}

function drawScreen(time: number): void {
  const W = screenCv.width;
  sctx.clearRect(0, 0, W, W);

  // 幕布底色与边框
  const g = sctx.createRadialGradient(W / 2, W / 2, 40, W / 2, W / 2, W * 0.7);
  g.addColorStop(0, '#fbf5e4');
  g.addColorStop(1, '#e9dfc4');
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, W, W);

  // 目标虚线
  sctx.save();
  sctx.setLineDash([7, 6]);
  sctx.lineWidth = 1.6;
  sctx.strokeStyle = '#a98b4f';
  for (const poly of puzzle.targetPolys) {
    sctx.beginPath();
    pathOnScreen(sctx, poly);
    sctx.stroke();
  }
  sctx.restore();

  // 透光孔:先画成亮点(光透过来的样子)
  if (puzzle.targetHole) {
    const hx = toCv(puzzle.targetHole.c.x), hy = toCv(puzzle.targetHole.c.y);
    const hr = (puzzle.targetHole.r / (2 * VIEW)) * W;
    const hg = sctx.createRadialGradient(hx, hy, 0, hx, hy, hr * 1.8);
    hg.addColorStop(0, 'rgba(255,236,150,0.95)');
    hg.addColorStop(0.55, 'rgba(255,214,90,0.45)');
    hg.addColorStop(1, 'rgba(255,214,90,0)');
    sctx.fillStyle = hg;
    sctx.beginPath(); sctx.arc(hx, hy, hr * 1.8, 0, Math.PI * 2); sctx.fill();
    sctx.setLineDash([3, 3]);
    sctx.strokeStyle = '#c9a13b';
    sctx.lineWidth = 1.2;
    sctx.beginPath(); sctx.arc(hx, hy, hr, 0, Math.PI * 2); sctx.stroke();
    sctx.setLineDash([]);
  }

  // 影子(并集视觉:同色同透明度,叠加不加深)
  sctx.save();
  sctx.fillStyle = 'rgba(38,30,24,0.88)';
  for (const p of pieces) {
    sctx.beginPath();
    pathOnScreen(sctx, shadowPoly(p));
    const h = shadowHolePoly(p);
    if (h) pathOnScreen(sctx, h);
    sctx.fill('evenodd');
  }
  sctx.restore();

  // 核对差异 overlay
  if (checkMode && lastScore) {
    sctx.save();
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(diffCanvas, 0, 0, W, W);
    sctx.restore();
  }

  // 孔被盖住:闪红圈
  if (lastScore && lastScore.holeTotal > 0 &&
      lastScore.holeBlocked > Math.max(2, lastScore.holeTotal * 0.05)) {
    const hx = toCv(puzzle.targetHole!.c.x), hy = toCv(puzzle.targetHole!.c.y);
    const hr = (puzzle.targetHole!.r / (2 * VIEW)) * W;
    const pulse = 0.5 + 0.5 * Math.sin(time / 180);
    sctx.strokeStyle = `rgba(200,30,30,${0.45 + 0.55 * pulse})`;
    sctx.lineWidth = 3;
    sctx.beginPath(); sctx.arc(hx, hy, hr + 4, 0, Math.PI * 2); sctx.stroke();
  }

  // 选中薄片的手柄
  const p = pieces[selected];
  if (p) {
    const c = centroid(shadowPoly(p));
    const cx = toCv(c.x), cy = toCv(c.y);
    const ang = p.rot - Math.PI / 2;
    const hx = cx + Math.cos(ang) * (HANDLE_DIST / (2 * VIEW)) * W;
    const hy = cy + Math.sin(ang) * (HANDLE_DIST / (2 * VIEW)) * W;
    sctx.strokeStyle = p.color;
    sctx.lineWidth = 1.4;
    sctx.setLineDash([4, 4]);
    sctx.beginPath(); sctx.moveTo(cx, cy); sctx.lineTo(hx, hy); sctx.stroke();
    sctx.setLineDash([]);
    sctx.fillStyle = '#fff';
    sctx.beginPath(); sctx.arc(hx, hy, 7, 0, Math.PI * 2); sctx.fill();
    sctx.strokeStyle = p.color;
    sctx.lineWidth = 2;
    sctx.stroke();
    // 选中框
    sctx.setLineDash([3, 4]);
    sctx.strokeStyle = p.color;
    sctx.lineWidth = 1.5;
    sctx.beginPath();
    pathOnScreen(sctx, shadowPoly(p));
    sctx.stroke();
    sctx.setLineDash([]);
  }
}

// ---------------- 绘制:台面俯视 ----------------

function drawTop(): void {
  const W = topCv.width, H = topCv.height;
  tctx.clearRect(0, 0, W, H);
  const zx = (z: number) => 26 + (z / SCREEN_Z) * (W - 46);
  const xy = (x: number) => H - 14 - ((x + VIEW) / (2 * VIEW)) * (H - 30);

  // 幕布线
  tctx.strokeStyle = '#c9b98f';
  tctx.lineWidth = 3;
  tctx.beginPath(); tctx.moveTo(zx(SCREEN_Z), 8); tctx.lineTo(zx(SCREEN_Z), H - 8); tctx.stroke();
  tctx.fillStyle = '#8f8060';
  tctx.font = '11px sans-serif';
  tctx.fillText('幕布', zx(SCREEN_Z) - 14, H - 2);

  // 目标在幕布上的纵向范围(淡金)
  tctx.fillStyle = 'rgba(201,161,59,0.18)';
  const allT = puzzle.targetPolys.flat();
  const tMin = Math.min(...allT.map(p => p.x)), tMax = Math.max(...allT.map(p => p.x));
  tctx.fillRect(zx(SCREEN_Z) - 5, xy(tMax), 5, xy(tMin) - xy(tMax));

  // 灯
  const lg = tctx.createRadialGradient(zx(0), xy(0), 0, zx(0), xy(0), 16);
  lg.addColorStop(0, '#ffe9a0');
  lg.addColorStop(1, 'rgba(255,220,120,0)');
  tctx.fillStyle = lg;
  tctx.beginPath(); tctx.arc(zx(0), xy(0), 16, 0, Math.PI * 2); tctx.fill();
  tctx.fillStyle = '#ffd34d';
  tctx.beginPath(); tctx.arc(zx(0), xy(0), 4, 0, Math.PI * 2); tctx.fill();
  tctx.fillStyle = '#8f8060';
  tctx.fillText('灯', zx(0) - 4, H - 2);

  // 薄片:标记 + 投影锥线
  for (const p of pieces) {
    const wv = worldVerts(p);
    const xs = wv.map(v => v.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const m = SCREEN_Z / p.z;
    // 锥线:灯 -> 薄片两端 -> 幕布
    tctx.strokeStyle = p.id === selected ? p.color : 'rgba(160,145,110,0.5)';
    tctx.lineWidth = p.id === selected ? 1.6 : 1;
    tctx.setLineDash([3, 4]);
    for (const xx of [x0, x1]) {
      tctx.beginPath();
      tctx.moveTo(zx(0), xy(0));
      tctx.lineTo(zx(p.z), xy(xx));
      tctx.lineTo(zx(SCREEN_Z), xy(xx * m));
      tctx.stroke();
    }
    tctx.setLineDash([]);
    // 薄片本身(俯视是一小段)
    tctx.strokeStyle = p.color;
    tctx.lineWidth = p.id === selected ? 5 : 3.5;
    tctx.beginPath();
    tctx.moveTo(zx(p.z), xy(x0));
    tctx.lineTo(zx(p.z), xy(x1));
    tctx.stroke();
    // 深度数值
    if (p.id === selected) {
      tctx.fillStyle = '#d8c9a3';
      tctx.fillText(`z=${Math.round(p.z)}  影×${(SCREEN_Z / p.z).toFixed(2)}`, zx(p.z) - 30, H - 2);
    }
  }
}

// ---------------- 状态刷新 ----------------

function refresh(): void {
  if (dirty) {
    lastScore = computeScore(puzzle, pieces);
    if (checkMode) rebuildDiff(lastScore);
    dirty = false;
    elHit.textContent = Math.round(lastScore.hitPct * 100) + '%';
    elExtra.textContent = Math.round(lastScore.extraPct * 100) + '%';
    barHit.style.width = Math.round(lastScore.hitPct * 100) + '%';
    if (lastScore.holeTotal > 0) {
      const bad = lastScore.holeBlocked > Math.max(2, lastScore.holeTotal * 0.05);
      elHole.innerHTML = bad
        ? '<span id="hole-bad">被影子盖住了!</span>'
        : '<span id="hole-ok">通畅</span>';
    } else {
      elHole.textContent = '—';
    }
    if (lastScore.passed && !solvedFlag) {
      solvedFlag = true;
      setMessage('🎉 过关!影子和目标对上了。可以「保存当前摆法」留个纪念。', true);
    } else if (!lastScore.passed && solvedFlag) {
      solvedFlag = false;
      setMessage('又动了薄片,不再是过关状态了。');
    }
    updatePieceMeta();
  }
}

function frame(time: number): void {
  refresh();
  drawScreen(time);
  drawTop();
  requestAnimationFrame(frame);
}

// ---------------- 交互:幕布画布 ----------------

type DragMode = 'none' | 'move' | 'rotate';
let dragMode: DragMode = 'none';
let dragLast: Vec = { x: 0, y: 0 };
let grabAngle = 0;

function handlePos(p: Piece): Vec {
  const c = centroid(shadowPoly(p));
  const ang = p.rot - Math.PI / 2;
  return { x: c.x + Math.cos(ang) * HANDLE_DIST, y: c.y + Math.sin(ang) * HANDLE_DIST };
}

screenCv.addEventListener('mousedown', e => {
  const pt = canvasPos(e, screenCv);
  const u = { x: fromCv(pt.x), y: fromCv(pt.y) }; // 幕布单位
  const p = pieces[selected];
  // 先测旋转手柄
  if (p) {
    const h = handlePos(p);
    const d = Math.hypot(u.x - h.x, u.y - h.y);
    if (d < 14) {
      dragMode = 'rotate';
      const c = centroid(shadowPoly(p));
      grabAngle = p.rot - Math.atan2(u.y - c.y, u.x - c.x);
      screenCv.classList.add('dragging');
      return;
    }
  }
  // 命中检测:从后往前(后画的优先)
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (pointInPoly(u, shadowPoly(pieces[i]))) {
      selected = i;
      rebuildPieceList();
      dragMode = 'move';
      dragLast = u;
      screenCv.classList.add('dragging');
      return;
    }
  }
});

window.addEventListener('mousemove', e => {
  if (dragMode === 'none') return;
  const pt = canvasPos(e, screenCv);
  const u = { x: fromCv(pt.x), y: fromCv(pt.y) };
  const p = pieces[selected];
  if (dragMode === 'move') {
    const m = SCREEN_Z / p.z; // 幕布位移 -> 薄片平面位移
    p.x += (u.x - dragLast.x) / m;
    p.y += (u.y - dragLast.y) / m;
    dragLast = u;
  } else {
    const c = centroid(shadowPoly(p));
    p.rot = grabAngle + Math.atan2(u.y - c.y, u.x - c.x);
  }
  dirty = true;
});

window.addEventListener('mouseup', () => {
  if (dragMode !== 'none') {
    snapPiece(pieces[selected]);
    dirty = true;
  }
  dragMode = 'none';
  screenCv.classList.remove('dragging');
});

screenCv.addEventListener('wheel', e => {
  e.preventDefault();
  const p = pieces[selected];
  if (!p) return;
  p.z = clampDepth(p.z + (e.deltaY > 0 ? 20 : -20));
  snapPiece(p);
  dirty = true;
}, { passive: false });

function clampDepth(z: number): number {
  return Math.min(puzzle.zMax, Math.max(puzzle.zMin, z));
}

// ---------------- 交互:台面俯视(拖深度) ----------------

let topDrag = false;

function topHit(e: MouseEvent): number {
  const pt = canvasPos(e, topCv);
  const W = topCv.width, H = topCv.height;
  const zx = (z: number) => 26 + (z / SCREEN_Z) * (W - 46);
  const xy = (x: number) => H - 14 - ((x + VIEW) / (2 * VIEW)) * (H - 30);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    const wv = worldVerts(p);
    const xs = wv.map(v => v.x);
    const y0 = xy(Math.min(...xs)), y1 = xy(Math.max(...xs));
    if (Math.abs(pt.x - zx(p.z)) < 8 && pt.y > y1 - 6 && pt.y < y0 + 6) return i;
  }
  return -1;
}

topCv.addEventListener('mousedown', e => {
  const i = topHit(e);
  if (i >= 0) {
    selected = i;
    rebuildPieceList();
    topDrag = true;
  }
});

window.addEventListener('mousemove', e => {
  if (!topDrag) return;
  const pt = canvasPos(e, topCv);
  const W = topCv.width;
  const z = ((pt.x - 26) / (W - 46)) * SCREEN_Z;
  const p = pieces[selected];
  p.z = clampDepth(z);
  dirty = true;
});

window.addEventListener('mouseup', () => {
  if (topDrag) {
    snapPiece(pieces[selected]);
    dirty = true;
  }
  topDrag = false;
});

// ---------------- 交互:按钮与键盘 ----------------

function rebuildPieceList(): void {
  const list = el('piece-list');
  list.innerHTML = '';
  pieces.forEach((p, i) => {
    const b = document.createElement('button');
    if (i === selected) b.classList.add('active');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.id = `piece-meta-${i}`;
    b.append(dot, name, meta);
    b.addEventListener('click', () => { selected = i; rebuildPieceList(); });
    list.appendChild(b);
  });
  updatePieceMeta();
}

function updatePieceMeta(): void {
  pieces.forEach((p, i) => {
    const m = document.getElementById(`piece-meta-${i}`);
    if (m) m.textContent = `z=${Math.round(p.z)} 影×${(SCREEN_Z / p.z).toFixed(2)}`;
  });
}

function rotateSelected(d: number): void {
  const p = pieces[selected];
  p.rot += d;
  snapPiece(p);
  dirty = true;
}

function depthSelected(d: number): void {
  const p = pieces[selected];
  p.z = clampDepth(p.z + d);
  snapPiece(p);
  dirty = true;
}

el<HTMLButtonElement>('btn-rotl').addEventListener('click', () => rotateSelected(-Math.PI / 36));
el<HTMLButtonElement>('btn-rotr').addEventListener('click', () => rotateSelected(Math.PI / 36));
el<HTMLButtonElement>('btn-nearer').addEventListener('click', () => depthSelected(-10));
el<HTMLButtonElement>('btn-farther').addEventListener('click', () => depthSelected(10));
el<HTMLButtonElement>('btn-hint').addEventListener('click', giveHint);
btnCheck.addEventListener('click', () => {
  checkMode = !checkMode;
  btnCheck.classList.toggle('active', checkMode);
  if (checkMode && lastScore) rebuildDiff(lastScore);
});
el<HTMLButtonElement>('btn-save').addEventListener('click', save);
el<HTMLButtonElement>('btn-load').addEventListener('click', () => {
  if (restore(false)) setMessage('已恢复保存的摆法。');
});
el<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
  pieces = clonePieces(puzzle);
  solvedFlag = false;
  dirty = true;
  setMessage('本题已重置。');
});
btnP1.addEventListener('click', () => loadPuzzle(0));
btnP2.addEventListener('click', () => loadPuzzle(1));

window.addEventListener('keydown', e => {
  const p = pieces[selected];
  if (!p) return;
  const step = 2 / (SCREEN_Z / p.z); // 幕布上挪 2 个单位
  switch (e.key) {
    case 'ArrowLeft': p.x -= step; break;
    case 'ArrowRight': p.x += step; break;
    case 'ArrowUp': p.y -= step; break;
    case 'ArrowDown': p.y += step; break;
    case 'q': case 'Q': rotateSelected(-Math.PI / 90); return;
    case 'e': case 'E': rotateSelected(Math.PI / 90); return;
    case 'w': case 'W': depthSelected(-10); return;
    case 's': case 'S': depthSelected(10); return;
    default: return;
  }
  e.preventDefault();
  dirty = true;
});

// ---------------- 启动 ----------------

loadPuzzle(0);
requestAnimationFrame(frame);
