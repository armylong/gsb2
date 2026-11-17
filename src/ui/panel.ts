/** 左侧控制面板：直接绑定 AppStore，状态变化后由主入口统一重绘视图 */
import { AppState, AppStore, Derived } from './store';
import { CapStyle, JoinStyle } from '../core/types';
import { SAMPLES } from '../core/samples';
import { runAllChecks, CheckResult } from '../core/verify';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  $('#panel').appendChild(h);
  return h;
}

function rangeRow(label: string, min: number, max: number, step: number, value: number,
  onChange: (v: number) => void, fmt: (v: number) => string = (v) => v.toFixed(2)) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lab = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = fmt(value);
  lab.append(name, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    onChange(v);
  });
  wrap.append(lab, input);
  $('#panel').appendChild(wrap);
  return { wrap, input, val };
}

function checkRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const wrap = document.createElement('div');
  wrap.className = 'check-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const lab = document.createElement('span');
  lab.textContent = label;
  wrap.append(input, lab);
  $('#panel').appendChild(wrap);
  return input;
}

function segButtons<T extends string>(label: string, options: [T, string][], value: T,
  onChange: (v: T) => void) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lab = document.createElement('label');
  lab.innerHTML = `<span>${label}</span>`;
  const seg = document.createElement('div');
  seg.className = 'seg';
  const btns = options.map(([key, text]) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (key === value) b.classList.add('active');
    b.addEventListener('click', () => {
      btns.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onChange(key);
    });
    seg.appendChild(b);
    return b;
  });
  wrap.append(lab, seg);
  $('#panel').appendChild(wrap);
}

export function buildPanel(store: AppStore, rerunCamera: () => void): void {
  const panel = $('#panel');
  panel.innerHTML = '';

  const title = document.createElement('h1');
  title.textContent = '笔画 → 三角网格';
  panel.appendChild(title);
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = '所有几何按场景单位生成，再由 earcut 三角化；未借用浏览器线条宽度，不做路径布尔运算。';
  panel.appendChild(sub);

  // ---------- 样例与路径 ----------
  section('样例路径（程序生成）');
  const sel = document.createElement('select');
  SAMPLES.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    store.loadSample(sel.value);
    syncControls();
    rerunCamera();
  });
  panel.appendChild(sel);

  const pathBtns = document.createElement('div');
  pathBtns.className = 'btn-row';
  pathBtns.style.marginTop = '8px';
  const closedBtn = document.createElement('button');
  closedBtn.textContent = store.state.closed ? '闭合：开' : '闭合：关';
  closedBtn.classList.toggle('active', store.state.closed);
  closedBtn.addEventListener('click', () => {
    store.toggleClosed();
    closedBtn.textContent = store.state.closed ? '闭合：开' : '闭合：关';
    closedBtn.classList.toggle('active', store.state.closed);
  });
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '清空顶点';
  clearBtn.addEventListener('click', () => {
    store.update((s) => { s.points = []; });
  });
  pathBtns.append(closedBtn, clearBtn);
  panel.appendChild(pathBtns);

  // ---------- 笔画参数 ----------
  section('笔画参数（场景长度单位）');
  rangeRow('笔画宽度 width', 0.1, 4, 0.05, store.state.stroke.width,
    (v) => store.update((s) => { s.stroke.width = v; }));
  segButtons<CapStyle>('开放端端帽', [['butt', '平头'], ['square', '方头'], ['round', '圆头']],
    store.state.stroke.cap, (v) => store.update((s) => { s.stroke.cap = v; }));
  segButtons<JoinStyle>('转角连接', [['miter', '尖角'], ['bevel', '削平'], ['round', '圆角']],
    store.state.stroke.join, (v) => store.update((s) => { s.stroke.join = v; }));
  rangeRow('尖角限制 miterLimit（尖角长 / width）', 0.2, 12, 0.05, store.state.stroke.miterLimit,
    (v) => store.update((s) => { s.stroke.miterLimit = v; }), (v) => v.toFixed(2));
  rangeRow('圆弧分段（每 π）', 4, 48, 2, store.state.stroke.arcSegments,
    (v) => store.update((s) => { s.stroke.arcSegments = v; }), (v) => v.toFixed(0));

  // ---------- 虚线 ----------
  section('虚线（按累计弧长连续排列）');
  checkRow('启用虚线', store.state.dash.dashed, (v) => store.update((s) => { s.dash.dashed = v; }));
  rangeRow('线段长度 dash', 0.1, 8, 0.05, store.state.dash.dashLength,
    (v) => store.update((s) => { s.dash.dashLength = v; }));
  rangeRow('空隙长度 gap', 0, 8, 0.05, store.state.dash.gapLength,
    (v) => store.update((s) => { s.dash.gapLength = v; }));
  rangeRow('起始偏移 offset', -10, 10, 0.05, store.state.dash.offset,
    (v) => store.update((s) => { s.dash.offset = v; }));

  // ---------- 显示 ----------
  section('显示');
  const display = { showFill: true, showWire: true, showCenter: true, showVertices: true };
  checkRow('填充（真实三角网格）', display.showFill, (v) => { display.showFill = v; window.dispatchEvent(new Event('display-change')); });
  checkRow('三角形边线', display.showWire, (v) => { display.showWire = v; window.dispatchEvent(new Event('display-change')); });
  checkRow('中心线（独立参照）', display.showCenter, (v) => { display.showCenter = v; window.dispatchEvent(new Event('display-change')); });
  checkRow('顶点标记', display.showVertices, (v) => { display.showVertices = v; window.dispatchEvent(new Event('display-change')); });

  // ---------- 统计 ----------
  section('网格统计');
  const stats = document.createElement('div');
  stats.className = 'stats';
  panel.appendChild(stats);

  // ---------- 验证 ----------
  section('可重复验证（预期值 / 实测值）');
  const summary = document.createElement('div');
  summary.id = 'summary';
  panel.appendChild(summary);
  const checksHost = document.createElement('div');
  panel.appendChild(checksHost);
  const rerunBtn = document.createElement('button');
  rerunBtn.textContent = '重新运行验证';
  rerunBtn.style.width = '100%';
  rerunBtn.addEventListener('click', () => renderChecks());
  panel.appendChild(rerunBtn);

  const note = document.createElement('p');
  note.className = 'muted';
  note.style.marginTop = '10px';
  note.textContent = '提示：左键空白添加顶点，左键拖动顶点移动，双击顶点删除，右键/中键平移，滚轮缩放（以光标为中心）。';
  panel.appendChild(note);

  function renderChecks(): void {
    const results: CheckResult[] = runAllChecks();
    const passCount = results.filter((r) => r.pass).length;
    summary.textContent = `结果：${passCount}/${results.length} 通过`;
    summary.style.color = passCount === results.length ? '#7ee2a8' : '#ff9aa6';
    checksHost.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = `check-item ${r.pass ? 'pass' : 'fail'}`;
      item.innerHTML = `
        <div class="head"><span>${r.name}</span><span class="badge ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></div>
        <div class="exp">预期：${r.expected}</div>
        <div class="meas">实测：${r.measured}</div>`;
      checksHost.appendChild(item);
    }
  }
  renderChecks();

  function syncControls(): void {
    closedBtn.textContent = store.state.closed ? '闭合：开' : '闭合：关';
    closedBtn.classList.toggle('active', store.state.closed);
  }

  // 暴露统计更新给主入口
  (window as unknown as { __updateStats: (d: Derived, st: AppState) => void }).__updateStats = (d) => {
    stats.innerHTML =
      `路径总长度 L = <b>${d.totalLength.toFixed(3)}</b><br>` +
      `网格顶点数 = <b>${d.mesh?.vertexCount ?? 0}</b><br>` +
      `三角形数 = <b>${d.mesh?.triangleCount ?? 0}</b><br>` +
      `虚线区间数 = <b>${d.mesh?.intervalCount ?? 0}</b><br>` +
      `有效顶点数（去重后）= <b>${d.path.points.length}</b>`;
  };
}
