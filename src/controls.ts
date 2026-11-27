import type { AppState } from './state';
import type { Store } from './state';
import { MAX_FREQ, MIN_FREQ, clamp, gainToDb } from './types';
import { VOWEL_PRESETS } from './presets';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** range + number 双控件绑定 */
function bindPair(rangeId: string, numId: string, get: () => number, set: (v: number) => void) {
  const range = $<HTMLInputElement>(rangeId);
  const num = $<HTMLInputElement>(numId);
  range.addEventListener('input', () => set(parseFloat(range.value)));
  num.addEventListener('change', () => set(parseFloat(num.value)));
  return () => {
    range.value = String(get());
    num.value = Number(get().toFixed(3)).toString();
  };
}

function bindCheck(id: string, get: () => boolean, set: (v: boolean) => void) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('change', () => set(el.checked));
  return () => {
    el.checked = get();
  };
}

function bindSlider(id: string, get: () => number, set: (v: number) => void) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('input', () => set(parseFloat(el.value)));
  return () => {
    el.value = String(get());
  };
}

interface RegionRow {
  root: HTMLElement;
  sync: () => void;
}

/** 构建三个共振区的编辑行（编辑对象为当前选中节点） */
export function buildFormantEditor(store: Store): { sync: () => void; highlight: (i: number) => void } {
  const host = $<HTMLDivElement>('formant-editor');
  const colors = ['var(--c-f1)', 'var(--c-f2)', 'var(--c-f3)'];
  const rows: RegionRow[] = [];

  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'formant-row';
    row.innerHTML = `
      <div class="formant-head">
        <span class="dot" style="background:${colors[i]}"></span>
        <b>共振区 F${i + 1}</b>
        <span class="num-readout" id="f${i}-readout"></span>
      </div>
      <label>中心 Hz
        <span class="ctl">
          <input type="range" data-k="center" min="60" max="${MAX_FREQ}" step="1" />
          <input type="number" data-kn="center" min="20" max="20000" step="1" class="num" />
        </span>
      </label>
      <label>带宽 Hz
        <span class="ctl">
          <input type="range" data-k="bandwidth" min="10" max="1200" step="1" />
          <input type="number" data-kn="bandwidth" min="1" max="8000" step="1" class="num" />
        </span>
      </label>
      <label>增益
        <span class="ctl">
          <input type="range" data-k="gain" min="0" max="2.5" step="0.01" />
          <input type="number" data-kn="gain" min="0" max="4" step="0.01" class="num" />
        </span>
      </label>
    `;
    host.appendChild(row);

    const ranges = row.querySelectorAll<HTMLInputElement>('input[data-k]');
    const nums = row.querySelectorAll<HTMLInputElement>('input[data-kn]');
    const keys = ['center', 'bandwidth', 'gain'] as const;

    ranges.forEach((r, j) => {
      r.addEventListener('input', () => {
        const key = keys[j];
        store.update((s) => {
          s.timeline.keys[s.selectedNode].formants[i][key] = parseFloat(r.value);
        });
      });
    });
    nums.forEach((n, j) => {
      n.addEventListener('change', () => {
        const key = keys[j];
        let v = parseFloat(n.value);
        if (key === 'center') v = clamp(v, MIN_FREQ, MAX_FREQ);
        store.update((s) => {
          s.timeline.keys[s.selectedNode].formants[i][key] = v;
        });
      });
    });

    const readout = $<HTMLSpanElement>(`f${i}-readout`);
    rows.push({
      root: row,
      sync: () => {
        const s: AppState = store.state;
        const region = s.timeline.keys[s.selectedNode].formants[i];
        ranges.forEach((r, j) => (r.value = String(region[keys[j]])));
        nums.forEach((n, j) => (n.value = Number(region[keys[j]].toFixed(2)).toString()));
        readout.textContent = `中心 ${region.center.toFixed(0)} Hz · 带宽 ${region.bandwidth.toFixed(
          0,
        )} Hz · ${gainToDb(region.gain).toFixed(1)} dB`;
        row.classList.toggle('selected', s.selectedNode === -1);
      },
    });
  }

  return {
    sync: () => rows.forEach((r) => r.sync()),
    highlight: () => undefined,
  };
}

export interface Controls {
  sync: () => void;
}

/** 绑定全部全局控件，返回一个把 store 状态刷到控件上的 sync 函数 */
export function bindControls(store: Store): Controls {
  const syncers: (() => void)[] = [];

  syncers.push(
    bindPair('f0-range', 'f0-num', () => store.state.f0, (v) =>
      store.update((s) => {
        s.f0 = clamp(v, 40, 1000);
      }),
    ),
  );
  syncers.push(
    bindPair('noise-range', 'noise-num', () => store.state.noiseMix, (v) =>
      store.update((s) => {
        s.noiseMix = clamp(v, 0, 1);
      }),
    ),
  );
  syncers.push(
    bindPair('dur-range', 'dur-num', () => store.state.duration, (v) =>
      store.update((s) => {
        s.duration = clamp(v, 0.2, 5);
      }),
    ),
  );

  syncers.push(
    bindCheck('middle-enable', () => store.state.timeline.middleEnabled, (v) =>
      store.update((s) => {
        s.timeline.middleEnabled = v;
        if (!v && s.selectedNode === 1) s.selectedNode = 0;
      }),
    ),
  );
  syncers.push(
    bindSlider('middle-pos', () => store.state.timeline.middlePos, (v) =>
      store.update((s) => {
        s.timeline.middlePos = clamp(v, 0.05, 0.95);
        s.timeline.keys[1].pos = s.timeline.middlePos;
      }),
    ),
  );

  syncers.push(
    bindCheck('normalize-enable', () => store.state.normalize, (v) =>
      store.update((s) => {
        s.normalize = v;
      }),
    ),
  );
  syncers.push(
    bindSlider('targetdb-range', () => store.state.targetDb, (v) =>
      store.update((s) => {
        s.targetDb = v;
      }),
    ),
  );
  syncers.push(
    bindSlider('master-range', () => store.state.masterDb, (v) =>
      store.update((s) => {
        s.masterDb = v;
      }),
    ),
  );
  syncers.push(
    bindSlider('cursor-range', () => store.state.cursor, (v) =>
      store.update((s) => {
        s.cursor = clamp(v, 0, 1);
      }),
    ),
  );

  // 节点选择按钮
  document.querySelectorAll<HTMLButtonElement>('button[data-node]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.update((s) => {
        s.selectedNode = parseInt(btn.dataset.node!, 10);
      });
    });
  });

  // 元音预设：写入当前选中节点
  document.querySelectorAll<HTMLButtonElement>('button[data-vowel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const vowel = btn.dataset.vowel!;
      const preset = VOWEL_PRESETS[vowel];
      store.update((s) => {
        s.timeline.keys[s.selectedNode].formants = preset.formants.map((r) => ({
          ...r,
        })) as typeof s.timeline.keys[number]['formants'];
      });
      const hint = $<HTMLParagraphElement>('vowel-hint');
      hint.textContent = `已把 ${preset.label} 的共振参数写入「${store.state.timeline.keys[store.state.selectedNode].label}」。`;
    });
  });

  const middlePosVal = $<HTMLSpanElement>('middle-pos-val');
  const targetDbVal = $<HTMLSpanElement>('targetdb-val');
  const masterVal = $<HTMLSpanElement>('master-val');
  const cursorVal = $<HTMLSpanElement>('cursor-val');

  const extraSync = () => {
    const s = store.state;
    middlePosVal.textContent = `${(s.timeline.middlePos * 100).toFixed(0)}%`;
    targetDbVal.textContent = `${s.targetDb.toFixed(1)} dBFS`;
    masterVal.textContent = `${s.masterDb.toFixed(1)} dB`;
    cursorVal.textContent = `${(s.cursor * 100).toFixed(1)}% · ${(s.cursor * s.duration).toFixed(2)}s`;
    document.querySelectorAll<HTMLButtonElement>('button[data-node]').forEach((btn) => {
      const idx = parseInt(btn.dataset.node!, 10);
      btn.classList.toggle('btn-active', s.selectedNode === idx);
      btn.disabled = idx === 1 && !s.timeline.middleEnabled;
    });
  };

  return {
    sync: () => {
      syncers.forEach((fn) => fn());
      extraSync();
    },
  };
}
