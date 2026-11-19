import { Sim, SoundType, SOUND_TYPE_INFO, estimateDirText } from './sim';
import { MISS_REASON_CN } from './sim';
import { PRESETS } from './presets';
import { draw, hoverText, CELL, ViewState } from './render';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;
const clockEl = document.getElementById('clock') as HTMLSpanElement;
const eventListEl = document.getElementById('event-list') as HTMLDivElement;
const npcListEl = document.getElementById('npc-list') as HTMLDivElement;
const presetDescEl = document.getElementById('preset-desc') as HTMLParagraphElement;
const modeHintEl = document.getElementById('mode-hint') as HTMLParagraphElement;

let sim: Sim = PRESETS[0].build();
let playing = true;
const view: ViewState = { selectedEventId: null, hover: null, showTime: false };

type Mode = 'emit' | 'door' | 'wall';
let mode: Mode = 'emit';

const MODE_HINTS: Record<Mode, string> = {
  emit: '点击地图格子,在该格发出声音。',
  door: '点击格子:空地 → 关着的门 → 开着的门 → 空地。只影响之后发出的声音。',
  wall: '点击格子在墙与空地之间切换(门需先用门编辑移除)。只影响之后发出的声音。',
};

// ---------- 预设 ----------

const presetRow = document.getElementById('preset-row') as HTMLDivElement;
PRESETS.forEach((p, i) => {
  const btn = document.createElement('button');
  btn.textContent = p.name;
  btn.addEventListener('click', () => {
    sim = p.build();
    view.selectedEventId = null;
    presetDescEl.textContent = p.description;
    presetRow.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    refresh();
  });
  presetRow.appendChild(btn);
  if (i === 0) {
    btn.classList.add('active');
    presetDescEl.textContent = p.description;
  }
});

// ---------- 控制 ----------

const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
btnPlay.addEventListener('click', () => {
  playing = !playing;
  btnPlay.textContent = playing ? '暂停' : '继续';
});
(document.getElementById('btn-step') as HTMLButtonElement).addEventListener('click', () => {
  playing = false;
  btnPlay.textContent = '继续';
  sim.tick();
  refresh();
});
(document.getElementById('btn-reset') as HTMLButtonElement).addEventListener('click', () => {
  sim.reset();
  view.selectedEventId = null;
  refresh();
});
(document.getElementById('chk-showtime') as HTMLInputElement).addEventListener('change', (e) => {
  view.showTime = (e.target as HTMLInputElement).checked;
  refresh();
});

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement).value as Mode;
    modeHintEl.textContent = MODE_HINTS[mode];
  });
});

// ---------- 画布交互 ----------

function cellFromEvent(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor((e.clientX - rect.left) / CELL),
    y: Math.floor((e.clientY - rect.top) / CELL),
  };
}

canvas.addEventListener('click', (e) => {
  const { x, y } = cellFromEvent(e);
  if (!sim.map.inBounds(x, y)) return;
  if (mode === 'emit') {
    const type = (document.querySelector('input[name="stype"]:checked') as HTMLInputElement).value as SoundType;
    const ev = sim.emit(type, x, y);
    if (!ev) modeHintEl.textContent = '该格是墙,无法发声。';
    else view.selectedEventId = ev.id;
  } else if (mode === 'door') {
    const c = sim.map.at(x, y);
    if (sim.npcs.some((n) => n.x === x && n.y === y)) return;
    if (c.terrain === 'floor') {
      c.terrain = 'door';
      c.doorOpen = false;
    } else if (c.terrain === 'door' && !c.doorOpen) {
      c.doorOpen = true;
    } else if (c.terrain === 'door') {
      c.terrain = 'floor';
      c.doorOpen = false;
    }
  } else {
    const c = sim.map.at(x, y);
    if (sim.npcs.some((n) => n.x === x && n.y === y)) return;
    if (c.terrain === 'floor') c.terrain = 'wall';
    else if (c.terrain === 'wall') c.terrain = 'floor';
  }
  refresh();
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = cellFromEvent(e);
  view.hover = { x, y };
  const text = hoverText(sim, view, x, y);
  if (text) {
    tooltip.style.display = 'block';
    tooltip.textContent = text;
    const rect = canvas.getBoundingClientRect();
    tooltip.style.left = `${e.clientX - rect.left + 14}px`;
    tooltip.style.top = `${e.clientY - rect.top + 14}px`;
  } else {
    tooltip.style.display = 'none';
  }
  drawFrame();
});
canvas.addEventListener('mouseleave', () => {
  view.hover = null;
  tooltip.style.display = 'none';
  drawFrame();
});

// ---------- 面板刷新 ----------

function refreshEvents(): void {
  if (sim.events.length === 0) {
    eventListEl.textContent = '(暂无事件)';
    return;
  }
  eventListEl.innerHTML = '';
  for (const ev of sim.events) {
    const div = document.createElement('div');
    div.className = 'event-item';
    const selId = view.selectedEventId ?? sim.events[sim.events.length - 1]?.id;
    if (ev.id === selId) div.classList.add('selected');
    div.textContent = `#${ev.id} ${SOUND_TYPE_INFO[ev.type].label} @(${ev.x},${ev.y}) t=${ev.t0} 初始强度${ev.initialIntensity}`;
    div.title = '点击在地图上显示该事件的传播';
    div.addEventListener('click', () => {
      view.selectedEventId = ev.id;
      refresh();
    });
    eventListEl.appendChild(div);
  }
}

function refreshNpcs(): void {
  npcListEl.innerHTML = '';
  for (const n of sim.npcs) {
    const card = document.createElement('div');
    card.className = 'npc-card';
    const target = n.investigationTarget();
    const state = target
      ? `<span class="state-investigate">调查事件#${target.eventId},${estimateDirText(target.entry)}</span>`
      : '<span class="state-idle">待机</span>';
    const lines: string[] = [`<div><b>${n.name}</b> @(${n.x},${n.y}) 阈值${n.threshold} — ${state}</div>`];
    for (const ev of sim.events) {
      const st = sim.npcEventStatus(n, ev);
      let cls = 'wait';
      let text: string;
      if (st.kind === 'heard') {
        cls = 'ok';
        text = `✔ t=${st.time} 听到,强度${st.intensity},${estimateDirText(st.entry)}`;
      } else if (st.kind === 'pending') {
        text = `… 尚未到达(预计 t=${st.time},强度${st.intensity})`;
      } else if (st.kind === 'too-quiet') {
        cls = 'bad';
        text = `✘ ${MISS_REASON_CN['too-quiet']}(${st.intensity} < ${n.threshold})`;
      } else {
        cls = 'bad';
        text = `✘ ${MISS_REASON_CN.unreachable}`;
      }
      lines.push(`<div class="ev-line ${cls}">事件#${ev.id}: ${text}</div>`);
    }
    card.innerHTML = lines.join('');
    npcListEl.appendChild(card);
  }
}

function drawFrame(): void {
  draw(ctx, sim, view);
}

function refresh(): void {
  clockEl.textContent = `t = ${sim.time}`;
  refreshEvents();
  refreshNpcs();
  drawFrame();
}

// ---------- 主循环 ----------

setInterval(() => {
  if (playing) {
    sim.tick();
    refresh();
  }
}, 250);

refresh();
