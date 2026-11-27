import * as THREE from 'three';
import { DEFAULT_EYE, DEFAULT_SPEC, FACE_LABEL, FACE_ORDER, FaceId, OCCLUDED_EYE, SceneSpec } from './geom';
import { computeProjection, ImageSpec, MarkCell, ProjectionResult, projectPoint } from './project';
import { addLandingMarker, buildPaintGroup, setupScene, updateEyeMarker } from './scene';
import { exportFaceSVG } from './svg';
import { drawTargetCanvas, makeSampler } from './target';
import { verifySVG } from './verify';

const spec: SceneSpec = structuredClone(DEFAULT_SPEC);
const state = {
  eye: DEFAULT_EYE.clone(),
  drafts: [] as Draft[],
  nextDraftId: 1,
};

interface Draft {
  id: number;
  eye: THREE.Vector3;
  img: ImageSpec;
  result: ProjectionResult;
  group: THREE.Group;
  svgs: Partial<Record<FaceId, string>>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const targetCanvas = drawTargetCanvas();
const view = $('view');
const bundle = setupScene(view, spec, targetCanvas);
// 便于冒烟测试与调试
(window as unknown as { __bundle: typeof bundle }).__bundle = bundle;

// ---------- 界面控件 ----------

const sliders: { id: string; key: 'x' | 'y' | 'z'; label: string }[] = [
  { id: 'eyeX', key: 'x', label: 'eyeXv' },
  { id: 'eyeY', key: 'y', label: 'eyeYv' },
  { id: 'eyeZ', key: 'z', label: 'eyeZv' },
];

function imgSpec(): ImageSpec {
  return { ...spec.image };
}

function refreshEyeUI(): void {
  for (const s of sliders) {
    ($(s.id) as unknown as HTMLInputElement).value = String(state.eye[s.key]);
    $(s.label).textContent = state.eye[s.key].toFixed(2);
  }
  updateEyeMarker(bundle, state.eye, new THREE.Vector3(spec.image.cx, spec.image.cy, spec.image.cz));
}

function refreshImgUI(): void {
  ($('imgW') as unknown as HTMLInputElement).value = String(spec.image.w);
  ($('imgH') as unknown as HTMLInputElement).value = String(spec.image.h);
  $('imgWv').textContent = spec.image.w.toFixed(1);
  $('imgHv').textContent = spec.image.h.toFixed(1);
  // 只更新参考面本身,不动已生成的稿
  bundle.imagePlane.scale.set(spec.image.w, spec.image.h, 1);
}

for (const s of sliders) {
  $(s.id).addEventListener('input', (e) => {
    state.eye[s.key] = Number((e.target as HTMLInputElement).value);
    refreshEyeUI();
  });
}
$('imgW').addEventListener('input', (e) => {
  spec.image.w = Number((e.target as HTMLInputElement).value);
  refreshImgUI();
});
$('imgH').addEventListener('input', (e) => {
  spec.image.h = Number((e.target as HTMLInputElement).value);
  refreshImgUI();
});

// ---------- 相机预设 ----------

$('presetEye').addEventListener('click', () => {
  bundle.camera.position.copy(state.eye);
  bundle.controls.target.set(spec.image.cx, spec.image.cy, spec.image.cz);
  // 观察点视角下藏起虚拟参考面,直接看各面上的画拼回目标图
  bundle.imagePlane.visible = false;
});
$('presetTop').addEventListener('click', () => {
  bundle.camera.position.set(0, 22, -4);
  bundle.controls.target.set(0, 0, -4);
  bundle.imagePlane.visible = true;
});
$('presetFree').addEventListener('click', () => {
  bundle.camera.position.set(5, 5, 10);
  bundle.controls.target.set(0, 1, -2);
  bundle.imagePlane.visible = true;
});

// ---------- 生成草稿 ----------

function gridSize(): [number, number] {
  const n = Number(($('gridN') as unknown as HTMLSelectElement).value);
  return [n, Math.round(n * 1.25)];
}

function generate(): void {
  const img = imgSpec();
  const [nu, nv] = gridSize();
  const sampler = makeSampler(targetCanvas, img);
  const result = computeProjection(state.eye, img, bundle.occluders, nu, nv, sampler);
  const group = buildPaintGroup(result.cells);
  bundle.paintRoot.add(group);

  const svgs: Draft['svgs'] = {};
  for (const face of FACE_ORDER) {
    const svg = exportFaceSVG(face, result.cells);
    if (svg) svgs[face] = svg;
  }

  const draft: Draft = {
    id: state.nextDraftId++,
    eye: state.eye.clone(),
    img,
    result,
    group,
    svgs,
  };
  state.drafts.push(draft);
  addDraftUI(draft);
  drawOverlay(result.marks, nu, nv);
  // 标记属于旧的观察点,生成新稿后清掉,避免误读
  clearMarkers();
}

function addDraftUI(d: Draft): void {
  const el = document.createElement('div');
  el.className = 'draft';
  const counts = FACE_ORDER.map((f) => {
    const n = d.result.cells.filter((c) => c.face === f).length;
    return n ? `${FACE_LABEL[f]}${n}` : null;
  })
    .filter(Boolean)
    .join(' ');
  el.innerHTML =
    `<div><b>稿 #${d.id}</b> <label><input type="checkbox" checked /> 显示</label></div>` +
    `<div class="meta">eye=(${d.eye.x.toFixed(2)}, ${d.eye.y.toFixed(2)}, ${d.eye.z.toFixed(2)}) 图 ${d.img.w.toFixed(1)}×${d.img.h.toFixed(1)}</div>` +
    `<div class="meta">${counts || '无有效格'}</div>` +
    `<div class="btns"><button data-act="export">导出 SVG</button><button data-act="verify">核对</button><button data-act="del">删除</button></div>`;
  const checkbox = el.querySelector('input[type=checkbox]') as HTMLInputElement;
  checkbox.addEventListener('change', () => {
    d.group.visible = checkbox.checked;
  });
  el.querySelector('[data-act=export]')!.addEventListener('click', () => exportDraft(d));
  el.querySelector('[data-act=verify]')!.addEventListener('click', () => verifyDraft(d));
  el.querySelector('[data-act=del]')!.addEventListener('click', () => {
    bundle.paintRoot.remove(d.group);
    state.drafts = state.drafts.filter((x) => x !== d);
    el.remove();
  });
  $('drafts').prepend(el);
}

function exportDraft(d: Draft): void {
  for (const [face, svg] of Object.entries(d.svgs)) {
    const blob = new Blob([svg!], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draft${d.id}-${face}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

function verifyDraft(d: Draft): void {
  const lines: string[] = [`稿 #${d.id} 导出顶点折回三维再投影的核对结果:`];
  for (const svg of Object.values(d.svgs)) {
    const r = verifySVG(svg!, spec, d.eye, d.img);
    lines.push(
      `  ${FACE_LABEL[r.face]}: ${r.vertexCount} 顶点, 最大误差 ${(r.maxErr * 1000).toFixed(3)} mm, 平均 ${(r.meanErr * 1000).toFixed(3)} mm`,
    );
  }
  $('verifyOut').textContent = lines.join('\n');
}

// ---------- 问题格标注 ----------

const MARK_COLOR: Record<MarkCell['kind'], string> = {
  miss: 'rgba(229,62,62,0.75)',
  edge: 'rgba(237,137,54,0.75)',
  blocked: 'rgba(159,122,234,0.75)',
};

function drawOverlay(marks: MarkCell[], nu: number, nv: number): void {
  const c = $('overlay') as unknown as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(targetCanvas, 0, 0, c.width, c.height);
  const cw = c.width / nu;
  const ch = c.height / nv;
  const count: Record<string, number> = { miss: 0, edge: 0, blocked: 0 };
  for (const m of marks) {
    count[m.kind]++;
    ctx.fillStyle = MARK_COLOR[m.kind];
    // j=0 在图的下边
    ctx.fillRect(m.i * cw, c.height - (m.j + 1) * ch, cw, ch);
  }
  $('markStats').textContent = `射出场景 ${count.miss} 格 · 跨面边缘 ${count.edge} 格 · 不可画面 ${count.blocked} 格`;
}

// ---------- 点选查询 ----------

function clearMarkers(): void {
  bundle.markerRoot.clear();
}
$('clearMarkers').addEventListener('click', clearMarkers);

let downPos: [number, number] | null = null;
bundle.renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
});
bundle.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos || Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 5) return;
  const rect = bundle.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, bundle.camera);
  const hit = ray.intersectObject(bundle.imagePlane, false)[0];
  if (!hit) return;
  const u = hit.point.x - spec.image.cx;
  const v = hit.point.y - spec.image.cy;
  inspect(u, v);
});

function inspect(u: number, v: number): void {
  const img = imgSpec();
  const r = projectPoint(state.eye, img, bundle.occluders, u, v);
  const lines = [`图上位置 u=${u.toFixed(2)}m, v=${v.toFixed(2)}m`];
  if (r.status === 'ok' && r.p && r.face) {
    lines.push(`落点 (${r.p.x.toFixed(2)}, ${r.p.y.toFixed(2)}, ${r.p.z.toFixed(2)}) · ${FACE_LABEL[r.face]}`);
    addLandingMarker(bundle.markerRoot, state.eye, r.p, r.face);
  } else if (r.status === 'blocked') {
    lines.push('视线先打到不可绘制的面(台阶侧面/背面)');
  } else {
    lines.push('射线射出场景,没有落点');
  }
  $('info').textContent = lines.join('\n');

  // 在目标图预览上画十字
  const c = $('overlay') as unknown as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  const px = ((u + img.w / 2) / img.w) * c.width;
  const py = (1 - (v + img.h / 2) / img.h) * c.height;
  ctx.strokeStyle = '#ff3355';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px - 8, py);
  ctx.lineTo(px + 8, py);
  ctx.moveTo(px, py - 8);
  ctx.lineTo(px, py + 8);
  ctx.stroke();
}

// ---------- 示例 ----------

$('loadDefault').addEventListener('click', () => {
  state.eye.copy(DEFAULT_EYE);
  spec.image.w = DEFAULT_SPEC.image.w;
  spec.image.h = DEFAULT_SPEC.image.h;
  refreshEyeUI();
  refreshImgUI();
  generate();
});
$('loadOccluded').addEventListener('click', () => {
  state.eye.copy(OCCLUDED_EYE);
  spec.image.w = DEFAULT_SPEC.image.w;
  spec.image.h = DEFAULT_SPEC.image.h;
  refreshEyeUI();
  refreshImgUI();
  generate();
});
$('gen').addEventListener('click', generate);

// ---------- 启动 ----------

refreshEyeUI();
refreshImgUI();
generate(); // 默认先出一稿

window.addEventListener('resize', bundle.resize);
bundle.renderer.setAnimationLoop(() => {
  bundle.controls.update();
  bundle.renderer.render(bundle.scene, bundle.camera);
});
