import './styles.css';
import { FmEngine } from './audio/live-engine';
import { renderOffline } from './audio/engine';
import { analyzeSidebands, SidebandAnalysis } from './audio/sidebands';
import { defaultPatch, normalizePatch } from './audio/patch-utils';
import type { FmPatch } from './audio/types';
import { carrierFreqFor } from './audio/engine';
import { midiToFreq, midiToName } from './audio/notes';
import { encodeWav } from './audio/wav';
import { BRIGHT_BELL, PRESETS, PURE_TONE } from './audio/presets';
import { CurveEditor } from './ui/curve-editor';
import { SpectrumView } from './ui/spectrum';
import { Keyboard } from './ui/keyboard';

const state: { patch: FmPatch; selectedMidi: number; engine: FmEngine | null } = {
  patch: defaultPatch(),
  selectedMidi: 69,
  engine: null,
};

function ensureEngine(): FmEngine {
  if (!state.engine) {
    state.engine = new FmEngine();
    spectrum.attachAnalyser(state.engine.analyser, state.engine.sampleRate);
    document.getElementById('sample-rate-info')!.textContent =
      `当前 AudioContext 采样率: ${state.engine.sampleRate} Hz, Nyquist: ${state.engine.sampleRate / 2} Hz`;
  }
  return state.engine;
}

// ---------- DOM 引用 ----------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  carrierMode: $<HTMLElement>('carrier-mode'),
  fixedFreqRow: $<HTMLElement>('fixed-freq-row'),
  fixedFreq: $<HTMLInputElement>('fixed-freq'),
  modRatio: $<HTMLInputElement>('mod-ratio'),
  modRatioVal: $<HTMLElement>('mod-ratio-val'),
  modDepth: $<HTMLInputElement>('mod-depth'),
  modDepthVal: $<HTMLElement>('mod-depth-val'),
  modelTime: $<HTMLInputElement>('model-time'),
  modelTimeVal: $<HTMLElement>('model-time-val'),
  decayTime: $<HTMLInputElement>('decay-time'),
  decayTimeVal: $<HTMLElement>('decay-time-val'),
  attackTime: $<HTMLInputElement>('attack-time'),
  attackTimeVal: $<HTMLElement>('attack-time-val'),
  outputGain: $<HTMLInputElement>('output-gain'),
  outputGainVal: $<HTMLElement>('output-gain-val'),
  curveReset: $<HTMLButtonElement>('curve-reset'),
  freqSummary: $<HTMLElement>('freq-summary'),
  warning: $<HTMLElement>('nyquist-warning'),
  tableBody: $<HTMLTableSectionElement>('sideband-table').querySelector('tbody')!,
  exportNote: $<HTMLSelectElement>('export-note'),
  exportInfo: $<HTMLElement>('export-info'),
  exportBtn: $<HTMLButtonElement>('export-btn'),
  presetDesc: $<HTMLElement>('preset-desc'),
};

// ---------- 曲线编辑器 ----------
const curveEditor = new CurveEditor($('curve-canvas'), state.patch.depthCurve, (points) => {
  state.patch.depthCurve = points;
  state.engine?.updateDepth(state.patch);
  refreshAnalysis();
});

// ---------- 频谱 ----------
const spectrum = new SpectrumView($('spectrum-canvas'));

// ---------- 键盘 ----------
new Keyboard($('keyboard'), {
  noteOn: (midi) => {
    const engine = ensureEngine();
    void engine.resume();
    engine.noteOn(midi, state.patch);
    state.selectedMidi = midi;
    els.exportNote.value = String(midi);
    refreshAnalysis();
  },
  noteOff: (midi) => {
    state.engine?.noteOff(midi);
  },
});

// ---------- 参数绑定 ----------
function bindRange(
  input: HTMLInputElement,
  valEl: HTMLElement,
  key: keyof FmPatch,
  fmt: (v: number) => string,
  onChange: () => void,
): void {
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    (state.patch[key] as number) = v;
    valEl.textContent = fmt(v);
    onChange();
    refreshAnalysis();
  });
}

bindRange(els.modRatio, els.modRatioVal, 'modRatio', (v) => v.toFixed(2), () =>
  state.engine?.updateModRatio(state.patch),
);
bindRange(els.modDepth, els.modDepthVal, 'modDepth', (v) => v.toFixed(2), () =>
  state.engine?.updateDepth(state.patch),
);
bindRange(els.modelTime, els.modelTimeVal, 'modelTime', (v) => v.toFixed(2), () =>
  state.engine?.updateModelTime(state.patch),
);
bindRange(els.decayTime, els.decayTimeVal, 'decayTime', (v) => v.toFixed(2), () => {
  /* 仅影响之后新触发的声音 */
});
bindRange(els.attackTime, els.attackTimeVal, 'attackTime', (v) => v.toFixed(3), () => {
  /* 仅影响之后新触发的声音 */
});
bindRange(els.outputGain, els.outputGainVal, 'outputGain', (v) => v.toFixed(2), () =>
  state.engine?.updateOutputGain(state.patch.outputGain),
);

// 载波模式切换
els.carrierMode.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    els.carrierMode.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.patch.carrierMode = btn.dataset.mode as FmPatch['carrierMode'];
    els.fixedFreqRow.hidden = state.patch.carrierMode !== 'fixed';
    state.engine?.updateCarrier(state.patch);
    refreshAnalysis();
  });
});

els.fixedFreq.addEventListener('input', () => {
  const v = Math.max(20, Math.min(8000, parseFloat(els.fixedFreq.value) || 220));
  state.patch.fixedCarrierHz = v;
  state.engine?.updateCarrier(state.patch);
  refreshAnalysis();
});

els.curveReset.addEventListener('click', () => {
  state.patch.depthCurve = normalizePatch(defaultPatch()).depthCurve;
  curveEditor.setPoints(state.patch.depthCurve);
  state.engine?.updateDepth(state.patch);
  refreshAnalysis();
});

// ---------- 预设 ----------
function loadPreset(presetId: string): void {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  state.patch = normalizePatch(JSON.parse(JSON.stringify(preset.patch)) as FmPatch);
  syncControlsToPatch();
  state.engine?.updateDepth(state.patch);
  state.engine?.updateModRatio(state.patch);
  state.engine?.updateCarrier(state.patch);
  els.presetDesc.textContent = preset.description;
  refreshAnalysis();
}

$('preset-pure').addEventListener('click', () => loadPreset(PURE_TONE.id));
$('preset-bell').addEventListener('click', () => loadPreset(BRIGHT_BELL.id));
$('mod-zero').addEventListener('click', () => {
  state.patch.modDepth = 0;
  els.modDepth.value = '0';
  els.modDepthVal.textContent = '0.00';
  state.engine?.updateDepth(state.patch);
  els.presetDesc.textContent =
    '调制指数 I=0: J0(0)=1、其余 Jn(0)=0, 数学上频谱只剩载波, 听到的就是纯正弦(可对照频谱与耳朵)。';
  refreshAnalysis();
});

function syncControlsToPatch(): void {
  const p = state.patch;
  els.modRatio.value = String(p.modRatio);
  els.modRatioVal.textContent = p.modRatio.toFixed(2);
  els.modDepth.value = String(p.modDepth);
  els.modDepthVal.textContent = p.modDepth.toFixed(2);
  els.modelTime.value = String(p.modelTime);
  els.modelTimeVal.textContent = p.modelTime.toFixed(2);
  els.decayTime.value = String(p.decayTime);
  els.decayTimeVal.textContent = p.decayTime.toFixed(2);
  els.attackTime.value = String(p.attackTime);
  els.attackTimeVal.textContent = p.attackTime.toFixed(3);
  els.outputGain.value = String(p.outputGain);
  els.outputGainVal.textContent = p.outputGain.toFixed(2);
  els.fixedFreq.value = String(p.fixedCarrierHz);
  els.fixedFreqRow.hidden = p.carrierMode !== 'fixed';
  els.carrierMode.querySelectorAll<HTMLElement>('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === p.carrierMode);
  });
  curveEditor.setPoints(p.depthCurve);
}

// ---------- 侧带分析 ----------
function refreshAnalysis(): void {
  const patch = state.patch;
  const carrierHz = carrierFreqFor(patch, state.selectedMidi);
  const sr = state.engine?.sampleRate ?? 48000;
  const analysis: SidebandAnalysis = analyzeSidebands(patch, carrierHz, sr);

  els.freqSummary.innerHTML =
    `载波 fc = <b>${formatHz(analysis.carrierHz)}</b>` +
    ` &nbsp;|&nbsp; 调制器 fm = fc × ${patch.modRatio.toFixed(2)} = <b>${formatHz(analysis.modulatorHz)}</b>` +
    ` &nbsp;|&nbsp; 峰值指数 I = <b>${analysis.peakIndex.toFixed(2)}</b>` +
    ` &nbsp;|&nbsp; 试听音符 ${midiToName(state.selectedMidi)} (${midiToFreq(state.selectedMidi).toFixed(1)} Hz)`;

  renderWarning(analysis);
  renderTable(analysis);
  spectrum.setMarkers(analysis.sidebands);
  updateExportInfo(carrierHz);
}

function renderWarning(a: SidebandAnalysis): void {
  const offenders = a.sidebands.filter((s) => s.aliased);
  if (offenders.length === 0) {
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  els.warning.hidden = false;
  const highest = offenders.reduce((m, s) =>
    Math.abs(s.nominalHz) > Math.abs(m.nominalHz) ? s : m,
  );
  els.warning.innerHTML =
    `⚠ 有 <b>${offenders.length}</b> 个标称侧带超过 Nyquist (${a.nyquistHz.toFixed(0)} Hz), ` +
    `最高标称分量 ${formatHz(highest.nominalHz)}。` +
    `这些分量无法被当前采样率表示, 实际听到的是折叠到 <b>${formatHz(highest.audibleHz)}</b> 的别名, ` +
    `下表"实际位置"列给出的是折叠后的真实频率, 而非标称值。`;
}

function renderTable(a: SidebandAnalysis): void {
  const rows: string[] = [];
  for (const sb of a.sidebands) {
    const status = sb.aliased
      ? `<span class="tag tag-alias">超 Nyquist·折叠</span>`
      : sb.negativeNominal
        ? '<span class="tag tag-neg">负频对偶</span>'
        : '<span class="tag tag-ok">带内</span>';
    rows.push(
      `<tr class="${sb.order === 0 ? 'carrier-row' : ''}">` +
        `<td>${sb.order}</td>` +
        `<td>${formatHz(sb.nominalHz)}</td>` +
        `<td>${formatHz(sb.audibleHz)}</td>` +
        `<td>${sb.levelDb.toFixed(1)}</td>` +
        `<td>${status}</td></tr>`,
    );
  }
  els.tableBody.innerHTML = rows.join('');
}

function updateExportInfo(carrierHz: number): void {
  const tail = Math.max(state.patch.decayTime, state.patch.modelTime) + 0.05;
  els.exportInfo.textContent =
    `导出载波 ${formatHz(carrierHz)}, 渲染时长 ${tail.toFixed(2)}s (含自然衰减尾巴)`;
}

function formatHz(hz: number): string {
  const sign = hz < 0 ? '-' : '';
  const v = Math.abs(hz);
  return `${sign}${v >= 1000 ? `${(v / 1000).toFixed(2)}k` : v.toFixed(1)} Hz`;
}

// ---------- 导出 ----------
for (let m = 48; m <= 84; m++) {
  const opt = document.createElement('option');
  opt.value = String(m);
  opt.textContent = `${midiToName(m)} (${midiToFreq(m).toFixed(1)} Hz)`;
  if (m === state.selectedMidi) opt.selected = true;
  els.exportNote.appendChild(opt);
}
els.exportNote.addEventListener('change', () => {
  state.selectedMidi = parseInt(els.exportNote.value, 10);
  refreshAnalysis();
});

els.exportBtn.addEventListener('click', async () => {
  const midi = parseInt(els.exportNote.value, 10);
  const sr = ensureEngine().sampleRate;
  els.exportBtn.disabled = true;
  const original = els.exportBtn.textContent;
  els.exportBtn.textContent = '离线渲染中…';
  try {
    // 与实时试听同一条 createFmBellVoice 路径, 包络/曲线完全一致
    const buffer = await renderOffline(state.patch, midi, sr);
    const blob = encodeWav(buffer.getChannelData(0), sr);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fm-bell_${midiToName(midi)}_${Math.round(carrierFreqFor(state.patch, midi))}hz.wav`;
    a.click();
    URL.revokeObjectURL(url);
    els.presetDesc.textContent =
      `已导出 ${midiToName(midi)}, 实际渲染 ${buffer.duration.toFixed(2)}s / ${sr} Hz, 尾巴保留到振幅包络自然结束。`;
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = original;
  }
});

// ---------- 初始化 ----------
state.patch = normalizePatch(defaultPatch());
syncControlsToPatch();
refreshAnalysis();
els.presetDesc.textContent = '选择上方示例, 或直接拖动参数; 按住音符时改参数不会重新起音。';

// 测试钩子: 供端到端测试直接驱动曲线编辑器(不参与正常交互)
(window as unknown as Record<string, unknown>).__fmLab = {
  setCurve: (points: { t: number; v: number }[]) => {
    state.patch.depthCurve = points;
    curveEditor.setPoints(points);
    state.engine?.updateDepth(state.patch);
    refreshAnalysis();
  },
};
