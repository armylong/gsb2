import './styles.css';
import { OscEngine } from './audio/engine';
import {
  analyzeTable,
  buildPreset,
  meanDc,
  normalizePeak,
  peakAmplitude,
  removeDc,
  rms,
  TABLE_SIZE,
  type PresetId,
  type RenderMode,
} from './dsp/wavetable';
import { classifyMeasurement, type MeasurementResult } from './dsp/spectrum';
import { renderSequence, renderTone } from './dsp/render';
import { encodeWavPcm16, downloadBlob } from './dsp/wav';
import { keyboardNotes, midiToFreq, midiToName } from './dsp/notes';
import { buildTestSequence, type TestSequence } from './dsp/rng';
import { defaultSettings, sequenceFromSettings, validateSettings, type AppSettings } from './state';
import { WaveEditor } from './ui/waveEditor';
import { SpectrumView } from './ui/spectrumView';
import { runAllChecks, type CheckResult } from './checks';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const settings = defaultSettings();
const engine = new OscEngine();
let editor: WaveEditor;
let spectrum: SpectrumView;
let activeMidi = settings.baseMidi;
let sustain = false;
let lastMeasurement: MeasurementResult | null = null;

// ---------- 工具 ----------

function effectiveTable(): Float64Array {
  const raw = editor.value;
  return settings.removeDc ? removeDc(raw) : raw;
}

function pushTableToEngine(): void {
  engine.setTable(effectiveTable());
  refreshWaveStats();
}

function refreshWaveStats(): void {
  const raw = editor.value;
  const dc = meanDc(raw);
  const t = effectiveTable();
  $('dc-stat').textContent = `直流均值 ${dc.toFixed(4)}${settings.removeDc ? '（已去除）' : ''}`;
  $('peak-stat').textContent = `峰值 ${peakAmplitude(t).toFixed(3)}`;
  $('rms-stat').textContent = `RMS ${rms(t).toFixed(3)}`;
}

function currentFreq(): number {
  return midiToFreq(activeMidi) * Math.pow(2, settings.semitoneOffset / 12);
}

// ---------- 卡片 1：波形编辑 ----------

function buildPresetButtons(): void {
  const row = $('preset-row');
  const ids: PresetId[] = ['sine', 'sharp-saw', 'notched'];
  row.innerHTML = '';
  for (const id of ids) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.dataset.preset = id;
    btn.textContent = id === 'sine' ? '正弦' : id === 'sharp-saw' ? '尖锯齿' : '窄凹口';
    btn.addEventListener('click', () => loadPreset(id));
    row.appendChild(btn);
  }
  updatePresetButtons();
}

function updatePresetButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === settings.presetId);
  });
}

function loadPreset(id: PresetId): void {
  settings.presetId = id;
  settings.rawTable = Array.from(buildPreset(id, TABLE_SIZE));
  editor.reset(Float64Array.from(settings.rawTable));
  updatePresetButtons();
  pushTableToEngine();
  scheduleMeasure();
}

function initEditor(): void {
  editor = new WaveEditor(
    $('wave-canvas'),
    $('seam-canvas'),
    Float64Array.from(settings.rawTable),
  );
  editor.onChange = () => {
    settings.presetId = 'custom';
    settings.rawTable = Array.from(editor.value);
    updatePresetButtons();
    pushTableToEngine();
    scheduleMeasure();
  };
  buildPresetButtons();

  $('remove-dc').addEventListener('change', (e) => {
    settings.removeDc = (e.target as HTMLInputElement).checked;
    pushTableToEngine();
    scheduleMeasure();
  });
  $('btn-undo').addEventListener('click', () => editor.undo());
  $('btn-reset-wave').addEventListener('click', () => {
    if (settings.presetId === 'custom') {
      editor.reset(Float64Array.from(settings.rawTable));
      pushTableToEngine();
    } else {
      loadPreset(settings.presetId);
    }
  });
  $('btn-normalize').addEventListener('click', () => {
    editor.setValue(normalizePeak(editor.value), true);
    settings.rawTable = Array.from(editor.value);
    pushTableToEngine();
    scheduleMeasure();
  });
  refreshWaveStats();
}

// ---------- 卡片 2：播放 ----------

function initNotes(): void {
  const row = $('note-row');
  for (const n of keyboardNotes()) {
    const btn = document.createElement('button');
    btn.className = 'note-btn';
    btn.type = 'button';
    btn.dataset.midi = String(n.midi);
    btn.innerHTML = `${n.name}<span class="sub">${n.freq.toFixed(1)}Hz</span>`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pressNote(n.midi);
    });
    btn.addEventListener('pointerup', () => releaseNote());
    btn.addEventListener('pointerleave', () => {
      if (!sustain) releaseNote();
    });
    row.appendChild(btn);
  }
  highlightNote();
}

function highlightNote(): void {
  document.querySelectorAll<HTMLButtonElement>('.note-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.midi) === activeMidi && engine.isNoteOn);
  });
}

async function pressNote(midi: number): Promise<void> {
  activeMidi = midi;
  settings.baseMidi = midi;
  await engine.init();
  engine.setTable(effectiveTable());
  engine.setLevelOn(settings.loudnessAlign);
  engine.setMasterGain(settings.masterGain);
  engine.noteDown(midiToFreq(midi));
  engine.setSemitoneOffset(settings.semitoneOffset);
  if (settings.autoSweep) {
    engine.startAutoSweep(settings.sweepRange, settings.sweepSpeed);
  }
  highlightNote();
}

function releaseNote(): void {
  if (sustain) return;
  engine.noteUp();
  highlightNote();
}

function initPlayControls(): void {
  // 模式分段
  document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.dataset.mode as RenderMode;
      settings.mode = mode;
      settings.abMix = mode === 'naive' ? 0 : 1;
      updateModeUi();
      engine.setAbMix(settings.abMix);
    });
  });

  const fader = $<HTMLInputElement>('ab-fader');
  fader.addEventListener('input', () => {
    settings.abMix = Number(fader.value) / 1000;
    settings.mode = settings.abMix < 0.5 ? 'naive' : 'bandlimited';
    updateModeUi();
    engine.setAbMix(settings.abMix);
  });

  // 按住发音按钮
  const noteBtn = $('btn-note');
  noteBtn.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    await pressNote(activeMidi);
    noteBtn.classList.add('active');
    noteBtn.textContent = '发音中…松开停止';
  });
  const stopHold = () => {
    if (!sustain) {
      engine.noteUp();
      noteBtn.classList.remove('active');
      noteBtn.textContent = '按住发音（或键盘空格）';
      highlightNote();
    }
  };
  noteBtn.addEventListener('pointerup', stopHold);
  noteBtn.addEventListener('pointerleave', stopHold);

  // 空格键
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      if (!engine.isNoteOn) void pressNote(activeMidi);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !sustain) {
      engine.noteUp();
      highlightNote();
    }
  });

  // 持续开关
  $('btn-sustain').addEventListener('click', async () => {
    sustain = !sustain;
    $('btn-sustain').textContent = `持续开关：${sustain ? '开' : '关'}`;
    if (sustain) {
      await pressNote(activeMidi);
    } else {
      engine.noteUp();
      highlightNote();
    }
  });

  // 扫频推子
  const pitch = $<HTMLInputElement>('pitch-fader');
  pitch.addEventListener('input', () => {
    settings.semitoneOffset = Number(pitch.value);
    $('pitch-stat').textContent = `${settings.semitoneOffset >= 0 ? '+' : ''}${settings.semitoneOffset.toFixed(1)} 半音`;
    engine.setSemitoneOffset(settings.semitoneOffset);
    scheduleMeasure();
  });

  $('auto-sweep').addEventListener('change', (e) => {
    settings.autoSweep = (e.target as HTMLInputElement).checked;
    if (settings.autoSweep && engine.isNoteOn) {
      engine.startAutoSweep(settings.sweepRange, settings.sweepSpeed);
    } else {
      engine.stopSweep();
    }
  });
  $('sweep-range').addEventListener('change', (e) => {
    settings.sweepRange = Number((e.target as HTMLSelectElement).value);
    if (settings.autoSweep && engine.isNoteOn) engine.startAutoSweep(settings.sweepRange, settings.sweepSpeed);
  });
  $('sweep-speed').addEventListener('change', (e) => {
    settings.sweepSpeed = Number((e.target as HTMLSelectElement).value);
    if (settings.autoSweep && engine.isNoteOn) engine.startAutoSweep(settings.sweepRange, settings.sweepSpeed);
  });

  $('loudness-align').addEventListener('change', (e) => {
    settings.loudnessAlign = (e.target as HTMLInputElement).checked;
    engine.setLevelOn(settings.loudnessAlign);
  });
  $('master-gain').addEventListener('input', (e) => {
    settings.masterGain = Number((e.target as HTMLInputElement).value) / 100;
    engine.setMasterGain(settings.masterGain);
  });

  engine.onStateChange = (s) => {
    $('engine-stat').textContent =
      `采样率 ${(s.sampleRate / 1000).toFixed(1)}kHz · 现音高 ${s.currentFreq.toFixed(1)}Hz · ` +
      `${midiToName(Math.round(69 + 12 * Math.log2(s.currentFreq / 440)))}`;
  };

  updateModeUi();
}

function updateModeUi(): void {
  document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === settings.mode);
  });
  const fader = $<HTMLInputElement>('ab-fader');
  fader.value = String(Math.round(settings.abMix * 1000));
  const pctA = Math.round((1 - settings.abMix) * 100);
  $('ab-fader-stat').textContent = `A ${pctA}% / B ${100 - pctA}%`;
}

// ---------- 卡片 3：测量与成分对照 ----------

let measureTimer: number | null = null;
function scheduleMeasure(): void {
  if (measureTimer !== null) clearTimeout(measureTimer);
  measureTimer = window.setTimeout(() => void doMeasure(), 250);
}

async function doMeasure(): Promise<void> {
  const table = effectiveTable();
  const coeffs = analyzeTable(table);
  const sampleRate = engine.ready ? engine.sampleRate : 48000;
  const f0 = currentFreq();
  const mode = ($<HTMLSelectElement>('measure-mode').value as RenderMode) || settings.measureMode;
  settings.measureMode = mode;
  $('measure-stat').textContent = '离线渲染测量中…';
  await new Promise((r) => setTimeout(r, 0));
  const sig = renderTone({
    sampleRate,
    f0,
    duration: 1.5,
    mode,
    table,
    coeffs,
    levelMatch: settings.loudnessAlign,
  });
  lastMeasurement = classifyMeasurement(sig, sampleRate, f0, mode, coeffs);
  spectrum.setResult(lastMeasurement);
  renderTable(lastMeasurement);
  const extras = lastMeasurement.classified.filter((p) => p.kind === 'extra').length;
  const aliases = lastMeasurement.classified.filter((p) => p.kind === 'alias').length;
  $('measure-stat').textContent =
    `${midiToName(activeMidi)} ${f0.toFixed(1)}Hz · 模式${mode === 'naive' ? 'A' : 'B'} · ` +
    `真实峰 ${lastMeasurement.classified.filter((p) => p.kind === 'harmonic').length} · ` +
    `折叠 ${aliases} · 多出 ${extras} · 噪声地板 ${lastMeasurement.noiseFloorDb.toFixed(0)}dBFS`;
}

function renderTable(r: MeasurementResult): void {
  const tbody = document.querySelector<HTMLTableSectionElement>('#harmonic-table tbody')!;
  tbody.innerHTML = '';
  const maxRows = r.rows.filter((row) => row.idealDb > -80).slice(0, 40);
  for (const row of maxRows) {
    const tr = document.createElement('tr');
    const statusBadge = (() => {
      switch (row.status) {
        case 'ok':
          return '<span class="badge ok"><span class="dot" style="background:#199e70"></span>实测一致</span>';
        case 'missing':
          return '<span class="badge missing">缺失（限带剔除）</span>';
        case 'folded':
          return `<span class="badge alias">折叠→${row.foldedFreq!.toFixed(0)}Hz</span>`;
        default:
          return '<span class="badge oob">越界</span>';
      }
    })();
    tr.innerHTML = `
      <td>k=${row.k}</td>
      <td>${row.idealFreq.toFixed(1)}</td>
      <td>${row.idealDb.toFixed(1)}</td>
      <td>${row.measured ? row.measured.freq.toFixed(1) : '—'}</td>
      <td>${row.measured ? row.measured.db.toFixed(1) : '—'}</td>
      <td>${statusBadge}</td>`;
    tbody.appendChild(tr);
  }
  const extras = r.classified.filter((p) => p.kind === 'extra');
  const list = $('extra-list');
  list.innerHTML = extras.length
    ? '实测多出、理论无对应（真峰）：' +
      extras
        .slice(0, 12)
        .map((p) => `<span class="item" style="color:#e66767">● ${p.freq.toFixed(1)}Hz ${p.db.toFixed(1)}dBFS</span>`)
        .join('　')
    : '没有“多出的真峰”——实测到的分量都能在理论谐波或折叠位置上找到对应。';
}

// ---------- 卡片 4：导出与复现 ----------

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function initExport(): void {
  $('btn-export-tone').addEventListener('click', () => {
    const table = effectiveTable();
    const coeffs = analyzeTable(table);
    const sr = 48000;
    const f0 = currentFreq();
    const a = renderTone({ sampleRate: sr, f0, duration: 2, mode: 'naive', table, coeffs, levelMatch: settings.loudnessAlign });
    const b = renderTone({ sampleRate: sr, f0, duration: 2, mode: 'bandlimited', table, coeffs, levelMatch: settings.loudnessAlign });
    const blob = encodeWavPcm16([a, b], sr);
    downloadBlob(blob, `timbre-${midiToName(activeMidi)}-AB-${timestamp()}.wav`);
  });

  $('btn-export-seq').addEventListener('click', () => {
    const table = effectiveTable();
    const coeffs = analyzeTable(table);
    const sr = 48000;
    const seq = sequenceFromSettings(settings, sr);
    const a = renderSequence(seq, table, coeffs, 'naive', settings.loudnessAlign);
    const b = renderSequence(seq, table, coeffs, 'bandlimited', settings.loudnessAlign);
    const blob = encodeWavPcm16([a, b], sr);
    downloadBlob(blob, `pitch-seq-seed${settings.seed}-${timestamp()}.wav`);
    const meta = JSON.stringify({ ...seq, settings: sanitizeSettings() }, null, 2);
    downloadBlob(new Blob([meta], { type: 'application/json' }), `pitch-seq-seed${settings.seed}-meta.json`);
    renderSeqPreview(seq);
  });

  $('btn-export-settings').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(sanitizeSettings(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `wavetable-lab-settings-seed${settings.seed}.json`);
  });

  $('import-settings').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = validateSettings(JSON.parse(await file.text()));
      applySettings(parsed);
    } catch (err) {
      alert(`导入失败：${(err as Error).message}`);
    }
    input.value = '';
  });

  $('btn-reseed').addEventListener('click', () => {
    settings.seed = (Math.random() * 0xffffffff) >>> 0;
    renderSeqPreview(sequenceFromSettings(settings, 48000));
  });

  renderSeqPreview(buildTestSequence(settings.seed, 48000));
}

function sanitizeSettings(): AppSettings {
  return { ...settings, rawTable: settings.rawTable.map((v) => Number(v.toFixed(6))) };
}

function renderSeqPreview(seq: TestSequence): void {
  $('btn-reseed').textContent = `重抽种子（当前 ${seq.seed}）`;
  const lines = seq.notes.map(
    (n, i) =>
      `${String(i + 1).padStart(2)}. ${n.name.padEnd(4)} ${n.freq.toFixed(2).padStart(9)}Hz  @${n.start.toFixed(2)}s`,
  );
  $('seq-preview').textContent =
    `确定性音高序列（种子 ${seq.seed}，同设置逐次一致）：\n${lines.join('\n')}`;
}

function applySettings(s: AppSettings): void {
  Object.assign(settings, s);
  editor.reset(Float64Array.from(settings.rawTable));
  ($<HTMLInputElement>('remove-dc')).checked = settings.removeDc;
  ($<HTMLInputElement>('loudness-align')).checked = settings.loudnessAlign;
  ($<HTMLInputElement>('master-gain')).value = String(Math.round(settings.masterGain * 100));
  ($<HTMLInputElement>('pitch-fader')).value = String(settings.semitoneOffset);
  $('pitch-stat').textContent = `${settings.semitoneOffset >= 0 ? '+' : ''}${settings.semitoneOffset.toFixed(1)} 半音`;
  ($<HTMLInputElement>('auto-sweep')).checked = settings.autoSweep;
  ($<HTMLSelectElement>('sweep-range')).value = String(settings.sweepRange);
  ($<HTMLSelectElement>('sweep-speed')).value = String(settings.sweepSpeed);
  ($<HTMLSelectElement>('measure-mode')).value = settings.measureMode;
  activeMidi = settings.baseMidi;
  updatePresetButtons();
  updateModeUi();
  pushTableToEngine();
  renderSeqPreview(sequenceFromSettings(settings, 48000));
  scheduleMeasure();
}

// ---------- 卡片 5：本地验证 ----------

function initChecks(): void {
  const list = $('check-list');
  const placeholder: CheckResult[] = [
    { id: 'ph', title: '点击“运行全部检查”执行 8 项确定性验证', pass: false, detail: '含 worklet/离线一致性、正弦无假谐波、折叠公式、等响度等' },
  ];
  renderChecks(placeholder, true);
  $('btn-run-checks').addEventListener('click', async () => {
    list.innerHTML = '<li class="pending"><span class="mark">…</span>运行中（需加载 AudioWorklet）</li>';
    try {
      const r = await runAllChecks();
      renderChecks(r, false);
    } catch (err) {
      list.innerHTML = `<li class="fail"><span class="mark">✗</span>检查执行失败：${(err as Error).message}</li>`;
    }
  });
}

function renderChecks(results: CheckResult[], pending: boolean): void {
  const list = $('check-list');
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = pending ? 'pending' : r.pass ? 'pass' : 'fail';
    li.innerHTML = `<span class="mark">${pending ? '○' : r.pass ? '✓' : '✗'}</span>
      <span>${r.title}</span>
      <span class="detail">${r.detail}</span>`;
    list.appendChild(li);
  }
}

// ---------- 启动 ----------

function init(): void {
  initEditor();
  initNotes();
  initPlayControls();
  spectrum = new SpectrumView($('ideal-canvas'), $('measured-canvas'), $('spec-tooltip'));
  $('btn-measure').addEventListener('click', () => void doMeasure());
  $('measure-mode').addEventListener('change', () => void doMeasure());
  initExport();
  initChecks();
  // 首次自动测量（不发声），让页面打开就有对照内容
  void doMeasure();
}

// AudioContext 需要用户手势；首次测量用离线渲染不受影响
document.addEventListener('DOMContentLoaded', init);
