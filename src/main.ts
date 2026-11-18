// 页面主逻辑：固定步长推进 + 控件 + 曲线记录 + 参数对照
import {
  createSim, applyParams, setDrive, step, getCompression,
  FIXED_DT, DEFAULT_PARAMS,
  type Sim, type SimParams, type TerrainKind, type DriveMode,
} from './sim';
import { drawScene } from './render';
import { drawChart, emptyRecord, type RunRecord } from './charts';

const view = document.getElementById('view') as HTMLCanvasElement;
const chart = document.getElementById('chart') as HTMLCanvasElement;
const vctx = view.getContext('2d')!;
const cctx = chart.getContext('2d')!;

let terrain: TerrainKind = 'flat';
let params: SimParams = { ...DEFAULT_PARAMS };
let sim: Sim = createSim(params, terrain);
let record: RunRecord = emptyRecord();
let running = false;
let snapshotA: { params: SimParams; terrain: TerrainKind; record: RunRecord } | null = null;

// ---- 画布尺寸（含 DPR）----
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const r = view.getBoundingClientRect();
  view.width = Math.round(r.width * dpr);
  view.height = Math.round(r.height * dpr);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cr = chart.getBoundingClientRect();
  chart.width = Math.round(cr.width * dpr);
  chart.height = Math.round(cr.height * dpr);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

// ---- 控件 ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sStiff = $<HTMLInputElement>('sStiff');
const sDamp = $<HTMLInputElement>('sDamp');
const sMass = $<HTMLInputElement>('sMass');

function syncSliders(): void {
  sStiff.value = String(params.stiffness);
  sDamp.value = String(params.damping);
  sMass.value = String(params.chassisMass);
  $('vStiff').textContent = String(params.stiffness);
  $('vDamp').textContent = String(params.damping);
  $('vMass').textContent = String(params.chassisMass);
}

function onParamInput(): void {
  params = {
    stiffness: Number(sStiff.value),
    damping: Number(sDamp.value),
    chassisMass: Number(sMass.value),
  };
  syncSliders();
  applyParams(sim, params); // 运行中改参数：只换系数，不残留旧力
}
sStiff.addEventListener('input', onParamInput);
sDamp.addEventListener('input', onParamInput);
sMass.addEventListener('input', onParamInput);

// 地形切换：重建世界并清空旧曲线
document.querySelectorAll<HTMLButtonElement>('#terrainRow button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#terrainRow button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    terrain = btn.dataset.terrain as TerrainKind;
    reset();
  });
});

function reset(): void {
  // 整体重建世界：相同参数下落点与初始速度完全一致
  sim = createSim(params, terrain);
  record = emptyRecord();
}

const btnRun = $<HTMLButtonElement>('btnRun');
function setRunning(v: boolean): void {
  running = v;
  btnRun.textContent = running ? '暂停' : '运行';
}
btnRun.addEventListener('click', () => setRunning(!running));
$('btnStep').addEventListener('click', () => {
  setRunning(false);
  stepOnce();
});
$('btnReset').addEventListener('click', () => {
  setRunning(false);
  reset();
});

// ---- 驱动 ----
const keys = new Set<string>();
function updateDriveFromKeys(): void {
  let mode: DriveMode = 'coast';
  if (keys.has('ArrowRight') || keys.has('KeyD')) mode = 'forward';
  if (keys.has('ArrowLeft') || keys.has('KeyA')) mode = 'reverse';
  if (keys.has('ArrowDown') || keys.has('KeyS') || keys.has('Space')) mode = 'brake';
  setDrive(sim, mode);
}
window.addEventListener('keydown', (e) => {
  if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  updateDriveFromKeys();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  updateDriveFromKeys();
});

function bindDriveButton(id: string, mode: DriveMode): void {
  const btn = $(id);
  const on = (e: Event) => { e.preventDefault(); setDrive(sim, mode); };
  const off = () => { if (sim.drive === mode) setDrive(sim, 'coast'); };
  btn.addEventListener('mousedown', on);
  btn.addEventListener('touchstart', on);
  btn.addEventListener('mouseup', off);
  btn.addEventListener('mouseleave', off);
  btn.addEventListener('touchend', off);
}
bindDriveButton('btnFwd', 'forward');
bindDriveButton('btnRev', 'reverse');
bindDriveButton('btnBrake', 'brake');
$('btnCoast').addEventListener('click', () => setDrive(sim, 'coast'));

// ---- 参数对照 ----
const cmpStatus = $('cmpStatus');
$('btnSaveA').addEventListener('click', () => {
  snapshotA = {
    params: { ...params },
    terrain,
    record: { t: [...record.t], cL: [...record.cL], cR: [...record.cR] },
  };
  cmpStatus.textContent = `已保存对照A：k=${params.stiffness} c=${params.damping} m=${params.chassisMass}，地形=${terrain}，曲线 ${record.t.length ? record.t[record.t.length - 1].toFixed(1) : 0}s`;
});
$('btnLoadA').addEventListener('click', () => {
  if (!snapshotA) return;
  params = { ...snapshotA.params };
  terrain = snapshotA.terrain;
  document.querySelectorAll('#terrainRow button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.terrain === terrain));
  syncSliders();
  setRunning(false);
  reset();
});
$('btnClearA').addEventListener('click', () => {
  snapshotA = null;
  cmpStatus.textContent = '未保存对照。流程：设参数→运行→暂停→保存A→改参数→重置→运行，曲线叠加对比。';
});

// ---- 主循环：固定步长 + 累加器，帧率不影响模拟结果 ----
let acc = 0;
let lastTs: number | null = null;

function stepOnce(): void {
  step(sim, FIXED_DT);
  record.t.push(sim.time);
  record.cL.push(getCompression(sim, 0));
  record.cR.push(getCompression(sim, 1));
}

function frame(ts: number): void {
  if (lastTs === null) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.25) dt = 0.25; // 掉帧保护
  if (running) {
    acc += dt;
    while (acc >= FIXED_DT) {
      stepOnce();
      acc -= FIXED_DT;
    }
  } else {
    acc = 0; // 暂停期间不累积，读数不漂移
  }
  const vw = view.getBoundingClientRect();
  drawScene(vctx, sim, vw.width, vw.height);
  const cw = chart.getBoundingClientRect();
  drawChart(cctx, cw.width, cw.height, record, snapshotA?.record ?? null);
  requestAnimationFrame(frame);
}

syncSliders();
resize();
requestAnimationFrame(frame);
