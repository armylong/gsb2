// Canvas 观察页:地图渲染 + 交互 + 回合报告/归档对照面板
import { Game } from './engine.ts';
import type { Faction, TurnRecord } from './engine.ts';
import { scenarioCutoff, scenarioSimultaneous } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

const CELL = 46;
const COLORS: Record<string, string> = {
  A: '#2b6cb0',
  B: '#c53030',
  normal: '#f7f5ef',
  blocked: '#4a4a4a',
  zone: '#fff3cd',
};

let scenario: Scenario;
let game: Game;
let scriptIdx = 0;
let selected: string | null = null;

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

function load(s: Scenario): void {
  scenario = s;
  game = s.game;
  scriptIdx = 0;
  selected = null;
  canvas.width = game.width * CELL;
  canvas.height = game.height * CELL;
  (document.getElementById('desc') as HTMLElement).textContent = s.description;
  renderAll();
}

function drawMap(): void {
  const supA = game.suppliedSet('A');
  const supB = game.suppliedSet('B');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      const c = game.cell(x, y);
      const px = x * CELL;
      const py = y * CELL;
      // 底色
      ctx.fillStyle = c.kind === 'blocked' ? COLORS.blocked : c.kind === 'contested' ? COLORS.zone : COLORS.normal;
      ctx.fillRect(px, py, CELL, CELL);
      // 连通补给染色(淡)
      const k = `${x},${y}`;
      if (supA.has(k)) {
        ctx.fillStyle = 'rgba(43,108,176,0.15)';
        ctx.fillRect(px, py, CELL, CELL);
      }
      if (supB.has(k)) {
        ctx.fillStyle = 'rgba(197,48,48,0.15)';
        ctx.fillRect(px, py, CELL, CELL);
      }
      // 争夺区归属角标
      if (c.kind === 'contested' && c.zone) {
        const owner = game.zones.get(c.zone)?.owner ?? null;
        if (owner) {
          ctx.fillStyle = COLORS[owner];
          ctx.beginPath();
          ctx.moveTo(px + CELL, py);
          ctx.lineTo(px + CELL, py + 12);
          ctx.lineTo(px + CELL - 12, py);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = '#97781f';
        ctx.fillText(c.zone, px + 8, py + CELL - 8);
      }
      // 建筑
      if (c.kind === 'camp' || c.kind === 'outpost') {
        const f = c.owner as Faction;
        ctx.fillStyle = COLORS[f];
        if (c.kind === 'camp') {
          ctx.fillRect(px + 6, py + 6, CELL - 12, CELL - 12);
        } else {
          ctx.fillRect(px + 11, py + 11, CELL - 22, CELL - 22);
          // 前哨补给状态:绿圈=在补给网,灰叉=断供
          const ok = (f === 'A' ? supA : supB).has(k);
          ctx.strokeStyle = ok ? '#2f9e44' : '#868e96';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 8, py + 8, CELL - 16, CELL - 16);
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(c.kind === 'camp' ? '营' : '哨', px + CELL / 2, py + CELL / 2);
      }
      // 标记点
      const mA = game.marks.A.has(k);
      const mB = game.marks.B.has(k);
      if (mA) dot(px + 10, py + CELL - 10, COLORS.A);
      if (mB) dot(px + CELL - 10, py + CELL - 10, COLORS.B);
      // 网格线
      ctx.strokeStyle = '#d8d4c8';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL, CELL);
    }
  }
  // 单位
  for (const u of game.units) {
    const cx = u.x * CELL + CELL / 2;
    const cy = u.y * CELL + CELL / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[u.faction];
    ctx.fill();
    ctx.lineWidth = u.id === selected ? 4 : 2;
    ctx.strokeStyle = u.id === selected ? '#ffd43b' : '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(u.id, cx, cy);
  }
}

function dot(x: number, y: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function recordHtml(rec: TurnRecord, stale: boolean): string {
  const zones = rec.zones
    .map((z) => {
      const contrib = (list: { source: string; amount: number }[]) =>
        list.map((c) => `<li>${c.source}: <b>${c.amount}</b></li>`).join('') || '<li>无</li>';
      return `<div class="zone">
        <b>[${z.zone}]</b> 控制值 <b>${z.controlValue}</b> · 领先 <b>${z.leader ?? '平局'}</b> · 连续 ${z.streak} 回合
        · 归属 ${z.ownerBefore ?? '无'} → <b>${z.ownerAfter ?? '无'}</b>
        <div class="cols"><div><u>A方贡献</u><ul>${contrib(z.contributionsA)}</ul></div>
        <div><u>B方贡献</u><ul>${contrib(z.contributionsB)}</ul></div></div>
        ${z.events.map((e) => `<div class="evt">⚑ ${e}</div>`).join('')}
      </div>`;
    })
    .join('');
  return `<div class="rec${stale ? ' stale' : ''}">
    <div class="rec-h">${stale ? '(旧) ' : ''}第 ${rec.turn} 回合 · A补给前哨: ${rec.suppliedOutposts.A.join(',') || '无'} · B补给前哨: ${rec.suppliedOutposts.B.join(',') || '无'}</div>
    ${zones}</div>`;
}

function renderPanels(): void {
  const hist = document.getElementById('history') as HTMLElement;
  hist.innerHTML = game.history.length
    ? [...game.history].reverse().map((r) => recordHtml(r, false)).join('')
    : '<i>尚未结算任何回合</i>';
  const arch = document.getElementById('archive') as HTMLElement;
  arch.innerHTML = game.archive.length
    ? [...game.archive].reverse().map((r) => recordHtml(r, true)).join('')
    : '<i>暂无归档(撤回一轮后旧结果会保留在这里)</i>';
  (document.getElementById('turn') as HTMLElement).textContent = `当前回合: ${game.turn}`;
}

function renderAll(): void {
  drawMap();
  renderPanels();
}

function nextTurn(): void {
  const moves = scenario.script[scriptIdx] ?? [];
  for (const [id, x, y] of moves) {
    try {
      game.moveUnit(id, x, y);
    } catch (e) {
      alert(`脚本移动失败: ${(e as Error).message}`);
    }
  }
  scriptIdx += 1;
  game.endTurn();
  renderAll();
}

canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / CELL);
  const y = Math.floor((ev.clientY - rect.top) / CELL);
  const u = game.unitAt(x, y);
  if (u) {
    selected = u.id;
  } else if (selected) {
    try {
      game.moveUnit(selected, x, y);
      selected = null;
    } catch (e) {
      alert((e as Error).message);
    }
  }
  renderAll();
});

document.getElementById('btn-next')?.addEventListener('click', nextTurn);
document.getElementById('btn-undo')?.addEventListener('click', () => {
  if (game.undo()) {
    if (scriptIdx > 0) scriptIdx -= 1;
    renderAll();
  }
});
document.getElementById('btn-sc1')?.addEventListener('click', () => load(scenarioCutoff()));
document.getElementById('btn-sc2')?.addEventListener('click', () => load(scenarioSimultaneous()));

load(scenarioCutoff());
