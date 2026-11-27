import { LEVELS } from './game/levels';
import { analyzeCatch } from './game/engine';
import { Session } from './game/session';
import { H, W, render, type HitTarget } from './ui/render';
import { handleClick, handleKey, pendingText, type UiState } from './ui/input';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('找不到 #game canvas');
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas 2D 上下文不可用');
const ctx: CanvasRenderingContext2D = context;

const ui: UiState = { screen: 'intro', message: null };
let session = new Session(LEVELS[0]);
let hits: HitTarget[] = [];

function startLevel(levelId: string): void {
  const level = LEVELS.find((l) => l.id === levelId);
  if (!level) return;
  session.load(level);
  ui.screen = 'play';
  ui.message = null;
}

function backToIntro(): void {
  ui.screen = 'intro';
  ui.message = null;
}

function draw(): void {
  hits = render(ctx, {
    screen: ui.screen,
    levels: LEVELS,
    level: session.level,
    state: session.state,
    selectedDoughId: session.selectedDoughId,
    pendingAction: session.pendingAction,
    pendingText: pendingText(session),
    simulation: session.simulation,
    canUndo: session.canUndo,
    catchInfos: analyzeCatch(session.state, session.level),
    message: ui.message,
  });
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  // 必须先减掉画布在页面中的偏移，再按 CSS 尺寸 → 画布内部分辨率缩放
  const mx = ((e.clientX - rect.left) / rect.width) * W;
  const my = ((e.clientY - rect.top) / rect.height) * H;
  handleClick(session, ui, hits, mx, my, startLevel, backToIntro);
  draw();
});

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') e.preventDefault();
  handleKey(session, ui, e.key);
  draw();
});

draw();
