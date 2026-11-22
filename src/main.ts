import './styles.css';
import {
  World,
  Piece,
  PieceKind,
  DirSet,
  RemovalPreview,
  settle,
} from './engine';
import {
  TEMPLATES,
  PRESETS,
  GRID_W,
  GROUND_Y,
  makePiece,
  loadPreset,
  freshWorld,
  PieceTemplate,
} from './presets';
import { render, cellFromEvent, FallingAnim } from './render';

type Mode = 'place' | 'remove' | 'inspect';

const world: World = freshWorld();
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const panel = document.getElementById('panel')!;
const statusbar = document.getElementById('statusbar')!;

let mode: Mode = 'inspect';
let selectedKind: PieceKind = 'pillar';
let deckLength = 3;
let rotate = false;
let showLoad = true;
let showArrows = true;
let hoverId: string | undefined;
let selectedId: string | undefined;
let preview: RemovalPreview | undefined;
let falling: FallingAnim[] = [];

// ---- 面板内编辑态(选中构件后可改承重方向与上限) ----
let editBearing: DirSet = { north: false, south: false, west: false, east: false };
let editCapacity = 0;

const modeLabels: Record<Mode, string> = {
  place: '放置',
  remove: '拆除',
  inspect: '查看',
};

function currentTemplate(): PieceTemplate {
  return TEMPLATES[selectedKind];
}

function setMode(m: Mode) {
  mode = m;
  if (m !== 'remove') {
    preview = undefined;
    selectedId = undefined;
  }
  if (m !== 'inspect') selectedId = undefined;
  buildPanel();
  draw();
}

function startFalling(pieces: Piece[]) {
  const now = performance.now();
  falling = pieces.map((p) => ({
    piece: p,
    originY: p.cells[0].y,
    startedAt: now,
  }));
  setTimeout(() => {
    falling = [];
    draw();
  }, 950);
}

function refreshStatus() {
  const s = world.settle();
  const aliveN = s.alive.length;
  const fallN = s.fallen.length;
  const overN = s.overloaded.length;
  statusbar.innerHTML =
    `模式 <b class="ok">${modeLabels[mode]}</b> ｜ 站立构件 ${aliveN} ｜ ` +
    `悬空掉落 <b class="${fallN ? 'danger' : 'ok'}">${fallN}</b> ｜ ` +
    `超载失效 <b class="${overN ? 'danger' : 'ok'}">${overN}</b> ｜ ` +
    `可撤销 ${world.canUndo() ? '是' : '否'}`;
}

function draw(now = performance.now()) {
  const s = world.settle();
  render(ctx, {
    pieces: world.pieces,
    settlement: s,
    previewTargetId: preview?.target.id,
    topoAffectedIds: preview ? new Set(preview.topoAffected.map((p) => p.id)) : undefined,
    topoStillStandingIds: preview
      ? new Set(preview.topoStillStanding.map((p) => p.id))
      : undefined,
    simulatedFallenIds: preview ? new Set(preview.simulatedFallen.map((p) => p.id)) : undefined,
    hoverId,
    falling,
    showLoad,
    showArrows,
  }, now);
  refreshStatus();
}

// ---------------- 画布交互 ----------------

canvas.addEventListener('mousemove', (ev) => {
  const { x, y } = cellFromEvent(canvas, ev);
  const p = world.pieceAt(x, y);
  hoverId = p?.id;
  draw();
});

canvas.addEventListener('mouseleave', () => {
  hoverId = undefined;
  draw();
});

canvas.addEventListener('click', (ev) => {
  const { x, y } = cellFromEvent(canvas, ev);
  if (x < 0 || x >= GRID_W || y < 0 || y >= GROUND_Y) return;
  const hit = world.pieceAt(x, y);

  if (mode === 'place') {
    const tpl = currentTemplate();
    const piece = makePiece(tpl, { x, y }, deckLength, rotate);
    if (!world.add(piece)) {
      flashStatus('放置失败: 格子越界或已被占用');
      return;
    }
    selectedId = piece.id;
    draw();
    buildPanel();
    return;
  }

  if (!hit) {
    preview = undefined;
    selectedId = undefined;
    buildPanel();
    draw();
    return;
  }

  if (mode === 'remove') {
    selectedId = hit.id;
    preview = world.preview(hit.id);
    buildPanel();
    draw();
    return;
  }

  // inspect
  selectedId = hit.id;
  editBearing = { ...hit.bearing };
  editCapacity = hit.capacity;
  buildPanel();
  draw();
});

function flashStatus(msg: string) {
  statusbar.textContent = msg;
}

function commitRemoval() {
  if (!preview) return;
  const id = preview.target.id;
  const { removed } = world.commitRemoval(id);
  startFalling(removed);
  preview = undefined;
  selectedId = undefined;
  buildPanel();
  draw();
}

function undo() {
  if (!world.undo()) return;
  preview = undefined;
  selectedId = undefined;
  falling = [];
  buildPanel();
  draw();
}

// ---------------- 面板 ----------------

function el(tag: string, html = '', cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

function buildPanel() {
  panel.innerHTML = '';

  // 预设
  const presetSec = el('div', '', 'section');
  presetSec.appendChild(el('h3', '预设场景(样例自动生成)'));
  const presetRow = el('div', '', 'row');
  for (const ps of PRESETS) {
    const b = el('button', ps.title.replace('预设', '')) as HTMLButtonElement;
    b.onclick = () => {
      loadPreset(world, ps);
      preview = undefined;
      selectedId = undefined;
      falling = [];
      buildPanel();
      draw();
      flashStatus(ps.brief);
    };
    presetRow.appendChild(b);
  }
  presetSec.appendChild(presetRow);
  panel.appendChild(presetSec);

  // 模式
  const modeSec = el('div', '', 'section');
  modeSec.appendChild(el('h3', '操作模式'));
  const modeRow = el('div', '', 'row');
  (['place', 'remove', 'inspect'] as Mode[]).forEach((m) => {
    const b = el('button', modeLabels[m]) as HTMLButtonElement;
    if (mode === m) b.classList.add('active');
    b.onclick = () => setMode(m);
    modeRow.appendChild(b);
  });
  modeSec.appendChild(modeRow);
  modeSec.appendChild(
    el(
      'div',
      '放置: 点空格子放入构件 ｜ 拆除: 点构件先看预览, 再提交 ｜ 查看: 点构件编辑承重方向/上限',
      'muted',
    ),
  );
  panel.appendChild(modeSec);

  // 放置参数
  if (mode === 'place') {
    const placeSec = el('div', '', 'section');
    placeSec.appendChild(el('h3', '构件选择与参数'));
    const kindRow = el('div', '', 'row');
    (Object.keys(TEMPLATES) as PieceKind[]).forEach((k) => {
      const b = el('button', TEMPLATES[k].label) as HTMLButtonElement;
      if (selectedKind === k) b.classList.add('active');
      b.onclick = () => {
        selectedKind = k;
        buildPanel();
      };
      kindRow.appendChild(b);
    });
    placeSec.appendChild(kindRow);
    const tpl = currentTemplate();
    placeSec.appendChild(el('div', tpl.desc, 'muted'));

    const row2 = el('div', '', 'row');
    if (selectedKind === 'deck') {
      row2.appendChild(el('label', '长度', 'field'));
      const len = document.createElement('input');
      len.type = 'number';
      len.min = '2';
      len.max = String(GRID_W);
      len.value = String(deckLength);
      len.oninput = () => {
        deckLength = Math.max(2, Math.min(GRID_W, Number(len.value) || 2));
      };
      row2.appendChild(len);
    }
    const rot = el('button', rotate ? '旋转: 竖直' : '旋转: 水平') as HTMLButtonElement;
    rot.onclick = () => {
      rotate = !rotate;
      buildPanel();
    };
    row2.appendChild(rot);
    placeSec.appendChild(row2);

    const row3 = el('div', '', 'row');
    row3.appendChild(el('label', '自重', 'field'));
    const w = document.createElement('input');
    w.type = 'number';
    w.value = String(tpl.weight);
    w.oninput = () => {
      tpl.weight = Math.max(0, Number(w.value) || 0);
    };
    row3.appendChild(w);
    row3.appendChild(el('label', '承重上限(空=∞)', 'field'));
    const cap = document.createElement('input');
    cap.type = 'number';
    cap.placeholder = '∞';
    cap.value = tpl.capacity === Infinity ? '' : String(tpl.capacity);
    cap.oninput = () => {
      tpl.capacity = cap.value === '' ? Infinity : Math.max(0, Number(cap.value) || 0);
    };
    row3.appendChild(cap);
    placeSec.appendChild(row3);
    placeSec.appendChild(bearingEditor(tpl.bearing, () => buildPanel()));
    panel.appendChild(placeSec);
  }

  // 选中构件信息 / 编辑
  const selected = world.pieces.find((p) => p.id === selectedId);
  if (selected && mode === 'inspect') {
    panel.appendChild(pieceEditor(selected));
  }

  // 拆除预览面板
  if (preview) {
    panel.appendChild(previewSection(preview));
  }

  // 显示开关
  const viewSec = el('div', '', 'section');
  viewSec.appendChild(el('h3', '显示'));
  const viewRow = el('div', '', 'row');
  const bLoad = el('button', showLoad ? '✓ 负载标签' : '负载标签') as HTMLButtonElement;
  bLoad.onclick = () => {
    showLoad = !showLoad;
    buildPanel();
    draw();
  };
  const bArrow = el('button', showArrows ? '✓ 支撑箭头' : '支撑箭头') as HTMLButtonElement;
  bArrow.onclick = () => {
    showArrows = !showArrows;
    buildPanel();
    draw();
  };
  viewRow.append(bLoad, bArrow);
  viewSec.appendChild(viewRow);
  const undoRow = el('div', '', 'row');
  const bUndo = el('button', '↶ 撤销上一步') as HTMLButtonElement;
  bUndo.disabled = !world.canUndo();
  bUndo.onclick = undo;
  const bClear = el('button', '清空场景') as HTMLButtonElement;
  bClear.onclick = () => {
    world.reset([]);
    preview = undefined;
    selectedId = undefined;
    buildPanel();
    draw();
  };
  undoRow.append(bUndo, bClear);
  viewSec.appendChild(undoRow);
  panel.appendChild(viewSec);

  // 规则说明
  const rules = el('div', '', 'section rules');
  rules.appendChild(el('h3', '结算规则'));
  rules.appendChild(
    el(
      'ul',
      `
      <li>接触边: 两个构件的格子共用网格边, 且被支撑方的承重方向包含该方位, 才形成有效支撑。</li>
      <li>接地: 与地面行接触的构件接地; 接地性沿支撑链反向 BFS 传播。</li>
      <li>共同承重: 构件把(自重+入边负载)均分到全部有效出边, 多一条支撑边就多一份份额。</li>
      <li>承重环无地基: 环内互撑但 BFS 到不了地面, 整环判悬空掉落。</li>
      <li>超载: 构件总负载 &gt; 上限即失效移除, 触发级联重算。</li>
      <li>拆除: 先出拓扑预览(不考虑上限), 提交后才按真实上限结算, 全程可撤销。</li>
    `,
    ),
  );
  panel.appendChild(rules);
}

function bearingEditor(bearing: DirSet, onChange: () => void): HTMLElement {
  const wrap = el('div', '', 'checkgrid');
  const items: [keyof DirSet, string][] = [
    ['north', '北(托上)'],
    ['south', '南(被托)'],
    ['west', '西'],
    ['east', '东'],
  ];
  for (const [k, label] of items) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = bearing[k];
    cb.onchange = () => {
      bearing[k] = cb.checked;
      onChange();
    };
    lab.append(cb, document.createTextNode(label));
    wrap.appendChild(lab);
  }
  return wrap;
}

function pieceEditor(piece: Piece): HTMLElement {
  const sec = el('div', '', 'section');
  sec.appendChild(el('h3', `选中: ${piece.name} (${piece.id})`));
  const rt = world.settle().byId.get(piece.id);
  const info = el('div', '', 'piece-info');
  const stateTag = !rt?.grounded
    ? '<span class="tag danger">悬空</span>'
    : rt.overloaded || piece.capacity < rt.totalLoad
      ? '<span class="tag danger">超载</span>'
      : piece.capacity !== Infinity && rt.totalLoad / piece.capacity >= 0.7
        ? '<span class="tag warn">逼近上限</span>'
        : '<span class="tag ok">稳固</span>';
  info.innerHTML =
    `${stateTag} 自重 ${piece.weight} ｜ 当前总负载 ${rt ? rt.totalLoad.toFixed(1) : '—'} ｜ ` +
    `支撑来源 ${rt?.supportFrom.length ?? 0} 条`;
  sec.appendChild(info);

  const row = el('div', '', 'row');
  row.appendChild(el('label', '承重上限', 'field'));
  const cap = document.createElement('input');
  cap.type = 'number';
  cap.placeholder = '∞';
  cap.value = editCapacity === Infinity ? '' : String(editCapacity);
  cap.oninput = () => {
    editCapacity = cap.value === '' ? Infinity : Math.max(0, Number(cap.value) || 0);
    piece.capacity = editCapacity;
    draw();
  };
  row.appendChild(cap);
  sec.appendChild(row);
  sec.appendChild(el('div', '承重方向(改动即时生效):', 'muted'));
  sec.appendChild(
    bearingEditor(editBearing, () => {
      piece.bearing = { ...editBearing };
      draw();
    }),
  );
  return sec;
}

function previewSection(pv: RemovalPreview): HTMLElement {
  const sec = el('div', '', 'section preview-box');
  sec.appendChild(el('h3', `拆除预览: ${pv.target.name}`));
  const standing = pv.topoStillStanding;
  const topoFall = pv.topoAffected.filter((p) => !standing.some((s) => s.id === p.id));
  const lines: string[] = [];
  lines.push(
    `<span class="tag info">拓扑预览</span>受影响 ${pv.topoAffected.length} 件: ` +
      `<span class="ok">仍站立 ${standing.length}</span> ｜ <span class="warn">将悬空 ${topoFall.length}</span>`,
  );
  lines.push(
    `<span class="tag danger">真实结算</span>掉落 ${pv.simulatedFallen.length} 件 ｜ 超载失效 ${pv.simulatedOverloaded.length} 件`,
  );
  if (pv.topoAffected.length !== pv.simulatedFallen.length + pv.simulatedOverloaded.length) {
    lines.push(
      '<span class="warn">⚠ 预览与结算不一致: 存在承重上限导致的级联失效, 提交后实际掉落范围更大。</span>',
    );
  }
  if (pv.simulatedFallen.length === 0 && pv.simulatedOverloaded.length === 0) {
    lines.push('<span class="ok">✓ 拆除后其余构件均可通过剩余支撑链接地。</span>');
  }
  sec.appendChild(el('div', lines.join('<br>')));
  const row = el('div', '', 'row');
  const bCommit = el('button', '确认提交拆除') as HTMLButtonElement;
  bCommit.classList.add('danger');
  bCommit.onclick = commitRemoval;
  const bCancel = el('button', '取消') as HTMLButtonElement;
  bCancel.onclick = () => {
    preview = undefined;
    selectedId = undefined;
    buildPanel();
    draw();
  };
  row.append(bCommit, bCancel);
  sec.appendChild(row);
  return sec;
}

// ---------------- 快捷键 ----------------

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    preview = undefined;
    selectedId = undefined;
    buildPanel();
    draw();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') {
    ev.preventDefault();
    undo();
  } else if (ev.key === 'Enter' && preview) {
    commitRemoval();
  }
});

// 初始载入预设(支持 ?preset=bridge|twin|ring 直达), 让打开即有样例
const presetParam = new URLSearchParams(location.search).get('preset');
const initialPreset = PRESETS.find((p) => p.id === presetParam) ?? PRESETS[0];
loadPreset(world, initialPreset);
buildPanel();
draw();

// 动画心跳: 坠落过程中持续重绘
function tick(now: number) {
  if (falling.length) draw(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// 供测试/控制台手工调用
declare global {
  interface Window {
    buildSandbox: {
      world: World;
      settle: () => ReturnType<typeof settle>;
    };
  }
}
window.buildSandbox = { world, settle: () => settle(world.pieces, GROUND_Y) };
