import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import GUI from "lil-gui";
import { computeSection, checkMesh, type Plane, type SectionResult, type Vec3 } from "./core/section";
import { buildMesh, type BuiltMesh, type MeshKind } from "./meshes";
import { runAllVerifications } from "./verify";

// ---------- 场景基础 ----------
const container = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 200);
camera.position.set(6, 4.5, 7);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(5, 8, 6);
scene.add(dir);
const grid = new THREE.GridHelper(12, 24, 0x39404c, 0x242a33);
grid.position.y = -3.2;
scene.add(grid);

// ---------- 状态 ----------
interface State {
  model: MeshKind;
  offset: number;
  theta: number; // 法向绕 Y 角（度）
  phi: number; // 法向俯仰角（度）
  showFill: boolean;
  showPlane: boolean;
}

const state: State = {
  model: "shell",
  offset: 0,
  theta: 90, // 初始法向 +X，即侧切
  phi: 0,
  showFill: true,
  showPlane: true,
};

let built: BuiltMesh = buildMesh(state.model);
let meshObject: THREE.Mesh;
let sectionGroup = new THREE.Group();
let boundaryGroup = new THREE.Group();
let planeMesh: THREE.Mesh;
let planeFrame: THREE.LineSegments;
let currentResult: SectionResult | null = null;

scene.add(sectionGroup);
scene.add(boundaryGroup);

// ---------- 切平面 gizmo ----------
const PLANE_SIZE = 7.5;
const planeGeom = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
const planeMat = new THREE.MeshBasicMaterial({
  color: 0x8ab4f8,
  transparent: true,
  opacity: 0.16,
  side: THREE.DoubleSide,
  depthWrite: false,
});
planeMesh = new THREE.Mesh(planeGeom, planeMat);
planeFrame = new THREE.LineSegments(
  new THREE.EdgesGeometry(planeGeom),
  new THREE.LineBasicMaterial({ color: 0x8ab4f8, transparent: true, opacity: 0.8 })
);
scene.add(planeMesh, planeFrame);

function currentPlane(): Plane {
  const t = THREE.MathUtils.degToRad(state.theta);
  const p = THREE.MathUtils.degToRad(state.phi);
  const normal = new THREE.Vector3(
    Math.cos(p) * Math.cos(t),
    Math.sin(p),
    Math.cos(p) * Math.sin(t)
  ).normalize();
  return { normal: { x: normal.x, y: normal.y, z: normal.z }, w: state.offset };
}

function syncPlaneGizmo(plane: Plane) {
  const n = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
  const pos = n.clone().multiplyScalar(plane.w);
  planeMesh.position.copy(pos);
  planeFrame.position.copy(pos);
  // PlaneGeometry 默认法向 +Z，对齐到 n
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  planeMesh.quaternion.copy(q);
  planeFrame.quaternion.copy(q);
  planeMesh.visible = state.showPlane;
  planeFrame.visible = state.showPlane;
}

// ---------- 模型装载 ----------
function loadModel(kind: MeshKind) {
  if (meshObject) {
    scene.remove(meshObject);
    meshObject.geometry.dispose();
    (meshObject.material as THREE.Material).dispose();
  }
  built = buildMesh(kind);
  const isBroken = kind.startsWith("broken");
  const mat = new THREE.MeshStandardMaterial({
    color: isBroken ? 0x90a4ae : 0x7fa8d8,
    transparent: true,
    opacity: isBroken ? 0.55 : 0.42,
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0.05,
    depthWrite: false,
  });
  meshObject = new THREE.Mesh(built.geometry, mat);
  scene.add(meshObject);
  rebuildBoundary();
  rebuildSection();
}

// ---------- 破面边界边标记 ----------
function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    g.remove(child);
    if (child instanceof THREE.LineSegments) child.geometry.dispose();
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  }
}

function rebuildBoundary() {
  clearGroup(boundaryGroup);
  const check = checkMesh(built.data);
  if (check.boundaryEdges.length === 0) {
    updateBrokenPanel([]);
    return;
  }

  const positions: number[] = [];
  for (const e of check.boundaryEdges) {
    positions.push(e.pa.x, e.pa.y, e.pa.z, e.pb.x, e.pb.y, e.pb.z);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geom,
    new THREE.LineBasicMaterial({ color: 0xff5252 })
  );
  boundaryGroup.add(lines);

  // 边界边端点用小球标出位置
  const ball = new THREE.SphereGeometry(0.045, 12, 8);
  const ballMat = new THREE.MeshBasicMaterial({ color: 0xff8080 });
  const shown = check.boundaryEdges.slice(0, 40);
  for (const e of shown) {
    for (const p of [e.pa, e.pb]) {
      const s = new THREE.Mesh(ball, ballMat);
      s.position.set(p.x, p.y, p.z);
      boundaryGroup.add(s);
    }
  }
  updateBrokenPanel(check.boundaryEdges);
}

// ---------- 截面重建（实际相交边 -> 闭合轮廓 -> 填充） ----------
function rebuildSection() {
  clearGroup(sectionGroup);
  const plane = currentPlane();
  syncPlaneGizmo(plane);
  const result = computeSection(built.data, plane);
  currentResult = result;

  // 每个外环建一个 Shape，嵌套的内环作为孔洞
  if (state.showFill) {
    const fillMaterial = new THREE.MeshStandardMaterial({
      color: 0x26a69a,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      roughness: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const outers = result.loops.filter((l) => l.depth % 2 === 0);
    for (const outer of outers) {
      const inners = result.loops.filter((l) => l.depth === outer.depth + 1 && loopContains(outer, l));
      const shape = new THREE.Shape();
      toShapePath(shape, outer.points, plane, false);
      for (const inner of inners) {
        const hole = new THREE.Path();
        toShapePath(hole, inner.points, plane, true);
        shape.holes.push(hole);
      }
      const fillGeom = new THREE.ShapeGeometry(shape);
      const fill = new THREE.Mesh(fillGeom, fillMaterial);
      orientObjectToPlane(fill, plane, result.basis);
      sectionGroup.add(fill);
    }
  }

  // 轮廓线：外环青色、内环橙色
  addLoopLines(result, plane);
  // 未闭合截交链：红色加粗
  addOpenChains(result);
  updateStats(result);
}

function toShapePath(target: THREE.Shape | THREE.Path, pts: Vec3[], plane: Plane, asHole: boolean) {
  const b = currentResult!.basis;
  const xy = pts.map((p) => toPlaneXY(p, b));
  // Shape 孔洞要求与外环相反绕序
  const signed = signedAreaXY(xy);
  const outerWantsCCW = !asHole;
  const isCCW = signed > 0;
  const ordered = outerWantsCCW === isCCW ? xy : [...xy].reverse();
  target.moveTo(ordered[0].x, ordered[0].y);
  for (let i = 1; i < ordered.length; i++) target.lineTo(ordered[i].x, ordered[i].y);
  target.closePath();
  void plane;
}

function toPlaneXY(p: Vec3, b: SectionResult["basis"]) {
  const dx = p.x - b.origin.x;
  const dy = p.y - b.origin.y;
  const dz = p.z - b.origin.z;
  return {
    x: dx * b.u.x + dy * b.u.y + dz * b.u.z,
    y: dx * b.v.x + dy * b.v.y + dz * b.v.z,
  };
}

function signedAreaXY(xy: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const p = xy[i];
    const q = xy[(i + 1) % xy.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function orientObjectToPlane(obj: THREE.Object3D, plane: Plane, basis: SectionResult["basis"]) {
  // 局部 +Z 对齐平面法向，局部原点放到平面参考点
  const n = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
  const u = new THREE.Vector3(basis.u.x, basis.u.y, basis.u.z);
  const v = new THREE.Vector3(basis.v.x, basis.v.y, basis.v.z);
  const m = new THREE.Matrix4().makeBasis(u, v, n);
  obj.quaternion.setFromRotationMatrix(m);
  obj.position.copy(new THREE.Vector3(basis.origin.x, basis.origin.y, basis.origin.z));
}

function addLoopLines(result: SectionResult, plane: Plane) {
  const makeLine = (pts: Vec3[], color: number) => {
    const closed = [...pts, pts[0]];
    const arr = new Float32Array(closed.length * 3);
    closed.forEach((p, i) => {
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const line = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
    );
    sectionGroup.add(line);
  };
  for (const loop of result.loops) {
    makeLine(loop.points, loop.depth % 2 === 0 ? 0x4dd0e1 : 0xffb74d);
  }
  void plane;
}

function addOpenChains(result: SectionResult) {
  for (const chain of result.openChains) {
    const arr = new Float32Array(chain.points.length * 3);
    chain.points.forEach((p, i) => {
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    sectionGroup.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xff5252 })));

    // 链的两个端点高亮，表示破口位置
    const ball = new THREE.SphereGeometry(0.06, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff1744 });
    for (const p of [chain.points[0], chain.points[chain.points.length - 1]]) {
      const s = new THREE.Mesh(ball, mat);
      s.position.set(p.x, p.y, p.z);
      sectionGroup.add(s);
    }
  }
}

function loopContains(outer: SectionResult["loops"][number], inner: SectionResult["loops"][number]): boolean {
  // 绕数判断：内环路的第一个点是否落在外环内（对任意绕序稳定）
  const b = currentResult!.basis;
  const q = toPlaneXY(inner.points[0], b);
  const poly = outer.points.map((p) => toPlaneXY(p, b));
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const cross = (c.x - a.x) * (q.y - a.y) - (c.y - a.y) * (q.x - a.x);
    if (a.y <= q.y) {
      if (c.y > q.y && cross > 0) wn++;
    } else if (c.y <= q.y && cross < 0) wn--;
  }
  return wn !== 0;
}

// ---------- 面板数据 ----------
const $ = (id: string) => document.getElementById(id)!;
const fmt = (x: number) => (Math.abs(x) < 1e-8 ? "0" : x.toFixed(4));

function updateStats(result: SectionResult) {
  const outer = result.loops.filter((l) => l.depth % 2 === 0).length;
  const inner = result.loops.length - outer;
  $("stat-loops").textContent = `${result.loops.length}（外 ${outer} / 内 ${inner}）`;
  $("stat-area").textContent = fmt(result.sectionArea);
  $("stat-perimeter").textContent = fmt(result.totalPerimeter);
  $("stat-segments").textContent = String(result.segmentCount);
  $("stat-open").innerHTML = result.openChains.length
    ? `<span class="bad">${result.openChains.length} 条（长度 ${result.openChains.map((c) => c.length.toFixed(2)).join(", ")}）</span>`
    : "0";
  const detail = $("open-detail");
  if (result.openChains.length) {
    detail.innerHTML = result.openChains
      .slice(0, 6)
      .map((c) => {
        const a = c.points[0];
        const z = c.points[c.points.length - 1];
        return `断点：(${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)}) → (${z.x.toFixed(2)}, ${z.y.toFixed(2)}, ${z.z.toFixed(2)})`;
      })
      .join("<br>");
  } else {
    detail.textContent = "截面轮廓全部闭合";
  }
}

function updateBrokenPanel(edges: { pa: Vec3; pb: Vec3 }[]) {
  const el = $("stat-boundary");
  if (edges.length === 0) {
    el.innerHTML = '<span class="ok">0（网格封闭）</span>';
    return;
  }
  el.innerHTML = `<span class="bad">${edges.length} 条</span>`;
  const detail = $("open-detail");
  const shown = edges.slice(0, 8).map((e) => {
    const mid = { x: (e.pa.x + e.pb.x) / 2, y: (e.pa.y + e.pb.y) / 2, z: (e.pa.z + e.pb.z) / 2 };
    return `边中点 (${mid.x.toFixed(2)}, ${mid.y.toFixed(2)}, ${mid.z.toFixed(2)})`;
  });
  detail.innerHTML = `边界边位置（前 ${shown.length} 条）：<br>${shown.join("<br>")}${edges.length > 8 ? `<br>…共 ${edges.length} 条` : ""}`;
}

// ---------- 平面拖拽（平移 / Shift 旋转） ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragging = false;
let rotating = false;

function setPointer(e: PointerEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(planeMesh, false);
  if (hit.length === 0) return;
  dragging = true;
  rotating = e.shiftKey;
  orbit.enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
});

renderer.domElement.addEventListener("pointermove", (e) => {
  setPointer(e);
  if (!dragging) {
    raycaster.setFromCamera(pointer, camera);
    const hover = raycaster.intersectObject(planeMesh, false).length > 0;
    renderer.domElement.style.cursor = hover ? (e.shiftKey ? "grab" : "move") : "";
    return;
  }
  const plane = currentPlane();
  const n = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
  raycaster.setFromCamera(pointer, camera);

  if (rotating) {
    // 取视线在垂直于 n 平面上的投影作为新法向
    const viewDir = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(viewDir, n);
    if (right.lengthSq() < 1e-8) return;
    right.normalize();
    const up = new THREE.Vector3().crossVectors(n, right).normalize();
    const dx = e.movementX;
    const dy = e.movementY;
    const newNormal = n.clone().addScaledVector(right, dx * 0.006).addScaledVector(up, -dy * 0.006).normalize();
    state.theta = THREE.MathUtils.radToDeg(Math.atan2(newNormal.z, newNormal.x));
    state.phi = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(newNormal.y, -1, 1)));
  } else {
    // 沿法向平移：射线与过原点、法向为 n 的平面求交
    const refPlane = new THREE.Plane(n.clone().multiplyScalar(-1), 0); // n·x = 0
    const hitPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(refPlane, hitPoint)) {
      state.offset = THREE.MathUtils.clamp(hitPoint.dot(n), -5, 5);
    }
  }
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  rebuildSection();
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (!dragging) return;
  dragging = false;
  rotating = false;
  orbit.enabled = true;
  renderer.domElement.releasePointerCapture(e.pointerId);
});

// ---------- GUI 控制 ----------
const gui = new GUI({ title: "控制面板" });
const modelFolder = gui.addFolder("模型");
modelFolder
  .add(state, "model", {
    "封闭方壳": "shell",
    "带孔环体": "torus",
    "破面方壳": "brokenShell",
    "破面环体": "brokenTorus",
  })
  .name("选择网格")
  .onChange((v: MeshKind) => loadModel(v));
modelFolder.add(state, "showFill").name("显示截面填充").onChange(() => rebuildSection());
modelFolder.add(state, "showPlane").name("显示切平面").onChange(() => syncPlaneGizmo(currentPlane()));
modelFolder.open();

const planeFolder = gui.addFolder("切平面");
planeFolder.add(state, "offset", -5, 5, 0.01).name("平移 w").onChange(() => rebuildSection());
planeFolder.add(state, "theta", -180, 180, 1).name("方位角 θ°").onChange(() => rebuildSection());
planeFolder.add(state, "phi", -89, 89, 1).name("俯仰角 φ°").onChange(() => rebuildSection());
planeFolder.open();

const presets: Record<string, () => void> = {
  "方壳·侧切 x=0": () => applyPreset("shell", 90, 0, 0),
  "方壳·贴面 x=2": () => applyPreset("shell", 90, 0, 2),
  "方壳·过角点": () => applyPreset("shell", 45, Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI, 2 * Math.sqrt(3)),
  "方壳·斜切 x+y=0": () => applyPreset("shell", 45, 0, 0),
  "方壳·切不到 x=5": () => applyPreset("shell", 90, 0, 5),
  "环体·侧切 x=0": () => applyPreset("torus", 90, 0, 0),
  "环体·切空 w=5": () => applyPreset("torus", 90, 0, 5),
  // 斜平面 x+3z=5.4：切穿顶面破口，可看到红色未闭合链与断点
  "破面方壳·斜切过破口": () =>
    applyPreset("brokenShell", Math.atan2(3, 1) * 180 / Math.PI, 0, 5.4 / Math.hypot(1, 3)),
  // 斜平面 x-1.5z=2：切穿环管底部破口
  "破面环体·斜切过破口": () =>
    applyPreset("brokenTorus", Math.atan2(-1.5, 1) * 180 / Math.PI, 0, 2 / Math.hypot(1, 1.5)),
  "破面方壳·侧切": () => applyPreset("brokenShell", 90, 0, 0),
};
const presetController = { preset: "方壳·侧切 x=0" };
planeFolder
  .add(presetController, "preset", Object.keys(presets))
  .name("预设位置")
  .onChange((name: string) => presets[name]());

function applyPreset(model: MeshKind, theta: number, phi: number, offset: number) {
  state.model = model;
  state.theta = theta;
  state.phi = phi;
  state.offset = offset;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  loadModel(model);
}

// ---------- 页面内验证 ----------
$("run-verify").addEventListener("click", () => {
  const report = runAllVerifications();
  const table = $("verify-table") as HTMLTableElement;
  table.hidden = false;
  const tbody = table.querySelector("tbody")!;
  tbody.innerHTML = "";
  for (const row of report.rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.caseName,
      row.metric,
      row.actual.toPrecision(6),
      row.expected.toPrecision(6),
      row.pass ? "✔ 通过" : "✘ 失败",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 4) td.className = row.pass ? "ok" : "bad";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  const summary = $("verify-summary");
  summary.innerHTML =
    report.passCount === report.total
      ? `<span class="ok">全部 ${report.total} 项通过</span>`
      : `<span class="bad">${report.passCount}/${report.total} 通过</span>`;
});

// ---------- 启动 ----------
loadModel(state.model);
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}
animate();
