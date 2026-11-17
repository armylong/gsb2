/**
 * main.ts —— 页面装配与状态同步
 * 所有视图共享同一份 TransformMap 与 facemath 读数,保证展开图、3D、检查点一致。
 */

import './style.css';
import {
  FACE_ORDER, FACE_LABEL, FACE_SHORT, GRID,
  sharedEdgeOf, neighborEdge, edgeColor,
  edgePoint, nearestSharedEdge,
  identityTransforms,
  type FaceId, type FaceEdge, type Side, type TransformMap,
  type EnvironmentHit,
} from './facemath';
import { generateAllFaces } from './texturegen';
import { UnfoldView } from './unfold';
import { Viewer, type CheckpointReadout } from './viewer';
import { POSES, poseById } from './poses';
import { runValidation } from './validate';

/* ---------------- 全局状态 ---------------- */

const transforms: TransformMap = identityTransforms();
const baseCanvases = generateAllFaces();
let workCanvases: Record<FaceId, HTMLCanvasElement> = { ...baseCanvases };

const viewport = document.getElementById('viewport')!;
const viewer = new Viewer(viewport, transforms, workCanvases);
const unfold = new UnfoldView(
  document.getElementById('unfold') as HTMLCanvasElement, transforms, workCanvases);

let selectedEdge: FaceEdge | null = null;

/* ---------------- 错误注入:单面变换后重新生成该面纹理 ---------------- */

function buildTransformedCanvas(face: FaceId): HTMLCanvasElement {
  const tr = transforms[face];
  const src = baseCanvases[face];
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  if (tr.flip) ctx.scale(-1, 1);
  if (tr.rot) ctx.rotate((tr.rot * Math.PI) / 2);
  ctx.drawImage(src, -c.width / 2, -c.height / 2);
  return c;
}

function applyTransforms(): void {
  for (const face of FACE_ORDER) {
    const tr = transforms[face];
    workCanvases[face] = (tr.rot === 0 && !tr.flip) ? baseCanvases[face] : buildTransformedCanvas(face);
  }
  viewer.updateFaceCanvases(workCanvases);
  unfold.update(transforms, workCanvases);
  viewer.refreshReadouts();
  refreshErrorStatus();
  refreshEdgeInfo();
}

function refreshErrorStatus(): void {
  const el = document.getElementById('err-status')!;
  const bad = FACE_ORDER.filter((f) => transforms[f].rot !== 0 || transforms[f].flip);
  if (!bad.length) {
    el.className = 'err-status good';
    el.textContent = '所有面均为规范朝向,接缝正确。';
    return;
  }
  el.className = 'err-status bad';
  el.innerHTML = '⚠ 错误设置:' + bad.map((f) => {
    const t = transforms[f];
    return `${FACE_SHORT[f]} 旋转 ${t.rot * 90}°${t.flip ? ' + 水平翻转' : ''}`;
  }).join(';') + '。观察接缝处边带颜色与刻度错位,检查点可追踪到误转面。';
}

/* ---------------- 展开图:边点击 / 面点击 ---------------- */

unfold.onEdgeClick = (e: FaceEdge) => {
  selectedEdge = e;
  unfold.setSelection({ edge: e, cell: null });
  viewer.highlightSharedEdge(e);
  refreshEdgeInfo();
};
unfold.onFaceClick = (f: FaceId) => {
  (document.getElementById('err-face') as HTMLSelectElement).value = f;
};

function refreshEdgeInfo(): void {
  const el = document.getElementById('edge-info')!;
  if (!selectedEdge) {
    el.innerHTML = '<p class="dim">点击展开图中的一条面边,这里会给出它与相邻面的配对边、刻度对应次序与 3D 方向。</p>';
    return;
  }
  const se = sharedEdgeOf(selectedEdge);
  const nb = neighborEdge(selectedEdge);
  const table = unfold.selectedEdgeTickTable(transforms)!;
  const rows = table.pairs.map(([a, b], i) =>
    `<tr><td>${i}</td><td>${a}</td><td>${b}</td></tr>`).join('');
  const ta3 = edgePoint(table.a, 0);
  const tb3 = edgePoint(table.b, 0);
  el.innerHTML = `
    <p><span class="edge-swatch" style="background:${edgeColor(se)}"></span>
      共享边 <b>E${se.id}</b>:
      ${FACE_SHORT[se.a.face]} 面 ${sideName(se.a.side)} 边 ↔
      ${FACE_SHORT[se.b.face]} 面 ${sideName(se.b.side)} 边</p>
    <p>当前选中:<b>${FACE_SHORT[selectedEdge.face]} · ${sideName(selectedEdge.side)}</b>,
      配对边:<b>${FACE_SHORT[nb.face]} · ${sideName(nb.side)}</b></p>
    <p class="dim">边起点 3D 坐标 A=${fmt(ta3)} B=${fmt(tb3)}
      (同向则相等,反向则互为对角)</p>
    <table>
      <tr><th>刻度</th><th>${FACE_SHORT[table.a.face]} ${sideName(table.a.side)}</th>
      <th>${FACE_SHORT[table.b.face]} ${sideName(table.b.side)}</th></tr>
      ${rows}
    </table>
    <p class="dim">刻度 0..${GRID} 即边带上的白色数字;3D 中两侧同刻度点(或反向时的 ${GRID}-tick)是同一点。</p>`;
}

function sideName(s: Side): string {
  return { left: '左', right: '右', top: '上', bottom: '下' }[s];
}
function fmt(v: number[]): string {
  return '(' + v.map((x) => x.toFixed(2)).join(', ') + ')';
}

/* ---------------- 检查点读数面板 ---------------- */

viewer.setOnPick((readouts: CheckpointReadout[]) => {
  syncUnfoldHit(readouts);
  renderReadouts(readouts);
});

function syncUnfoldHit(readouts: CheckpointReadout[]): void {
  const hit: EnvironmentHit | null = readouts.length ? readouts[readouts.length - 1].hit : null;
  unfold.setHit(hit);
}

function renderReadouts(readouts: CheckpointReadout[]): void {
  const el = document.getElementById('readouts')!;
  if (!readouts.length) {
    el.innerHTML = '<p class="dim">尚未放置检查点。点击 3D 视图中的物体表面,或切换到"跨面边缘反射"姿态。</p>';
    return;
  }
  el.innerHTML = readouts.map((r) => {
    const h = r.hit;
    const targetName = r.cp.target === 'mirror' ? '镜面球' : '斜面物体';
    return `<div class="cp-card ${h.mismatched ? 'bad' : ''}">
      <h3>#${r.cp.id} ${targetName} · ${r.cp.note}</h3>
      <table>
        <tr><td>世界位置</td><td class="mono">${fmt(r.worldPoint)}</td></tr>
        <tr><td>表面朝向 N</td><td class="mono">${fmt(r.worldNormal)}</td></tr>
        <tr><td>入射方向 I</td><td class="mono">${fmt(r.incident)}</td></tr>
        <tr><td>反射方向 R</td><td class="mono">${fmt(r.reflection)}</td></tr>
        <tr><td>命中环境面</td><td><b>${FACE_LABEL[h.face]}</b></td></tr>
        <tr><td>显示网格</td><td>行${h.row} 列${h.col} · 编号 ${h.cellIdx}
          (uv ${h.displayUV.u.toFixed(3)}, ${h.displayUV.v.toFixed(3)})</td></tr>
        <tr><td>规范网格</td><td>行${h.canonicalRow} 列${h.canonicalCol} · 编号 ${h.canonicalCellIdx}</td></tr>
        <tr><td>面状态</td><td>${h.mismatched
          ? '<span class="pill bad">误转/误翻 — 规范读数才是物理真实位置</span>'
          : '<span class="pill good">规范朝向</span>'}</td></tr>
      </table>
    </div>`;
  }).join('');
}

/* ---------------- 控件:物体与相机 ---------------- */

document.getElementById('object-select')!.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#object-select .btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    viewer.selectObject((btn as HTMLElement).dataset.obj as 'mirror' | 'chamfer');
  });
});

const rotInputs = ['rot-x', 'rot-y', 'rot-z'].map((id) => document.getElementById(id) as HTMLInputElement);
function syncRotSliders(): void {
  const [x, y, z] = viewer.getObjectRotation().map((r) => Math.round((r * 180) / Math.PI));
  rotInputs[0].value = String(x);
  rotInputs[1].value = String(y);
  rotInputs[2].value = String(z);
}
rotInputs.forEach((input) => {
  input.addEventListener('input', () => {
    viewer.setObjectRotation(
      ...rotInputs.map((i) => (Number(i.value) * Math.PI) / 180) as [number, number, number]);
  });
});
document.getElementById('btn-reset-object')!.addEventListener('click', () => {
  viewer.resetObjectRotation();
  syncRotSliders();
});
document.getElementById('btn-clear-cp')!.addEventListener('click', () => {
  viewer.clearCheckpoints();
  unfold.setHit(null);
});
document.getElementById('btn-reset-camera')!.addEventListener('click', () => viewer.resetCamera());

/* 主轴视图按钮 */
const axisViewIds = ['view-px', 'view-nx', 'view-py', 'view-ny', 'view-pz', 'view-nz', 'default'];
const axisBox = document.getElementById('axis-views')!;
for (const id of axisViewIds) {
  const pose = poseById(id);
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = pose.label;
  b.addEventListener('click', () => applyPose(id));
  axisBox.appendChild(b);
}

/* ---------------- 固定姿态 ---------------- */

const posesBox = document.getElementById('poses')!;
for (const pose of POSES) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.dataset.pose = pose.id;
  b.textContent = pose.label;
  b.title = pose.hint;
  b.addEventListener('click', () => applyPose(pose.id));
  posesBox.appendChild(b);
}

function applyPose(id: string): void {
  const pose = poseById(id);
  document.querySelectorAll('[data-pose]').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.pose === id));
  viewer.setCameraView(pose.cameraPos, pose.cameraUp);
  viewer.setObjectRotation(pose.objectEuler[0], pose.objectEuler[1], pose.objectEuler[2]);
  syncRotSliders();
  if (pose.checkpoints.length) {
    viewer.setCheckpoints(pose.checkpoints);
  }
  // 跨面边缘姿态:按检查点的真实反射方向找最近的共享棱,展开图与 3D 同步高亮
  if (id === 'seam') {
    requestAnimationFrame(() => {
      const readouts = viewer.getReadouts();
      if (!readouts.length) return;
      const se = nearestSharedEdge(readouts[0].reflection);
      selectedEdge = se.a;
      unfold.setSelection({ edge: se.a, cell: null });
      viewer.highlightSharedEdge(se.a);
      refreshEdgeInfo();
    });
  }
  // 相机移动后入射线/反射线需要重算
  requestAnimationFrame(() => viewer.refreshReadouts());
}

/* ---------------- 错误注入控件 ---------------- */

const errFace = document.getElementById('err-face') as HTMLSelectElement;
for (const f of FACE_ORDER) {
  const opt = document.createElement('option');
  opt.value = f;
  opt.textContent = FACE_LABEL[f];
  errFace.appendChild(opt);
}
document.getElementById('btn-apply-err')!.addEventListener('click', () => {
  const f = errFace.value as FaceId;
  transforms[f] = {
    rot: Number((document.getElementById('err-rot') as HTMLSelectElement).value) as 0 | 1 | 2 | 3,
    flip: (document.getElementById('err-flip') as HTMLInputElement).checked,
  };
  applyTransforms();
});
document.getElementById('btn-reset-err')!.addEventListener('click', () => {
  for (const f of FACE_ORDER) transforms[f] = { rot: 0, flip: false };
  (document.getElementById('err-rot') as HTMLSelectElement).value = '0';
  (document.getElementById('err-flip') as HTMLInputElement).checked = false;
  applyTransforms();
});

/* ---------------- 页面内验证 ---------------- */

document.getElementById('btn-validate')!.addEventListener('click', () => {
  const report = runValidation();
  const el = document.getElementById('validation')!;
  el.innerHTML = report.cases.map((c) => `
    <div class="v-case ${c.passed ? 'pass' : 'fail'}">
      <span class="vid">${c.id}</span>
      <div><div>${c.name} ${c.passed ? '✅' : '❌'}</div>
      <div class="detail">${c.detail}</div></div>
    </div>`).join('')
    + `<p class="dim">汇总:${report.cases.filter((c) => c.passed).length}/${report.cases.length} 通过 ——
    验证与 3D 渲染共用 facemath 同一套方向/邻接/反射实现。</p>`;
});

/* ---------------- 启动 ---------------- */

viewer.setOnSelectionChange((obj) => {
  document.querySelectorAll('#object-select .btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.obj === obj);
  });
});
viewer.start();
unfold.draw();
refreshErrorStatus();

// 调试钩子(冒烟测试用)
(window as unknown as Record<string, unknown>).__viewer = viewer;

// 初始给一个示例检查点,让页面一打开就有读数可看
viewer.setCheckpoints([
  { localPoint: [0.86, 0.2, -0.66], localNormal: [Math.SQRT1_2, 0, Math.SQRT1_2], note: '初始:切角斜面' },
]);
