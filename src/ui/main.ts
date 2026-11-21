/**
 * UI 控制器：固定时间步长驱动引擎，requestAnimationFrame 只负责渲染。
 * 模拟步长由"模拟帧率"下拉框决定（可切到 4fps 模拟极端高速），
 * 与显示器刷新频率完全独立 —— 这是"成绩与显示帧率无关"的直接演示。
 */
import { createTrack } from '../engine/track';
import { LapSession, GateEvent, GateEventKind } from '../engine/session';
import { buildSamples, SampleDef } from '../engine/samples';
import { Path } from '../engine/path';
import { Recorder, Ghost, recordLapOffline } from '../engine/ghost';
import { Vec2, v } from '../engine/geometry';
import { Renderer, Flash, flashKindFor } from './renderer';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const track = createTrack();
const samples = buildSamples(track);
const session = new LapSession(track);
const renderer = new Renderer(canvas, track);
const recorder = new Recorder();

let activePath: Path | null = null;
let pathClock = 0;
let ghost: Ghost | null = null;
let flashes: Flash[] = [];
let playing = false;
let manual = false;
let simFps = 60;
let speedMul = 4;

// 手动驾驶状态
const car = { speed: 0, angle: 0, maxSpeed: 1400, accel: 520, turnRate: 2.6 };
const keys = new Set<string>();

// ---------- DOM ----------
const $ = (id: string) => document.getElementById(id)!;
const els = {
  clock: $('hud-clock'),
  mode: $('hud-mode'),
  lap: $('hud-lap'),
  laps: $('hud-laps'),
  expected: $('hud-expected'),
  fps: $('hud-fps'),
  log: $('log'),
  lapsCard: $('laps'),
  sampleSelect: $('sel-sample') as HTMLSelectElement,
  sampleDesc: $('sample-desc'),
  fpsSelect: $('sel-fps') as HTMLSelectElement,
  speedSelect: $('sel-speed') as HTMLSelectElement,
};

for (const s of samples) {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.label;
  els.sampleSelect.appendChild(opt);
}

const currentSample = (): SampleDef =>
  samples.find((s) => s.id === els.sampleSelect.value) ?? samples[0];

const refreshSampleDesc = (): void => {
  els.sampleDesc.textContent = currentSample().description;
};
els.sampleSelect.addEventListener('change', refreshSampleDesc);
refreshSampleDesc();

// ---------- 事件日志 ----------
const LOG_CLASS: Record<GateEventKind, string> = {
  'gate-hit': 'ok',
  lap: 'ok',
  'gate-reverse': 'bad',
  'gate-skip': 'bad',
  'gate-overlap': 'warn',
  'gate-ignored': 'warn',
};
const KIND_TAG: Record<GateEventKind, string> = {
  'gate-hit': '通过',
  lap: '完赛',
  'gate-reverse': '逆行',
  'gate-skip': '跳关',
  'gate-overlap': '重叠',
  'gate-ignored': '忽略',
};

let loggedSerial = 0;
function drainEvents(now: number): void {
  for (; loggedSerial < session.events.length; loggedSerial++) {
    const e = session.events[loggedSerial];
    appendLog(e);
    flashes.push({ pos: e.point, gate: e.gate, bornAt: now, kind: flashKindFor(e.kind) });
    if (flashes.length > 24) flashes.shift();
  }
}

function appendLog(e: GateEvent): void {
  const item = document.createElement('div');
  item.className = `log-item ${LOG_CLASS[e.kind]}`;
  item.innerHTML =
    `<span class="meta">t=${e.time.toFixed(4)}s · ${KIND_TAG[e.kind]}</span><br>${e.message}`;
  els.log.prepend(item);
  while (els.log.children.length > 60) els.log.lastChild?.remove();
}

function renderLaps(): void {
  if (session.laps.length === 0) {
    els.lapsCard.textContent = '尚无有效圈';
    return;
  }
  const rows = session.laps
    .map(
      (lap) =>
        `<tr><td>#${lap.index}</td><td>${lap.gateTimes[1]?.toFixed(3) ?? '—'}</td>` +
        `<td>${lap.gateTimes[2]?.toFixed(3) ?? '—'}</td><td>${lap.gateTimes[3]?.toFixed(3) ?? '—'}</td>` +
        `<td><b>${lap.total.toFixed(4)}s</b></td></tr>`,
    )
    .join('');
  els.lapsCard.innerHTML =
    '<table><tr><th>圈</th><th>G1</th><th>G2</th><th>G3</th><th>圈速</th></tr>' + rows + '</table>';
}

// ---------- 控制 ----------
function loadSample(autoplay: boolean): void {
  const sample = currentSample();
  resetAll();
  activePath = sample.path;
  pathClock = sample.path.frames[0].t;
  const first = sample.path.sampleAt(pathClock);
  session.reset(first.pos);
  session.angle = first.angle;
  car.angle = first.angle;
  manual = false;
  playing = autoplay;
  loggedSerial = 0;
  els.log.innerHTML = '';
}

function resetAll(): void {
  session.reset();
  activePath = null;
  playing = false;
  manual = false;
  car.speed = 0;
  car.angle = 0;
  pathClock = 0;
  flashes = [];
  loggedSerial = 0;
  recorder.recording && recorder.stop();
  updateRecordButton();
}

$('btn-play').addEventListener('click', () => {
  if (!activePath) loadSample(true);
  else {
    if (manual) loadSample(true);
    else playing = !playing;
  }
});
$('btn-reset').addEventListener('click', () => {
  resetAll();
  els.log.innerHTML = '';
  renderLaps();
});
$('btn-load').addEventListener('click', () => loadSample(false));
$('btn-pause').addEventListener('click', () => session.togglePause());
els.fpsSelect.addEventListener('change', () => {
  simFps = Number(els.fpsSelect.value);
});
els.speedSelect.addEventListener('change', () => {
  speedMul = Number(els.speedSelect.value);
});

// ---------- 录制与幻影 ----------
const recordBtn = $('btn-record') as HTMLButtonElement;
function updateRecordButton(): void {
  recordBtn.textContent = recorder.recording ? '■ 停止录制 (R)' : '● 录制手动路线 (R)';
}
recordBtn.addEventListener('click', toggleRecording);

function toggleRecording(): void {
  if (recorder.recording) {
    const frames = recorder.stop();
    updateRecordButton();
    if (frames.length >= 2 && session.lapCount > 0) {
      ghost = new Ghost(frames, 0);
      flashInfo(`录制结束：${frames.length} 帧，检测到有效圈，已生成同步幻影`);
    } else {
      flashInfo(`录制结束：${frames.length} 帧，但未产生有效圈，不生成幻影`);
    }
  } else {
    resetAll();
    manual = true;
    recorder.start();
    updateRecordButton();
    flashInfo('开始录制：手动驾驶，正向通过 G0→G1→G2→G3 完成一圈');
  }
}

$('btn-ghost').addEventListener('click', () => {
  const valid = samples.find((s) => s.id === 'valid')!;
  const tmp = new LapSession(track);
  try {
    const { ghost: g, events } = recordLapOffline(tmp, valid.path, 1 / 240);
    ghost = g;
    const lap = events.find((e) => e.kind === 'lap');
    flashInfo(`幻影已生成（离线 240Hz 录制，时长 ${g.duration.toFixed(2)}s，圈速 ${lap?.lapTime?.toFixed(4)}s）`);
  } catch (err) {
    flashInfo(`幻影生成失败：${(err as Error).message}`);
  }
});
$('btn-clear-ghost').addEventListener('click', () => {
  ghost = null;
});

function flashInfo(text: string): void {
  const e: GateEvent = {
    kind: 'gate-ignored',
    gate: -1,
    time: session.time,
    point: v(-100, -100),
    forward: true,
    overlap: false,
    mode: session.mode,
    message: text,
  };
  appendLog(e);
}

// ---------- 键盘 ----------
window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLSelectElement) return;
  keys.add(ev.code);
  if (ev.code === 'Space') {
    ev.preventDefault();
    session.togglePause();
  }
  if (ev.code === 'KeyR') toggleRecording();
  if (ev.code === 'KeyG') ($('btn-ghost') as HTMLButtonElement).click();
});
window.addEventListener('keyup', (ev) => keys.delete(ev.code));

// ---------- 模拟步进 ----------
function manualStep(dt: number): Vec2 {
  if (keys.has('ArrowUp')) car.speed += car.accel * dt;
  if (keys.has('ArrowDown')) car.speed -= car.accel * dt;
  if (!keys.has('ArrowUp') && !keys.has('ArrowDown')) {
    // 滑行阻尼
    car.speed *= Math.exp(-1.6 * dt);
  }
  car.speed = Math.max(-car.maxSpeed * 0.4, Math.min(car.maxSpeed, car.speed));
  const steer = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
  car.angle += steer * car.turnRate * dt * (0.35 + 0.65 * Math.min(1, Math.abs(car.speed) / 300));
  const next = v(
    session.pos.x + Math.cos(car.angle) * car.speed * dt,
    session.pos.y + Math.sin(car.angle) * car.speed * dt,
  );
  session.advance(dt, next, car.angle);
  return next;
}

function pathStep(dt: number): void {
  if (!activePath) return;
  pathClock += dt;
  const sample = activePath.sampleAt(pathClock);
  session.advance(dt, sample.pos, sample.angle);
  if (pathClock >= activePath.duration) playing = false;
}

function simStep(dt: number): void {
  if (manual) {
    manualStep(dt);
  } else if (playing && activePath) {
    pathStep(dt);
  } else {
    // 静止：仍推进时钟判定（无位移不会触发任何闸门）
    session.advance(dt, session.pos, session.angle);
  }
  // 暂停步内部不推进时钟/判定，capture 也会自动跳过
  recorder.capture(session);
}

// ---------- 主循环：固定步长 + 累加器，渲染独立 ----------
let lastWall = performance.now();
let acc = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let fpsLast = lastWall;

function frame(now: number): void {
  const wallDt = Math.min(0.1, (now - lastWall) / 1000);
  lastWall = now;

  // 暂停 = 整个模拟冻结：不消耗累加器，路径位置与时钟一起停住
  if (!session.paused) acc += wallDt * speedMul;
  const step = 1 / simFps;
  let guard = 0;
  while (acc >= step && guard < 400) {
    simStep(step);
    acc -= step;
    guard++;
  }
  if (guard === 400) acc = 0;

  drainEvents(now);
  renderLaps();
  updateHud(now);

  renderer.draw({
    carPos: session.pos,
    carAngle: session.angle,
    ghost,
    sessionTime: session.time,
    mode: session.mode,
    expected: session.expected,
    flashes,
    now,
    paused: session.paused,
  });

  requestAnimationFrame(frame);
}

function updateHud(now: number): void {
  els.clock.textContent = `${session.time.toFixed(4)} s`;
  els.mode.textContent = session.mode;
  els.mode.className = `metric mode-${session.mode}`;
  els.lap.textContent = session.mode === 'running' ? `${session.currentLapElapsed.toFixed(4)} s` : '—';
  els.laps.textContent = String(session.lapCount);
  els.expected.textContent = session.mode === 'running' ? `G${session.expected}` : session.mode === 'invalid' ? '作废' : 'G0';

  fpsFrames++;
  fpsAcc += (now - fpsLast) / 1000;
  fpsLast = now;
  if (fpsAcc >= 0.5) {
    els.fps.textContent = `${Math.round(fpsFrames / fpsAcc)} fps（模拟 ${simFps} fps）`;
    fpsFrames = 0;
    fpsAcc = 0;
  }
}

// 初始化：默认载入正常样例（不自动播放），便于先观察布局
loadSample(false);
requestAnimationFrame(frame);
