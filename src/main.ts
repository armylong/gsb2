import './styles.css';
import { Store, defaultState } from './state';
import { SAMPLE_RATE, type RenderOptions } from './types';
import { renderSynth } from './dsp/synth';
import { decodeWav, downloadWav, encodeWav } from './dsp/wav';
import { readbackCheck, type ReadbackReport } from './dsp/readback';
import { AudioEngine } from './audio-engine';
import { SpectrumPlot, TimelinePlot } from './plots';
import { bindControls, buildFormantEditor } from './controls';
import { EXAMPLES } from './presets';
import { themeColors } from './theme';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const store = new Store(defaultState());
const engine = new AudioEngine();
const spectrum = new SpectrumPlot(
  $<HTMLCanvasElement>('spectrum-canvas'),
  $<HTMLDivElement>('spectrum-tip'),
);
const timeline = new TimelinePlot($<HTMLCanvasElement>('timeline-canvas'));
const controls = bindControls(store);
const editor = buildFormantEditor(store);

let cachedWarnings: string[] = [];
let freezeCursor: number | null = null;
let rafQueued = false;

function renderSamples(opts: RenderOptions): Float32Array {
  const result = renderSynth(opts);
  cachedWarnings = result.warnings;
  return result.samples;
}

function refresh(): void {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    controls.sync();
    editor.sync();
    timeline.draw(store.state);
    spectrum.rebuild(store.state, renderSamples);
    renderWarnings();
  });
}

store.subscribe(refresh);

function renderWarnings(): void {
  const host = $('warnings');
  if (cachedWarnings.length === 0) {
    host.innerHTML = `<span class="ok">✓ 参数均在可用频带（40 Hz–12 kHz）内，当前位置峰检测正常。</span>`;
    return;
  }
  host.innerHTML = cachedWarnings.map((w) => `<span class="warn">⚠ ${w}</span>`).join('');
}

// ---- 时间线交互 ----
timeline.onSeek = (t) => {
  store.update((s) => {
    s.cursor = t;
  });
};
timeline.onSelectNode = (i) => {
  store.update((s) => {
    s.selectedNode = i;
  });
};

// ---- 播放控制 ----
$('play').addEventListener('click', () => {
  freezeCursor = null;
  engine.playFull(store.state, store.targetRms, store.state.cursor * store.state.duration);
  updatePlayHint();
});
$('stop').addEventListener('click', () => {
  engine.stopAll();
  updatePlayHint();
});
$('freeze').addEventListener('click', () => {
  freezeCursor = store.state.cursor;
  engine.freezeAt(store.state, freezeCursor, store.targetRms);
  updatePlayHint();
});
$('resume').addEventListener('click', () => {
  const from = freezeCursor ?? store.state.cursor;
  freezeCursor = null;
  engine.playFull(store.state, store.targetRms, from * store.state.duration);
  store.update((s) => {
    s.cursor = from;
  });
  updatePlayHint();
});

engine.onEnded = () => {
  store.update((s) => {
    s.cursor = 1;
  });
  updatePlayHint();
};

function updatePlayHint(): void {
  const hint = $('play-state-hint');
  const s = store.state;
  if (engine.mode === 'playing') {
    hint.textContent = `整段试听中（从 ${(s.cursor * s.duration).toFixed(2)}s 起）；包络与逐样本系数插值保证无边界脉冲、音高恒定。`;
  } else if (engine.mode === 'frozen') {
    hint.textContent = `已定住 t=${((freezeCursor ?? s.cursor) * 100).toFixed(1)}% 处的音色，等功率交叉淡化循环，无接缝脉冲。`;
  } else {
    hint.textContent = '已停止。光标位置保持不变，可继续试听或定住该位置。';
  }
}

// 播放时持续刷新光标与电平表
function meterLoop(): void {
  if (engine.mode === 'playing') {
    const pos = engine.getPosition(store.state);
    const t = Math.min(1, pos / store.state.duration);
    if (Math.abs(t - store.state.cursor) > 0.0005) {
      store.update((s) => {
        s.cursor = t;
      });
    }
  }
  const db = engine.readLevel();
  const fill = $('meter-fill') as HTMLDivElement;
  const dbText = $('meter-db');
  if (db === -Infinity) {
    fill.style.width = '0%';
    dbText.textContent = '−∞ dB';
  } else {
    const pct = Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
    fill.style.width = `${pct}%`;
    dbText.textContent = `${db.toFixed(1)} dB`;
  }
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// 主音量变化即时下发（不等重渲染）
store.subscribe(() => engine.setMasterDb(store.state.masterDb));

// ---- 导出 WAV + 回读 ----
$('export').addEventListener('click', () => {
  const s = store.state;
  const samples = renderSamples({
    sampleRate: SAMPLE_RATE,
    duration: s.duration,
    f0: s.f0,
    noiseMix: s.noiseMix,
    timeline: s.timeline,
    normalizeTo: store.targetRms,
    seed: s.seed,
  });
  const encoded = encodeWav(samples, SAMPLE_RATE);
  downloadWav(samples, SAMPLE_RATE, `formant-${Date.now()}.wav`);
  // 从导出的字节回读，而不是直接用内存样本，验证 WAV 闭环
  const decoded = decodeWav(encoded);
  const report = readbackCheck(decoded.samples, decoded.sampleRate, s.timeline, s.f0);
  renderReport(report);
});

function statusBadge(status: string): string {
  const map: Record<string, { cls: string; text: string }> = {
    ok: { cls: 'st-ok', text: '清楚' },
    weak: { cls: 'st-warn', text: '峰弱' },
    missing: { cls: 'st-crit', text: '无峰' },
    merged: { cls: 'st-warn', text: '合并' },
  };
  const m = map[status] ?? { cls: 'st-warn', text: status };
  return `<span class="badge ${m.cls}">${m.text}</span>`;
}

function renderReport(report: ReadbackReport): void {
  const host = $('readback');
  const c = themeColors();
  const nodeHtml = report.nodes
    .map((nd) => {
      const rows = nd.regions
        .map((r) => {
          const peak = r.matchedPeak
            ? `${r.matchedPeak.freq.toFixed(0)} Hz`
            : '—';
          const delta = r.deltaHz !== null ? `${r.deltaHz >= 0 ? '+' : ''}${r.deltaHz.toFixed(0)} Hz` : '—';
          return `<tr>
            <td><span class="dot" style="background:${[c.f1, c.f2, c.f3][r.index]}"></span>F${r.index + 1}</td>
            <td>${r.expectedCenter.toFixed(0)}</td>
            <td>${peak}</td>
            <td>${delta}</td>
            <td>${statusBadge(r.status)}</td>
          </tr>`;
        })
        .join('');
      const f0Text = nd.f0 !== null ? `${nd.f0.toFixed(1)} Hz` : '未检测到';
      return `<div class="report-node">
        <h4>${nd.label}（t=${(nd.pos * 100).toFixed(0)}%） · 基频 ${f0Text}（设定 ${store.state.f0.toFixed(0)} Hz）</h4>
        <table>
          <thead><tr><th>共振区</th><th>期望中心</th><th>实测峰</th><th>偏差</th><th>状态</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${nd.notes.length ? `<p class="note">${nd.notes.map((n) => `• ${n}`).join('<br>')}</p>` : ''}
        ${nd.regions.map((r) => `<p class="note">${r.message}</p>`).join('')}
      </div>`;
    })
    .join('');

  const moveHtml = report.movements
    .filter((mv) => Math.abs(mv.deltaHz) >= 20)
    .map(
      (mv) =>
        `<tr><td>${mv.label}</td><td>${mv.from.toFixed(0)} → ${mv.to.toFixed(0)} Hz</td><td>${
          mv.deltaHz >= 0 ? '+' : ''
        }${mv.deltaHz.toFixed(0)} Hz</td></tr>`,
    )
    .join('');

  host.innerHTML = `
    <h3>回读结果（来自导出的 WAV 字节，采样率 ${SAMPLE_RATE} Hz）</h3>
    ${nodeHtml}
    ${
      moveHtml
        ? `<h4>节点间共振位置变化</h4><table><thead><tr><th>轨迹</th><th>中心移动</th><th>变化量</th></tr></thead><tbody>${moveHtml}</tbody></table>`
        : '<p class="note">节点间共振位置基本不动（静止口形）。</p>'
    }
    ${report.globalNotes.map((n) => `<p class="warn">⚠ ${n}</p>`).join('')}
  `;
}

// ---- 三个内置例子 ----
EXAMPLES.forEach((factory, i) => {
  const ids = ['ex-static', 'ex-glide', 'ex-breathy'];
  $(ids[i]).addEventListener('click', () => {
    const ex = factory();
    engine.stopAll();
    freezeCursor = null;
    store.update((s) => {
      s.f0 = ex.f0;
      s.noiseMix = ex.noiseMix;
      s.duration = ex.duration;
      s.timeline = {
        middleEnabled: ex.middleEnabled,
        middlePos: ex.middlePos,
        keys: ex.keys.map((k) => ({
          ...k,
          formants: k.formants.map((r) => ({ ...r })) as typeof k.formants,
        })),
      };
      s.selectedNode = 0;
      s.cursor = 0.1;
    });
    $('vowel-hint').textContent = `例子「${ex.name}」：${ex.description}`;
    updatePlayHint();
  });
});

// ---- 主题 ----
$('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  refresh();
});

// 初始绘制
refresh();
updatePlayHint();
