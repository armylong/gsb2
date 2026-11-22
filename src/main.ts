import {
  Input, NO_INPUT, RoundState, ConflictEntry, EventEntry, LevelDef,
  LEVELS, TICK_MS, ACTOR_R, REACH, PED_RADIUS,
  actorName, lampName, createRoundState, stepRound, simulate,
} from './sim.js';

// ---------- DOM ----------
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = (id: string) => document.getElementById(id)!;
const elRound = $('roundLabel'), elMode = $('modeLabel'), elHint = $('hint'), elBanner = $('banner');
const elState = $('statePanel'), elConflicts = $('conflictPanel'), elEvents = $('eventPanel');
const elCheck = $('checkResult');
const slider = $('timeline') as HTMLInputElement;
const btnPause = $('btnPause') as HTMLButtonElement;

// ---------- 会话状态 ----------
let level: LevelDef = LEVELS[0];
let recordings: Input[][] = [];      // 已完成轮次的输入(影子数据源, 重录只弹最后一轮)
let currentInputs: Input[] = [];     // 当前轮真人已录输入
let liveTick = 0;                    // 直播 frontier
let viewTick = 0;                    // 正在查看的拍
let mode: 'live' | 'review' = 'live';
let paused = false;
let roundEnding = false;
let advanceTimer: number | null = null;

// 直播增量状态(与 simulate 重放互相校验用)
let liveState: RoundState = createRoundState(level, 1);
let liveConflicts: ConflictEntry[] = [];
let liveEvents: EventEntry[] = [];
let snapshots: string[] = [];        // snapshots[t] = 第 t 拍执行后的状态 JSON

const SHADOW_COLORS = ['#e74c3c', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c'];

function resetLive(): void {
  currentInputs = [];
  liveTick = 0;
  viewTick = 0;
  mode = 'live';
  paused = false;
  roundEnding = false;
  if (advanceTimer !== null) { clearTimeout(advanceTimer); advanceTimer = null; }
  liveState = createRoundState(level, 1 + recordings.length);
  liveConflicts = [];
  liveEvents = [];
  snapshots = [];
  slider.max = '0';
  slider.value = '0';
}

function switchLevel(idx: number): void {
  level = LEVELS[idx];
  recordings = [];
  resetLive();
  elHint.textContent = level.hint;
  banner(`进入 ${level.name}`);
}

function banner(text: string): void {
  elBanner.textContent = text;
  elBanner.classList.add('show');
  setTimeout(() => elBanner.classList.remove('show'), 1800);
}

// ---------- 回合流转 ----------
function endRound(reason: string): void {
  recordings.push(currentInputs);
  const done = recordings.length;
  resetLive();
  banner(`${reason} 第${done}轮已记录, 进入第${done + 1}轮(影子 ×${recordings.length})`);
}

function scheduleRoundEnd(reason: string): void {
  if (roundEnding) return;
  roundEnding = true;
  banner(reason);
  advanceTimer = window.setTimeout(() => {
    advanceTimer = null;
    endRound(reason);
  }, 1400);
}

// ---------- 直播推进 ----------
const keys = new Set<string>();
let interactQueued = false;

function sampleInput(): Input {
  const dx = (keys.has('arrowright') || keys.has('d') ? 1 : 0) - (keys.has('arrowleft') || keys.has('a') ? 1 : 0);
  const dy = (keys.has('arrowdown') || keys.has('s') ? 1 : 0) - (keys.has('arrowup') || keys.has('w') ? 1 : 0);
  const act = interactQueued;
  interactQueued = false;
  return { dx, dy, act };
}

function advanceLive(): void {
  const inp = sampleInput();
  currentInputs.push(inp);
  const inputs: Input[] = [inp];
  for (const r of recordings) inputs.push(r[liveTick] ?? NO_INPUT);
  stepRound(level, liveState, inputs, liveEvents, liveConflicts);
  liveTick++;
  snapshots.push(JSON.stringify(liveState));
  slider.max = String(liveTick);
  if (mode === 'live') { viewTick = liveTick; slider.value = String(liveTick); }
  if (liveState.won) scheduleRoundEnd('🚪 门开了!');
  else if (liveTick >= level.roundTicks) scheduleRoundEnd('⏱ 时间到.');
}

// ---------- 查看状态: 直播用增量态, 回放用从 0 重放 ----------
function getView(): { state: RoundState; conflicts: ConflictEntry[]; events: EventEntry[] } {
  if (mode === 'live' && viewTick === liveTick) {
    return { state: liveState, conflicts: liveConflicts, events: liveEvents };
  }
  return simulate(level, recordings, currentInputs, viewTick);
}

// ---------- 渲染 ----------
function render(): void {
  const { state } = getView();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 地面
  ctx.fillStyle = '#1c2230';
  ctx.fillRect(0, 0, level.width, level.height);
  ctx.strokeStyle = '#2a3350';
  for (let x = 0; x <= level.width; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, level.height); ctx.stroke(); }
  for (let y = 0; y <= level.height; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(level.width, y); ctx.stroke(); }

  // 门
  const d = level.door;
  ctx.fillStyle = state.doorOpen ? '#3ddc84' : '#5a2d2d';
  ctx.fillRect(d.x, d.y, d.w, d.h);
  if (state.doorOpen) {
    ctx.shadowColor = '#3ddc84'; ctx.shadowBlur = 18;
    ctx.fillRect(d.x, d.y, d.w, d.h);
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = '#cfd8ff';
  ctx.font = '13px sans-serif';
  ctx.fillText(state.doorOpen ? '门 · 开' : '门 · 关', d.x + d.w / 2 - 22, d.y + d.h + 16);

  // 底座
  level.pedestals.forEach((p, i) => {
    const lit = state.lamps.some(l => l.pedestal === i);
    ctx.strokeStyle = lit ? '#ffd54a' : '#6b7590';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x - 16, p.y - 16, 32, 32);
    if (lit) {
      ctx.fillStyle = 'rgba(255,213,74,0.18)';
      ctx.beginPath(); ctx.arc(p.x, p.y, PED_RADIUS + 14, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#8b95b0';
    ctx.fillText(`底座${i + 1}`, p.x - 18, p.y + 34);
  });

  // 灯
  for (const l of state.lamps) {
    const held = l.holder >= 0;
    const lx = l.x, ly = held ? l.y - 22 : l.y;
    ctx.fillStyle = '#ffd54a';
    ctx.shadowColor = '#ffd54a';
    ctx.shadowBlur = l.pedestal >= 0 ? 16 : 6;
    ctx.beginPath(); ctx.arc(lx, ly, 8, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#7a6200';
    ctx.fillText(lampName(l.id), lx - 10, ly - 12);
  }

  // 角色: 影子先画, 真人最后
  const actors = [...state.actors].sort((a, b) => b.id - a.id);
  for (const a of actors) {
    const isPlayer = a.id === 0;
    const color = isPlayer ? '#4da3ff' : SHADOW_COLORS[(a.id - 1) % SHADOW_COLORS.length];
    ctx.globalAlpha = isPlayer ? 1 : 0.55;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(a.x, a.y, ACTOR_R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isPlayer ? '#ffffff' : color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = isPlayer ? '#ffffff' : color;
    ctx.fillText(isPlayer ? '你' : `影${a.id}`, a.x - 8, a.y - ACTOR_R - 6);
  }

  // 真人拾取范围提示
  const me = state.actors[0];
  if (me && mode === 'live') {
    ctx.strokeStyle = 'rgba(77,163,255,0.25)';
    ctx.beginPath(); ctx.arc(me.x, me.y, REACH, 0, Math.PI * 2); ctx.stroke();
  }

  // 顶部 HUD
  ctx.fillStyle = '#cfd8ff';
  ctx.font = '14px sans-serif';
  const t = state.tick;
  ctx.fillText(
    `第 ${recordings.length + 1} 轮   t=${t}/${level.roundTicks} (${(t / 20).toFixed(1)}s)   ${mode === 'live' ? (paused ? '直播·暂停' : '直播') : `回放 t=${viewTick}`}`,
    12, 20,
  );
}

// ---------- 侧面板 ----------
function updatePanel(): void {
  const { state, conflicts, events } = getView();
  elRound.textContent = `第 ${recordings.length + 1} 轮 · 已完成 ${recordings.length} 轮录制`;
  elMode.textContent = mode === 'live'
    ? (paused ? '直播(暂停中)' : '直播')
    : `回放第 ${viewTick} 拍(操作已锁定, 点「回到直播」继续)`;

  const actorRows = state.actors.map(a =>
    `<div class="row"><b style="color:${a.id === 0 ? '#4da3ff' : SHADOW_COLORS[(a.id - 1) % SHADOW_COLORS.length]}">${actorName(a.id)}</b>` +
    ` (${Math.round(a.x)},${Math.round(a.y)}) ${a.carrying >= 0 ? '拿着' + lampName(a.carrying) : '空手'}</div>`).join('');
  const lampRows = state.lamps.map(l => {
    const where = l.holder >= 0 ? `被${actorName(l.holder)}拿着`
      : l.pedestal >= 0 ? `在底座${l.pedestal + 1}上`
      : `在地上(${Math.round(l.x)},${Math.round(l.y)})`;
    return `<div class="row">${lampName(l.id)}: ${where}</div>`;
  }).join('');
  elState.innerHTML = actorRows + lampRows +
    `<div class="row">门: ${state.doorOpen ? '<b style="color:#3ddc84">开</b>' : '关'}</div>`;

  const shownConflicts = conflicts.filter(c => c.tick <= viewTick);
  elConflicts.innerHTML = shownConflicts.length === 0
    ? '<div class="dim">本轮暂无抢灯冲突</div>'
    : shownConflicts.map(c =>
      `<div class="row conflict">t=${c.tick} ${lampName(c.lampId)}: ` +
      `${c.contenders.map(actorName).join(' vs ')} → <b>${actorName(c.winner)}</b> 获得</div>`).join('');

  const shownEvents = events.filter(e => e.tick <= viewTick).slice(-9);
  elEvents.innerHTML = shownEvents.map(e => `<div class="row dim">t=${e.tick} ${e.text}</div>`).join('');
}

// ---------- 主循环 ----------
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  acc += now - last;
  last = now;
  if (mode === 'live' && !paused && !roundEnding) {
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      advanceLive();
      if (roundEnding) { acc = 0; break; }
    }
  } else {
    acc = 0;
  }
  render();
  updatePanel();
  requestAnimationFrame(frame);
}

// ---------- 事件绑定 ----------
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (k === 'e' || k === 'j' || k === ' ') {
    if (mode === 'live' && !paused && !roundEnding) interactQueued = true;
    return;
  }
  if (k === 'p') { togglePause(); return; }
  keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function togglePause(): void {
  if (mode !== 'live') return;
  paused = !paused;
  btnPause.textContent = paused ? '继续' : '暂停';
}

btnPause.onclick = togglePause;

$('btnStepBack').onclick = () => {
  if (viewTick > 0) {
    mode = 'review';
    viewTick--;
    slider.value = String(viewTick);
  }
};
$('btnStepFwd').onclick = () => {
  if (viewTick < liveTick) {
    if (viewTick + 1 === liveTick && mode === 'review') { /* 允许走到 frontier */ }
    mode = 'review';
    viewTick++;
    slider.value = String(viewTick);
  }
};
$('btnLive').onclick = () => {
  mode = 'live';
  viewTick = liveTick;
  slider.value = String(liveTick);
  interactQueued = false;
};
slider.oninput = () => {
  mode = 'review';
  viewTick = Number(slider.value);
};

$('btnEndRound').onclick = () => {
  if (roundEnding) return;
  if (currentInputs.length === 0) { banner('本轮还没有任何输入'); return; }
  endRound('手动结束.');
};

$('btnResetRound').onclick = () => {
  resetLive();
  banner('本轮已重置, 之前的录制保留');
};

$('btnRerecord').onclick = () => {
  if (recordings.length === 0) { banner('还没有已完成的轮次可重录'); return; }
  recordings.pop();
  resetLive();
  banner(`已丢弃上一轮录制, 重录第 ${recordings.length + 1} 轮(更早轮次保留)`);
};

$('btnCheck').onclick = () => {
  // 连续播放的增量快照 vs 每拍从 0 直接定位, 必须完全一致
  let bad = 0;
  let firstBad = -1;
  for (let t = 0; t <= liveTick; t++) {
    const fresh = JSON.stringify(simulate(level, recordings, currentInputs, t).state);
    const snap = t === 0
      ? JSON.stringify(createRoundState(level, 1 + recordings.length))
      : snapshots[t - 1];
    if (fresh !== snap) { bad++; if (firstBad < 0) firstBad = t; }
  }
  elCheck.textContent = bad === 0
    ? `✓ 0..${liveTick} 共 ${liveTick + 1} 拍: 连续播放与直接定位完全一致`
    : `✗ ${bad} 拍不一致, 首个 t=${firstBad}`;
  elCheck.style.color = bad === 0 ? '#3ddc84' : '#ff6b6b';
};

$('btnLevel1').onclick = () => switchLevel(0);
$('btnLevel2').onclick = () => switchLevel(1);

// ---------- 启动 ----------
elHint.textContent = level.hint;
requestAnimationFrame(frame);
