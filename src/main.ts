import {
  createInitialState,
  DIR_ARROW,
  isWin,
  KEY_TO_DIR,
  nextHint,
  parseScript,
  solve,
  step,
  type Dir,
  type SearchResult,
  type StepInfo,
} from './engine.js';
import { History } from './history.js';
import { LEVELS } from './levels.js';
import { drawScene, VIEW_H, VIEW_W, type VisualPositions } from './render.js';

function required<T>(value: T | null, name: string): T {
  if (!value) throw new Error(`Missing required element: ${name}`);
  return value;
}

const canvas = required(document.querySelector<HTMLCanvasElement>('#game'), '#game');
const ctx = required(canvas.getContext('2d'), 'Canvas 2D context');

const levelSelect = required(document.querySelector<HTMLSelectElement>('#levelSelect'), '#levelSelect');
const levelName = required(document.querySelector<HTMLElement>('#levelName'), '#levelName');
const levelTagline = required(document.querySelector<HTMLElement>('#levelTagline'), '#levelTagline');
const lessonBox = required(document.querySelector<HTMLElement>('#lessonBox'), '#lessonBox');
const undoBtn = required(document.querySelector<HTMLButtonElement>('#undoBtn'), '#undoBtn');
const hintBtn = required(document.querySelector<HTMLButtonElement>('#hintBtn'), '#hintBtn');
const applyHintBtn = required(document.querySelector<HTMLButtonElement>('#applyHintBtn'), '#applyHintBtn');
const resetBtn = required(document.querySelector<HTMLButtonElement>('#resetBtn'), '#resetBtn');
const replayWinBtn = required(document.querySelector<HTMLButtonElement>('#replayWinBtn'), '#replayWinBtn');
const replayDeadBtn = required(document.querySelector<HTMLButtonElement>('#replayDeadBtn'), '#replayDeadBtn');
const stopReplayBtn = required(document.querySelector<HTMLButtonElement>('#stopReplayBtn'), '#stopReplayBtn');
const statusLine = required(document.querySelector<HTMLElement>('#statusLine'), '#statusLine');
const eventLog = required(document.querySelector<HTMLElement>('#eventLog'), '#eventLog');
const hintPanel = required(document.querySelector<HTMLElement>('#hintPanel'), '#hintPanel');
const hintArrow = required(document.querySelector<HTMLElement>('#hintArrow'), '#hintArrow');
const diagnosisBox = required(document.querySelector<HTMLElement>('#diagnosisBox'), '#diagnosisBox');
const snapshotBox = required(document.querySelector<HTMLElement>('#snapshotBox'), '#snapshotBox');

// Fixed 2x backing store keeps the responsive canvas crisp on Retina displays.
canvas.width = VIEW_W * 2;
canvas.height = VIEW_H * 2;
ctx.scale(2, 2);

for (const level of LEVELS) {
  const option = document.createElement('option');
  option.value = level.id;
  option.textContent = `${level.index + 1}. ${level.name}`;
  levelSelect.append(option);
}

let level = LEVELS[0]!;
let history = new History(createInitialState(level));
let lastInfo: StepInfo | null = null;
let lastActionAt = 0;
let hintVisible = false;
let currentHintDir: Dir | null = null;
let currentSearch: SearchResult = solve(level, history.current);
let replayTimer: number | null = null;
let replaySteps: Dir[] = [];
let replayIndex = 0;

const visual: VisualPositions = {
  inside: { ...history.current.pos.inside },
  outside: { ...history.current.pos.outside },
};

function stopReplay(): void {
  if (replayTimer !== null) {
    window.clearInterval(replayTimer);
    replayTimer = null;
  }
  replaySteps = [];
  replayIndex = 0;
  stopReplayBtn.disabled = true;
  replayWinBtn.disabled = false;
  replayDeadBtn.disabled = false;
}

function snapVisual(): void {
  visual.inside = { ...history.current.pos.inside };
  visual.outside = { ...history.current.pos.outside };
}

function addLog(message: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info'): void {
  const item = document.createElement('li');
  item.textContent = message;
  item.dataset.tone = tone;
  eventLog.prepend(item);
  while (eventLog.children.length > 7) eventLog.lastElementChild?.remove();
}

function describeStep(info: StepInfo): { text: string; tone: 'info' | 'good' | 'bad' | 'warn' } {
  const blockedInside = info.blockedReason.inside;
  const blockedOutside = info.blockedReason.outside;
  const parts: string[] = [];
  const reasonText = (reason: NonNullable<typeof blockedInside>): string =>
    reason === 'wall' ? '撞障碍' : reason === 'closed-door' ? '门还关着' : '到边界';

  if (blockedInside && blockedOutside) {
    parts.push(`内侧${reasonText(blockedInside)}，外侧${reasonText(blockedOutside)}，都留在原格`);
  } else if (blockedInside) {
    parts.push(`内侧${reasonText(blockedInside)}留在原格，外侧移动`);
  } else if (blockedOutside) {
    parts.push(`外侧${reasonText(blockedOutside)}留在原格，内侧移动`);
  } else {
    parts.push('两只都移动一格');
  }

  for (const event of info.events) {
    if (event.type === 'marker-toggle') {
      const marker = level.markers.find((m) => m.id === event.markerId);
      parts.push(
        `${marker?.label ?? event.markerId}${event.kind === 'once' ? '首次触发并消耗' : '反转'}：门下一步${event.open ? '可通行' : '关闭'}`,
      );
    }
    if (event.type === 'win') parts.push('同时到达目标');
  }

  const tone = info.events.some((e) => e.type === 'win')
    ? 'good'
    : info.events.some((e) => e.type === 'marker-toggle')
      ? 'warn'
      : blockedInside || blockedOutside
        ? 'bad'
        : 'info';
  return { text: `${DIR_ARROW[info.dir]} ${parts.join('；')}`, tone };
}

function refreshSearchAndPanels(): void {
  const state = history.current;
  currentSearch = solve(level, state);
  const hint = nextHint(level, state);
  currentHintDir = hintVisible ? hint.dir : null;

  undoBtn.disabled = !history.canUndo;
  hintBtn.disabled = isWin(level, state);
  applyHintBtn.disabled = !hint.dir;
  applyHintBtn.hidden = !hintVisible || !hint.dir;

  const won = isWin(level, state);
  levelName.textContent = level.name;
  levelTagline.textContent = level.tagline;
  lessonBox.textContent = level.lesson;
  levelSelect.value = level.id;

  snapshotBox.innerHTML = [
    `<div><span>有效步数</span><strong>${history.depth - 1}</strong></div>`,
    `<div><span>内侧位置</span><strong>R${state.pos.inside.r + 1} C${state.pos.inside.c + 1}</strong></div>`,
    `<div><span>外侧位置</span><strong>R${state.pos.outside.r + 1} C${state.pos.outside.c + 1}</strong></div>`,
    ...level.doors.map((door) =>
      `<div><span>${door.label ?? door.id}</span><strong class="${state.doors[door.id] ? 'ok' : 'bad'}">${state.doors[door.id] ? '开启' : '关闭'}</strong></div>`,
    ),
    ...level.markers.filter((m) => m.kind === 'once').map((marker) =>
      `<div><span>${marker.label}</span><strong class="${state.used[marker.id] ? 'bad' : 'ok'}">${state.used[marker.id] ? '已消耗' : '未消耗'}</strong></div>`,
    ),
  ].join('');

  if (won) {
    statusLine.dataset.tone = 'good';
    statusLine.textContent = '过关！两只颜色对应的甲虫都停在自己的目标格。可撤销复盘，或回放过关脚本。';
  } else if (currentSearch.status !== 'won') {
    const diagnosis = currentSearch.diagnosis;
    statusLine.dataset.tone = 'bad';
    statusLine.textContent = diagnosis.title;
    diagnosisBox.hidden = false;
    diagnosisBox.dataset.kind = diagnosis.kind;
    diagnosisBox.innerHTML = `
      <h3>${diagnosis.title}</h3>
      <p>${diagnosis.detail}</p>
      <ul>${diagnosis.lines.map((line) => `<li>${line}</li>`).join('')}</ul>
      <small>已穷举 ${diagnosis.reachableStates} 个真实状态（位置 / 门 / 一次性标记）。可按 U 撤销。</small>
    `;
    hintPanel.dataset.state = 'dead';
    hintArrow.textContent = '×';
    hintArrow.setAttribute('aria-label', '无解');
  } else {
    diagnosisBox.hidden = true;
    diagnosisBox.innerHTML = '';
    statusLine.dataset.tone = 'info';
    statusLine.textContent = lastInfo
      ? describeStep(lastInfo).text
      : '准备就绪：按方向键、WASD，或先点“提示下一步”。';
    hintPanel.dataset.state = hintVisible && hint.dir ? 'ready' : 'idle';
    if (hintVisible && hint.dir) {
      hintArrow.textContent = DIR_ARROW[hint.dir];
      hintArrow.setAttribute('aria-label', `提示方向 ${hint.dir}`);
    } else {
      hintArrow.textContent = '?';
      hintArrow.setAttribute('aria-label', '尚未求提示');
    }
  }
}

function applyDirection(dir: Dir, source: 'key' | 'button' | 'replay' = 'key'): void {
  if (source !== 'replay') stopReplay();
  const result = step(level, history.current, dir);
  lastInfo = result.info;
  lastActionAt = performance.now();

  if (result.info.effective) {
    history.push(result.state);
  } else if (source !== 'replay') {
    addLog(describeStep(result.info).text, 'bad');
  }

  const description = describeStep(result.info);
  if (result.info.effective || source === 'replay') addLog(description.text, description.tone);
  refreshSearchAndPanels();
}

function undo(): void {
  stopReplay();
  const previous = history.undo();
  if (!previous) return;
  lastInfo = null;
  hintVisible = true; // After undo, immediately show the real next hint context.
  addLog('已撤销一步，门、标记和甲虫位置均恢复。', 'info');
  refreshSearchAndPanels();
}

function resetLevel(): void {
  stopReplay();
  history.reset(createInitialState(level));
  lastInfo = null;
  hintVisible = false;
  snapVisual();
  eventLog.replaceChildren();
  addLog(`已载入「${level.name}」。`, 'info');
  refreshSearchAndPanels();
}

function loadLevel(id: string): void {
  const next = LEVELS.find((item) => item.id === id) ?? LEVELS[0]!;
  level = next;
  history = new History(createInitialState(level));
  lastInfo = null;
  hintVisible = false;
  stopReplay();
  snapVisual();
  eventLog.replaceChildren();
  addLog(`已载入「${level.name}」。`, 'info');
  refreshSearchAndPanels();
}

function playScript(script: string | undefined): void {
  stopReplay();
  history.reset(createInitialState(level));
  lastInfo = null;
  hintVisible = false;
  snapVisual();
  eventLog.replaceChildren();

  replaySteps = parseScript(script ?? '');
  replayIndex = 0;
  if (replaySteps.length === 0) {
    addLog('这一关没有可回放脚本。', 'warn');
    refreshSearchAndPanels();
    return;
  }

  replayWinBtn.disabled = true;
  replayDeadBtn.disabled = true;
  stopReplayBtn.disabled = false;
  addLog('开始自动回放…', 'info');
  refreshSearchAndPanels();

  replayTimer = window.setInterval(() => {
    const dir = replaySteps[replayIndex];
    if (!dir) {
      stopReplay();
      refreshSearchAndPanels();
      return;
    }
    replayIndex += 1;
    applyDirection(dir, 'replay');
    if (replayIndex >= replaySteps.length) {
      stopReplay();
      refreshSearchAndPanels();
    }
  }, 680);
}

levelSelect.addEventListener('change', () => {
  loadLevel(levelSelect.value);
  levelSelect.blur();
});
undoBtn.addEventListener('click', undo);
resetBtn.addEventListener('click', resetLevel);
hintBtn.addEventListener('click', () => {
  hintVisible = true;
  refreshSearchAndPanels();
});
applyHintBtn.addEventListener('click', () => {
  if (currentHintDir) applyDirection(currentHintDir, 'button');
});
replayWinBtn.addEventListener('click', () => playScript(level.replay.win));
replayDeadBtn.addEventListener('click', () => {
  if (level.id !== 'spent-key-deadend') loadLevel('spent-key-deadend');
  // Wait until the load has swapped the level before starting its dead script.
  window.setTimeout(() => playScript(LEVELS[2]!.replay.dead), 0);
});
stopReplayBtn.addEventListener('click', stopReplay);

document.querySelectorAll<HTMLButtonElement>('.dpad').forEach((button) => {
  button.addEventListener('click', () => {
    const dir = button.dataset.dir as Dir | undefined;
    if (dir) applyDirection(dir, 'button');
  });
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;

  const dir = KEY_TO_DIR[event.key];
  if (dir) {
    event.preventDefault();
    stopReplay();
    applyDirection(dir);
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key.toLowerCase() === 'u') {
    event.preventDefault();
    undo();
  } else if (event.key.toLowerCase() === 'h') {
    event.preventDefault();
    hintVisible = true;
    refreshSearchAndPanels();
  } else if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    resetLevel();
  } else if (event.key >= '1' && event.key <= String(LEVELS.length)) {
    const index = Number(event.key) - 1;
    const chosen = LEVELS[index];
    if (chosen) loadLevel(chosen.id);
  }
});

function animate(now: number): void {
  const state = history.current;
  for (const side of ['inside', 'outside'] as const) {
    const target = state.pos[side];
    const current = visual[side];
    current.r += (target.r - current.r) * 0.24;
    current.c += (target.c - current.c) * 0.24;
    if (Math.abs(target.r - current.r) < 0.012) current.r = target.r;
    if (Math.abs(target.c - current.c) < 0.012) current.c = target.c;
  }

  ctx.setTransform(2, 0, 0, 2, 0, 0);
  drawScene(ctx, {
    level,
    state,
    visual,
    now,
    hintDir: currentHintDir,
    lastInfo,
    lastActionAt,
    replaying: replayTimer !== null,
  });
  window.requestAnimationFrame(animate);
}

refreshSearchAndPanels();
window.requestAnimationFrame(animate);
