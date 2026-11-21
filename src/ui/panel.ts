export interface PanelElements {
  root: HTMLDivElement;
  modeSelect: HTMLSelectElement;
  fovSlider: HTMLInputElement;
  nearSlider: HTMLInputElement;
  farSlider: HTMLInputElement;
  fovValue: HTMLSpanElement;
  nearValue: HTMLSpanElement;
  farValue: HTMLSpanElement;
  showHelpers: HTMLInputElement;
  showBoxes: HTMLInputElement;
  playButton: HTMLButtonElement;
  stepButton: HTMLButtonElement;
  resetPathButton: HTMLButtonElement;
  resetCameraButton: HTMLButtonElement;
  exportButton: HTMLButtonElement;
  frameValue: HTMLSpanElement;
  totalMeshesValue: HTMLSpanElement;
  perMeshValue: HTMLSpanElement;
  perGroupValue: HTMLSpanElement;
  nativeValue: HTMLSpanElement;
  skippedValue: HTMLSpanElement;
  compareValue: HTMLSpanElement;
  groupTableBody: HTMLTableSectionElement;
  meshTableBody: HTMLTableSectionElement;
  recordHint: HTMLSpanElement;
  selectedValue: HTMLSpanElement;
}

function row(label: string, control: HTMLElement): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'control-row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  wrapper.append(labelEl, control);
  return wrapper;
}

function slider(min: number, max: number, step: number, value: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

function valueSpan(): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'value';
  return span;
}

export function createPanel(): PanelElements {
  const root = document.createElement('div');
  root.id = 'panel-inner';

  const section = (title: string): HTMLDivElement => {
    const el = document.createElement('div');
    el.className = 'section';
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    return el;
  };

  // ---- 剔除策略 ----
  const strategySection = section('剔除策略');
  const modeSelect = document.createElement('select');
  for (const mode of [
    ['per-mesh', '逐物件判定（每摆件独立测）'],
    ['per-group', '按组判定（组 out 跳过 / 交叉下钻）'],
    ['native', '原生对照（Three.js frustumCulled）'],
  ] as const) {
    const option = document.createElement('option');
    option.value = mode[0];
    option.textContent = mode[1];
    modeSelect.appendChild(option);
  }
  strategySection.appendChild(row('模式', modeSelect));
  root.appendChild(strategySection);

  // ---- 观察相机视锥 ----
  const cameraSection = section('观察相机视锥参数');
  const fovSlider = slider(20, 90, 1, 52);
  const nearSlider = slider(0.1, 5, 0.1, 0.5);
  const farSlider = slider(10, 80, 1, 40);
  const fovValue = valueSpan();
  const nearValue = valueSpan();
  const farValue = valueSpan();
  const labeledSlider = (label: string, valueEl: HTMLSpanElement, input: HTMLInputElement) => {
    const wrapper = document.createElement('div');
    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    wrapper.append(labelEl, valueEl, input);
    return wrapper;
  };
  cameraSection.appendChild(labeledSlider('FOV', fovValue, fovSlider));
  cameraSection.appendChild(labeledSlider('Near', nearValue, nearSlider));
  cameraSection.appendChild(labeledSlider('Far', farValue, farSlider));
  root.appendChild(cameraSection);

  // ---- 显示开关 ----
  const displaySection = section('总览调试显示');
  const showHelpers = document.createElement('input');
  showHelpers.type = 'checkbox';
  showHelpers.checked = true;
  const showBoxes = document.createElement('input');
  showBoxes.type = 'checkbox';
  showBoxes.checked = false;
  displaySection.appendChild(row('视锥/包围球', showHelpers));
  displaySection.appendChild(row('包围盒', showBoxes));
  root.appendChild(displaySection);

  // ---- 固定路径 ----
  const pathSection = section('固定路径核对（180 帧）');
  const buttonRow = document.createElement('div');
  buttonRow.className = 'button-row';
  const playButton = document.createElement('button');
  playButton.textContent = '播放路径';
  const stepButton = document.createElement('button');
  stepButton.textContent = '单帧步进';
  const resetPathButton = document.createElement('button');
  resetPathButton.textContent = '复位路径';
  const resetCameraButton = document.createElement('button');
  resetCameraButton.textContent = '相机复位';
  const exportButton = document.createElement('button');
  exportButton.textContent = '导出报告 JSON';
  buttonRow.append(playButton, stepButton, resetPathButton, resetCameraButton, exportButton);
  pathSection.appendChild(buttonRow);
  const frameLine = document.createElement('div');
  frameLine.className = 'control-row';
  const frameLabel = document.createElement('label');
  frameLabel.textContent = '当前帧';
  const frameValue = valueSpan();
  frameLine.append(frameLabel, frameValue);
  pathSection.appendChild(frameLine);
  const recordHint = document.createElement('span');
  recordHint.className = 'hint';
  recordHint.textContent = '播放完成后可导出；无头基线见 verify/baseline.json';
  pathSection.appendChild(recordHint);
  root.appendChild(pathSection);

  // ---- 实时统计 ----
  const statsSection = section('实时绘制统计');
  const totalMeshesValue = valueSpan();
  const perMeshValue = valueSpan();
  const perGroupValue = valueSpan();
  const nativeValue = valueSpan();
  const skippedValue = valueSpan();
  const compareValue = valueSpan();
  const selectedValue = valueSpan();
  statsSection.appendChild(row('摆件总数', totalMeshesValue));
  statsSection.appendChild(row('逐物件应绘制', perMeshValue));
  statsSection.appendChild(row('按组应绘制', perGroupValue));
  statsSection.appendChild(row('原生实际提交', nativeValue));
  statsSection.appendChild(row('组整体跳过', skippedValue));
  statsSection.appendChild(row('逐物件/按组差异', compareValue));
  statsSection.appendChild(row('当前选中', selectedValue));
  root.appendChild(statsSection);

  // ---- 组统计表 ----
  const groupSection = section('组级判定');
  const groupTable = document.createElement('table');
  const groupHead = document.createElement('thead');
  groupHead.innerHTML =
    '<tr><th>组</th><th>状态</th><th>原因</th><th>提交/总数</th></tr>';
  const groupTableBody = document.createElement('tbody');
  groupTable.append(groupHead, groupTableBody);
  groupSection.appendChild(groupTable);
  root.appendChild(groupSection);

  // ---- 摆件明细表 ----
  const meshSection = section('摆件明细（点击行选中）');
  const meshTable = document.createElement('table');
  const meshHead = document.createElement('thead');
  meshHead.innerHTML = '<tr><th>摆件</th><th>所属组</th><th>状态</th><th>原因</th><th>提交</th></tr>';
  const meshTableBody = document.createElement('tbody');
  meshTable.append(meshHead, meshTableBody);
  meshSection.appendChild(meshTable);
  root.appendChild(meshSection);

  return {
    root,
    modeSelect,
    fovSlider,
    nearSlider,
    farSlider,
    fovValue,
    nearValue,
    farValue,
    showHelpers,
    showBoxes,
    playButton,
    stepButton,
    resetPathButton,
    resetCameraButton,
    exportButton,
    frameValue,
    totalMeshesValue,
    perMeshValue,
    perGroupValue,
    nativeValue,
    skippedValue,
    compareValue,
    groupTableBody,
    meshTableBody,
    recordHint,
    selectedValue,
  };
}
