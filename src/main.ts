import { calibrate, groundPoint, refLineGroundPoints } from './calibration';
import type { Calibration } from './calibration';
import { ImageView } from './imageView';
import type { Mode } from './imageView';
import { generateSceneImage, PRESETS } from './sceneImage';
import type { MarkedLine, PlacedBox, ScenePreset } from './types';
import { View3D } from './view3d';

interface LastValid {
  lines: MarkedLine[];
  calibration: Calibration;
}

const state = {
  lines: [] as MarkedLine[],
  boxes: [] as PlacedBox[],
  refLenM: 1.0,
  boxW: 0.6,
  boxD: 0.6,
  boxH: 0.8,
  preset: PRESETS[0] as ScenePreset,
};

let nextLineId = 1;
let nextBoxId = 1;
let calibration: Calibration | null = null;
let lastValid: LastValid | null = null;
let sceneImage: HTMLCanvasElement;

const panel = document.getElementById('panel')!;
const statusBar = document.getElementById('image-status')!;

/** 当前生效的标定:当前无效时回退到上一次有效结果 */
function effectiveCalibration(): Calibration | null {
  if (calibration?.ok) return calibration;
  return lastValid?.calibration ?? null;
}

const imageView = new ImageView(
  document.getElementById('image-canvas') as HTMLCanvasElement,
  {
    onLineCreated(line) {
      // 参考线只保留一条
      if (line.dir === 'REF') state.lines = state.lines.filter((l) => l.dir !== 'REF');
      state.lines.push(line);
      nextLineId = imageView.getNextId();
      recompute();
    },
    onLinesChanged: () => recompute(),
    onLinesChanging: () => recompute(true),
    onSelectLine: () => updatePanel(),
    onPlaceBox(imgPt) {
      const cal = effectiveCalibration();
      if (!cal) {
        setStatus('标定无效,无法放置盒子(请先完成两组方向的画线)');
        return;
      }
      const g = groundPoint(imgPt, cal, state.preset.width, state.preset.height);
      if (!g) {
        setStatus('该点在地平线之上或射线不落地,无法放置');
        return;
      }
      state.boxes.push({
        id: nextBoxId++, gx: g.x, gz: g.z,
        w: state.boxW, d: state.boxD, h: state.boxH,
      });
      setStatus(`盒子已放置于地面 (${g.x.toFixed(2)}, ${g.z.toFixed(2)}) m`);
      recompute();
    },
    onStatus: setStatus,
  },
);

const view3d = new View3D(document.getElementById('view3d-canvas') as HTMLCanvasElement);

function setStatus(msg: string) {
  statusBar.textContent = msg;
}

function loadScene(preset: ScenePreset) {
  state.preset = preset;
  sceneImage = generateSceneImage(preset);
  imageView.setImage(sceneImage);
  recompute();
}

function recompute(light = false) {
  calibration = calibrate(
    state.lines, state.preset.width, state.preset.height, state.refLenM,
  );
  if (calibration.ok) {
    lastValid = {
      lines: state.lines.map((l) => ({ ...l, p1: { ...l.p1 }, p2: { ...l.p2 } })),
      calibration,
    };
  }
  syncViews(light);
}

function syncViews(light: boolean) {
  const eff = effectiveCalibration();
  imageView.lines = state.lines;
  imageView.boxes = state.boxes;
  imageView.calibration = eff;
  imageView.render();
  const refLine = state.lines.find((l) => l.dir === 'REF');
  const refGround = eff && refLine
    ? refLineGroundPoints(refLine, eff, state.preset.width, state.preset.height)
    : null;
  view3d.update(eff, state.boxes, state.preset.width, state.preset.height, refGround);
  if (!light) updatePanel();
}

// ---------- 面板 ----------

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function updatePanel() {
  const cal = calibration;
  const eff = effectiveCalibration();
  const usingFallback = !!(!cal?.ok && lastValid);
  const p = state.preset;

  let statusHtml: string;
  if (cal?.ok) {
    statusHtml = `<span class="status-ok">✔ 标定有效</span>`;
  } else if (usingFallback) {
    statusHtml = `<span class="status-warn">⚠ 当前标定无效,显示的是上一次有效对齐的结果</span>`;
  } else {
    statusHtml = `<span class="status-bad">✖ 标定无效(尚无有效对齐)</span>`;
  }

  const issues = cal && !cal.ok ? cal.issues : cal?.issues.filter((i) => i) ?? [];
  const issuesHtml = issues.length
    ? `<ul class="issue-list">${issues.map((i) => `<li>${i}</li>`).join('')}</ul>`
    : '';

  const effRows = eff
    ? `
      <tr><td>焦距 f</td><td class="num">${fmt(eff.focal)} px</td></tr>
      <tr><td>水平视场角</td><td class="num">${fmt(eff.fovDeg)}°</td></tr>
      <tr><td>朝向 yaw</td><td class="num">${fmt(eff.yawDeg)}°</td></tr>
      <tr><td>俯角</td><td class="num">${fmt(eff.depressionDeg)}°</td></tr>
      <tr><td>相机高度</td><td class="num">${fmt(eff.cameraHeight, 2)} m${eff.heightFromRef ? '' : ' (默认)'}</td></tr>
      <tr><td>残差 RMS (X/Z)</td><td class="num">${fmt(eff.rmsX, 2)} / ${fmt(eff.rmsZ, 2)} px</td></tr>
      <tr><td>正交偏差</td><td class="num">${fmt(eff.orthoErrDeg, 2)}°</td></tr>`
    : '<tr><td colspan="2" class="hint-text">暂无有效标定</td></tr>';

  const truthRows = `
    <tr class="truth"><td>真值 f</td><td class="num">${p.focal} px</td></tr>
    <tr class="truth"><td>真值 yaw / 俯角</td><td class="num">${p.yawDeg}° / ${p.depressionDeg}°</td></tr>
    <tr class="truth"><td>真值高度</td><td class="num">${p.camHeight.toFixed(2)} m</td></tr>`;

  const lineItems = state.lines.map((ln) => {
    const len = Math.hypot(ln.p2.x - ln.p1.x, ln.p2.y - ln.p1.y);
    const res = eff?.residuals.get(ln.id);
    const sel = ln.id === imageView.selectedId ? ' selected' : '';
    return `<div class="line-item${sel}" data-id="${ln.id}">
      <span class="swatch" style="background:${ln.dir === 'X' ? '#e8912d' : ln.dir === 'Z' ? '#2dc4c4' : '#5cc45c'}"></span>
      <span>#${ln.id}</span>
      <select data-id="${ln.id}" class="dir-select">
        <option value="X"${ln.dir === 'X' ? ' selected' : ''}>X 方向</option>
        <option value="Z"${ln.dir === 'Z' ? ' selected' : ''}>Z 方向</option>
        <option value="REF"${ln.dir === 'REF' ? ' selected' : ''}>参考长度</option>
      </select>
      <span class="resid">${len.toFixed(0)}px${res !== undefined && ln.dir !== 'REF' ? ` · 偏差${res.toFixed(1)}px` : ''}</span>
      <button class="del" data-del="${ln.id}" title="删除">✕</button>
    </div>`;
  }).join('') || '<div class="hint-text">还没有标线。用工具栏在图上沿地面网格线画线。</div>';

  const boxItems = state.boxes.map((b) =>
    `<div class="box-item">
      <span>盒子 #${b.id} @ (${b.gx.toFixed(2)}, ${b.gz.toFixed(2)}) m · ${b.w}×${b.d}×${b.h}m</span>
      <button class="del" data-del-box="${b.id}" title="删除">✕</button>
    </div>`,
  ).join('') || '<div class="hint-text">还没有盒子。选"放置盒子"模式后在图像地面处点击。</div>';

  panel.innerHTML = `
    <div class="panel-section">
      <h3>场景</h3>
      <div class="scene-switch">
        ${PRESETS.map((pr) => `
          <label><input type="radio" name="scene" value="${pr.key}"${pr.key === p.key ? ' checked' : ''}/> ${pr.label}</label>
        `).join('')}
      </div>
      <div class="hint-text">场景由程序生成:地面网格间距 1m,可沿网格画线;参考线沿一格画并填 1m 即可恢复真实尺度。</div>
    </div>
    <div class="panel-section">
      <h3>标定状态</h3>
      ${statusHtml}
      ${issuesHtml}
      <button id="btn-revert" class="panel-btn primary" ${lastValid ? '' : 'disabled'}>回到上一次有效对齐</button>
      <button id="btn-clear-lines" class="panel-btn">清空标线</button>
      <button id="btn-clear-boxes" class="panel-btn">清空盒子</button>
    </div>
    <div class="panel-section">
      <h3>推断结果(居中画幅 · 方形像素)</h3>
      <table class="kv-table">${effRows}</table>
    </div>
    <div class="panel-section">
      <h3>与生成参数对比</h3>
      <table class="kv-table">${truthRows}</table>
    </div>
    <div class="panel-section">
      <h3>尺度与盒子</h3>
      <div class="input-row">
        <label>参考线实际长度 (m)</label>
        <input id="inp-reflen" type="number" step="0.1" min="0.01" value="${state.refLenM}" />
      </div>
      <div class="input-row">
        <label>盒子 宽×深×高 (m)</label>
        <input id="inp-boxw" type="number" step="0.1" min="0.05" value="${state.boxW}" />
        <input id="inp-boxd" type="number" step="0.1" min="0.05" value="${state.boxD}" />
        <input id="inp-boxh" type="number" step="0.1" min="0.05" value="${state.boxH}" />
      </div>
    </div>
    <div class="panel-section">
      <h3>标线 (${state.lines.length})</h3>
      ${lineItems}
    </div>
    <div class="panel-section">
      <h3>已放置盒子 (${state.boxes.length})</h3>
      ${boxItems}
    </div>
  `;

  // 事件
  panel.querySelectorAll<HTMLInputElement>('input[name="scene"]').forEach((el) => {
    el.addEventListener('change', () => {
      const pr = PRESETS.find((x) => x.key === el.value);
      if (pr) loadScene(pr);
    });
  });
  panel.querySelector<HTMLButtonElement>('#btn-revert')?.addEventListener('click', () => {
    if (!lastValid) return;
    state.lines = lastValid.lines.map((l) => ({ ...l, p1: { ...l.p1 }, p2: { ...l.p2 } }));
    nextLineId = Math.max(0, ...state.lines.map((l) => l.id)) + 1;
    imageView.setNextId(nextLineId);
    setStatus('已恢复到上一次有效对齐');
    recompute();
  });
  panel.querySelector<HTMLButtonElement>('#btn-clear-lines')?.addEventListener('click', () => {
    state.lines = [];
    recompute();
  });
  panel.querySelector<HTMLButtonElement>('#btn-clear-boxes')?.addEventListener('click', () => {
    state.boxes = [];
    recompute();
  });
  panel.querySelector<HTMLInputElement>('#inp-reflen')?.addEventListener('change', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (v > 0) { state.refLenM = v; recompute(); }
  });
  const bindBox = (id: string, key: 'boxW' | 'boxD' | 'boxH') => {
    panel.querySelector<HTMLInputElement>(id)?.addEventListener('change', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (v > 0) { state[key] = v; updatePanel(); }
    });
  };
  bindBox('#inp-boxw', 'boxW');
  bindBox('#inp-boxd', 'boxD');
  bindBox('#inp-boxh', 'boxH');

  panel.querySelectorAll<HTMLSelectElement>('.dir-select').forEach((el) => {
    el.addEventListener('change', () => {
      const id = Number(el.dataset.id);
      const ln = state.lines.find((l) => l.id === id);
      if (!ln) return;
      const dir = el.value as MarkedLine['dir'];
      if (dir === 'REF') state.lines = state.lines.filter((l) => l.dir !== 'REF' || l.id === id);
      ln.dir = dir;
      recompute();
    });
  });
  panel.querySelectorAll<HTMLElement>('[data-del]').forEach((el) => {
    el.addEventListener('click', () => {
      state.lines = state.lines.filter((l) => l.id !== Number(el.dataset.del));
      recompute();
    });
  });
  panel.querySelectorAll<HTMLElement>('[data-del-box]').forEach((el) => {
    el.addEventListener('click', () => {
      state.boxes = state.boxes.filter((b) => b.id !== Number(el.dataset.delBox));
      recompute();
    });
  });
  panel.querySelectorAll<HTMLElement>('.line-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'SELECT' || (e.target as HTMLElement).tagName === 'BUTTON') return;
      imageView.selectedId = Number(el.dataset.id);
      imageView.render();
      updatePanel();
    });
  });
}

// ---------- 工具栏 ----------

document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    imageView.mode = btn.dataset.mode as Mode;
  });
});
document.getElementById('btn-fit')!.addEventListener('click', () => imageView.fit());

// ---------- 启动 ----------

loadScene(PRESETS[0]);
setStatus('在图上沿地面网格画线:同一方向至少画 2 条,两个方向互相垂直');
