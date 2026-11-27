import { level, parades, solutionA, solutionB } from './data.js';
import { Game } from './game.js';
import { drawScene } from './render.js';
import { checkSight, cloneLayout } from './sim.js';
import { Layout } from './model.js';

const canvas = document.getElementById('cv') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const side = document.getElementById('side')!;

let paradeIdx = 0;
let game = new Game(level, parades[paradeIdx]);

const solutions: Layout[] = [solutionA, solutionB];

function displayedLayout(): Layout {
  return game.phase === 'edit' ? game.staged : game.committed;
}

// ---------- 画布交互 ----------
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const layout = displayedLayout();
  const chair = layout.chairs.find(c => {
    const h = level.holes.find(h => h.id === c.holeId)!;
    return Math.hypot(h.pos.x - x, h.pos.y - y) <= 18;
  });
  if (chair) {
    if (game.phase === 'edit' && game.selectedChair && game.selectedChair !== chair.id) {
      game.stageSwapViewers(game.selectedChair, chair.id); // 换人
      game.selectedChair = null;
    } else {
      game.selectedChair = game.selectedChair === chair.id ? null : chair.id;
    }
    if (chair.viewerId) game.inspectedViewer = chair.viewerId;
    renderUI();
    return;
  }
  const hole = level.holes.find(h => Math.hypot(h.pos.x - x, h.pos.y - y) <= 16);
  if (hole && game.phase === 'edit' && game.selectedChair) {
    game.stageMove(game.selectedChair, hole.id);
    renderUI();
    return;
  }
  game.selectedChair = null;
  renderUI();
});

// ---------- 侧栏 ----------
function contractText(vid: string): string {
  const v = level.viewers.find(v => v.id === vid)!;
  const boat = game.parade.boats.find(b => b.id === v.contract.boatId)!;
  return v.contract.kind === 'full'
    ? `整场看「${boat.name}」≥${(v.contract.minRatio * 100).toFixed(0)}%`
    : `关键时刻看「${boat.name}」`;
}

function fmt(g: number): string {
  return `${Math.floor(g / 60)}:${(g % 60).toFixed(1).padStart(4, '0')}`;
}

function renderUI(): void {
  const cs = game.committedSim();
  const ss = game.stagedSim();
  const inEdit = game.phase === 'edit';
  const stagedDirty = game.stagedMoveCount() > 0 ||
    JSON.stringify(game.staged) !== JSON.stringify(game.committed);
  const phaseText = { edit: '布置中(场次间)', playing: game.paused ? '演出中(已暂停)' : '演出中', done: '整场结束' }[game.phase];

  const viewerRows = level.viewers.map(v => {
    const sres = ss.viewers.find(r => r.viewerId === v.id)!;
    const cres = cs.viewers.find(r => r.viewerId === v.id)!;
    const mark = (ok: boolean) => ok ? '<b class="ok">✓</b>' : '<b class="bad">✗</b>';
    const changed = sres.ok !== cres.ok;
    return `<div class="vrow ${game.inspectedViewer === v.id ? 'sel' : ''}" data-action="inspect" data-id="${v.id}">
      ${mark(inEdit && stagedDirty ? sres.ok : cres.ok)} ${v.name}
      <span class="dim">眼高${v.eyeHeight}m 朝向±${(v.fovHalf * 180 / Math.PI).toFixed(0)}°</span>
      <div class="dim small">${contractText(v.id)}${changed ? (sres.ok ? ' <span class="ok">→ 预计达标</span>' : ' <span class="bad">→ 预计失败</span>') : ''}</div>
    </div>`;
  }).join('');

  let inspectHtml = '';
  if (game.inspectedViewer) {
    const v = level.viewers.find(x => x.id === game.inspectedViewer)!;
    const layout = displayedLayout();
    const chair = layout.chairs.find(c => c.viewerId === v.id);
    if (chair) {
      const rows = game.parade.boats.map(b => {
        const s = checkSight(level, layout, game.round, game.parade, v, chair, b.id, game.phase === 'edit' ? 0 : game.t);
        if (!s.boatActive) return `<div class="dim">${b.name}:已离场/未入场</div>`;
        if (s.visible) return `<div class="ok">${b.name}:看得见</div>`;
        const why = !s.inFov ? '转出可接受朝向' : `被 ${s.blockers.map(x => x.label).join('、')} 挡住`;
        return `<div class="bad">${b.name}:看不见 — ${why}</div>`;
      }).join('');
      inspectHtml = `<h3>观察:${v.name} @ ${game.round.name} t=${(game.phase === 'edit' ? 0 : game.t).toFixed(1)}s</h3>${rows}
        <div class="dim small">擦边规则:视线距遮挡物边缘 ${2}px 内一律算看得见(预览与结算同一判定)</div>`;
    }
  }

  const events = cs.events.map(ev => {
    const v = level.viewers.find(x => x.id === ev.viewerId)!;
    const boat = game.parade.boats.find(b => b.id === ev.boatId)!;
    const past = game.phase !== 'edit' && ev.g <= game.globalT + 1e-9;
    return `<div class="ev ${ev.kind} ${past ? 'past' : ''}" data-action="jump" data-g="${ev.g}">
      [${fmt(ev.g)}] ${v.name} ${ev.kind === 'lost' ? '看不见' : '重新看见'} ${boat.name.split('(')[0]} <span class="dim">${ev.reason}</span>
    </div>`;
  }).join('');

  const settle = cs.viewers.map(r => {
    const v = level.viewers.find(x => x.id === r.viewerId)!;
    const jump = r.firstFailG !== null ? `data-action="jump" data-g="${r.firstFailG}" title="点击跳回失去视野的一刻"` : '';
    return `<div class="ev ${r.ok ? 'gained' : 'lost'}" ${jump}>
      ${r.ok ? '✓' : '✗'} ${v.name} <span class="dim">${r.detail}</span>${r.firstFailG !== null ? ' ⏪' : ''}
    </div>`;
  }).join('');

  const selChair = game.selectedChair ? game.staged.chairs.find(c => c.id === game.selectedChair) : null;

  side.innerHTML = `
    <h2>灯船巡游 · 岸边座位</h2>
    <div class="row">
      ${parades.map((p, i) => `<button data-action="parade" data-i="${i}" class="${i === paradeIdx ? 'on' : ''}">${p.name}</button>`).join('')}
    </div>
    <div class="row dim">${phaseText} · ${game.round.name} · 剩余移动 ${game.movesLeft} 次${stagedDirty && inEdit ? ` · 已暂存 ${game.stagedMoveCount()} 次` : ''}</div>
    ${game.message ? `<div class="msg">${game.message}</div>` : ''}
    <div class="row">
      <button data-action="apply" ${inEdit ? '' : 'disabled'}>应用并开演</button>
      <button data-action="discard" ${inEdit && stagedDirty ? '' : 'disabled'}>放弃暂存</button>
      <button data-action="undo">撤销</button>
    </div>
    <div class="row">
      <button data-action="playpause" ${game.phase === 'playing' ? '' : 'disabled'}>${game.paused ? '继续' : '暂停'}</button>
      <button data-action="speed">速度 x${game.speed}</button>
      <button data-action="replay">从头演出</button>
      <button data-action="reset">重置布局</button>
    </div>
    <div class="row">
      <button data-action="solution" ${inEdit ? '' : 'disabled'}>载入通关布置(暂存)</button>
      ${selChair ? `<button data-action="rotl">⟲ 转椅</button><button data-action="rotr">⟳ 转椅</button>` : '<span class="dim">点选椅子可旋转/搬动;点另一把椅子换人</span>'}
    </div>
    <div class="row"><input type="range" id="tl" min="0" max="${game.totalDuration}" step="0.1" value="${game.globalT}"></div>
    <h3>观众(点击观察)</h3>${viewerRows}
    ${inspectHtml}
    <h3>结算(按已生效布置)</h3>${settle}
    <h3>演出记录</h3><div class="log">${events || '<span class="dim">暂无</span>'}</div>
  `;
}

side.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!el) return;
  const a = el.dataset.action!;
  switch (a) {
    case 'parade': {
      paradeIdx = Number(el.dataset.i);
      game = new Game(level, parades[paradeIdx]);
      break;
    }
    case 'apply': game.applyAndPlay(); break;
    case 'discard': game.discardStaged(); break;
    case 'undo': game.undo(); break;
    case 'playpause': game.paused = !game.paused; break;
    case 'speed': game.speed = game.speed >= 4 ? 1 : game.speed * 2; break;
    case 'replay': game.replayAll(); break;
    case 'reset': game.resetLayout(); break;
    case 'solution': {
      game.staged = cloneLayout(solutions[paradeIdx]);
      game.message = '通关布置已放入暂存,应用后开演';
      break;
    }
    case 'rotl': if (game.selectedChair) game.rotate(game.selectedChair, -1); break;
    case 'rotr': if (game.selectedChair) game.rotate(game.selectedChair, 1); break;
    case 'inspect': game.inspectedViewer = el.dataset.id!; break;
    case 'jump': game.jumpTo(Number(el.dataset.g)); break;
  }
  renderUI();
});

side.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === 'tl') { game.jumpTo(Number(el.value)); renderUI(); }
});

// ---------- 主循环 ----------
let last = performance.now();
let uiTick = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  drawScene(ctx, level, game.parade, game);
  uiTick += dt;
  if (uiTick > 0.25) { uiTick = 0; renderUI(); } // 演出中刷新时间/日志高亮
  requestAnimationFrame(frame);
}
renderUI();
requestAnimationFrame(frame);
