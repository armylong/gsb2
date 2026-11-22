import * as THREE from 'three';
import { createSampleScene } from './three/sampleScene.ts';
import { Viewer3D } from './three/viewer3d.ts';
import type { WorldMesh } from './hlr/geometry.ts';
import { buildWorld } from './hlr/geometry.ts';
import type { ViewDescriptor } from './hlr/view.ts';
import { standardViews } from './hlr/view.ts';
import type { HLRResult } from './hlr/hlr.ts';
import { runHLR } from './hlr/hlr.ts';
import { serializeSvg } from './hlr/svg.ts';
import type { PickInfo } from './ui/drawingView.ts';
import { DrawingView, buildHighlightRequest } from './ui/drawingView.ts';

const state = {
  thresholdDeg: 1,
  currentViewName: 'front',
  currentView: null as ViewDescriptor | null,
  showHidden: true,
  mesh: null as WorldMesh | null,
  result: null as HLRResult | null
};

const el = (id: string): HTMLElement => document.getElementById(id)!;

function recompute(): HLRResult | null {
  if (!state.mesh || !state.currentView) return null;
  const result = runHLR(state.mesh, state.currentView, state.thresholdDeg);
  state.result = result;
  drawing.render(result);
  updateStats(result);
  return result;
}

function updateStats(result: HLRResult): void {
  const vis = result.segments.filter((s) => s.kind === 'visible').length;
  const hid = result.segments.filter((s) => s.kind === 'hidden').length;
  el('stats').textContent =
    `视图 ${state.currentViewName} · 折边阈值 ${state.thresholdDeg}° · ` +
    `边 ${result.edgeRecords.length} 条 · 实线 ${vis} 段 · 虚线 ${hid} 段 · depthEps=${result.depthEps.toExponential(1)}`;
}

// ---------- 场景与两个视图 ----------
const sample = createSampleScene();
// 3D 窗口需要一份独立的场景图（避免 group 被两处挂接）
const viewer = new Viewer3D(el('view3d'), sample.group);

const partMeta = sample.parts.map((p) => ({ id: p.raw.id, label: p.raw.label, color: p.raw.color }));
const drawing = new DrawingView(el('drawing'), {
  onPick: (info: PickInfo) => {
    viewer.highlight(buildHighlightRequest(info));
    const seg = info.segment;
    el('pickInfo').innerHTML =
      `<b>边</b> ${seg.edgeId}<br><b>所属零件</b> ${seg.partId}<br>` +
      `<b>段类型</b> ${seg.kind === 'visible' ? '实线（可见）' : '虚线（被遮挡）'}<br>` +
      `<b>参数区间</b> t∈[${seg.t0.toFixed(3)}, ${seg.t1.toFixed(3)}]<br>` +
      `<b>遮挡零件</b> ${seg.occluderPartIds.length ? seg.occluderPartIds.join(', ') : '—'}`;
  },
  onSelectionCleared: () => {
    viewer.clearHighlight();
    el('pickInfo').textContent = '点击图纸上的线段查看对应三维边与遮挡零件';
  }
});
drawing.setPartMeta(partMeta);

function rebuildMeshAndCompute(viewName: string, view?: ViewDescriptor): void {
  state.mesh = buildWorld(sample.parts.map((p) => p.raw), state.thresholdDeg);
  const aspect = drawing.svgOptions.width / drawing.svgOptions.height;
  let chosen: ViewDescriptor;
  if (view) {
    // 显式视图（含重开文件、同步 3D 视角）原样保留；仅修正宽高比适配当前画布
    chosen = { ...view, aspect };
  } else {
    const views = standardViews(state.mesh, aspect);
    chosen = views.find((v) => v.name === viewName) ?? views[0];
  }
  state.currentViewName = chosen.name;
  state.currentView = chosen;
  viewer.applyView(chosen);
  recompute();
}

// ---------- 控件 ----------
el('btnFront').addEventListener('click', () => rebuildMeshAndCompute('front'));
el('btnTop').addEventListener('click', () => rebuildMeshAndCompute('top'));
el('btnIso').addEventListener('click', () => rebuildMeshAndCompute('iso'));
el('btnSync').addEventListener('click', () => {
  const v = viewer.currentViewDescriptor('custom');
  rebuildMeshAndCompute('custom', v);
});
el('btnClearPick').addEventListener('click', () => {
  drawing.clearSelection();
  viewer.clearHighlight();
  el('pickInfo').textContent = '点击图纸上的线段查看对应三维边与遮挡零件';
});

const thresholdInput = el('threshold') as HTMLInputElement;
thresholdInput.addEventListener('input', () => {
  state.thresholdDeg = Number(thresholdInput.value);
  el('thresholdValue').textContent = `${state.thresholdDeg}°`;
  // 阈值变动：重建网格并重算；边 id 由零件+顶点对确定，对应关系保持
  rebuildMeshAndCompute(state.currentViewName, state.currentView ?? undefined);
});

el('chkHidden').addEventListener('change', (ev) => {
  state.showHidden = (ev.target as HTMLInputElement).checked;
  drawing.setShowHidden(state.showHidden);
});

el('btnExport').addEventListener('click', () => {
  if (!state.result) return;
  const text = serializeSvg(state.result, drawing.svgOptions, partMeta);
  const blob = new Blob([text], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hlr-${state.currentViewName}-t${state.thresholdDeg}.svg`;
  a.click();
  URL.revokeObjectURL(url);
  el('ioStatus').textContent = `已导出 ${a.download}（含视图与分段元数据）`;
});

el('fileInput').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const { meta, mismatches } = drawing.restoreFromSvgText(text, (m) => {
      // 用文件里的视图与阈值对当前样例实时重算，逐段校验一致性
      state.mesh = buildWorld(sample.parts.map((p) => p.raw), m.thresholdDeg);
      state.thresholdDeg = m.thresholdDeg;
      thresholdInput.value = String(m.thresholdDeg);
      el('thresholdValue').textContent = `${m.thresholdDeg}°`;
      state.currentView = m.view;
      state.currentViewName = m.view.name;
      viewer.applyView(m.view);
      return runHLR(state.mesh, m.view, m.thresholdDeg);
    });
    state.result = drawing.currentResult;
    const status =
      mismatches.length === 0
        ? `已重开 ${file.name}：视图 ${meta.view.name}、阈值 ${meta.thresholdDeg}°，实时重算与图纸分段完全一致`
        : `已重开 ${file.name}，但发现 ${mismatches.length} 处不一致：${mismatches.slice(0, 3).join('；')}`;
    el('ioStatus').textContent = status;
    el('stats').textContent =
      `视图 ${meta.view.name}（重开） · 折边阈值 ${meta.thresholdDeg}° · 段 ${meta.segments.length} 条`;
  } catch (err) {
    el('ioStatus').textContent = `重开失败：${(err as Error).message}`;
  } finally {
    input.value = '';
  }
});

// 让文件输入框可点
el('btnImport').addEventListener('click', () => el('fileInput').click());

// 初始出图
rebuildMeshAndCompute('front');

// 暴露给控制台调试
export { THREE };
