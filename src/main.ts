import './styles.css';
import {
  animalById,
  display,
  locationById,
  nameOf,
  type ExplainedCandidate,
} from './engine/engine';
import type { Board, EventType, Puzzle, State } from './engine/types';
import { puzzles } from './game/puzzles';
import {
  buildDemoScript,
  commitCandidate,
  currentCandidates,
  eventAtStep,
  initialState,
  backtrackToBranch,
  resetAttempt,
  roundOfStep,
  undoOne,
  userChain,
  verifyForward,
  type DemoStep,
  type GameState,
} from './game/state';
import { drawScene } from './render/board';
import {
  boardViewport,
  makeTween,
  resolvePositions,
  statePositions,
  type MotionState,
} from './render/motion';
import { anchorPx } from './render/viewport';
import { PALETTE } from './render/board';
import { clamp, lerp, withAlpha } from './render/util';

/* ------------------------------------------------------------------ */
/* DOM 引用                                                           */
/* ------------------------------------------------------------------ */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $<HTMLCanvasElement>('#board');
const ctx = canvas.getContext('2d')!;
const panel = $<HTMLElement>('#panel');
const levelNav = $<HTMLElement>('#level-nav');
const caption = $<HTMLElement>('#board-caption');

const statusLeft = $<HTMLElement>('#status-left');
const statusRight = $<HTMLElement>('#status-right');
const toast = $<HTMLElement>('#toast');

/* ------------------------------------------------------------------ */
/* 全局状态                                                           */
/* ------------------------------------------------------------------ */
interface App {
  puzzle: Puzzle;
  game: GameState;
  motion: MotionState;
  tweenToken: number;
  /** 教学盘：已经演示到第几步，-1 = 未开始。 */
  demoStep: number;
  demoTimer: number | null;
  demoPlaying: boolean;
  /** 通关后回放的进度（-1 = 不回放）。 */
  replayAt: number;
  replayTimer: number | null;
  hoverLoc: string | null;
  hoverCand: number | null;
  solvedIds: Set<string>;
}

const app: App = {
  puzzle: puzzles[0]!,
  game: initialState(puzzles[0]!),
  motion: { positions: {}, tweens: {} },
  tweenToken: 0,
  demoStep: -1,
  demoTimer: null,
  demoPlaying: false,
  replayAt: -1,
  replayTimer: null,
  hoverLoc: null,
  hoverCand: null,
  solvedIds: new Set(),
};

const demoScriptCache = new Map<string, DemoStep[]>();

/* ------------------------------------------------------------------ */
/* 画布尺寸                                                           */
/* ------------------------------------------------------------------ */
let cssW = 0;
let cssH = 0;
function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  cssW = rect.width;
  cssH = rect.height;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 重新算一遍动物位置（视口变了）
  const v = boardViewport(app.puzzle.board, cssW, cssH);
  const pos = statePositions(app.puzzle.board, viewState(), v);
  app.motion = { positions: pos, tweens: {} };
}

/** 悬停候选时，把地图临时切到那一步的前驱，用来「预览可能的前一步」。 */
function previewState(): State | null {
  if (app.puzzle.mode === 'tutorial' || app.replayAt >= 0 || app.game.phase === 'solved') return null;
  if (app.hoverCand === null) return null;
  const cands = currentCandidates(app.game);
  const c = cands[app.hoverCand];
  return c ? c.prev : null;
}

function viewState(): State {
  if (app.puzzle.mode === 'tutorial') return demoState();
  if (app.replayAt >= 0) return replayStateAt(app.replayAt);
  return previewState() ?? app.game.state;
}

function demoState(): State {
  const script = demoScript();
  if (app.demoStep < 0) return app.puzzle.startState ?? app.puzzle.finalState;
  const step = script[app.demoStep];
  return step ? step.stateAfter : app.puzzle.startState ?? app.puzzle.finalState;
}

function demoScript(): DemoStep[] {
  const cached = demoScriptCache.get(app.puzzle.id);
  if (cached) return cached;
  const script = buildDemoScript(app.puzzle);
  demoScriptCache.set(app.puzzle.id, script);
  return script;
}

/** 通关回放：把用户的正向链按回合拆开，0 = 起点，n = 终态。 */
function replayStateAt(index: number): State {
  const start = app.game.attempt.state;
  const moves = userChain(app.game);
  let s = start;
  for (let i = 0; i < index && i < moves.length; i++) {
    const m = moves[i]!;
    s = { ...s, [m.actor]: m.to };
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 开始 / 切换关卡                                                    */
/* ------------------------------------------------------------------ */
function loadPuzzle(p: Puzzle) {
  stopDemo();
  stopReplay();
  app.puzzle = p;
  app.game = initialState(p);
  app.demoStep = -1;
  app.replayAt = -1;
  app.hoverCand = null;
  app.motion = { positions: {}, tweens: {} };
  const v = boardViewport(p.board, cssW || 800, cssH || 600);
  app.motion.positions = statePositions(p.board, viewState(), v);
  renderNav();
  renderPanel();
  renderCaption();
  renderStatus();
}

/* ------------------------------------------------------------------ */
/* 导航                                                               */
/* ------------------------------------------------------------------ */
function renderNav() {
  levelNav.innerHTML = '';
  puzzles.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'level-btn';
    btn.setAttribute('aria-current', String(p.id === app.puzzle.id));
    const solved = app.solvedIds.has(p.id);
    btn.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span>${p.title.split(' · ')[0]}</span>${solved ? '<span class="tick">✓</span>' : ''}`;
    btn.addEventListener('click', () => {
      if (p.id !== app.puzzle.id) loadPuzzle(p);
    });
    levelNav.appendChild(btn);
  });
}

/* ------------------------------------------------------------------ */
/* 面板渲染                                                           */
/* ------------------------------------------------------------------ */
function renderPanel() {
  panel.innerHTML = '';
  if (app.puzzle.mode === 'tutorial') renderTutorialPanel();
  else renderReversePanel();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderTutorialPanel() {
  const p = app.puzzle;
  const script = demoScript();

  panel.append(el('h1', undefined, p.title));
  panel.append(el('p', 'sub', p.subtitle));
  panel.append(el('div', 'divider'));

  const intro = el('p', 'intro', p.intro);
  panel.append(intro);

  panel.append(el('h2', undefined, '规则卡'));
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="row"><span class="swatch island"></span><div><b>浮岛</b>：每座岛只有一条固定方向的下游水道；不停在岛上另一只动物。同一地点至多一只。</div></div>
    <div class="row"><span class="swatch channel"></span><div><b>单向水道</b>：箭头指向下游，只能顺着游，不能倒着走。</div></div>
    <div class="row"><span class="swatch lawn"></span><div><b>草坪</b>：没有出口。停上去就结束，不能再动。</div></div>
    <div class="row"><span class="swatch retreat"></span><div><b>退路</b>：下游被占时，只能原地不动，或退到岛边这块空草坪。</div></div>
  `;
  panel.append(legend);

  panel.append(el('h2', undefined, '正向演示'));
  const rail = el('div', 'sol-path');
  script.forEach((s, i) => {
    const done = i <= app.demoStep;
    const row = el('div', 'sol-step');
    const marker = el('div', 'marker', String(i + 1));
    if (app.demoStep === i) marker.style.borderColor = PALETTE.gold;
    const txt = el('div', 'txt');
    const a = animalById(p.board, s.actor);
    txt.innerHTML =
      `<b>#${a.number} ${a.name}</b> ${nameOf(p.board, s.from)} → ${nameOf(p.board, s.to)}` +
      `<span class="tag ${s.kind}">${s.kind === 'swim' ? '游' : s.kind === 'grass' ? '退草' : '原地'}</span>` +
      `<span class="tag ${s.event === 'island' ? 'island' : s.event === 'lawn' ? 'lawn' : 'wait'}">${eventCn(s.event)}</span>` +
      `<br/>${s.note}`;
    if (!done) {
      txt.style.opacity = '0.45';
    }
    row.append(marker, txt);
    rail.append(row);
  });
  panel.append(rail);

  const row = el('div', 'btn-row');
  const prev = el('button', 'btn ghost small', '◀ 上一步') as HTMLButtonElement;
  prev.disabled = app.demoStep < 0;
  prev.addEventListener('click', () => stepDemo(-1));
  const next = el('button', 'btn primary small', '下一步 ▶') as HTMLButtonElement;
  next.disabled = app.demoStep >= script.length - 1;
  next.addEventListener('click', () => stepDemo(1));
  row.append(prev, next);
  panel.append(row);

  const row2 = el('div', 'btn-row');
  const play = el('button', 'btn small', app.demoPlaying ? '暂停演示' : '自动演示') as HTMLButtonElement;
  play.addEventListener('click', () => toggleDemo());
  const reset = el('button', 'btn ghost small', '回到清晨') as HTMLButtonElement;
  reset.disabled = app.demoStep < 0;
  reset.addEventListener('click', () => {
    stopDemo();
    app.demoStep = -1;
    syncDemoState();
    renderPanel();
    renderCaption();
    renderStatus();
  });
  row2.append(play, reset);
  panel.append(row2);
}

function renderReversePanel() {
  const p = app.puzzle;
  const g = app.game;

  panel.append(el('h1', undefined, p.title));
  panel.append(el('p', 'sub', p.subtitle));
  panel.append(el('div', 'divider'));
  panel.append(el('p', 'intro', p.intro));

  if (p.clue) {
    const clue = el('div', 'clue-card');
    clue.innerHTML = `<span class="label">早晨线索</span>${p.clue.text}`;
    panel.append(clue);
  }

  // 事件轨道
  panel.append(el('h2', undefined, '回合记录'));
  const strip = el('div', 'event-strip');
  p.events.forEach((ev, i) => {
    const step = p.events.length - 1 - i;
    const done = g.attempt.chosen.some((c) => c.step === step);
    const active = !g.attempt.dead && g.attempt.nextStep === step && g.phase === 'solve';
    const chip = el('div', 'event-chip');
    if (done) chip.classList.add('done');
    if (active) chip.classList.add('active');
    const who = g.attempt.chosen.find((c) => c.step === step);
    chip.innerHTML =
      `<span class="r">第 ${i + 1} 回合</span>` +
      `<span class="e">${eventCn(ev)}</span>` +
      `<span class="who">${who ? `#${animalById(p.board, who.actor).number}` : ''}</span>`;
    strip.append(chip);
  });
  panel.append(strip);

  if (g.phase === 'solved') {
    renderSolvedPanel();
  } else if (g.attempt.dead) {
    renderDeadPanel();
  } else {
    renderCandidatePanel();
  }

  panel.append(el('div', 'divider'));
  const undoRow = el('div', 'btn-row');
  const undo = el('button', 'btn small', '↶ 撤销一步') as HTMLButtonElement;
  undo.disabled = g.undo.length === 0;
  undo.addEventListener('click', () => {
    stopReplay();
    app.game = undoOne(app.game);
    app.hoverCand = null;
    renderAll();
  });
  const reset = el('button', 'btn ghost small', '回到终态') as HTMLButtonElement;
  reset.disabled = g.attempt.chosen.length === 0 && !g.attempt.dead;
  reset.addEventListener('click', () => {
    stopReplay();
    app.game = resetAttempt(app.game);
    app.hoverCand = null;
    renderAll();
  });
  undoRow.append(undo, reset);
  panel.append(undoRow);
}

function renderCandidatePanel() {
  const p = app.puzzle;
  const g = app.game;
  const step = g.attempt.nextStep;
  const ev = eventAtStep(p, step);
  const cands = currentCandidates(g);

  panel.append(el('h2', undefined, `回推第 ${roundOfStep(p, step)} 回合 · ${eventLongCn(ev)}`));

  if (cands.length === 0) {
    // 走到这里说明这条解释在更早的回合被记录排除了：明确标为死路，
    // 并就地给出「退回分叉」的按钮，而不是让人自己去找撤销。
    const banner = el('div', 'solved-banner dead-banner');
    const title = el('div', 'title', '这里走不通');
    banner.append(title);
    banner.append(
      el(
        'div',
        'msg',
        `第 ${roundOfStep(p, step)} 回合是「${eventLongCn(ev)}」，可当前盘上没有任何一只动物` +
          `能按正向规则走过来（出口空着却要退草、或该退草时出口却空着）。` +
          `说明刚才那条解释已经被这一步的记录排除了。`,
      ),
    );
    const back = el('button', 'btn small', '↶ 退回上一个分叉') as HTMLButtonElement;
    back.addEventListener('click', () => {
      stopReplay();
      app.game = backtrackToBranch(app.game);
      app.hoverCand = null;
      renderAll();
      showToast('退回到分叉处，换另一条解释。', '');
    });
    banner.append(back);
    panel.append(banner);
  } else {
    // 找出「同动物同目标、直游与退草」的对照对，给并排视图
    panel.append(el('p', 'sub', '每个候选都已经被正向规则验过一遍；能走回当前盘的才会出现在这里。'));

    const list = el('div', 'cand-list');
    cands.forEach((c, i) => {
      const btn = el('button', 'cand') as HTMLButtonElement;
      if (app.hoverCand === i) btn.classList.add('sel');
      btn.addEventListener('mouseenter', () => {
        app.hoverCand = i;
        // 预览目标：游/退草看目的地，原地看原地
        app.hoverLoc = c.move.to;
        // 只切换选中态，避免整块面板重绘导致 hover 抖动
        list.querySelectorAll('.cand').forEach((n) => n.classList.remove('sel'));
        btn.classList.add('sel');
        renderCaption();
      });
      btn.addEventListener('mouseleave', () => {
        if (app.hoverCand === i) {
          app.hoverCand = null;
          app.hoverLoc = null;
          btn.classList.remove('sel');
          renderCaption();
        }
      });
      btn.addEventListener('click', () => {
        acceptCandidate(c);
      });
      const badgeKind = c.move.kind;
      const badge = el('span', `badge ${badgeKind}`, badgeKind === 'swim' ? '游' : badgeKind === 'grass' ? '草' : '等');
      const body = el('div', 'body');
      const line1 = el('div', 'line1');
      const a = animalById(p.board, c.actor);
      line1.append(el('span', 'actor', `#${a.number} ${a.name}`));
      line1.append(el('span', 'when', `${nameOf(p.board, c.move.from)} → ${nameOf(p.board, c.move.to)}`));
      body.append(line1);
      body.append(el('div', 'note', c.move.note));
      const occ =
        c.move.blockerId
          ? `当时 ${nameOf(p.board, p.board.outlets[c.move.from] ?? '')} 由 #${animalById(p.board, c.move.blockerId).number} 占着`
          : `当时 ${nameOf(p.board, c.move.from)} 的下游空着`;
      body.append(el('div', 'when', occ));
      btn.append(badge, body);
      list.append(btn);
    });
    panel.append(list);
  }

  // 分叉并排视图
  const dual = findDual(cands);
  if (dual) renderCompare(dual);
}

function renderCompare(dual: { swim: ExplainedCandidate; grass: ExplainedCandidate; dest: string; actor: string }) {
  const p = app.puzzle;
  panel.append(el('h2', undefined, '并排看两种解释'));
  const wrap = el('div', 'compare');
  const mk = (c: ExplainedCandidate, kindLabel: string, kind: 'swim' | 'grass') => {
    const card = el('div', 'cmp-card');
    const head = el('div', 'head');
    head.append(el('span', `tag ${kind}`, kindLabel));
    head.append(el('span', undefined, `${nameOf(p.board, c.move.from)} → ${nameOf(p.board, dual.dest)}`));
    card.append(head);
    const occ = el('div', 'occ');
    const blocker = c.move.blockerId ? animalById(p.board, c.move.blockerId) : null;
    const outlet = c.move.blockerId ? p.board.outlets[c.move.from] ?? '' : '';
    if (kind === 'swim') {
      occ.innerHTML =
        `这条说：下水道尽头当时是空的，` +
        `<b>${nameOf(p.board, c.move.from)}</b> 顺着水道游进了 <b class="who">${nameOf(p.board, dual.dest)}</b>。`;
    } else {
      occ.innerHTML =
        `这条说：当时 <b class="hit">${nameOf(p.board, outlet)}</b> 被 ` +
        `<b class="who">#${blocker?.number} ${blocker?.name}</b> 占着，` +
        `<b>${nameOf(p.board, c.move.from)}</b> 游不过去，退到了旁边的草坪。`;
    }
    card.append(occ);
    card.append(el('div', 'occ', `两边的前一步：${stateCn(p.board, c.prev)}`));

    // 区分点：这一步的记录都是「草坪」，真正不同在「当时出口有没有人」。
    const note =
      kind === 'swim'
        ? '占位要求：前一步，出口空着。'
        : `占位要求：前一步，出口由 #${blocker?.number ?? '?'} 占着。`;
    const badge = el('div', 'verdict diff');
    badge.textContent = note;
    card.append(badge);

    const pick = el('button', 'btn small', '选这条') as HTMLButtonElement;
    pick.addEventListener('click', () => acceptCandidate(c));
    card.append(pick);
    return card;
  };

  wrap.append(mk(dual.swim, '直游', 'swim'), mk(dual.grass, '退草', 'grass'));
  panel.append(wrap);
  panel.append(
    el(
      'p',
      'sub',
      `同一个终态位置，${display(p.board, dual.actor)} 有两种说得通的来路。` +
        `两边都会先过正向规则，区别在「当时的占位」：直游要求下游当时空着，` +
        `退草要求下游当时被别人占着。挑一条，再往回推，让更早的回合记录决定谁对。`,
    ),
  );
}

function renderDeadPanel() {
  const g = app.game;
  const banner = el('div', 'solved-banner');
  banner.style.background = 'linear-gradient(135deg, rgba(217,122,99,0.16), rgba(95,195,182,0.04))';
  banner.style.borderColor = 'rgba(217,122,99,0.42)';
  const title = el('div', 'title', '这条推不通');
  title.style.color = 'var(--red)';
  banner.append(title);
  banner.append(el('div', 'msg', g.attempt.dead ?? ''));
  const back = el('button', 'btn small', '↶ 撤销到分叉处') as HTMLButtonElement;
  back.addEventListener('click', () => {
    app.game = undoOne(app.game);
    app.hoverCand = null;
    renderAll();
  });
  banner.append(back);
  panel.append(banner);
  // 仍然把已选的链展示出来
  renderChainSummary();
}

function renderSolvedPanel() {
  const p = app.puzzle;
  const g = app.game;
  const banner = el('div', 'solved-banner');
  const title = el('div', 'title', '✓ 清晨盘成立');
  banner.append(title);
  banner.append(el('div', 'msg', p.coda));
  const ok = verifyForward(p, g.attempt);
  banner.append(
    el('div', 'msg', ok ? '正向回放：起点 → 每一步 → 终态，事件顺序完全对上。' : '回放核对未通过。'),
  );
  panel.append(banner);

  renderChainSummary();

  panel.append(el('h2', undefined, '正向回放核对'));
  const row = el('div', 'btn-row');
  const play = el('button', 'btn primary small', '▶ 回放整条链') as HTMLButtonElement;
  play.addEventListener('click', () => startReplay());
  row.append(play);
  panel.append(row);
}

function renderChainSummary() {
  const p = app.puzzle;
  const g = app.game;
  // step 0 = 最后一回合，正向时间顺序是 step 由大到小。
  const chosen = [...g.attempt.chosen].sort((a, b) => b.step - a.step);
  const rail = el('div', 'sol-path');
  // 起点
  if (chosen.length === p.events.length) {
    const startRow = el('div', 'sol-step');
    startRow.append(el('div', 'marker', '起'));
    const txt = el('div', 'txt');
    txt.innerHTML = `<b>清晨</b> ${stateCn(p.board, g.attempt.state)}`;
    startRow.append(txt);
    rail.append(startRow);
  }
  chosen.forEach((c, i) => {
    const row = el('div', 'sol-step');
    row.append(el('div', 'marker', String(i + 1)));
    const txt = el('div', 'txt');
    const a = animalById(p.board, c.actor);
    txt.innerHTML =
      `<b>#${a.number} ${a.name}</b> ${nameOf(p.board, c.move.from)} → ${nameOf(p.board, c.move.to)}` +
      `<span class="tag ${c.move.kind}">${c.move.kind === 'swim' ? '游' : c.move.kind === 'grass' ? '退草' : '原地'}</span>`;
    row.append(txt);
    rail.append(row);
  });
  panel.append(rail);
}

/* ------------------------------------------------------------------ */
/* 动作                                                               */
/* ------------------------------------------------------------------ */
function acceptCandidate(c: ExplainedCandidate) {
  const next = commitCandidate(app.game, c);
  if (next === app.game) {
    showToast(app.game.flash?.text ?? '无法选择这条候选。', 'bad');
    return;
  }
  app.game = next;
  app.hoverCand = null;

  // 游动 / 退草动画
  if (c.move.kind !== 'wait') {
    const now = performance.now();
    const v = boardViewport(app.puzzle.board, cssW, cssH);
    const tween = makeTween(app.puzzle.board, v, c.actor, c.move.from, c.move.to, c.move.kind, now);
    app.motion.tweens[c.actor] = tween;
  }

  if (next.phase === 'solved') {
    app.solvedIds.add(app.puzzle.id);
    renderNav();
  }

  if (next.flash) showToast(next.flash.text, next.flash.kind === 'bad' ? 'bad' : next.flash.kind === 'ok' ? 'ok' : '');
  renderAll();
}

function findDual(cands: ExplainedCandidate[]) {
  const byKey = new Map<string, { swim?: ExplainedCandidate; grass?: ExplainedCandidate }>();
  for (const c of cands) {
    const k = `${c.actor}|${c.move.to}`;
    if (!byKey.has(k)) byKey.set(k, {});
    const o = byKey.get(k)!;
    if (c.move.kind === 'swim') o.swim = c;
    if (c.move.kind === 'grass') o.grass = c;
  }
  for (const [k, o] of byKey) {
    if (o.swim && o.grass) {
      const [actor, dest] = k.split('|');
      return { swim: o.swim, grass: o.grass, dest: dest!, actor: actor! };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 教学盘演示                                                         */
/* ------------------------------------------------------------------ */
function stepDemo(dir: 1 | -1) {
  const script = demoScript();
  const next = clamp(app.demoStep + dir, -1, script.length - 1);
  if (next === app.demoStep) return;
  const prevState = demoState();
  app.demoStep = next;
  const nextState = demoState();
  animateTransition(app.puzzle.board, prevState, nextState);
  syncDemoState();
  renderPanel();
  renderCaption();
  renderStatus();
}

function toggleDemo() {
  if (app.demoPlaying) {
    stopDemo();
    renderPanel();
    return;
  }
  app.demoPlaying = true;
  if (app.demoStep >= demoScript().length - 1) {
    app.demoStep = -1;
    syncDemoState();
  }
  renderPanel();
  app.demoTimer = window.setInterval(() => {
    const script = demoScript();
    if (app.demoStep >= script.length - 1) {
      stopDemo();
      renderPanel();
      return;
    }
    stepDemo(1);
  }, 1900);
}

function stopDemo() {
  if (app.demoTimer !== null) {
    clearInterval(app.demoTimer);
    app.demoTimer = null;
  }
  app.demoPlaying = false;
}

/* ------------------------------------------------------------------ */
/* 通关回放                                                           */
/* ------------------------------------------------------------------ */
function startReplay() {
  stopReplay();
  const moves = userChain(app.game);
  app.replayAt = 0;
  syncReplayState();
  renderCaption();
  app.replayTimer = window.setInterval(() => {
    if (app.replayAt >= moves.length) {
      stopReplay();
      return;
    }
    const prev = replayStateAt(app.replayAt);
    app.replayAt += 1;
    const next = replayStateAt(app.replayAt);
    animateTransition(app.puzzle.board, prev, next);
    syncReplayState();
    renderCaption();
    if (app.replayAt >= moves.length) stopReplay();
  }, 1150);
}

function stopReplay() {
  if (app.replayTimer !== null) {
    clearInterval(app.replayTimer);
    app.replayTimer = null;
  }
  app.replayAt = -1;
}

/* ------------------------------------------------------------------ */
/* 动画                                                               */
/* ------------------------------------------------------------------ */
function animateTransition(board: Board, from: State, to: State) {
  for (const a of board.animals) {
    if (from[a.id] === to[a.id]) continue;
    const v = boardViewport(board, cssW, cssH);
    const kind = locationById(board, to[a.id]!).kind === 'lawn' ? 'grass' : 'swim';
    const tween = makeTween(board, v, a.id, from[a.id]!, to[a.id]!, kind, performance.now());
    app.motion.tweens[a.id] = tween;
  }
}

function syncDemoState() {
  const v = boardViewport(app.puzzle.board, cssW, cssH);
  app.motion.positions = statePositions(app.puzzle.board, demoState(), v);
}

function syncReplayState() {
  const v = boardViewport(app.puzzle.board, cssW, cssH);
  app.motion.positions = statePositions(app.puzzle.board, replayStateAt(Math.max(0, app.replayAt)), v);
}

/* ------------------------------------------------------------------ */
/* 说明文字 / 高亮                                                    */
/* ------------------------------------------------------------------ */
function renderCaption() {
  caption.innerHTML = '';
  const p = app.puzzle;
  if (p.mode === 'tutorial') {
    const script = demoScript();
    const s = app.demoStep >= 0 ? script[app.demoStep] : null;
    if (s) {
      const card = el('div', 'cap-card');
      const a = animalById(p.board, s.actor);
      card.innerHTML = `<span class="k">第 ${app.demoStep + 1} 步</span> · <b>#${a.number} ${a.name}</b> ${nameOf(p.board, s.from)} → ${nameOf(p.board, s.to)}<br/>${s.note}`;
      caption.append(card);
    } else {
      const card = el('div', 'cap-card');
      card.innerHTML = `清晨：<b>${stateCn(p.board, p.startState ?? p.finalState)}</b><br/>点「下一步」或「自动演示」看它们怎么走到傍晚。`;
      caption.append(card);
    }
    return;
  }

  if (app.replayAt >= 0) {
    const card = el('div', 'cap-card');
    const moves = userChain(app.game);
    const idx = Math.min(app.replayAt, moves.length);
    const m = idx > 0 ? moves[idx - 1] : null;
    card.innerHTML = m
      ? `<span class="k">回放 ${idx}/${moves.length}</span> · <b>#${animalById(p.board, m.actor).number} ${animalById(p.board, m.actor).name}</b> ${nameOf(p.board, m.from)} → ${nameOf(p.board, m.to)}<br/>${m.note}`
      : `<span class="k">回放</span> · 清晨起点`;
    caption.append(card);
    return;
  }

  if (app.game.phase === 'solved') {
    const card = el('div', 'cap-card');
    card.innerHTML = `<span class="k">✓ 闭合</span> · 起点 → 终态，事件顺序与记录一致。`;
    caption.append(card);
    return;
  }

  const g = app.game;
  if (g.attempt.dead) {
    const card = el('div', 'cap-card');
    card.innerHTML = `<span class="k">断在这里</span> · 撤销到上一个分叉，换一条解释。`;
    caption.append(card);
    return;
  }

  const step = g.attempt.nextStep;
  if (step < p.events.length) {
    const cands = currentCandidates(g);
    const hov = app.hoverCand !== null ? cands[app.hoverCand] : null;
    const card = el('div', 'cap-card');
    if (hov) {
      card.innerHTML = `<span class="k">候选预览</span> · <b>#${animalById(p.board, hov.actor).number} ${animalById(p.board, hov.actor).name}</b> ${nameOf(p.board, hov.move.from)} → ${nameOf(p.board, hov.move.to)}<br/>${hov.move.note}`;
    } else {
      card.innerHTML = `<span class="k">正在回推第 ${roundOfStep(p, step)} 回合</span> · 记录是「${eventCn(eventAtStep(p, step))}」<br/>从候选里挑一个能正向走回当前盘的前一步。`;
    }
    caption.append(card);
  }
}

function stateCn(board: Board, s: State): string {
  return board.animals
    .map((a) => `#${a.number}${nameOf(board, s[a.id]!)}`)
    .join(' · ');
}

function eventCn(e: EventType): string {
  return e === 'island' ? '岛上' : e === 'lawn' ? '草坪' : '原地';
}

function eventLongCn(e: EventType): string {
  return e === 'island' ? '有动物游到了岛上' : e === 'lawn' ? '有动物到了草坪' : '有动物原地没动';
}

/* ------------------------------------------------------------------ */
/* 状态栏 / toast                                                     */
/* ------------------------------------------------------------------ */
function renderStatus() {
  statusLeft.innerHTML = '';
  statusRight.innerHTML = '';
  const p = app.puzzle;
  if (p.mode === 'tutorial') {
    const script = demoScript();
    const s = el('span', undefined, `演示进度 ${Math.max(0, app.demoStep + 1)} / ${script.length}`);
    statusLeft.append(s);
    statusRight.innerHTML = `<span class="kbd">←</span><span class="kbd">→</span> 切换步骤`;
    return;
  }
  const g = app.game;
  const done = g.attempt.chosen.length;
  statusLeft.append(el('span', undefined, `已定回合 ${done} / ${p.events.length}`));
  if (g.undo.length) statusLeft.append(el('span', undefined, `可撤销 ${g.undo.length} 步`));
  if (g.phase === 'solved') statusLeft.append(el('span', undefined, '✓ 已闭合'));
  statusRight.innerHTML = `<span class="kbd">Z</span> 撤销 <span class="kbd">R</span> 重来 <span class="kbd">1-3</span> 切关`;
}

let toastTimer = 0;
function showToast(text: string, kind: '' | 'ok' | 'bad' = '') {
  toast.textContent = text;
  toast.className = `toast show ${kind}`;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.className = `toast ${kind}`;
    window.setTimeout(() => (toast.hidden = true), 260);
  }, 3200);
}

/* ------------------------------------------------------------------ */
/* 绘制循环                                                           */
/* ------------------------------------------------------------------ */
function frame(now: number) {

  // 过期的补间清掉
  for (const [id, tw] of Object.entries(app.motion.tweens)) {
    if (now - tw.startedAt >= tw.duration) delete app.motion.tweens[id];
  }

  const board = app.puzzle.board;
  const v = boardViewport(board, cssW, cssH);
  const state = viewState();
  const previewing = previewState() !== null;
  const base = statePositions(board, state, v);
  // 补间期间用补间位置，结束后回到底座；预览前一步时不做补间
  const positions = previewing ? { ...base } : { ...base, ...app.motion.positions };
  if (!previewing) {
    const resolved = resolvePositions(board, state, v, app.motion, now);
    for (const id of Object.keys(app.motion.tweens)) {
      if (resolved[id]) positions[id] = resolved[id]!;
    }
  }

  const highlightedAnimal = (() => {
    if (app.puzzle.mode !== 'tutorial' && app.game.phase !== 'solved') {
      const cands = currentCandidates(app.game);
      if (app.hoverCand !== null && cands[app.hoverCand]) return cands[app.hoverCand]!.actor;
    }
    return null;
  })();

  const hlLocs = new Set<string>();
  if (app.hoverLoc) hlLocs.add(app.hoverLoc);
  const hlAnimals = new Set<string>();
  if (highlightedAnimal) hlAnimals.add(highlightedAnimal);

  drawScene(
    ctx,
    board,
    state,
    {
      time: now / 1000,
      positions,
      highlightLocations: hlLocs,
      highlightAnimals: hlAnimals,
      flow: app.replayAt >= 0 ? 2.4 : 1,
      preview: previewing,
    },
    cssW,
    cssH,
  );

  // 悬停候选的目标岛光圈
  if (app.hoverLoc) {
    const loc = board.locations.find((l) => l.id === app.hoverLoc);
    if (loc) {
      const a = anchorPx(v, loc);
      ctx.save();
      ctx.strokeStyle = withAlpha(PALETTE.gold, 0.75);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, v.tile * 0.52, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 教学盘：从当前动物到下一步目标的箭头提示
  if (app.puzzle.mode === 'tutorial') drawNextHint(now);

  requestAnimationFrame(frame);
}

function drawNextHint(now: number) {
  const script = demoScript();
  const i = app.demoStep + 1;
  if (i < 0 || i >= script.length) return;
  const s = script[i]!;
  const board = app.puzzle.board;
  const v = boardViewport(board, cssW, cssH);
  const from = anchorPx(v, locationById(board, s.from));
  const to = anchorPx(v, locationById(board, s.to));
  if (s.from === s.to) {
    // 原地：在动物头上画一个等待符号
    const r = v.tile * 0.2;
    ctx.save();
    ctx.strokeStyle = withAlpha(PALETTE.gold, 0.5 + 0.3 * Math.sin(now / 300));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(from.x + v.tile * 0.3, from.y - v.tile * 0.42, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = withAlpha(PALETTE.gold, 0.8);
    ctx.font = `600 ${r}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('…', from.x + v.tile * 0.3, from.y - v.tile * 0.42);
    ctx.restore();
    return;
  }
  const pulse = 0.45 + 0.25 * Math.sin(now / 260);
  ctx.save();
  ctx.strokeStyle = withAlpha(PALETTE.gold, pulse);
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 7]);
  ctx.lineDashOffset = -now / 60;
  ctx.beginPath();
  ctx.moveTo(lerp(from.x, to.x, 0.2), lerp(from.y, to.y, 0.2));
  ctx.lineTo(lerp(from.x, to.x, 0.8), lerp(from.y, to.y, 0.8));
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'z' || e.key === 'Z') {
      if (app.puzzle.mode === 'reverse' && app.game.undo.length) {
        stopReplay();
        app.game = undoOne(app.game);
        app.hoverCand = null;
        renderAll();
      }
    } else if (e.key === 'r' || e.key === 'R') {
      if (app.puzzle.mode === 'reverse') {
        stopReplay();
        app.game = resetAttempt(app.game);
        app.hoverCand = null;
        renderAll();
      }
    } else if (e.key === 'ArrowRight' && app.puzzle.mode === 'tutorial') {
      stepDemo(1);
    } else if (e.key === 'ArrowLeft' && app.puzzle.mode === 'tutorial') {
      stepDemo(-1);
    } else if (['1', '2', '3'].includes(e.key)) {
      const idx = Number(e.key) - 1;
      const p = puzzles[idx];
      if (p && p.id !== app.puzzle.id) loadPuzzle(p);
    }
  });
}

// 鼠标悬停在地点附近时，把目标位置高亮
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const v = boardViewport(app.puzzle.board, cssW, cssH);
  let found: string | null = null;
  for (const loc of app.puzzle.board.locations) {
    const a = anchorPx(v, loc);
    if (Math.hypot(a.x - x, a.y - y) < v.tile * 0.6) found = loc.id;
  }
  if (found !== app.hoverLoc) {
    app.hoverLoc = found;
    renderCaption();
  }
});
canvas.addEventListener('mouseleave', () => {
  app.hoverLoc = null;
  renderCaption();
});

/* ------------------------------------------------------------------ */
/* 渲染总入口                                                         */
/* ------------------------------------------------------------------ */
function renderAll() {
  renderPanel();
  renderCaption();
  renderStatus();
  renderNav();
}

function boot() {
  resize();
  window.addEventListener('resize', resize);
  bindKeys();
  loadPuzzle(puzzles[0]!);
  requestAnimationFrame(frame);
}

boot();
