// 主控制器：状态管理、双视口重建、检查清单、导入导出与回读对比。

import * as THREE from 'three';
import { Viewport, syncPair } from './viewport.js';
import {
  buildShadedGeometry, buildHighlightMesh, buildEdgeLinesFromShaded,
  buildEdgeLinesFromMesh, buildNormalArrows, ISSUE_COLORS, EDGE_COLORS,
  estimateScale, pickSourceFace,
} from './scene-builder.js';
import { buildShadedMesh } from '../core/smoothing.js';
import { inspectMesh, ISSUE_TYPES, ISSUE_LABELS, ISSUE_SEVERITY } from '../core/inspect.js';
import {
  loadMeshFile, parseOBJ, MeshLoadError,
  exportOBJ, exportAsciiSTL,
} from '../io/meshio.js';
import { SAMPLE_LIBRARY } from '../samples/generators.js';
import { dot, normalize } from '../core/math3d.js';

const state = {
  sourceMesh: null,      // 原始 TriangleMesh
  inspection: null,
  mode: 'smooth',
  creaseAngle: 35,
  showHardEdges: true,
  showProblemFaces: true,
  showNormals: false,
  showWire: false,
  selectedIssue: null,   // 当前点击的问题类型
  selectedFace: null,
  roundtrip: null,       // 回读对比结果
  viewingRoundtrip: false,
};

const $ = (id) => document.getElementById(id);
const vpFlat = new Viewport($('vpFlat'), 'flat');
const vpSmooth = new Viewport($('vpSmooth'), 'smooth');
syncPair(vpFlat, vpSmooth);

new ResizeObserver(() => { vpFlat.resize(); vpSmooth.resize(); }).observe($('viewports'));

// ---------------- 模型加载 ----------------

function loadMesh(mesh, warningsExtra = []) {
  if (!mesh.faces.length) {
    showError(new MeshLoadError('no-triangles', '模型没有任何三角面，无法显示或导出'));
    return;
  }
  state.sourceMesh = mesh;
  state.inspection = inspectMesh(mesh);
  state.selectedIssue = null;
  state.selectedFace = null;
  state.roundtrip = null;
  state.viewingRoundtrip = false;
  $('roundtripBox').hidden = true;
  $('btnRoundtrip').disabled = false;
  $('metaName').textContent = mesh.meta.fileName || '内存生成模型';
  $('metaFormat').textContent = mesh.meta.format || 'procedural';
  $('metaStruct').textContent =
    `${mesh.vertexCount} 顶点 / ${mesh.faceCount} 三角面 / ${state.inspection.componentCount} 连通分量`;

  const warns = [...(mesh.meta.warnings || []), ...warningsExtra];
  $('loadWarnings').innerHTML = warns.length
    ? warns.map((w) => `<div class="warn-item">⚠ ${w}</div>`).join('') : '';

  rebuildAll();
  renderIssueList();
  updateTopStats();
  vpFlat.frameModel(mesh.positions);
  vpSmooth.syncFrom(vpFlat);
  const errors = state.inspection.issues.filter((i) => i.severity === 'error').length;
  if (errors) {
    toast(`模型加载成功，但检查发现 ${errors} 类错误级问题，详见下方清单`, 'error');
  } else if (state.inspection.issues.length) {
    toast('模型加载成功，存在需要注意的区域（见问题清单）', 'ok');
  } else {
    toast('模型加载成功，未发现结构问题', 'ok');
  }
}

async function handleFile(file) {
  try {
    const mesh = await loadMeshFile(file);
    loadMesh(mesh);
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  const codeMap = {
    unsupported: '不支持的文件',
    corrupt: '文件已损坏',
    empty: '空模型',
    'no-triangles': '缺少三角面',
  };
  const title = codeMap[err.code] || '加载失败';
  $('loadWarnings').innerHTML =
    `<div class="err-item">✖ ${title}（${err.code || 'unknown'}）：${err.message}<br/>` +
    '未生成任何场景对象，也不会导出空模型。</div>';
  toast(`${title}：${err.message}`, 'error');
}

// ---------------- 双视口重建 ----------------

function rebuildAll() {
  const mesh = state.sourceMesh;
  if (!mesh) return;

  const flatShaded = buildShadedMesh(mesh, { mode: 'flat' });
  const smoothShaded = buildShadedMesh(mesh, {
    mode: state.mode === 'flat' ? 'flat' : 'smooth',
    creaseAngleDeg: state.creaseAngle,
  });
  state._flatShaded = flatShaded;
  state._smoothShaded = smoothShaded;
  $('vpSmoothLabel').textContent = state.mode === 'flat'
    ? '平滑视口（当前锁定为平面模式）'
    : `平滑显示（临界角 ${state.creaseAngle}°，硬边 ${smoothShaded.hardEdges.length} 条）`;

  rebuildViewport(vpFlat, flatShaded, true);
  rebuildViewport(vpSmooth, smoothShaded, false);
  updateTopStats();
}

function rebuildViewport(vp, shaded, isFlatVp) {
  vp.clearModel();
  const geo = buildShadedGeometry(shaded);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9db4d4, metalness: 0.05, roughness: 0.55,
    flatShading: false, side: THREE.FrontSide,
  });
  const model = new THREE.Mesh(geo, mat);
  vp.addModelObject(model);
  vp.setPickable(model);

  // 线框叠加
  if (state.showWire) {
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x2a3b55, transparent: true, opacity: 0.8 }));
    vp.addModelObject(wire);
  }

  // 硬边 / 棱边
  if (state.showHardEdges) {
    const reasons = isFlatVp
      ? ['angle', 'flat-mode', 'boundary', 'non-manifold', 'orientation']
      : null; // 平滑视口显示当前参数下的全部硬边
    const lines = buildEdgeLinesFromShaded(shaded, reasons);
    if (lines.geometry.attributes.position.count) vp.addOverlay(lines);
  }

  // 检查问题覆盖层（边界 / 非流形 / 方向不连续边 + 问题面）
  if (state.showProblemFaces && state.inspection) {
    addInspectionOverlays(vp, shaded);
  }

  // 法线箭头（仅平滑视口有意义；平面视口省略避免拥挤）
  if (!isFlatVp && state.showNormals) {
    vp.addOverlay(buildNormalArrows(shaded));
  }

  vp.showGrid(estimateScale(shaded.positions));
  vp.render();
}

function addInspectionOverlays(vp, shaded) {
  const insp = state.inspection;
  const mesh = state.sourceMesh;

  if (insp.boundaryEdges.length) {
    vp.addOverlay(buildEdgeLinesFromMesh(mesh, insp.boundaryEdges, EDGE_COLORS.boundary));
  }
  if (insp.nonManifoldEdges.length) {
    vp.addOverlay(buildEdgeLinesFromMesh(mesh, insp.nonManifoldEdges, EDGE_COLORS['non-manifold']));
  }
  if (insp.discontinuityEdges.length) {
    vp.addOverlay(buildEdgeLinesFromMesh(mesh, insp.discontinuityEdges, EDGE_COLORS.orientation));
  }

  const faceSet = new Set();
  for (const issue of insp.issues) {
    if (state.selectedIssue && issue.type !== state.selectedIssue) continue;
    if (issue.type === ISSUE_TYPES.BOUNDARY
      || issue.type === ISSUE_TYPES.NON_MANIFOLD
      || issue.type === ISSUE_TYPES.ORIENTATION_DISCONTINUITY) continue; // 已用边线表达
    issue.faces.forEach((f) => faceSet.add(f));
  }
  if (state.selectedFace !== null) faceSet.add(state.selectedFace);
  if (faceSet.size) {
    const color = state.selectedIssue ? ISSUE_COLORS[state.selectedIssue] : 0xff5a5f;
    vp.addOverlay(buildHighlightMesh(mesh, faceSet, color));
  }
}

// ---------------- 问题清单 ----------------

function renderIssueList() {
  const insp = state.inspection;
  const ul = $('issueList');
  ul.innerHTML = '';
  if (!insp) {
    $('issueSummary').textContent = '尚未加载模型。';
    return;
  }
  const c = insp.counts;
  $('issueSummary').innerHTML =
    `共 <b>${insp.componentCount}</b> 个连通分量；`
    + `错误级问题面 <b style="color:var(--error)">${c.errorFaceCount}</b> 个，`
    + `警告级问题面 <b style="color:var(--warn)">${c.warningFaceCount}</b> 个；`
    + `方向不连续边 ${c.discontinuityEdgeCount} 条，边界边 ${c.boundaryEdgeCount} 条，`
    + `非流形边 ${c.nonManifoldEdgeCount} 条。`
    + (insp.unreliableFaces.length
      ? `<br/>以下区域的平滑结果<span style="color:var(--warn)">无法保证可靠</span>，工具只标记不自动修复：边界、非流形、方向不连续区域。`
      : '<br/>未发现无法可靠处理的区域。');

  if (!insp.issues.length) {
    ul.innerHTML = '<li class="issue-item" style="border-left:3px solid var(--ok)">✓ 检查通过：未发现退化面、反向面或方向不连续。</li>';
    return;
  }
  insp.issues.forEach((issue, idx) => {
    const li = document.createElement('li');
    li.className = `issue-item ${issue.severity}`;
    if (state.selectedIssue === issue.type) li.style.outline = '1px solid var(--accent)';
    const shown = issue.faces.slice(0, 14).join(', ')
      + (issue.faces.length > 14 ? ` …（共 ${issue.faces.length} 个，点击在模型上查看）` : '');
    li.innerHTML = `
      <div class="issue-title">
        <span class="badge ${issue.severity}">${issue.severity === 'error' ? '错误' : '注意'}</span>
        ${ISSUE_LABELS[issue.type]}
      </div>
      <div class="issue-detail">${issue.detail}</div>
      <div class="issue-faces">面索引：${shown || '（无）'}</div>`;
    li.addEventListener('click', () => {
      state.selectedIssue = state.selectedIssue === issue.type ? null : issue.type;
      state.selectedFace = issue.faces[0] ?? null;
      rebuildAll();
      renderIssueList();
    });
    ul.appendChild(li);
  });
}

// ---------------- 顶部统计 ----------------

function updateTopStats() {
  if (!state.sourceMesh) {
    $('statMode').textContent = '显示方式：—';
    $('statFaces').textContent = '面数：—';
    $('statVerts').textContent = '顶点：—';
    $('statIssues').textContent = '问题：—';
    return;
  }
  const s = state._smoothShaded;
  const modeText = state.mode === 'flat' ? '平面' : `平滑（${state.creaseAngle}°）`;
  $('statMode').innerHTML = `显示方式：<b>${modeText}</b>`;
  $('statFaces').innerHTML = `面数：<b>${state.sourceMesh.faceCount}</b>`
    + (s.stats.outputFaceCount !== state.sourceMesh.faceCount
      ? ` → 有效 ${s.stats.outputFaceCount}` : '');
  $('statVerts').innerHTML = `顶点：<b>${state.sourceMesh.vertexCount}</b>`
    + (s.stats.inputVertexCount !== s.stats.outputVertexCount
      ? ` → 拆分后 ${s.stats.outputVertexCount}` : '');
  const n = state.inspection.issues.length;
  $('statIssues').innerHTML = `问题：<b style="color:${n ? 'var(--warn)' : 'var(--ok)'}">${n} 类</b>`;
}

// ---------------- 拾取 ----------------

function bindPick(vp) {
  vp.onPick = (hit) => {
    const fi = pickSourceFace(hit, state._smoothShaded);
    if (fi === null) return;
    state.selectedFace = fi;
    rebuildAll();
    const face = state.sourceMesh.faces[fi];
    toast(`选中面 #${fi}，顶点索引 [${face.join(', ')}]`);
  };
}
bindPick(vpFlat);
bindPick(vpSmooth);

// ---------------- 导出与回读 ----------------

function currentShaded() {
  return state.mode === 'flat' ? state._flatShaded : state._smoothShaded;
}

function guardExport() {
  const shaded = currentShaded();
  if (!shaded) {
    toast('没有可导出的模型', 'error');
    return null;
  }
  if (shaded.faces.length === 0) {
    showError(new MeshLoadError('no-triangles',
      '所有面均为退化面，没有有效三角面；为避免产生空模型，导出已阻止'));
    return null;
  }
  return shaded;
}

function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseName() {
  return (state.sourceMesh.meta.fileName || 'model').replace(/\.[^.]+$/, '');
}

$('btnExportOBJ').addEventListener('click', () => {
  const shaded = guardExport();
  if (!shaded) return;
  downloadText(`${baseName()}_${shaded.mode}${shaded.mode === 'smooth' ? `_${shaded.creaseAngle}deg` : ''}.obj`,
    exportOBJ(shaded, state.sourceMesh.meta.fileName), 'text/plain');
  toast(`已导出 OBJ：${shaded.faces.length} 面 / ${shaded.positions.length / 3} 顶点（含显式法线）`, 'ok');
});

$('btnExportSTL').addEventListener('click', () => {
  const shaded = guardExport();
  if (!shaded) return;
  downloadText(`${baseName()}_${shaded.mode}.stl`,
    exportAsciiSTL(shaded, baseName()), 'model/stl');
  toast(`已导出 ASCII STL：${shaded.faces} 个 facet`, 'ok');
});

$('btnRoundtrip').addEventListener('click', async () => {
  const shaded = guardExport();
  if (!shaded) return;
  const objText = exportOBJ(shaded, state.sourceMesh.meta.fileName);
  try {
    const reimported = parseOBJ(objText, 'roundtrip.obj');
    const report = compareRoundtrip(shaded, reimported);
    state.roundtrip = { report, reimported, objText };
    state.viewingRoundtrip = true;
    renderRoundtrip(report);
    // 回读模型直接进场景（保留原检查结果做对照）
    const rtInspection = inspectMesh(reimported);
    state.sourceMesh = reimported;
    state.inspection = rtInspection;
    state.selectedIssue = null;
    rebuildAll();
    renderIssueList();
    updateTopStats();
    vpFlat.frameModel(reimported.positions);
    vpSmooth.syncFrom(vpFlat);
    toast('已导出并重新打开，对比结果见左下角面板', 'ok');
  } catch (err) {
    showError(err);
  }
});

// 导出前后结构与明暗法线比对
function compareRoundtrip(shaded, reimported) {
  const before = {
    vertices: shaded.positions.length / 3,
    faces: shaded.faces.length,
    hardEdges: shaded.hardEdges.length,
  };
  const after = {
    vertices: reimported.vertexCount,
    faces: reimported.faceCount,
    hardEdges: countHardEdgesAfterImport(reimported, shaded.creaseAngleDeg),
  };

  // 法线回读比对：OBJ 显式 vn 与导出法线逐顶点比较
  let normalMaxDiff = 0;
  let normalCompared = 0;
  const normalsInFile = reimported.meta.normalsInFile || [];
  const fnIdx = reimported.meta.faceNormalIndices || [];
  if (normalsInFile.length && fnIdx.length === reimported.faceCount) {
    const perVertex = new Map(); // 顶点 -> 该顶点关联的 vn（导出时一一对应，应一致）
    reimported.faces.forEach((face, fi) => {
      face.forEach((vi, k) => {
        const ni = fnIdx[fi][k];
        if (ni === null || ni >= normalsInFile.length) return;
        if (!perVertex.has(vi)) perVertex.set(vi, ni);
      });
    });
    for (const [vi, ni] of perVertex) {
      const a = [shaded.normals[vi * 3], shaded.normals[vi * 3 + 1], shaded.normals[vi * 3 + 2]];
      const b = normalsInFile[ni];
      if (b.some((x) => !Number.isFinite(x))) continue;
      const d = 1 - dot(normalize(a), normalize(b));
      normalMaxDiff = Math.max(normalMaxDiff, d);
      normalCompared++;
    }
  }

  const checks = [
    { label: '三角面数', before: before.faces, after: after.faceCount,
      pass: before.faces === after.faceCount },
    { label: '顶点数（拆分后）', before: before.vertices, after: after.vertices,
      pass: before.vertices === after.vertices },
    { label: '硬边数（按同角度重算）', before: before.hardEdges, after: after.hardEdges,
      pass: before.hardEdges === after.hardEdges },
    { label: '法线回读',
      before: `${normalCompared} 顶点`,
      after: normalCompared ? `最大偏差 ${normalMaxDiff.toExponential(1)}` : 'OBJ 无法线',
      pass: normalCompared > 0 && normalMaxDiff < 1e-5 },
  ];
  const allPass = checks.every((c) => c.pass);
  return { before, after, checks, allPass };
}

// 回读模型按相同临界角重新识别硬边，验证棱边表现一致
function countHardEdgesAfterImport(mesh, angleDeg) {
  const reShaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: angleDeg });
  return reShaded.hardEdges.length;
}

function renderRoundtrip(report) {
  const box = $('roundtripBox');
  box.hidden = false;
  const rows = report.checks.map((c) => `<tr>
      <td>${c.label}</td>
      <td>${c.before}</td>
      <td>${c.after}</td>
      <td class="${c.pass ? 'match' : 'diff'}">${c.pass ? '一致 ✓' : '不一致 ✖'}</td>
    </tr>`).join('');
  $('roundtripTable').innerHTML =
    `<tr><th>项目</th><th>导出前</th><th>回读后</th><th>结果</th></tr>${rows}`;
  $('roundtripVerdict').innerHTML = report.allPass
    ? '<span class="match">✓ 回读验证通过：面数、棱边与法线明暗与导出时一致。</span>'
    : '<span class="diff">✖ 存在不一致项，请检查具体行。</span>';
}

$('btnBackSource').addEventListener('click', () => {
  if (!state.roundtrip) return;
  toast('请从左侧样例或文件重新打开原始模型（回读视图保留以便对照）');
});

// ---------------- UI 事件 ----------------

$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
  e.target.value = '';
});

const drop = $('dropZone');
['dragover', 'dragenter'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
// 整窗拖放兜底
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    rebuildAll();
  });
});

$('angleSlider').addEventListener('input', (e) => {
  state.creaseAngle = Number(e.target.value);
  $('angleValue').textContent = `${state.creaseAngle}°`;
  if (state.mode === 'flat') {
    // 切到平滑以便看到角度效果
    state.mode = 'smooth';
    document.querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === 'smooth'));
  }
  rebuildAll();
});

[['chkHardEdges', 'showHardEdges'], ['chkProblemFaces', 'showProblemFaces'],
 ['chkNormals', 'showNormals'], ['chkWire', 'showWire']].forEach(([id, key]) => {
  $(id).addEventListener('change', (e) => {
    state[key] = e.target.checked;
    rebuildAll();
  });
});

// ---------------- 样例库 ----------------

function buildSampleButtons() {
  const root = $('sampleGroups');
  for (const group of SAMPLE_LIBRARY) {
    const title = document.createElement('div');
    title.className = 'sample-group-title';
    title.textContent = group.group;
    root.appendChild(title);
    const row = document.createElement('div');
    row.className = 'sample-btns';
    group.items.forEach(([label, factory]) => {
      const btn = document.createElement('button');
      btn.className = 'sample-btn' + (group.group.includes('问题') ? ' bad' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        try {
          loadMesh(factory());
        } catch (err) {
          showError(err);
        }
      });
      row.appendChild(btn);
    });
    root.appendChild(row);
  }
}
buildSampleButtons();

// ---------------- 图例 ----------------

function buildLegend() {
  const items = [
    ['角度硬边', EDGE_COLORS.angle],
    ['边界边', EDGE_COLORS.boundary],
    ['非流形边', EDGE_COLORS['non-manifold']],
    ['方向不连续', EDGE_COLORS.orientation],
    ['反向/问题面', 0xff5a5f],
    ['重复顶点', ISSUE_COLORS[ISSUE_TYPES.DUPLICATE_VERTEX]],
  ];
  $('legend').innerHTML = items.map(([t, c]) =>
    `<span><i style="background:#${c.toString(16).padStart(6, '0')}"></i>${t}</span>`).join('');
}
buildLegend();

// ---------------- toast ----------------

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

// 渲染循环（OrbitControls damping 需要持续渲染）
function animate() {
  requestAnimationFrame(animate);
  vpFlat.render();
  vpSmooth.render();
}
animate();
