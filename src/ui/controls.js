// 侧边栏控件构建：参数滑块、预设、视角、物体列表（纯 DOM 操作）
import { PARAM_META, PARAM_PRESETS, VIEW_PRESETS, OBJECT_DEFS } from '../diag/scene-config.js';

const GROUP_LABELS = {
  coverage: '阴影覆盖范围',
  resolution: '清晰度',
  bias: '偏移',
  light: '方向光',
};

const GROUP_ORDER = ['coverage', 'resolution', 'bias', 'light'];

export function buildControls(root, handlers) {
  root.innerHTML = '';

  // ---- 现象预设 ----
  const presetSec = section(root, '现象预设（一键复现）');
  const presetGrid = document.createElement('div');
  presetGrid.className = 'preset-grid';
  for (const preset of PARAM_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = preset.label;
    btn.title = preset.note;
    btn.dataset.preset = preset.id;
    btn.addEventListener('click', () => handlers.onPreset(preset.id));
    presetGrid.appendChild(btn);
  }
  presetSec.appendChild(presetGrid);

  // ---- 视角预设 ----
  const viewSec = section(root, '视角预设');
  const viewGrid = document.createElement('div');
  viewGrid.className = 'preset-grid';
  for (const view of VIEW_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'chip chip-view';
    btn.textContent = view.label;
    btn.dataset.view = view.id;
    btn.addEventListener('click', () => handlers.onView(view.id));
    viewGrid.appendChild(btn);
  }
  viewSec.appendChild(viewGrid);

  // ---- 参数滑块（按分组） ----
  const sliders = {};
  for (const group of GROUP_ORDER) {
    const sec = section(root, GROUP_LABELS[group]);
    for (const meta of PARAM_META.filter((m) => m.group === group)) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const head = document.createElement('div');
      head.className = 'param-head';
      const name = document.createElement('span');
      name.className = 'param-name';
      name.textContent = meta.label;
      const value = document.createElement('span');
      value.className = 'param-value';
      value.dataset.value = meta.key;
      head.append(name, value);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = meta.min;
      input.max = meta.max;
      input.step = meta.step;
      input.dataset.param = meta.key;
      input.addEventListener('input', () => {
        let v = Number(input.value);
        if (meta.pow2) {
          // 吸附到最近的 2 的幂，阴影贴图要求幂次尺寸
          v = 2 ** Math.round(Math.log2(v));
          input.value = v;
        }
        handlers.onParam(meta.key, v);
      });

      row.append(head, input);
      sec.appendChild(row);
      sliders[meta.key] = { input, value, meta };
    }
  }

  // ---- 物体列表（选择/拖动、显示状态） ----
  const objSec = section(root, '物体（选中后可在场景中拖动）');
  const objList = document.createElement('div');
  objList.className = 'object-list';
  const objectRows = {};
  for (const def of OBJECT_DEFS) {
    const row = document.createElement('button');
    row.className = 'object-row';
    row.dataset.object = def.id;
    const dot = document.createElement('span');
    dot.className = 'object-dot';
    dot.style.background = '#' + def.color.toString(16).padStart(6, '0');
    const label = document.createElement('span');
    label.textContent = def.label;
    const state = document.createElement('span');
    state.className = 'object-state';
    state.dataset.state = def.id;
    row.append(dot, label, state);
    row.addEventListener('click', () => handlers.onSelectObject(def.id));
    objList.appendChild(row);
    objectRows[def.id] = { row, state };
  }
  objSec.appendChild(objList);

  return { sliders, objectRows };
}

function section(root, title) {
  const sec = document.createElement('section');
  sec.className = 'panel-section';
  const h = document.createElement('h3');
  h.textContent = title;
  sec.appendChild(h);
  root.appendChild(sec);
  return sec;
}

/** 用当前参数刷新所有滑块位置与数值显示 */
export function syncSliders(sliders, params) {
  for (const [key, { input, value, meta }] of Object.entries(sliders)) {
    const v = params[key];
    input.value = v;
    const digits = meta.digits ?? (Math.abs(meta.step) < 1 ? 2 : 0);
    value.textContent = `${v.toFixed(digits)}${meta.unit || ''}`;
  }
}
