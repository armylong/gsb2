// 界面:Canvas 渲染 + 交互(摆放/旋转/换色/删除/撤销/回看)
import { Board, Piece, Dir, DX, DY, RED, GREEN, BLUE, MASK_CSS, MASK_NAME, PIECE_NAME, DIR_NAME } from './model.js';
import { simulate, traceReceiver, SimResult, TraceResult } from './sim.js';
import { PRESETS, GRID_W, GRID_H } from './presets.js';

const CELL = 56;
const board = new Board(GRID_W, GRID_H);

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
canvas.width = GRID_W * CELL;
canvas.height = GRID_H * CELL;
const ctx = canvas.getContext('2d')!;

type Tool = { kind: 'select' } | { kind: 'erase' } | { kind: 'place'; piece: Piece };
let tool: Tool = { kind: 'select' };
let selected: string | null = null;
let highlight: TraceResult | null = null;
let sim: SimResult;
const history: string[] = [];

// ---------- 工具栏 ----------
const TOOLS: { id: string; label: string; tool: Tool }[] = [
  { id: 'select', label: '选择', tool: { kind: 'select' } },
  { id: 'emit-r', label: '🔴 红光块', tool: { kind: 'place', piece: { type: 'emitter', rot: Dir.E, color: RED } } },
  { id: 'emit-g', label: '🟢 绿光块', tool: { kind: 'place', piece: { type: 'emitter', rot: Dir.E, color: GREEN } } },
  { id: 'emit-b', label: '🔵 蓝光块', tool: { kind: 'place', piece: { type: 'emitter', rot: Dir.E, color: BLUE } } },
  { id: 'mirror-s', label: '镜面 /', tool: { kind: 'place', piece: { type: 'mirror', rot: 0, color: 0 } } },
  { id: 'mirror-b', label: '镜面 \\', tool: { kind: 'place', piece: { type: 'mirror', rot: 1, color: 0 } } },
  { id: 'split-s', label: '分束 /', tool: { kind: 'place', piece: { type: 'splitter', rot: 0, color: 0 } } },
  { id: 'split-b', label: '分束 \\', tool: { kind: 'place', piece: { type: 'splitter', rot: 1, color: 0 } } },
  { id: 'blocker', label: '挡板', tool: { kind: 'place', piece: { type: 'blocker', rot: 0, color: 0 } } },
  { id: 'receiver', label: '接收板', tool: { kind: 'place', piece: { type: 'receiver', rot: 0, color: RED } } },
  { id: 'erase', label: '橡皮', tool: { kind: 'erase' } },
];

const toolsEl = document.getElementById('tools')!;
for (const t of TOOLS) {
  const btn = document.createElement('button');
  btn.textContent = t.label;
  btn.dataset.tool = t.id;
  btn.addEventListener('click', () => {
    tool = t.tool;
    document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('active', b === btn));
  });
  toolsEl.appendChild(btn);
}
(toolsEl.firstChild as HTMLElement).classList.add('active');

const presetsEl = document.getElementById('presets')!;
PRESETS.forEach((p, i) => {
  const btn = document.createElement('button');
  btn.textContent = p.name;
  btn.addEventListener('click', () => {
    pushHistory();
    p.apply(board);
    selected = null; highlight = null;
    refresh();
  });
  presetsEl.appendChild(btn);
});

// ---------- 状态刷新 ----------
function pushHistory(): void {
  history.push(board.serialize());
  if (history.length > 100) history.shift();
}

function undo(): void {
  const data = history.pop();
  if (data === undefined) return;
  board.restore(data);
  selected = null; highlight = null;
  refresh();
}

function refresh(): void {
  sim = simulate(board);
  render();
  updatePanel();
}

// ---------- 面板 ----------
function recvStatus(ck: string, req: number): { label: string; cls: string } {
  const got = sim.receiverMask.get(ck) ?? 0;
  if (got === req) return { label: '✔ 满足', cls: 'ok' };
  if ((got & ~req) !== 0) return { label: '✘ 多收了颜色', cls: 'extra' };
  if (got === 0) return { label: '✘ 无光照', cls: 'bad' };
  return { label: '✘ 缺颜色', cls: 'bad' };
}

function updatePanel(): void {
  // 出口状态
  const receivers = [...board.pieces.entries()].filter(([, p]) => p.type === 'receiver');
  const allOk = receivers.length > 0 && receivers.every(([ck, p]) => (sim.receiverMask.get(ck) ?? 0) === p.color);
  const exitEl = document.getElementById('exit-status')!;
  exitEl.textContent = allOk ? '🚪 出口已解锁!' : '🔒 出口未解锁';
  exitEl.className = allOk ? 'unlocked' : 'locked';

  // 循环提示
  const loopEl = document.getElementById('loop-info')!;
  if (sim.loopCells.size > 0) {
    loopEl.textContent = `⚠ 检测到封闭反射回路(${sim.loopCells.size} 格,橙色标记),模拟已在 ${sim.steps} 步内收敛`;
    loopEl.style.display = '';
  } else {
    loopEl.style.display = 'none';
  }

  // 接收板列表
  const listEl = document.getElementById('recv-list')!;
  listEl.innerHTML = '';
  for (const [ck, p] of receivers) {
    const got = sim.receiverMask.get(ck) ?? 0;
    const st = recvStatus(ck, p.color);
    const li = document.createElement('li');
    li.innerHTML = `<span class="${st.cls}">${st.label}</span> (${ck}) 要求 <b>${MASK_NAME[p.color]}</b>,实收 <b>${MASK_NAME[got]}</b>`;
    li.addEventListener('click', () => selectCell(ck));
    listEl.appendChild(li);
  }

  // 选中信息
  const selEl = document.getElementById('sel-info')!;
  if (!selected || !board.pieces.get(selected)) {
    selEl.textContent = '未选中棋子';
  } else {
    const p = board.pieces.get(selected)!;
    let extra = '';
    if (p.type === 'emitter') extra = ` 颜色:${MASK_NAME[p.color]} 朝向:${DIR_NAME[p.rot & 3]}`;
    if (p.type === 'mirror' || p.type === 'splitter') extra = ` 方向:${(p.rot & 1) === 0 ? '/' : '\\'}`;
    if (p.type === 'receiver') extra = ` 要求:${MASK_NAME[p.color]}`;
    selEl.textContent = `(${selected}) ${PIECE_NAME[p.type]}${extra}`;
  }
  document.getElementById('undo-info')!.textContent = `可撤销步数:${history.length}`;
}

// ---------- 交互 ----------
function selectCell(ck: string | null): void {
  selected = ck;
  highlight = null;
  if (ck && board.pieces.get(ck)?.type === 'receiver') {
    highlight = traceReceiver(sim, board, ck); // 点击接收板:回看相关光段与来源
  }
  render();
  updatePanel();
}

function mutate(fn: () => void): void {
  pushHistory();
  fn();
  refresh();
}

function rotateSelected(): void {
  if (!selected) return;
  const [x, y] = selected.split(',').map(Number);
  const p = board.get(x, y);
  if (!p) return;
  if (p.type === 'emitter') mutate(() => { p.rot = (p.rot + 1) % 4; });
  else if (p.type === 'mirror' || p.type === 'splitter') mutate(() => { p.rot = (p.rot + 1) % 2; });
}

function colorSelected(): void {
  if (!selected) return;
  const [x, y] = selected.split(',').map(Number);
  const p = board.get(x, y);
  if (!p) return;
  if (p.type === 'emitter') mutate(() => { p.color = p.color === RED ? GREEN : p.color === GREEN ? BLUE : RED; });
  else if (p.type === 'receiver') mutate(() => { p.color = (p.color % 7) + 1; });
}

function deleteSelected(): void {
  if (!selected) return;
  const [x, y] = selected.split(',').map(Number);
  if (!board.get(x, y)) return;
  mutate(() => board.delete(x, y));
  selected = null; highlight = null;
  refresh();
}

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / CELL);
  const y = Math.floor((ev.clientY - rect.top) / CELL);
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return;
  const ck = Board.key(x, y);

  if (tool.kind === 'select') {
    selectCell(board.pieces.has(ck) ? ck : null);
  } else if (tool.kind === 'erase') {
    if (board.pieces.has(ck)) {
      mutate(() => board.delete(x, y));
      if (selected === ck) { selected = null; highlight = null; }
      refresh();
    }
  } else {
    const piece = { ...tool.piece };
    mutate(() => board.set(x, y, piece));
    selectCell(ck);
  }
});

document.getElementById('btn-rotate')!.addEventListener('click', rotateSelected);
document.getElementById('btn-color')!.addEventListener('click', colorSelected);
document.getElementById('btn-delete')!.addEventListener('click', deleteSelected);
document.getElementById('btn-undo')!.addEventListener('click', undo);

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'r' || ev.key === 'R') rotateSelected();
  else if (ev.key === 'c' || ev.key === 'C') colorSelected();
  else if (ev.key === 'Delete' || ev.key === 'Backspace') deleteSelected();
  else if (ev.key === 'Escape') selectCell(null);
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
});

// ---------- 渲染 ----------
const BIT_COLORS = [MASK_CSS[RED], MASK_CSS[GREEN], MASK_CSS[BLUE]];

function render(): void {
  ctx.fillStyle = '#16181d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 网格
  ctx.strokeStyle = '#2a2e36';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_W; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= GRID_H; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(canvas.width, y * CELL); ctx.stroke();
  }

  // 回路格子标记
  ctx.strokeStyle = 'rgba(255,150,40,0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  for (const ck of sim.loopCells) {
    const [x, y] = ck.split(',').map(Number);
    ctx.strokeRect(x * CELL + 3, y * CELL + 3, CELL - 6, CELL - 6);
  }
  ctx.setLineDash([]);

  // 光段:每条组成颜色各画一条细线,叠加关系一目了然
  const half = CELL / 2 - 3;
  for (const [seg, mask] of sim.segMask) {
    const d = seg & 3, cell = seg >> 2;
    const x = cell % GRID_W, y = (cell / GRID_W) | 0;
    const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
    const dx = DX[d], dy = DY[d];
    const px = -dy, py = dx; // 垂直方向
    const base = d === Dir.N ? -5 : d === Dir.S ? 5 : d === Dir.E ? 5 : -5;
    const bits = [RED, GREEN, BLUE].filter(b => mask & b);
    const inLoop = sim.loopSegs.has(seg);
    const dimmed = highlight !== null && !highlight.segs.has(seg);
    const lit = highlight !== null && highlight.segs.has(seg);

    if (inLoop) { // 回路光段:橙色光晕
      ctx.globalAlpha = dimmed ? 0.1 : 0.55;
      ctx.strokeStyle = '#ff9a28';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(cx - dx * half + px * base, cy - dy * half + py * base);
      ctx.lineTo(cx + dx * half + px * base, cy + dy * half + py * base);
      ctx.stroke();
    }
    bits.forEach((bit, i) => {
      const off = base + (i - (bits.length - 1) / 2) * 3.5;
      ctx.globalAlpha = dimmed ? 0.12 : 1;
      ctx.strokeStyle = BIT_COLORS[[RED, GREEN, BLUE].indexOf(bit)];
      ctx.lineWidth = lit ? 4 : 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - dx * half + px * off, cy - dy * half + py * off);
      ctx.lineTo(cx + dx * half + px * off, cy + dy * half + py * off);
      ctx.stroke();
    });
  }
  ctx.globalAlpha = 1;

  // 棋子
  for (const [ck, p] of board.pieces) {
    const [x, y] = ck.split(',').map(Number);
    drawPiece(x, y, p, ck);
  }

  // 选中框
  if (selected) {
    const [x, y] = selected.split(',').map(Number);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x * CELL + 1.5, y * CELL + 1.5, CELL - 3, CELL - 3);
  }
}

function drawPiece(x: number, y: number, p: Piece, ck: string): void {
  const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
  const isSource = highlight?.sources.has(ck) ?? false;

  switch (p.type) {
    case 'emitter': {
      if (isSource) { // 回看来源:白色光环
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = MASK_CSS[p.color];
      ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0008'; ctx.lineWidth = 2; ctx.stroke();
      // 朝向箭头
      const d = p.rot & 3, dx = DX[d], dy = DY[d];
      ctx.fillStyle = '#16181d';
      ctx.beginPath();
      ctx.moveTo(cx + dx * 9, cy + dy * 9);
      ctx.lineTo(cx - dy * 5, cy + dx * 5);
      ctx.lineTo(cx + dy * 5, cy - dx * 5);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'mirror':
    case 'splitter': {
      const slash = (p.rot & 1) === 0; // '/'
      const x1 = slash ? x * CELL + 8 : x * CELL + CELL - 8;
      const y1 = slash ? y * CELL + CELL - 8 : y * CELL + 8;
      const x2 = slash ? x * CELL + CELL - 8 : x * CELL + 8;
      const y2 = slash ? y * CELL + 8 : y * CELL + CELL - 8;
      ctx.lineCap = 'round';
      if (p.type === 'splitter') { // 半透镜:浅色主线上叠虚线
        ctx.strokeStyle = '#8fd3ff';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.strokeStyle = '#ffffffaa';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = '#cfd8dc';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      break;
    }
    case 'blocker': {
      ctx.fillStyle = '#33363d';
      ctx.fillRect(x * CELL + 8, y * CELL + 8, CELL - 16, CELL - 16);
      ctx.strokeStyle = '#666c76';
      ctx.lineWidth = 2;
      ctx.strokeRect(x * CELL + 8, y * CELL + 8, CELL - 16, CELL - 16);
      ctx.beginPath();
      ctx.moveTo(x * CELL + 14, y * CELL + 14); ctx.lineTo(x * CELL + CELL - 14, y * CELL + CELL - 14);
      ctx.moveTo(x * CELL + CELL - 14, y * CELL + 14); ctx.lineTo(x * CELL + 14, y * CELL + CELL - 14);
      ctx.stroke();
      break;
    }
    case 'receiver': {
      const st = recvStatus(ck, p.color);
      const border = st.cls === 'ok' ? '#4ade60' : st.cls === 'extra' ? '#ff9040' : '#8a8f98';
      ctx.fillStyle = '#20242b';
      ctx.strokeStyle = border;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x * CELL + 7, y * CELL + 7, CELL - 14, CELL - 14, 6);
      ctx.fill(); ctx.stroke();
      // 要求颜色小圆点
      const bits = [RED, GREEN, BLUE].filter(b => p.color & b);
      bits.forEach((bit, i) => {
        ctx.fillStyle = BIT_COLORS[[RED, GREEN, BLUE].indexOf(bit)];
        ctx.beginPath();
        ctx.arc(cx + (i - (bits.length - 1) / 2) * 12, cy, 5, 0, Math.PI * 2);
        ctx.fill();
      });
      break;
    }
  }
}

// ---------- 启动 ----------
presetBoot();
function presetBoot(): void {
  PRESETS[0].apply(board);
  refresh();
}
