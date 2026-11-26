import { BeltScene, type SceneStatus } from './three/scene';
import { PRESETS, clonePulleys, DEFAULT_STEP } from './state/presets';
import type { Conflict, Pulley } from './math/belt';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const viewport = $('viewport');
const scene = new BeltScene(viewport, onStatus);

/** 当前编辑中的摆位（失效时仍保留，滑杆可继续调） */
let pulleys: Pulley[] = clonePulleys(PRESETS[0].pulleys);
const stepDistance = DEFAULT_STEP;
let lastStatus: SceneStatus | null = null;

// ---------- 摆位按钮 ----------

const presetBox = $('presets');
PRESETS.forEach((preset, i) => {
  const btn = document.createElement('button');
  btn.textContent = preset.name;
  btn.title = preset.description;
  btn.addEventListener('click', () => applyPreset(i));
  presetBox.appendChild(btn);
});

function applyPreset(i: number) {
  pulleys = clonePulleys(PRESETS[i].pulleys);
  syncSlidersFromMiddle();
  scene.rebuild(pulleys);
}

// ---------- 中间轮滑杆 ----------

const mx = $('mx') as HTMLInputElement;
const my = $('my') as HTMLInputElement;
const mr = $('mr') as HTMLInputElement;

function syncSlidersFromMiddle() {
  mx.value = String(pulleys[1].center.x);
  my.value = String(pulleys[1].center.y);
  mr.value = String(pulleys[1].radius);
  $('v-mx').textContent = Number(mx.value).toFixed(2);
  $('v-my').textContent = Number(my.value).toFixed(2);
  $('v-mr').textContent = Number(mr.value).toFixed(2);
}

function onMiddleChange() {
  pulleys[1] = {
    center: { x: Number(mx.value), y: Number(my.value) },
    radius: Number(mr.value),
  };
  $('v-mx').textContent = Number(mx.value).toFixed(2);
  $('v-my').textContent = Number(my.value).toFixed(2);
  $('v-mr').textContent = Number(mr.value).toFixed(2);
  scene.rebuild(pulleys);
}
for (const el of [mx, my, mr]) el.addEventListener('input', onMiddleChange);

// ---------- 走带控制 ----------

const playBtn = $('play');
playBtn.addEventListener('click', () => {
  scene.setRunning(!scene.isRunning());
  playBtn.textContent = scene.isRunning() ? '暂停' : '继续';
});

$('reverse').addEventListener('click', () => {
  scene.setDirection((scene.getDirection() * -1) as 1 | -1);
});

$('step-fwd').addEventListener('click', () => scene.step(stepDistance));
$('step-back').addEventListener('click', () => scene.step(-stepDistance));
$('v-step').textContent = stepDistance.toFixed(2);

const speed = $('speed') as HTMLInputElement;
speed.addEventListener('input', () => {
  $('v-speed').textContent = Number(speed.value).toFixed(2);
  scene.setSpeed(Number(speed.value));
});

const spacing = $('spacing') as HTMLInputElement;
spacing.addEventListener('input', () => {
  $('v-spacing').textContent = Number(spacing.value).toFixed(2);
  scene.setSpacing(Number(spacing.value));
});

// ---------- 选中刻度 ----------

const selectMarker = $('select-marker') as HTMLSelectElement;
selectMarker.addEventListener('change', () => {
  scene.selectByLabel(selectMarker.value === '' ? null : Number(selectMarker.value));
});

$('focus').addEventListener('click', () => {
  if (!scene.focusSelected()) {
    flashHint('请先选择一条数字刻度');
  }
});

// ---------- 键盘快捷键 ----------

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  switch (e.key) {
    case ' ':
      playBtn.click();
      e.preventDefault();
      break;
    case 'r':
    case 'R':
      scene.setDirection((scene.getDirection() * -1) as 1 | -1);
      break;
    case 'ArrowRight':
      scene.step(stepDistance);
      e.preventDefault();
      break;
    case 'ArrowLeft':
      scene.step(-stepDistance);
      e.preventDefault();
      break;
    case 'f':
    case 'F':
      scene.focusSelected();
      break;
  }
});

// ---------- 状态回显 ----------

function onStatus(s: SceneStatus) {
  lastStatus = s;
  $('r-length').textContent = s.length ? s.length.toFixed(3) : '—';
  $('r-phase').textContent = s.phase.toFixed(3);
  $('r-dist').textContent = s.distanceToSeam === null ? '—' : s.distanceToSeam.toFixed(3);
  $('r-dir').textContent = s.speed === 0 ? '停止' : scene.getDirection() > 0 ? '正向（s 增大）' : '反向（s 减小）';

  const contacts = $('r-contacts');
  contacts.innerHTML = s.contacts
    .map(
      (c) =>
        `<div class="contact-line"><span>轮 ${c.pulley} 接触包角</span><strong>${c.wrapDeg.toFixed(1)}°</strong></div>`,
    )
    .join('');

  const conflictBox = $('conflict-box');
  const conflictList = $('conflict-list');
  if (s.ok) {
    conflictBox.classList.add('hidden');
  } else {
    conflictBox.classList.remove('hidden');
    conflictList.innerHTML = s.conflicts.map(renderConflict).join('');
  }

  // 同步选中下拉（重建后编号集合可能变化）
  syncMarkerSelect(s);
}

function renderConflict(c: Conflict): string {
  const tags = c.wheels.map((w) => `<span class="wheel-tag">轮 ${w}</span>`).join('');
  return `<div class="conflict-item">${tags}<div>${c.message}</div></div>`;
}

function syncMarkerSelect(s: SceneStatus) {
  const prev = selectMarker.value;
  const count = s.length && s.spacing ? Math.floor(s.length / s.spacing) : 0;
  const options = ['<option value="">（不选择）</option>'];
  for (let k = 0; k < count; k += 5) options.push(`<option value="${k}">刻度 #${k}</option>`);
  selectMarker.innerHTML = options.join('');
  const target = s.selectedLabel !== null ? String(s.selectedLabel) : prev;
  if (Array.from(selectMarker.options).some((o) => o.value === target)) {
    selectMarker.value = target;
  } else {
    selectMarker.value = '';
  }
}

let hintTimer: number | undefined;
function flashHint(text: string) {
  const el = $('focus');
  const old = el.textContent;
  el.textContent = text;
  el.classList.add('danger');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    el.textContent = old;
    el.classList.remove('danger');
  }, 1400);
}

// ---------- 启动 ----------

syncSlidersFromMiddle();
scene.setSpeed(Number(speed.value));
scene.rebuild(pulleys);

// 暴露给控制台调试
Object.assign(window, { beltDebug: { scene, getPulleys: () => pulleys, getStatus: () => lastStatus } });
