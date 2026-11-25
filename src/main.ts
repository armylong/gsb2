// 群岛潮汐传送 —— 主控制器：输入、状态、分析面板、过门核对

import { ISLANDS, PUZZLES, SIDE_NAME, DIR_NAME, findIsland } from './data.js';
import { tryTransit } from './engine.js';
import {
  describeEdge,
  parseState,
  reachableIslands,
  shortestFlipPath,
  trappedStates,
} from './graph.js';
import { render, standAtGate, VIEW_H, VIEW_W } from './render.js';
import type {
  Dir,
  LogEntry,
  PlayerState,
  Puzzle,
  Side,
  TransitInfo,
} from './types.js';

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = VIEW_W;
canvas.height = VIEW_H;

const el = {
  puzzleTitle: document.getElementById('puzzle-title')!,
  puzzleBrief: document.getElementById('puzzle-brief')!,
  stateLine: document.getElementById('state-line')!,
  log: document.getElementById('log')!,
  transitCard: document.getElementById('transit-card')!,
  clockBox: document.getElementById('clock-box')!,
  medalBox: document.getElementById('medal-box')!,
  analysis: document.getElementById('analysis')!,
  banner: document.getElementById('banner')!,
  hint: document.getElementById('hint')!,
};

const SPEED = 3.4;

interface GameState {
  puzzle: Puzzle;
  player: PlayerState;
  reachMode: boolean;
  reachSet: Set<string>;
  trapSet: Set<string>;
  hoveredGate: string | null;
  walkTarget: { x: number; y: number } | null;
  keys: Set<string>;
  logs: LogEntry[];
  lastTransit: TransitInfo | null;
  seq: number;
  done: boolean;
  /** 过门后短暂忽略画布点击，避免落点与新岛门位重合误触发 */
  transitCooldownUntil: number;
}

let state: GameState = freshState(PUZZLES[0]);

function freshState(puzzle: Puzzle): GameState {
  const island = findIsland(puzzle.startIsland);
  return {
    puzzle,
    player: {
      islandId: island.id,
      x: island.cx,
      y: island.cy + island.radius * 0.42,
      facing: 'N',
      side: puzzle.startSide,
      medalTaken: false,
    },
    reachMode: false,
    reachSet: new Set(),
    trapSet: new Set(),
    hoveredGate: null,
    walkTarget: null,
    keys: new Set(),
    logs: [],
    lastTransit: null,
    seq: 0,
    done: false,
    transitCooldownUntil: 0,
  };
}

function log(text: string, kind: LogEntry['kind'] = 'info'): void {
  state.seq += 1;
  state.logs.push({ n: state.seq, text, kind });
  renderLog();
}

function renderLog(): void {
  const colorFor: Record<LogEntry['kind'], string> = {
    move: '#cfe8ff',
    block: '#ff9b9b',
    clock: '#9ad1ff',
    goal: '#ffd34d',
    info: '#c8d3de',
  };
  el.log.innerHTML = state.logs
    .slice(-40)
    .map(
      (e) =>
        `<div style="color:${colorFor[e.kind]}"><b>${e.n}.</b> ${e.text}</div>`
    )
    .join('');
  el.log.scrollTop = el.log.scrollHeight;
}

function sideBadge(side: Side): string {
  return side === 'tide'
    ? '<span class="badge tide">潮</span>'
    : '<span class="badge ebb">汐</span>';
}

function renderTransitCard(info: TransitInfo): void {
  const fromIsl = findIsland(info.fromIsland);
  const toIsl = findIsland(info.toIsland);
  el.transitCard.innerHTML = `
    <div class="card-title">上次过门核对</div>
    <div>${fromIsl.name} ·「${info.fromGateName}」${sideBadge(info.sideBefore)}</div>
    <div class="arrow">↓ ${info.flipped ? '过门翻卡 ⇄' : '过门不翻卡'}</div>
    <div>${toIsl.name} ·「${info.toGateName}」${sideBadge(info.sideAfter)}，落地朝向：<b>${DIR_NAME[info.facingAfter]}</b></div>
    <div class="muted">卡面：${SIDE_NAME[info.sideBefore]} → ${SIDE_NAME[info.sideAfter]}</div>
  `;
}

function updateHud(): void {
  const p = state.player;
  const island = findIsland(p.islandId);
  el.puzzleTitle.textContent = state.puzzle.title;
  el.puzzleBrief.textContent = state.puzzle.brief;
  el.stateLine.innerHTML = `当前：<b>${island.name}</b> · 卡面 ${sideBadge(p.side)} · 朝向 <b>${DIR_NAME[p.facing]}</b>${
    island.hasClock ? ' · <span style="color:#9ad1ff">岛上有潮钟</span>' : ''
  }`;

  // 潮钟按钮
  if (island.hasClock) {
    el.clockBox.style.display = 'flex';
    el.clockBox.innerHTML = `
      <span>潮钟重选卡面：</span>
      <button class="side-btn tide ${p.side === 'tide' ? 'cur' : ''}" data-side="tide">潮面</button>
      <button class="side-btn ebb ${p.side === 'ebb' ? 'cur' : ''}" data-side="ebb">汐面</button>`;
    el.clockBox.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = (btn as HTMLElement).dataset.side as Side;
        if (target === p.side) {
          log('卡面本来就是这一面，潮钟没有改变任何东西', 'clock');
          return;
        }
        p.side = target;
        state.reachMode = false;
        state.reachSet.clear();
        state.trapSet.clear();
        log(`在潮钟处把卡面重选为【${SIDE_NAME[target]}】（不消耗翻卡）`, 'clock');
        updateHud();
        renderAnalysis();
      });
    });
  } else {
    el.clockBox.style.display = 'none';
    el.clockBox.innerHTML = '';
  }

  // 纪念章状态
  if (state.puzzle.goalIsMedal) {
    el.medalBox.style.display = 'block';
    el.medalBox.textContent = p.medalTaken
      ? '★ 纪念章已取得'
      : '纪念章尚未取得';
    el.medalBox.className = p.medalTaken ? 'medal taken' : 'medal';
  } else {
    el.medalBox.style.display = 'none';
  }

  el.hint.textContent =
    '方向键/WASD 走动（点击地面可自动走过去）；走到门旁按回车/空格，或直接点击门进入。R 重来。';
}

function renderAnalysis(): void {
  const lines: string[] = [];
  if (state.reachMode) {
    const names = [...state.reachSet].map((id) => findIsland(id).name);
    lines.push(`<b style="color:#8ff0b0">可达区域</b>（从当前岛+卡面重新遍历，与你走过的路无关）：${names.join('、')}`);
  }
  if (state.trapSet.size > 0) {
    const traps = trappedStates(state.player.islandId, state.player.side);
    for (const t of traps) {
      const { islandId, side } = parseState(t.state);
      const path = t.path
        .map((e) => {
          const from = parseState(e.from);
          return `${findIsland(from.islandId).name}·${SIDE_NAME[from.side]} —${describeEdge(e)}→`;
        })
        .join(' ');
      lines.push(
        `<b style="color:#ff9b9b">回不去</b>：${findIsland(islandId).name}·${SIDE_NAME[side]}。示例走法：${path} ${findIsland(islandId).name}·${SIDE_NAME[side]}`
      );
    }
  }
  el.analysis.innerHTML = lines.join('<br>');
}

function nearestGate(maxDist: number) {
  const island = findIsland(state.player.islandId);
  let best: { id: string; dist: number } | null = null;
  for (const g of island.gates) {
    const d = Math.hypot(g.x - state.player.x, g.y - state.player.y);
    if (d <= maxDist && (!best || d < best.dist)) best = { id: g.id, dist: d };
  }
  return best;
}

function enterGate(gateId: string): void {
  const p = state.player;
  const outcome = tryTransit({ islandId: p.islandId, gateId, side: p.side });
  if (!outcome.ok) {
    log(outcome.reason, 'block');
    return;
  }
  const info = outcome.info;
  p.islandId = outcome.nextIslandId;
  p.side = outcome.nextSide;
  p.facing = outcome.facing;
  const targetGate = findIsland(p.islandId).gates.find((g) => g.id === info.toGate)!;
  const stand = standAtGate(targetGate);
  p.x = stand.x;
  p.y = stand.y;
  state.walkTarget = null;
  state.lastTransit = info;
  state.reachMode = false;
  state.reachSet.clear();
  state.trapSet.clear();
  state.transitCooldownUntil = performance.now() + 250;

  log(
    `经「${info.fromGateName}」到 ${findIsland(p.islandId).name}·「${info.toGateName}」，` +
      `卡面 ${SIDE_NAME[info.sideBefore]}→${SIDE_NAME[info.sideAfter]}，朝向${DIR_NAME[info.facingAfter]}`,
    'move'
  );
  renderTransitCard(info);

  // 纪念章
  const arrived = findIsland(p.islandId);
  if (arrived.hasMedal && state.puzzle.goalIsMedal && !p.medalTaken) {
    p.medalTaken = true;
    log('在章岛取下纪念章，题面一完成！', 'goal');
    state.done = true;
    el.banner.className = 'banner show win';
    el.banner.textContent = '★ 题面一完成：纪念章已取得';
  }

  // 自动核对：从新状态还回不回得到题面起点（纯图算法，不参考行走历史）
  const canGetBack = reachableIslands(p.islandId, p.side).has(
    state.puzzle.startIsland
  );
  if (!canGetBack) {
    log(`警告：从当前状态无法回到起点岛「${findIsland(state.puzzle.startIsland).name}」——你走进了回不去的区域`, 'block');
    if (!state.puzzle.goalIsMedal) {
      state.done = true;
      el.banner.className = 'banner show trap';
      el.banner.textContent = '题面二：已进入单向死胡同，所有门封死，只能重来';
    }
  }

  updateHud();
  renderAnalysis();
}

// ---------- 输入 ----------
window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
    ev.preventDefault();
  }
  if (k === 'r') {
    resetPuzzle(state.puzzle.id);
    return;
  }
  if (k === 'enter' || k === ' ') {
    const near = nearestGate(52);
    if (near) enterGate(near.id);
    else log('附近没有门，先走到一扇门旁', 'info');
    return;
  }
  state.keys.add(k);
  state.walkTarget = null;
});
window.addEventListener('keyup', (ev) => {
  state.keys.delete(ev.key.toLowerCase());
});

function gateAt(x: number, y: number): string | null {
  const island = findIsland(state.player.islandId);
  for (const g of island.gates) {
    if (Math.hypot(g.x - x, g.y - y) <= 26) return g.id;
  }
  return null;
}

canvas.addEventListener('mousemove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * VIEW_W;
  const y = ((ev.clientY - rect.top) / rect.height) * VIEW_H;
  const id = gateAt(x, y);
  state.hoveredGate = id;
  canvas.style.cursor = id ? 'pointer' : 'default';
});

canvas.addEventListener('click', (ev) => {
  if (performance.now() < state.transitCooldownUntil) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * VIEW_W;
  const y = ((ev.clientY - rect.top) / rect.height) * VIEW_H;
  const id = gateAt(x, y);
  if (id) {
    const gate = findIsland(state.player.islandId).gates.find((g) => g.id === id)!;
    const d = Math.hypot(gate.x - state.player.x, gate.y - state.player.y);
    if (d <= 60) {
      enterGate(id);
    } else {
      log(`先走到「${gate.name}」旁（已为你设定行走目标）`, 'info');
      const stand = standAtGate(gate);
      state.walkTarget = { x: stand.x, y: stand.y };
    }
    return;
  }
  // 点地面：限制在岛内部，作为自动行走目标
  const island = findIsland(state.player.islandId);
  const dx = x - island.cx;
  const dy = y - island.cy;
  const dist = Math.hypot(dx, dy);
  const maxR = island.radius - 18;
  if (dist <= maxR) {
    state.walkTarget = { x, y };
  } else if (dist > 0) {
    state.walkTarget = {
      x: island.cx + (dx / dist) * maxR,
      y: island.cy + (dy / dist) * maxR,
    };
  }
});

// ---------- 按钮 ----------
document.querySelectorAll<HTMLButtonElement>('[data-puzzle]').forEach((btn) => {
  btn.addEventListener('click', () => resetPuzzle(btn.dataset.puzzle!));
});
document.getElementById('btn-reset')!.addEventListener('click', () => resetPuzzle(state.puzzle.id));
document.getElementById('btn-reach')!.addEventListener('click', () => {
  state.reachMode = !state.reachMode;
  if (state.reachMode) {
    state.reachSet = reachableIslands(state.player.islandId, state.player.side);
    log(`查看可达区域：${[...state.reachSet].map((i) => findIsland(i).name).join('、')}`, 'info');
  } else {
    state.reachSet.clear();
  }
  renderAnalysis();
});
document.getElementById('btn-trap')!.addEventListener('click', () => {
  const traps = trappedStates(state.player.islandId, state.player.side);
  state.trapSet = new Set(traps.map((t) => parseState(t.state).islandId));
  if (traps.length === 0) {
    log('当前状态下，所有可达的地方都能回到本岛，没有回不去的目标', 'info');
  } else {
    for (const t of traps) {
      const { islandId, side } = parseState(t.state);
      log(`提示：${findIsland(islandId).name}·${SIDE_NAME[side]} 可能到达，却无法回到起点岛`, 'block');
    }
  }
  renderAnalysis();
});
document.getElementById('btn-flipinfo')!.addEventListener('click', () => {
  const sp = shortestFlipPath(
    state.puzzle.startIsland,
    state.puzzle.startSide,
    state.puzzle.goalIsland
  );
  if (!sp) {
    log('题面目标不可达', 'block');
    return;
  }
  const route = sp.edges
    .map((e) => {
      const from = parseState(e.from);
      return `${findIsland(from.islandId).name}·${SIDE_NAME[from.side]} —${describeEdge(e)}→`;
    })
    .join(' ');
  const last = sp.edges[sp.edges.length - 1];
  log(`最短路线（翻卡 ${sp.flips} 次）：${route} ${findIsland(last.to.split(':')[0]).name}`, 'info');
});

function resetPuzzle(puzzleId: string): void {
  const puzzle = PUZZLES.find((p) => p.id === puzzleId)!;
  state = freshState(puzzle);
  el.banner.className = 'banner';
  el.banner.textContent = '';
  el.transitCard.innerHTML = '<div class="card-title">过门核对</div><div class="muted">尚未通过任何门</div>';
  el.analysis.innerHTML = '';
  log(`载入${puzzle.title}，起点 ${findIsland(puzzle.startIsland).name}，持【${SIDE_NAME[puzzle.startSide]}】面`, 'info');
  updateHud();
  renderAnalysis();
}

// ---------- 主循环 ----------
const KEY_DIR: Record<string, Dir> = {
  arrowup: 'N',
  w: 'N',
  arrowdown: 'S',
  s: 'S',
  arrowleft: 'W',
  a: 'W',
  arrowright: 'E',
  d: 'E',
};
const DIR_VEC: Record<Dir, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
};

function clampToIsland(): void {
  const island = findIsland(state.player.islandId);
  const p = state.player;
  const dx = p.x - island.cx;
  const dy = p.y - island.cy;
  const d = Math.hypot(dx, dy);
  const maxR = island.radius - 16;
  if (d > maxR) {
    p.x = island.cx + (dx / d) * maxR;
    p.y = island.cy + (dy / d) * maxR;
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(48, now - last) / 16.67;
  last = now;
  const p = state.player;

  let moving = false;
  for (const k of Object.keys(KEY_DIR)) {
    if (state.keys.has(k)) {
      const dir = KEY_DIR[k];
      const v = DIR_VEC[dir];
      p.x += v.x * SPEED * dt;
      p.y += v.y * SPEED * dt;
      p.facing = dir;
      moving = true;
    }
  }
  if (moving) state.walkTarget = null;

  if (!moving && state.walkTarget) {
    const dx = state.walkTarget.x - p.x;
    const dy = state.walkTarget.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d <= SPEED * dt) {
      p.x = state.walkTarget.x;
      p.y = state.walkTarget.y;
      state.walkTarget = null;
    } else {
      p.x += (dx / d) * SPEED * dt;
      p.y += (dy / d) * SPEED * dt;
      p.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy > 0 ? 'S' : 'N';
    }
  }
  clampToIsland();

  render(ctx, {
    player: p,
    reachMode: state.reachMode,
    reachableIslands: state.reachSet,
    trapIslands: state.trapSet,
    hoveredGate: state.hoveredGate,
    time: now,
  });
  requestAnimationFrame(frame);
}

// 静态资产自检：保证四个岛都被画进画布
for (const isl of ISLANDS) {
  if (
    isl.cx - isl.radius < 0 ||
    isl.cx + isl.radius > VIEW_W ||
    isl.cy - isl.radius < 0 ||
    isl.cy + isl.radius > VIEW_H
  ) {
    throw new Error(`岛 ${isl.name} 超出画布范围`);
  }
}

resetPuzzle(PUZZLES[0].id);
requestAnimationFrame(frame);

// 仅供 e2e/harness.html 调用的只读测试钩子
const testApi = {
  reset: (puzzleId: string) => resetPuzzle(puzzleId),
  snapshot: () => ({ ...state.player }),
  gates: ISLANDS.flatMap((i) =>
    i.gates.map((g) => {
      const stand = standAtGate(g);
      return { id: g.id, x: g.x, y: g.y, standX: stand.x, standY: stand.y, islandId: i.id };
    })
  ),
  clockVisible: () => el.clockBox.style.display !== 'none',
  bannerShown: () => el.banner.textContent ?? '',
  logCount: () => state.logs.length,
  reachableNow: () => reachableIslands(state.player.islandId, state.player.side),
  trappedNow: () => trappedStates(state.player.islandId, state.player.side),
  pickClock: (side: Side) => {
    const btn = el.clockBox.querySelector<HTMLButtonElement>(`[data-side="${side}"]`);
    btn?.click();
  },
};
declare global {
  interface Window {
    __testApi?: typeof testApi;
  }
}
window.__testApi = testApi;
