// 入口：DOM/Canvas 装配、键鼠输入、主循环与 HUD。
// 规则全部在 engine 里，这里只做转发和绘制。

import {
  createGameState,
  reset,
  setPreview,
  startRotation,
  tryMove,
  update,
} from './engine/engine.js';
import {
  createBlockedLevel,
  createSolvableLevel,
} from './engine/levels.js';
import { render, leverAtPixel, TILE } from './engine/render.js';
import type { Dir, GameState, RotDir } from './engine/types.js';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const bannerEl = document.getElementById('banner') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const levelNameEl = document.getElementById('level-name') as HTMLSpanElement;

const LEVELS = [createSolvableLevel, createBlockedLevel];
let levelIndex = new URLSearchParams(location.search).get('level') === 'blocked' ? 1 : 0;
let state: GameState = createGameState(LEVELS[levelIndex]());

canvas.width = state.cols * TILE;
canvas.height = state.rows * TILE;

let hoverLever: 'A' | 'B' | null = null;
let mouseDir: RotDir = 'cw';
let lastTime = performance.now();

function loadLevel(index: number): void {
  levelIndex = index;
  state = createGameState(LEVELS[index]());
  canvas.width = state.cols * TILE;
  canvas.height = state.rows * TILE;
  levelNameEl.textContent = state.level.name;
  hoverLever = null;
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(state, dt);
  render(ctx, state, { hoverLever, mouseDir });
  renderHud();
  requestAnimationFrame(loop);
}

function renderHud(): void {
  const p = state.player;
  const aboard = p.aboard ? `步道 ${p.aboard}（随板转动）` : '静态地面';
  const orient = state.platforms
    .map((pl) => `${pl.id}:${pl.orientation * 90}°`)
    .join('  ');
  statusEl.textContent = `位置 (${p.cell.x},${p.cell.y}) · ${aboard} · 朝向 ${orient}`;
  if (state.banner) {
    bannerEl.textContent = state.banner;
    bannerEl.classList.add('show');
    bannerEl.classList.toggle('warn', !state.phase.includes('won'));
  } else {
    bannerEl.classList.remove('show');
  }
}

window.addEventListener('keydown', (e) => {
  const keyMap: Record<string, Dir> = {
    ArrowUp: 'N',
    ArrowDown: 'S',
    ArrowLeft: 'W',
    ArrowRight: 'E',
    w: 'N',
    s: 'S',
    a: 'W',
    d: 'E',
  };
  const dir = keyMap[e.key];
  if (dir) {
    e.preventDefault();
    tryMove(state, dir);
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    state = reset(state);
    levelNameEl.textContent = state.level.name;
  } else if (e.key === 'e' || e.key === 'E') {
    state.showEdges = !state.showEdges;
  } else if (e.key === '1') {
    loadLevel(0);
  } else if (e.key === '2') {
    loadLevel(1);
  } else if (e.key === 'q' || e.key === 'Q') {
    if (hoverLever) startRotation(state, hoverLever, 'ccw');
  } else if (e.key === ' ' || e.key === 'Enter') {
    if (hoverLever) {
      e.preventDefault();
      startRotation(state, hoverLever, mouseDir);
    }
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  mouseDir = (e.buttons & 2) === 2 ? 'ccw' : 'cw';
  const hit = leverAtPixel(state, px, py);
  const next = hit?.platformId ?? null;
  if (next !== hoverLever) {
    hoverLever = next;
    setPreview(state, hoverLever, mouseDir);
  } else if (hoverLever) {
    setPreview(state, hoverLever, mouseDir);
  }
});

canvas.addEventListener('mouseleave', () => {
  hoverLever = null;
  setPreview(state, null);
});

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const hit = leverAtPixel(state, px, py);
  if (!hit) return;
  const dir: RotDir = e.button === 2 ? 'ccw' : 'cw';
  startRotation(state, hit.platformId, dir);
});

document
  .getElementById('btn-reset')!
  .addEventListener('click', () => {
    state = reset(state);
    levelNameEl.textContent = state.level.name;
  });
document.getElementById('btn-edges')!.addEventListener('click', () => {
  state.showEdges = !state.showEdges;
});
document.getElementById('btn-l1')!.addEventListener('click', () => loadLevel(0));
document.getElementById('btn-l2')!.addEventListener('click', () => loadLevel(1));

levelNameEl.textContent = state.level.name;
requestAnimationFrame(loop);
