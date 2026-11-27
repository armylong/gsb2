import './style.css';
import { ToneEngine } from './audio/engine';
import { SegmentController } from './audio/segment-controller';
import { defaultSegment, type SegmentSpec } from './audio/segment';
import { readWavFile } from './audio/readback';
import { MultiRing } from './ui/ringbuf';
import { drawWavePanel } from './ui/wave-panel';
import { drawMeterPanel, drawPhasePanel, drawSegmentPanel } from './ui/panels';
import { PRESETS, SWEEP_A, SWEEP_RANGE } from './presets';
import { wrapPhase, type RouteMode } from './dsp/kernel';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const engine = new ToneEngine();
const WINDOW_S = 4;
// 7 个通道：L, R, sumRef, phaseDiff, fA, fB, envelope
// worklet 已降采样到约 6 kHz（48k/8），4 秒滚动窗 ≈ 24000 点
const RING_CAP = 30000;
const ring = new MultiRing(7, RING_CAP);
engine.setRing(ring);

let segmentCtl: SegmentController | null = null;
let sweepTimer: number | null = null;

// ---------- DOM ----------
const els = {
  start: $<HTMLButtonElement>('btn-start'),
  stop: $<HTMLButtonElement>('btn-stop'),
  resetPhase: $<HTMLButtonElement>('btn-reset-phase'),
  modeSeg: $<HTMLDivElement>('mode-seg'),
  modeHint: $<HTMLParagraphElement>('mode-hint'),
  freqA: $<HTMLInputElement>('freq-A'),
  freqB: $<HTMLInputElement>('freq-B'),
  numA: $<HTMLInputElement>('num-A'),
  numB: $<HTMLInputElement>('num-B'),
  gainA: $<HTMLInputElement>('gain-A'),
  gainB: $<HTMLInputElement>('gain-B'),
  phaseA: $<HTMLInputElement>('phase-A'),
  phaseB: $<HTMLInputElement>('phase-B'),
  readFA: $<HTMLSpanElement>('read-fA'),
  readFB: $<HTMLSpanElement>('read-fB'),
  sweepRow: $<HTMLDivElement>('sweep-row'),
  sweepTime: $<HTMLInputElement>('sweep-time'),
  sweepGo: $<HTMLButtonElement>('btn-sweep-go'),
  sweepStop: $<HTMLButtonElement>('btn-sweep-stop'),
  segDur: $<HTMLInputElement>('seg-dur'),
  segA0: $<HTMLInputElement>('seg-a0'),
  segA1: $<HTMLInputElement>('seg-a1'),
  segB0: $<HTMLInputElement>('seg-b0'),
  segB1: $<HTMLInputElement>('seg-b1'),
  segFade: $<HTMLInputElement>('seg-fade'),
  segBit: $<HTMLSelectElement>('seg-bit'),
  render: $<HTMLButtonElement>('btn-render'),
  exportBtn: $<HTMLButtonElement>('btn-export'),
  loopSeg: $<HTMLDivElement>('loop-seg'),
  loop: $<HTMLButtonElement>('btn-loop'),
  rewind: $<HTMLButtonElement>('btn-rewind'),
  loopStop: $<HTMLButtonElement>('btn-loop-stop'),
  seamData: $<HTMLDivElement>('seam-data'),
  wavFile: $<HTMLInputElement>('wav-file'),
  readback: $<HTMLDivElement>('readback'),
  cvWave: $<HTMLCanvasElement>('cv-wave'),
  cvPhase: $<HTMLCanvasElement>('cv-phase'),
  cvMeter: $<HTMLCanvasElement>('cv-meter'),
  cvSegment: $<HTMLCanvasElement>('cv-segment'),
};

// ---------- 控件绑定 ----------
function syncFreqUI() {
  const [fA, fB] = engine.freqs;
  els.freqA.value = String(fA);
  els.freqB.value = String(fB);
  els.numA.value = fA.toFixed(1);
  els.numB.value = fB.toFixed(1);
  els.readFA.textContent = `${fA.toFixed(2)} Hz`;
  els.readFB.textContent = `${fB.toFixed(2)} Hz`;
}

function bindFreq(slider: HTMLInputElement, num: HTMLInputElement, which: 0 | 1) {
  const apply = (v: number) => {
    const f: [number, number] = [...engine.freqs];
    f[which] = v;
    engine.setFreqs(f);
    syncFreqUI();
  };
  slider.addEventListener('input', () => apply(parseFloat(slider.value)));
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) apply(v);
  });
}
bindFreq(els.freqA, els.numA, 0);
bindFreq(els.freqB, els.numB, 1);

els.gainA.addEventListener('input', () => {
  engine.setGains([parseFloat(els.gainA.value), engine.gains[1]]);
});
els.gainB.addEventListener('input', () => {
  engine.setGains([engine.gains[0], parseFloat(els.gainB.value)]);
});

function currentStartPhases(): [number, number] {
  return [
    (parseFloat(els.phaseA.value) * Math.PI) / 180,
    (parseFloat(els.phaseB.value) * Math.PI) / 180,
  ];
}

els.modeSeg.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
  if (!btn) return;
  const mode = btn.dataset.mode as RouteMode;
  els.modeSeg.querySelectorAll('button').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  engine.setMode(mode);
  els.modeHint.textContent =
    mode === 'split'
      ? '分送：左耳只听 A、右耳只听 B。混合：两路各 ×1/√2 相加后送两边，每耳功率与分送相等。'
      : '混合：每只耳朵收到 A+B，各分量 ×1/√2 保持与分送等功率，切换不会带来响度差。';
});

els.start.addEventListener('click', async () => {
  engine.startPhases = currentStartPhases();
  await engine.start();
  els.start.disabled = true;
  els.stop.disabled = false;
});
els.stop.addEventListener('click', async () => {
  await engine.stop();
  els.start.disabled = false;
  els.stop.disabled = true;
});
els.resetPhase.addEventListener('click', () => {
  const p = currentStartPhases();
  engine.resetPhase(p);
  ring.clear();
});

// ---------- 预设 ----------
document.querySelectorAll('button[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = (btn as HTMLButtonElement).dataset.preset as keyof typeof PRESETS;
    const p = PRESETS[id];
    stopSweep();
    engine.setGains(p.gains);
    engine.setFreqs(p.freqs);
    engine.setMode(p.mode);
    engine.resetPhase(p.startPhase);
    els.gainA.value = String(p.gains[0]);
    els.gainB.value = String(p.gains[1]);
    els.phaseA.value = '0';
    els.phaseB.value = '0';
    els.modeSeg.querySelectorAll('button').forEach((b) => {
      const on = (b as HTMLButtonElement).dataset.mode === p.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    syncFreqUI();
    els.sweepRow.classList.toggle('hidden', id !== 'sweep');
  });
});

// ---------- 自动扫频 ----------
function stopSweep() {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  els.sweepGo.disabled = false;
}
els.sweepStop.addEventListener('click', stopSweep);
els.sweepGo.addEventListener('click', async () => {
  stopSweep();
  if (!engine.isRunning) await engine.start();
  els.start.disabled = true;
  els.stop.disabled = false;
  engine.resetPhase(currentStartPhases());
  const dur = parseFloat(els.sweepTime.value);
  const t0 = performance.now();
  const [f0, f1] = SWEEP_RANGE;
  els.sweepGo.disabled = true;
  // 每 50ms 下发一次目标频率，内核在音频块内线性插值，听感连续无咔哒
  sweepTimer = window.setInterval(() => {
    const u = Math.min(1, (performance.now() - t0) / (dur * 1000));
    const fb = f0 + (f1 - f0) * u;
    engine.setFreqs([SWEEP_A, fb]);
    syncFreqUI();
    if (u >= 1) stopSweep();
  }, 50);
});

// ---------- 选段 ----------
function readSpec(): SegmentSpec {
  const spec = defaultSegment(engine.mode);
  spec.duration = parseFloat(els.segDur.value);
  spec.startPhase = currentStartPhases();
  spec.gains = [engine.gains[0], engine.gains[1]];
  spec.sweep = {
    a: [parseFloat(els.segA0.value), parseFloat(els.segA1.value)],
    b: [parseFloat(els.segB0.value), parseFloat(els.segB1.value)],
  };
  spec.fade = parseFloat(els.segFade.value);
  return spec;
}

function seamText(s: SegmentController): string {
  const seam = s.seam!;
  const modeLine = s.loopMode === 'reset' ? '每轮设定相位开始' : '维持当前相位（硬循环）';
  const phaseMark = seam.phaseContinuous ? '✓ 连续' : '✗ 未接上';
  const freqMark = seam.freqContinuous ? '✓ 连续' : '✗ 跳变';
  return [
    `循环模式：${modeLine}`,
    `起点相位 A=${seam.startPhases[0].toFixed(2)} B=${seam.startPhases[1].toFixed(2)} rad`,
    `终点相位 A=${wrapPhase(seam.endPhases[0]).toFixed(2)} B=${wrapPhase(seam.endPhases[1]).toFixed(2)} rad（卷绕显示）`,
    `相位差 起点=${seam.startPhaseDiff.toFixed(2)} → 终点=${seam.endPhaseDiff.toFixed(2)} rad`,
    `接缝相位差跳变 ${seam.diffJump.toFixed(3)} rad  [${phaseMark}]`,
    `接缝频率跳变 A=${seam.freqJump[0].toFixed(2)} B=${seam.freqJump[1].toFixed(2)} Hz  [${freqMark}]`,
    `包络 起点=${seam.startEnvelope.toFixed(3)} → 终点=${seam.endEnvelope.toFixed(3)}`,
    s.loopMode === 'cont' && !seam.phaseContinuous
      ? '⚠ 硬循环下末样本直接接回首样本，倒回重听可对比相位错位'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

let currentPlayPos: number | null = null;

els.render.addEventListener('click', async () => {
  await engine.ensure();
  const spec = readSpec();
  segmentCtl = new SegmentController(engine, spec);
  segmentCtl.setPlayPosCallback((p) => (currentPlayPos = p));
  segmentCtl.render(engine.sampleRate);
  els.loop.disabled = false;
  els.rewind.disabled = false;
  els.loopStop.disabled = false;
  els.seamData.textContent = seamText(segmentCtl);
});

els.exportBtn.addEventListener('click', () => {
  if (!segmentCtl?.result) {
    els.seamData.textContent = '请先渲染选段再导出';
    return;
  }
  segmentCtl.exportWav(els.segBit.value === '32' ? 32 : 16);
});

els.loopSeg.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-loop]') as HTMLButtonElement | null;
  if (!btn) return;
  const mode = btn.dataset.loop as 'reset' | 'cont';
  segmentCtl && (segmentCtl.loopMode = mode);
  els.loopSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  if (segmentCtl?.seam) els.seamData.textContent = seamText(segmentCtl);
});

els.loop.addEventListener('click', async () => {
  if (!segmentCtl) return;
  await segmentCtl.playLoop();
});
els.rewind.addEventListener('click', () => segmentCtl?.rewind());
els.loopStop.addEventListener('click', () => segmentCtl?.stopLoop());

// ---------- 回读 ----------
els.wavFile.addEventListener('change', async () => {
  const file = els.wavFile.files?.[0];
  if (!file) return;
  try {
    const spec = segmentCtl?.spec;
    const expected = spec
      ? { fA: spec.sweep.a[0], fB: spec.sweep.b[0] }
      : undefined;
    els.readback.textContent = '分析中…';
    els.readback.textContent = await readWavFile(file, expected);
  } catch (err) {
    els.readback.textContent = `读取失败：${(err as Error).message}`;
  }
});

// ---------- 绘图循环 ----------
const hover = { wave: null as number | null, phase: null as number | null };
els.cvWave.addEventListener('mousemove', (e) => {
  hover.wave = e.offsetX;
});
els.cvWave.addEventListener('mouseleave', () => (hover.wave = null));
els.cvPhase.addEventListener('mousemove', (e) => {
  hover.phase = e.offsetX;
});
els.cvPhase.addEventListener('mouseleave', () => (hover.phase = null));

function drawLoop() {
  const snaps = ring.snapshots();
  const hasData = snaps[0].length > 1;
  if (hasData) {
    const [l, r, sum, pd, fA, fB, env] = snaps;
    drawWavePanel(
      els.cvWave,
      { left: l, right: r, sumRef: sum, envelope: env, windowS: WINDOW_S, mode: engine.mode },
      hover.wave,
    );
    const last = pd.length - 1;
    const diffRad = pd[last];
    drawPhasePanel(
      els.cvPhase,
      {
        phaseDiff: pd,
        freqA: fA,
        freqB: fB,
        windowS: WINDOW_S,
        readout: {
          fA: fA[last],
          fB: fB[last],
          beat: Math.abs(fA[last] - fB[last]),
          diffRad,
          diffDeg: (diffRad * 180) / Math.PI,
        },
      },
      hover.phase,
    );
  }
  const [rmsL, rmsR] = engine.readMeters();
  drawMeterPanel(els.cvMeter, rmsL, rmsR);

  if (segmentCtl) {
    drawSegmentPanel(els.cvSegment, {
      spec: segmentCtl.spec,
      seam: segmentCtl.seam,
      playPos: currentPlayPos,
      loopMode: segmentCtl.loopMode,
    });
  }
  requestAnimationFrame(drawLoop);
}

requestAnimationFrame(drawLoop);

syncFreqUI();

// 端到端测试/课堂调试钩子：暴露实时环形缓冲与引擎，供页面外脚本直接核对 DSP 数值
interface BeatsDebug {
  ring: MultiRing;
  engine: ToneEngine;
  getSegment: () => SegmentController | null;
}
(window as unknown as { __beats: BeatsDebug }).__beats = {
  ring,
  engine,
  getSegment: () => segmentCtl,
};
