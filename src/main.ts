/**
 * 桌面齿轮谜题
 * - 有限插轴上安装普通齿轮 / 同轴双联齿轮
 * - 手摇轮按啮合关系传动,给出转向与整圈进度
 * - 两条支路对同一轴要求不一致时,整个连通组锁死(不互相覆盖)
 * - 移除齿轮后从当前布局重新判断;相邻但未啮合的轴保持自由
 */

// ---------------- 基本常量 ----------------
const MODULE = 4;            // 模数:半径 = MODULE * 齿数 / 2
const MESH_TOL = 3;          // 啮合判定容差(px)
const CRANK_SPEED = 1.5;     // 手摇轮角速度(rad/s),自动摇动时

function radiusOf(teeth: number): number { return MODULE * teeth / 2; }
function outerOf(teeth: number): number { return radiusOf(teeth) + MODULE * 1.0; }

// ---------------- 数据定义 ----------------
interface GearSpec { id: string; teeth: number[]; } // teeth 长度 1=普通齿轮, 2=同轴双联

function specName(s: GearSpec): string {
  return s.teeth.length > 1 ? `双联 ${s.teeth[0]}+${s.teeth[1]} 齿` : `${s.teeth[0]} 齿`;
}

type Role = 'crank' | 'output' | 'normal';

interface AxleDef {
  id: string; x: number; y: number;
  role: Role; label: string;
  reqDir?: 1 | -1;      // 出口轴要求的转向: 1=正转(顺时针) -1=反转
  crankTeeth?: number;  // 手摇轮固定齿轮
}

interface InvItem { spec: GearSpec; count: number; }

interface PuzzleDef {
  id: string; name: string; desc: string;
  axles: AxleDef[]; inventory: InvItem[];
}

const SQRT3 = Math.sqrt(3);

const PUZZLES: PuzzleDef[] = [
  {
    id: 'p1',
    name: '第一题:复合轴减速',
    desc: '目标:出口 C 正转(↻)、出口 E 反转(↺)。\n' +
          'B 轴到两端距离不一样,单个齿轮够不着两头——\n' +
          '需要同轴双联齿轮做减速中继。直接装 36 齿是个大坑。',
    axles: [
      { id: 'A', x: 150, y: 330, role: 'crank',  label: 'A(手摇)', crankTeeth: 16 },
      { id: 'B', x: 254, y: 330, role: 'normal', label: 'B' },
      { id: 'C', x: 326, y: 330, role: 'output', label: 'C(出口)', reqDir: 1 },
      { id: 'E', x: 150, y: 242, role: 'output', label: 'E(出口)', reqDir: -1 },
    ],
    inventory: [
      { spec: { id: 'g16',    teeth: [16] },     count: 1 },
      { spec: { id: 'g20',    teeth: [20] },     count: 1 },
      { spec: { id: 'g24',    teeth: [24] },     count: 1 },
      { spec: { id: 'g28',    teeth: [28] },     count: 1 },
      { spec: { id: 'g36',    teeth: [36] },     count: 1 },
      { spec: { id: 'c3612',  teeth: [36, 12] }, count: 1 },
      { spec: { id: 'c2412',  teeth: [24, 12] }, count: 1 },
    ],
  },
  {
    id: 'p2',
    name: '第二题:自锁环路',
    desc: '目标:出口 D 正转(↻)。\n' +
          'A、B、C 三根轴两两都能啮合。如果把三个齿轮都装上,\n' +
          '支路 A→B 与 A→C→B 对 B 的转向要求相反,\n' +
          '整个连通组会锁死。试试装成环路,再拆掉一个恢复。',
    axles: [
      { id: 'A', x: 200, y: 360, role: 'crank',  label: 'A(手摇)', crankTeeth: 16 },
      { id: 'B', x: 264, y: 360, role: 'normal', label: 'B' },
      { id: 'C', x: 232, y: 360 - 32 * SQRT3, role: 'normal', label: 'C' },
      { id: 'D', x: 328, y: 360, role: 'output', label: 'D(出口)', reqDir: 1 },
    ],
    inventory: [
      { spec: { id: 'g16', teeth: [16] }, count: 4 },
    ],
  },
];

// ---------------- 运行状态 ----------------
const cv = document.getElementById('cv') as HTMLCanvasElement;
const g = cv.getContext('2d')!;

let puzzle: PuzzleDef;
let mounted = new Map<string, GearSpec>();   // axleId -> 装上的齿轮
let invLeft = new Map<string, number>();     // specId -> 剩余数量
let specById = new Map<string, GearSpec>();
let selectedSpec: string | null = null;
let focusAxle: string | null = null;

let crankAngle = 0;          // 手摇轮累计转角(rad)
let crankDir: 1 | -1 = 1;    // 手摇方向
let autoCrank = false;

// 传动求解结果
interface Edge { a: string; b: string; za: number; zb: number; }
let edges: Edge[] = [];
let ratios = new Map<string, number>();  // 各轴相对手摇轮的转速比(锁死时全部归零)
let parents = new Map<string, string>();
let locked = false;
let conflictInfo = '';
let component = new Set<string>();

let dragging = false;
let dragPrev = 0;

// ---------------- 工具 ----------------
function axleById(id: string): AxleDef { return puzzle.axles.find(a => a.id === id)!; }
function labelOf(id: string): string { return axleById(id).label; }

function teethOf(id: string): number[] | null {
  const a = axleById(id);
  if (a.role === 'crank') return [a.crankTeeth!];
  const m = mounted.get(id);
  return m ? m.teeth : null;
}

function fmtRatio(r: number): string {
  const sign = r > 0 ? '+' : r < 0 ? '−' : '';
  return sign + Math.abs(r).toFixed(3);
}

function dirChar(omega: number): string { return omega > 0 ? '↻正转' : omega < 0 ? '↺反转' : '停'; }

/** 从手摇轮到 id 的传动路径字符串 */
function pathStr(id: string): string {
  const chain: string[] = [];
  let cur: string | undefined = id;
  while (cur) { chain.unshift(axleById(cur).label); cur = parents.get(cur); }
  return chain.join(' → ');
}

// ---------------- 传动求解 ----------------
function rebuild(): void {
  // 1) 按当前布局重新计算啮合关系(相邻但齿距不合的轴不会连上)
  edges = [];
  const ax = puzzle.axles;
  for (let i = 0; i < ax.length; i++) {
    for (let j = i + 1; j < ax.length; j++) {
      const ta = teethOf(ax[i].id), tb = teethOf(ax[j].id);
      if (!ta || !tb) continue;
      const d = Math.hypot(ax[i].x - ax[j].x, ax[i].y - ax[j].y);
      for (const za of ta) for (const zb of tb) {
        if (Math.abs(d - (radiusOf(za) + radiusOf(zb))) < MESH_TOL) {
          edges.push({ a: ax[i].id, b: ax[j].id, za, zb });
        }
      }
    }
  }

  // 2) 从手摇轮 BFS 传播转速比;两条支路冲突时整组锁死
  ratios.clear(); parents.clear(); component.clear();
  locked = false; conflictInfo = '';
  const crank = puzzle.axles.find(a => a.role === 'crank')!;
  ratios.set(crank.id, 1);
  component.add(crank.id);
  const queue: string[] = [crank.id];
  while (queue.length) {
    const u = queue.shift()!;
    for (const e of edges) {
      let v: string, k: number;
      if (e.a === u) { v = e.b; k = -e.za / e.zb; }
      else if (e.b === u) { v = e.a; k = -e.zb / e.za; }
      else continue;
      const expect = ratios.get(u)! * k;
      if (!ratios.has(v)) {
        ratios.set(v, expect);
        parents.set(v, u);
        component.add(v);
        queue.push(v);
      } else if (Math.abs(ratios.get(v)! - expect) > 1e-9) {
        // 冲突:保留先到的值,绝不用后到的覆盖;标记整组锁死
        locked = true;
        conflictInfo =
          `轴「${labelOf(v)}」被两条支路驱动:\n` +
          `  沿 ${pathStr(u)} 要求 ${fmtRatio(expect)}\n` +
          `  已有值 ${fmtRatio(ratios.get(v)!)}(来自 ${pathStr(v)})\n` +
          `方向或速度不一致,整个连通组停转。`;
      }
    }
  }
  if (locked) {
    for (const id of component) ratios.set(id, 0);
  }
  updateInfo();
  updateBanner();
}

// ---------------- 界面 ----------------
const invDiv = document.getElementById('inv')!;
const infoDiv = document.getElementById('info')!;
const goalDiv = document.getElementById('goal')!;
const banner = document.getElementById('banner')!;

function refreshInventoryUI(): void {
  invDiv.innerHTML = '';
  for (const item of puzzle.inventory) {
    const left = invLeft.get(item.spec.id)!;
    const btn = document.createElement('button');
    btn.textContent = `${specName(item.spec)} ×${left}`;
    btn.disabled = left <= 0;
    if (selectedSpec === item.spec.id) btn.classList.add('sel');
    btn.onclick = () => {
      selectedSpec = selectedSpec === item.spec.id ? null : item.spec.id;
      refreshInventoryUI();
    };
    invDiv.appendChild(btn);
  }
}

function updateBanner(): void {
  const outs = puzzle.axles.filter(a => a.role === 'output');
  const ok = outs.length > 0 && outs.every(o => {
    const r = ratios.get(o.id);
    return !locked && r !== undefined && r !== 0 && Math.sign(r) * crankDir === o.reqDir;
  });
  banner.style.display = ok ? 'block' : 'none';
}

function updateInfo(): void {
  if (!focusAxle) { return; }
  const a = axleById(focusAxle);
  const lines: string[] = [`轴 ${a.label}`];
  const teeth = teethOf(a.id);
  if (a.role === 'crank') {
    lines.push(`手摇轮,固定 ${a.crankTeeth} 齿,当前${crankDir > 0 ? '正转↻' : '反转↺'}`);
  } else if (!teeth) {
    lines.push('未装齿轮。在零件盒里选一个,再点这根空轴。');
  } else {
    lines.push(`装有:${specName(mounted.get(a.id)!)}`);
  }

  if (teeth) {
    if (locked && component.has(a.id)) {
      lines.push('❌ 所在连通组已锁死,所有轴停转。', conflictInfo);
    } else if (ratios.has(a.id) && ratios.get(a.id) !== 0) {
      const r = ratios.get(a.id)!;
      const omega = r * crankDir;
      const turns = (r * crankAngle) / (2 * Math.PI);
      lines.push(
        `✅ 已连通:${pathStr(a.id)}`,
        `转速比 ${fmtRatio(r)}(相对手摇轮),${dirChar(omega)}`,
        `整圈进度:${turns.toFixed(2)} 圈`
      );
    } else if (a.role !== 'crank') {
      lines.push('⚪ 自由状态:没和手摇轮连上。',
                 '相邻的轴如果齿距对不上(中心距 ≠ 两节圆半径和)也不会啮合。');
    }
  }
  if (a.role === 'output') {
    const r = ratios.get(a.id);
    const ok = !locked && r !== undefined && r !== 0 && Math.sign(r) * crankDir === a.reqDir;
    lines.push(`出口要求:${a.reqDir! > 0 ? '正转↻' : '反转↺'} —— ${ok ? '✅ 达标' : '❌ 未达标'}`);
  }
  infoDiv.textContent = lines.join('\n');
}

// ---------------- 绘制 ----------------
function drawGearShape(x: number, y: number, teeth: number, angle: number,
                       fill: string, stroke: string): void {
  const r = radiusOf(teeth);
  const ro = outerOf(teeth);
  const ri = r - MODULE * 1.1;
  const step = Math.PI * 2 / teeth;
  g.beginPath();
  let first = true;
  for (let i = 0; i < teeth; i++) {
    const a = angle + i * step;
    const pts: Array<[number, number]> = [
      [ri, a - 0.30 * step], [ro, a - 0.14 * step],
      [ro, a + 0.14 * step], [ri, a + 0.30 * step],
    ];
    for (const [rr, aa] of pts) {
      const px = x + rr * Math.cos(aa), py = y + rr * Math.sin(aa);
      if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
    }
  }
  g.closePath();
  g.fillStyle = fill; g.fill();
  g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke();
  // 节圆(虚线)与旋转标记
  g.beginPath();
  g.setLineDash([3, 4]);
  g.arc(x, y, r, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1; g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + r * 0.62 * Math.cos(angle), y + r * 0.62 * Math.sin(angle));
  g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.stroke();
}

function render(): void {
  g.clearRect(0, 0, cv.width, cv.height);

  // 啮合关系:中心连线 + 啮合点
  for (const e of edges) {
    const A = axleById(e.a), B = axleById(e.b);
    const d = Math.hypot(B.x - A.x, B.y - A.y);
    const ra = radiusOf(e.za);
    const mx = A.x + (B.x - A.x) * ra / d;
    const my = A.y + (B.y - A.y) * ra / d;
    g.beginPath();
    g.setLineDash([4, 4]);
    g.moveTo(A.x, A.y); g.lineTo(B.x, B.y);
    g.strokeStyle = locked && component.has(e.a) && component.has(e.b)
      ? 'rgba(230,80,80,0.7)' : 'rgba(120,200,140,0.45)';
    g.lineWidth = 1; g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.arc(mx, my, 4, 0, Math.PI * 2);
    g.fillStyle = '#f0a13c'; g.fill();
  }

  // 各轴与齿轮
  for (const a of puzzle.axles) {
    const teeth = teethOf(a.id);
    const inComp = component.has(a.id);
    const ratio = ratios.get(a.id);
    const angle = ratio !== undefined ? ratio * crankAngle : 0;
    const isLockedHere = locked && inComp;

    if (teeth) {
      const sorted = [...teeth].sort((p, q) => q - p);
      const fill = isLockedHere ? '#7a3a3a' : inComp ? '#3f6d4e' : '#4a5158';
      const stroke = isLockedHere ? '#e05050' : inComp ? '#7cc78e' : '#6b747e';
      // 双联齿轮:两片画在同一轴上,共用一个转角
      drawGearShape(a.x, a.y, sorted[0], angle, fill, stroke);
      if (sorted.length > 1) {
        drawGearShape(a.x, a.y, sorted[1], angle, '#5a5340', '#a89a6a');
      }
      // 转向指示
      if (ratio !== undefined && ratio !== 0) {
        const omega = ratio * crankDir;
        g.fillStyle = '#fff';
        g.font = 'bold 15px sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(omega > 0 ? '↻' : '↺', a.x, a.y - outerOf(sorted[sorted.length - 1]) - 12);
      }
    }

    // 轴心(插轴)
    g.beginPath();
    g.arc(a.x, a.y, 6, 0, Math.PI * 2);
    g.fillStyle = focusAxle === a.id ? '#f0d43c' : '#aab2bb';
    g.fill();
    g.strokeStyle = '#222'; g.lineWidth = 1; g.stroke();

    // 标签
    g.fillStyle = '#c8cfd7';
    g.font = '12px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText(a.label, a.x, a.y + (teeth ? outerOf(Math.max(...teeth)) + 4 : 10));

    // 出口要求
    if (a.role === 'output') {
      const ok = !isLockedHere && ratio !== undefined && ratio !== 0 &&
                 Math.sign(ratio) * crankDir === a.reqDir;
      g.fillStyle = ok ? '#6fdc8c' : '#e0a0a0';
      g.font = 'bold 13px sans-serif';
      g.textBaseline = 'bottom';
      g.fillText(`要求${a.reqDir! > 0 ? '↻' : '↺'} ${ok ? '✓' : '✗'}`, a.x,
                 a.y - (teeth ? outerOf(Math.max(...teeth)) + 26 : 22));
    }
  }

  // 手摇轮摇把
  const crank = puzzle.axles.find(a => a.role === 'crank')!;
  const cr = radiusOf(crank.crankTeeth!);
  const hx = crank.x + cr * 0.62 * Math.cos(crankAngle);
  const hy = crank.y + cr * 0.62 * Math.sin(crankAngle);
  g.beginPath();
  g.arc(hx, hy, 5, 0, Math.PI * 2);
  g.fillStyle = locked ? '#e05050' : '#f0d43c';
  g.fill();

  if (locked) {
    g.fillStyle = 'rgba(224,80,80,0.95)';
    g.font = 'bold 20px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('⚠ 连通组锁死:支路冲突,全部停转', cv.width / 2, 14);
  }
}

// ---------------- 交互 ----------------
function hitAxle(mx: number, my: number): AxleDef | null {
  let best: AxleDef | null = null, bestD = 1e9;
  for (const a of puzzle.axles) {
    const d = Math.hypot(mx - a.x, my - a.y);
    const teeth = teethOf(a.id);
    const hitR = teeth ? outerOf(Math.max(...teeth)) + 4 : 16;
    if (d < hitR && d < bestD) { best = a; bestD = d; }
  }
  return best;
}

function canvasPos(ev: PointerEvent): [number, number] {
  const r = cv.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

cv.addEventListener('pointerdown', ev => {
  const [mx, my] = canvasPos(ev);
  const crank = puzzle.axles.find(a => a.role === 'crank')!;
  // 按住手摇轮 = 拖动摇把
  if (Math.hypot(mx - crank.x, my - crank.y) < outerOf(crank.crankTeeth!) + 6) {
    if (locked) {
      focusAxle = crank.id; updateInfo();
      infoDiv.textContent = '🔒 摇不动:连通组已锁死。\n' + conflictInfo;
      return;
    }
    dragging = true;
    dragPrev = Math.atan2(my - crank.y, mx - crank.x);
    cv.setPointerCapture(ev.pointerId);
    return;
  }
  const a = hitAxle(mx, my);
  if (!a) return;
  focusAxle = a.id;
  const nearPeg = Math.hypot(mx - a.x, my - a.y) < 12;

  if (a.role !== 'crank' && !nearPeg) {
    if (selectedSpec && !mounted.has(a.id)) {
      // 安装
      const left = invLeft.get(selectedSpec)!;
      if (left > 0) {
        mounted.set(a.id, specById.get(selectedSpec)!);
        invLeft.set(selectedSpec, left - 1);
        if (invLeft.get(selectedSpec) === 0) selectedSpec = null;
        refreshInventoryUI();
      }
    } else if (!selectedSpec && mounted.has(a.id)) {
      // 拆下,放回零件盒,随后从当前布局重新判断
      const spec = mounted.get(a.id)!;
      mounted.delete(a.id);
      invLeft.set(spec.id, invLeft.get(spec.id)! + 1);
      refreshInventoryUI();
    }
  }
  rebuild();
});

cv.addEventListener('pointermove', ev => {
  if (!dragging) return;
  const [mx, my] = canvasPos(ev);
  const crank = puzzle.axles.find(a => a.role === 'crank')!;
  const ang = Math.atan2(my - crank.y, mx - crank.x);
  let d = ang - dragPrev;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  crankAngle += d;
  dragPrev = ang;
  updateInfo();
});

cv.addEventListener('pointerup', () => { dragging = false; });

document.getElementById('autoBtn')!.onclick = ev => {
  autoCrank = !autoCrank;
  (ev.target as HTMLButtonElement).classList.toggle('on', autoCrank);
  (ev.target as HTMLButtonElement).textContent = autoCrank ? '停止摇动' : '自动摇动';
};

document.getElementById('dirBtn')!.onclick = ev => {
  crankDir = crankDir === 1 ? -1 : 1;
  (ev.target as HTMLButtonElement).textContent = crankDir === 1 ? '换成反转' : '换成正转';
  updateInfo(); updateBanner();
};

document.getElementById('resetBtn')!.onclick = () => loadPuzzle(puzzle.id);

const sel = document.getElementById('puzzleSel') as HTMLSelectElement;
for (const p of PUZZLES) {
  const opt = document.createElement('option');
  opt.value = p.id; opt.textContent = p.name;
  sel.appendChild(opt);
}
sel.onchange = () => loadPuzzle(sel.value);

function loadPuzzle(id: string): void {
  puzzle = PUZZLES.find(p => p.id === id)!;
  mounted = new Map();
  invLeft = new Map();
  specById = new Map();
  for (const item of puzzle.inventory) {
    invLeft.set(item.spec.id, item.count);
    specById.set(item.spec.id, item.spec);
  }
  selectedSpec = null;
  crankAngle = 0;
  autoCrank = false;
  const autoBtn = document.getElementById('autoBtn') as HTMLButtonElement;
  autoBtn.classList.remove('on'); autoBtn.textContent = '自动摇动';
  focusAxle = (puzzle.axles.find(a => a.role === 'output') || puzzle.axles[0]).id;
  goalDiv.textContent = puzzle.desc;
  refreshInventoryUI();
  rebuild();
}

// ---------------- 主循环 ----------------
let lastT = performance.now();
function tick(now: number): void {
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (autoCrank && !locked && !dragging) {
    crankAngle += crankDir * CRANK_SPEED * dt;
    updateInfo();
  }
  render();
  requestAnimationFrame(tick);
}

loadPuzzle(PUZZLES[0].id);
requestAnimationFrame(tick);
