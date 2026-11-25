import { angleDiff, rad2deg, vec, wrapAngle, type Vec2 } from './vec';
import { describeAwa, makeBoat } from './engine/physics';
import { createWorld, FIXED_DT, stepWorld, WORLD_H, WORLD_W } from './engine/world';
import { BUOYS, COURSES, CURRENTS, DEFAULT_WIND } from './engine/courses';
import type { BoatReadout, Inputs, WindState } from './engine/types';
import { CourseTracker } from './engine/course';
import { InputRecorder, ReplayPlayer, type ReplaySnapshot } from './engine/replay';
import { Renderer } from './render/renderer';

interface UiState {
  paused: boolean;
  showVectors: boolean;
  windDirDeg: number;
  windSpeed: number;
  sheet: number;
  courseIndex: number;
  mode: 'live' | 'replay';
  replaySheetMode: 'original' | 'fixed';
  replayFixedSheet: number;
}

const deg = (d: number) => (d * Math.PI) / 180;

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const hud = document.getElementById('hud')!;
const panel = document.getElementById('panel')!;
const logEl = document.getElementById('log')!;
const overlay = document.getElementById('overlay')!;

const state: UiState = {
  paused: false,
  showVectors: true,
  windDirDeg: rad2deg(DEFAULT_WIND.dir),
  windSpeed: DEFAULT_WIND.speed,
  sheet: COURSES[0].defaultSheet,
  courseIndex: 0,
  mode: 'live',
  replaySheetMode: 'fixed',
  replayFixedSheet: 0.5,
};

let wind: WindState = { ...DEFAULT_WIND };
let world = createWorld(wind, BUOYS, CURRENTS);
let boat = makeBoat(COURSES[0].startPos, COURSES[0].startHeading);
let tracker = new CourseTracker(COURSES[0]);
let readout: BoatReadout | null = null;
let trail: Vec2[] = [];
let recorder: InputRecorder | null = null;
let lastSnapshot: ReplaySnapshot | null = null;
let replayPlayer: ReplayPlayer | null = null;
let ghostPlayer: ReplayPlayer | null = null;
let replayGhost: { boat: ReturnType<typeof makeBoat>; trail: Vec2[] } | null = null;

const keys = new Set<string>();
const windArrowSeed: { pos: Vec2; phase: number }[] = [];
for (let x = 40; x < WORLD_W; x += 90) {
  for (let y = 40; y < WORLD_H; y += 90) {
    windArrowSeed.push({ pos: vec(x, y), phase: Math.random() * Math.PI * 2 });
  }
}

function currentCourse() {
  return COURSES[state.courseIndex];
}

function resetRun(): void {
  const c = currentCourse();
  wind = { dir: deg(state.windDirDeg), speed: state.windSpeed };
  world = createWorld(wind, BUOYS, CURRENTS);
  boat = makeBoat(c.startPos, c.startHeading);
  tracker = new CourseTracker(c);
  readout = null;
  trail = [];
  replayPlayer = null;
  ghostPlayer = null;
  replayGhost = null;
  ghostWorld = null;
  state.mode = 'live';
  recorder = new InputRecorder(wind, c.startPos, c.startHeading);
  recorder.begin(wind, c.startPos, c.startHeading);
  log(`重置：${c.name}`);
}

function log(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.prepend(line);
  while (logEl.children.length > 6) logEl.lastChild?.remove();
}

function readInputs(): Inputs {
  let rudder = 0;
  if (keys.has('a') || keys.has('arrowleft')) rudder -= 1;
  if (keys.has('d') || keys.has('arrowright')) rudder += 1;
  return { rudder, sheet: state.sheet };
}

let acc = 0;
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!state.paused) {
    acc += dt;
    while (acc >= FIXED_DT) {
      tick(FIXED_DT);
      acc -= FIXED_DT;
    }
  }
  draw();
  requestAnimationFrame(frame);
}

function tick(dt: number): void {
  const input = readInputs();
  if (state.mode === 'live') {
    const result = stepWorld(world, boat, input);
    readout = result.readout;
    recorder?.record(input, dt);
    pushTrail();
    const ev = tracker.check(trail[trail.length - 2] ?? boat.pos, boat.pos, world.time);
    handleGateEvent(ev.event);
  } else if (replayPlayer) {
    // 主船：用录制的原始帆角；幽灵船：用统一对照帆角。两者共用同一套打舵序列
    const inp = replayPlayer.next('original', state.replayFixedSheet);
    if (inp) {
      const result = stepWorld(world, boat, inp);
      readout = result.readout;
      pushTrail();
      tracker.check(trail[trail.length - 2] ?? boat.pos, boat.pos, world.time);
    }
    if (replayGhost && ghostPlayer) {
      const ghostInp = ghostPlayer.next('fixed', state.replayFixedSheet);
      if (ghostInp) {
        stepWorld(ghostWorldSafe(), replayGhost.boat, ghostInp);
        replayGhost.trail.push({ ...replayGhost.boat.pos });
      }
    }
  }
}

// 幽灵船需要独立世界，懒加载
let ghostWorld: ReturnType<typeof createWorld> | null = null;
function ghostWorldSafe() {
  if (!ghostWorld) ghostWorld = createWorld(wind, BUOYS, CURRENTS);
  return ghostWorld;
}

function pushTrail(): void {
  trail.push({ ...boat.pos });
  if (trail.length > 1200) trail.shift();
}

function handleGateEvent(ev: ReturnType<CourseTracker['check']>['event']): void {
  if (!ev) return;
  if (ev.ok) log(`✓ 通过 ${ev.label}（${ev.side === 'port' ? '左舷' : ev.side === 'starboard' ? '右舷' : '任意'}侧）`);
  else for (const r of ev.reasons) log(`✗ ${ev.label}：${r}`);
  if (tracker.finished) log(`🏁 路线完成！用时 ${tracker.finishTime?.toFixed(1)} 秒`);
}

function draw(): void {
  renderer.render({
    boat,
    readout: readout ?? blankReadout(),
    wind,
    currents: CURRENTS,
    buoys: BUOYS,
    course: currentCourse(),
    nextGateIndex: tracker.nextIndex,
    paused: state.paused,
    showVectors: state.showVectors,
    trail,
    windArrows: windArrowSeed.map((w) => ({ pos: w.pos, phase: w.phase + world.time * 2 })),
    ghost: replayGhost,
  });
  renderHud();
  if (state.paused) renderPausePanel();
  overlay.classList.toggle('hidden', !state.paused);
}

function blankReadout(): BoatReadout {
  return {
    apparentWind: vec(0, 0), apparentSpeed: 0, awa: 0, aoa: 0,
    sailForce: vec(0, 0), sailForceMag: 0, boomOffset: 0, luffing: false,
    leeway: 0, sog: 0, stw: 0, cog: boat.heading, vmgUpwind: 0,
    inNoGo: false, inIrons: false, tack: 'none', current: vec(0, 0),
  };
}

function renderHud(): void {
  const r = readout ?? blankReadout();
  const windFromDeg = ((rad2deg(wind.dir) + 180) % 360 + 360) % 360;
  hud.innerHTML = `
    <div class="hud-grid">
      <div><span class="k">航向</span><b>${rad2deg(boat.heading).toFixed(0)}°</b></div>
      <div><span class="k">对地航速</span><b>${r.sog.toFixed(2)}</b> m/s</div>
      <div><span class="k">对水航速</span><b>${r.stw.toFixed(2)}</b> m/s</div>
      <div><span class="k">表观风角</span><b class="${r.inNoGo ? 'warn' : ''}">${rad2deg(r.awa).toFixed(0)}°</b></div>
      <div><span class="k">帆攻角</span><b>${rad2deg(r.aoa).toFixed(0)}°</b></div>
      <div><span class="k">迎风VMG</span><b>${r.vmgUpwind.toFixed(2)}</b></div>
      <div><span class="k">侧漂</span><b>${r.leeway.toFixed(2)}</b></div>
      <div><span class="k">帆受力</span><b>${r.sailForceMag.toFixed(1)}</b></div>
      <div><span class="k">受风舷</span><b>${r.tack === 'port' ? '左舷' : r.tack === 'starboard' ? '右舷' : '—'}</b></div>
      <div><span class="k">帆状态</span><b class="${r.luffing ? 'warn' : ''}">${r.luffing ? '飘帆' : '吃风'}</b></div>
      <div><span class="k">水流</span><b>(${r.current.x.toFixed(1)},${r.current.y.toFixed(1)})</b></div>
      <div><span class="k">风眼方位</span><b>${windFromDeg.toFixed(0)}° / ${wind.speed.toFixed(1)}m/s</b></div>
    </div>
    <div class="hud-sub">
      <span class="tag ${r.inNoGo ? 'tag-warn' : 'tag-ok'}">${describeAwa(r.awa)}</span>
      <span class="tag">帆索 ${(state.sheet * 100).toFixed(0)}%</span>
      <span class="tag">门 ${tracker.nextIndex}/${currentCourse().gates.length}</span>
      <span class="tag">${state.mode === 'live' ? '实时' : '回放'}</span>
    </div>`;
}

function renderPausePanel(): void {
  const r = readout ?? blankReadout();
  overlay.innerHTML = `
    <div class="pause-card">
      <h2>已暂停 · 环境与航态</h2>
      <div class="pause-grid">
        <div><span>风向（吹去）</span><b>${state.windDirDeg.toFixed(0)}°</b></div>
        <div><span>风眼方位</span><b>${(((state.windDirDeg + 180) % 360) + 360) % 360}°</b></div>
        <div><span>风速</span><b>${state.windSpeed.toFixed(1)} m/s</b></div>
        <div><span>表观风速</span><b>${r.apparentSpeed.toFixed(2)} m/s</b></div>
        <div><span>对水/对地</span><b>${r.stw.toFixed(2)} / ${r.sog.toFixed(2)} m/s</b></div>
        <div><span>实际运动向</span><b>${rad2deg(r.cog).toFixed(0)}°</b></div>
        <div><span>船头向</span><b>${rad2deg(boat.heading).toFixed(0)}°</b></div>
        <div><span>水流向量</span><b>(${r.current.x.toFixed(2)}, ${r.current.y.toFixed(2)})</b></div>
      </div>
      <p class="hint">暂停时可调节风向、风速、帆索，恢复后立即生效。</p>
    </div>`;
}

// ---------- 控件 ----------
function buildPanel(): void {
  panel.innerHTML = `
    <div class="ctrl">
      <label>风向 <input id="windDir" type="range" min="0" max="359" value="${state.windDirDeg}"></label>
      <label>风速 <input id="windSpd" type="range" min="2" max="12" step="0.5" value="${state.windSpeed}"></label>
      <label>帆索（收→松）<input id="sheet" type="range" min="0" max="1" step="0.01" value="${state.sheet}"></label>
    </div>
    <div class="btn-row">
      <button id="pauseBtn">暂停</button>
      <button id="vectorBtn">向量:开</button>
      <button id="resetBtn">重置</button>
      <button id="recordStopBtn">结束录制</button>
      <button id="abBtn">A/B 帆角对照</button>
    </div>
    <div class="btn-row">
      ${COURSES.map((c, i) => `<button class="course-btn" data-i="${i}">${c.name}</button>`).join('')}
    </div>
    <div class="ctrl" id="abControls" style="display:none">
      <label>对照帆角 <input id="abSheet" type="range" min="0" max="1" step="0.01" value="${state.replayFixedSheet}"></label>
    </div>
    <p class="help">A/← 左舵 · D/→ 右舵 · 空格暂停 · R 重置 · V 向量 · E 结束录制 · B 帆角对照</p>`;

  const bind = (id: string, fn: (el: HTMLInputElement) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.addEventListener('input', () => fn(el));
  };
  bind('windDir', (el) => {
    state.windDirDeg = Number(el.value);
    world.wind.dir = deg(state.windDirDeg);
  });
  bind('windSpd', (el) => {
    state.windSpeed = Number(el.value);
    world.wind.speed = state.windSpeed;
  });
  bind('sheet', (el) => { state.sheet = Number(el.value); });
  bind('abSheet', (el) => { state.replayFixedSheet = Number(el.value); });

  document.getElementById('pauseBtn')!.addEventListener('click', togglePause);
  document.getElementById('vectorBtn')!.addEventListener('click', () => {
    state.showVectors = !state.showVectors;
    (document.getElementById('vectorBtn') as HTMLButtonElement).textContent = `向量:${state.showVectors ? '开' : '关'}`;
  });
  document.getElementById('resetBtn')!.addEventListener('click', resetRun);
  document.getElementById('recordStopBtn')!.addEventListener('click', stopRecording);
  document.getElementById('abBtn')!.addEventListener('click', startABReplay);
  document.querySelectorAll('.course-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.courseIndex = Number((b as HTMLElement).dataset.i);
      state.sheet = currentCourse().defaultSheet;
      (document.getElementById('sheet') as HTMLInputElement).value = String(state.sheet);
      resetRun();
    }),
  );
}

function togglePause(): void {
  state.paused = !state.paused;
  (document.getElementById('pauseBtn') as HTMLButtonElement).textContent = state.paused ? '继续' : '暂停';
}

function stopRecording(): void {
  if (!recorder || state.mode !== 'live') return;
  lastSnapshot = recorder.stop();
  log(`录制结束：${lastSnapshot.frames.length} 帧，${lastSnapshot.duration.toFixed(1)} 秒`);
}

function startABReplay(): void {
  if (!lastSnapshot) {
    log('请先实时航行并点击「结束录制」，再做帆角对照');
    return;
  }
  resetRun();
  state.mode = 'replay';
  replayPlayer = new ReplayPlayer(lastSnapshot);
  ghostPlayer = new ReplayPlayer(lastSnapshot);
  ghostWorld = createWorld(wind, BUOYS, CURRENTS);
  replayGhost = { boat: makeBoat(lastSnapshot.startPos, lastSnapshot.startHeading), trail: [] };
  document.getElementById('abControls')!.style.display = '';
  log('A/B 对照：主船用原帆角，幽灵船用对照帆角（同一条打舵序列）');
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (k === ' ') togglePause();
  else if (k === 'r') resetRun();
  else if (k === 'v') {
    state.showVectors = !state.showVectors;
    (document.getElementById('vectorBtn') as HTMLButtonElement).textContent = `向量:${state.showVectors ? '开' : '关'}`;
  } else if (k === 'e') stopRecording();
  else if (k === 'b') startABReplay();
  else keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// 触屏：左右半屏按住打舵，滑块调帆
let touchRudder = 0;
canvas.addEventListener('pointerdown', (e) => {
  touchRudder = e.offsetX < canvas.width / 2 ? -1 : 1;
  keys.add(touchRudder < 0 ? 'a' : 'd');
});
canvas.addEventListener('pointerup', () => {
  keys.delete('a');
  keys.delete('d');
  touchRudder = 0;
});
canvas.addEventListener('pointercancel', () => {
  keys.delete('a');
  keys.delete('d');
});

buildPanel();
resetRun();
requestAnimationFrame(frame);

// 避免未使用告警
void angleDiff;
void wrapAngle;
