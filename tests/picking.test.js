/**
 * 拾取/框选一致性测试（headless：three 的 Raycaster 与投影都是纯数学，无需 WebGL）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InstancedMesh,
  BoxGeometry,
  MeshStandardMaterial,
  PerspectiveCamera,
  Vector3,
  Matrix4,
  Quaternion,
  Vector2,
} from 'three';
import { FieldModel } from '../src/core/FieldModel.js';
import { SelectionStore, MODE_REPLACE } from '../src/core/SelectionStore.js';
import {
  pickPointId,
  pickBoxIds,
  projectInstance,
  localToNDC,
} from '../src/core/Picker.js';

const W = 1280;
const H = 800;
const Q = new Quaternion();
const SCALE = new Vector3(1, 1, 1);
const HIDDEN_SCALE = new Vector3(0.0001, 0.0001, 0.0001);

/** 按 FieldModel 构建与 SceneView 等价的 InstancedMesh（含隐藏缩放） */
function buildMesh(model, hiddenIds = []) {
  const mesh = new InstancedMesh(
    new BoxGeometry(0.72, 0.72, 0.72),
    new MeshStandardMaterial(),
    model.count,
  );
  const m = new Matrix4();
  const hiddenSet = new Set(hiddenIds);
  for (let id = 0; id < model.count; id++) {
    const [x, y, z] = model.positions[id];
    m.compose(new Vector3(x, y, z), Q, hiddenSet.has(id) ? HIDDEN_SCALE : SCALE);
    mesh.setMatrixAt(id, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeCamera() {
  const camera = new PerspectiveCamera(55, W / H, 0.1, 2000);
  camera.position.set(60, 80, 90);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test('点选：命中屏幕位置处最近的实例 id', () => {
  const model = new FieldModel({ count: 400, cols: 20 });
  const mesh = buildMesh(model);
  const camera = makeCamera();

  // 取一个已知实例的投影中心，在该屏幕坐标做点选，应选回同一个 id
  const target = 137;
  const p = projectInstance(mesh, target, camera, W, H);
  const picked = pickPointId(mesh, camera, p.x, p.y, W, H, () => false);
  assert.equal(picked, target);
});

test('点选：隐藏（缩放 0）的实例永远选不到，自动落到后方可见实例', () => {
  const model = new FieldModel({ count: 400, cols: 20 });
  const camera = makeCamera();

  // 先在完整网格上点选一个目标
  const fullMesh = buildMesh(model);
  const p = projectInstance(fullMesh, 137, camera, W, H);
  const front = pickPointId(fullMesh, camera, p.x, p.y, W, H, () => false);
  assert.equal(front, 137);

  // 把该实例隐藏后在同一屏幕位置再点：不能选到它
  const hiddenMesh = buildMesh(model, [137]);
  const hiddenLookup = (id) => id === 137;
  const pickedAfterHide = pickPointId(
    hiddenMesh,
    camera,
    p.x,
    p.y,
    W,
    H,
    hiddenLookup,
  );
  assert.notEqual(pickedAfterHide, 137);
  assert.ok(pickedAfterHide === null || !hiddenLookup(pickedAfterHide));
});

test('框选：矩形内的可见实例全部命中且无重复，遮挡不影响结果', () => {
  const model = new FieldModel({ count: 900, cols: 30 });
  const mesh = buildMesh(model);
  const camera = makeCamera();

  // 屏幕中央 300x200 的矩形
  const rect = { x0: W / 2 - 150, y0: H / 2 - 100, x1: W / 2 + 150, y1: H / 2 + 100 };
  const hits = pickBoxIds(mesh, camera, W, H, rect, () => false);

  assert.ok(hits.length > 0, '矩形内应有命中');
  assert.equal(new Set(hits).size, hits.length, '不能有重复 id');

  // 独立复核：每个命中 id 的投影中心确实在矩形内、且在相机前方
  for (const id of hits) {
    const p = projectInstance(mesh, id, camera, W, H);
    assert.ok(p.inFront);
    assert.ok(p.x >= rect.x0 && p.x <= rect.x1);
    assert.ok(p.y >= rect.y0 && p.y <= rect.y1);
  }

  // 幂等：再跑一次结果完全一致（密集遮挡下结果可理解、可复现）
  const hitsAgain = pickBoxIds(mesh, camera, W, H, rect, () => false);
  assert.deepEqual(hitsAgain, hits);
});

test('框选：隐藏实例被排除，结果交给选择层后计数准确', () => {
  const model = new FieldModel({ count: 900, cols: 30 });
  const mesh = buildMesh(model);
  const camera = makeCamera();
  const rect = { x0: W / 2 - 150, y0: H / 2 - 100, x1: W / 2 + 150, y1: H / 2 + 100 };

  const all = pickBoxIds(mesh, camera, W, H, rect, () => false);
  const hideSome = all.slice(0, 3);
  const visibleHits = pickBoxIds(
    mesh,
    camera,
    W,
    H,
    rect,
    (id) => hideSome.includes(id),
  );
  for (const id of hideSome) assert.ok(!visibleHits.includes(id));
  assert.equal(visibleHits.length, all.length - hideSome.length);

  // 选择层应用：无重复、计数正确
  const store = new SelectionStore();
  store.apply(visibleHits, MODE_REPLACE, 'box');
  assert.equal(store.size, visibleHits.length);
  store.apply(visibleHits, MODE_REPLACE, 'box'); // 重复框选
  assert.equal(store.size, visibleHits.length);
});

test('移动后选择一致性：物件位移后，在新屏幕位置仍选回原 id', () => {
  const model = new FieldModel({ count: 400, cols: 20 });
  const camera = makeCamera();
  const mesh = buildMesh(model);

  const target = 222;
  // 移动数据层 + 同步实例矩阵（模拟 SceneView.move 完成后的稳态）
  model.move([target], { x: 8, y: 2, z: -6 });
  const m = new Matrix4();
  const [x, y, z] = model.getPosition(target);
  m.compose(new Vector3(x, y, z), Q, SCALE);
  mesh.setMatrixAt(target, m);
  mesh.instanceMatrix.needsUpdate = true;

  const p = projectInstance(mesh, target, camera, W, H);
  const picked = pickPointId(mesh, camera, p.x, p.y, W, H, () => false);
  assert.equal(picked, target, '移动后 id 不变，点选仍命中同一身份');
});

test('窗口缩放后选择区域仍准确：NDC 归一化 + 按新尺寸重新投影', () => {
  const model = new FieldModel({ count: 400, cols: 20 });
  const mesh = buildMesh(model);
  const camera = makeCamera();
  camera.aspect = 800 / 600;
  camera.updateProjectionMatrix();

  const W2 = 800;
  const H2 = 600;
  const target = 137;
  const p = projectInstance(mesh, target, camera, W2, H2);

  // NDC 换算随尺寸变化
  const ndc = localToNDC(p.x, p.y, W2, H2);
  assert.ok(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1);

  const picked = pickPointId(mesh, camera, p.x, p.y, W2, H2, () => false);
  assert.equal(picked, target);

  // 同一批物件、按新尺寸框选，命中集合与逐点投影复核一致
  const rect = { x0: 100, y0: 80, x1: 700, y1: 520 };
  const hits = pickBoxIds(mesh, camera, W2, H2, rect, () => false);
  for (const id of hits) {
    const q = projectInstance(mesh, id, camera, W2, H2);
    assert.ok(q.x >= 100 && q.x <= 700 && q.y >= 80 && q.y <= 520 && q.inFront);
  }
});

test('相机移动后：旧屏幕坐标与新投影分离，框选以当前画面为准', () => {
  const model = new FieldModel({ count: 400, cols: 20 });
  const mesh = buildMesh(model);
  const camera = makeCamera();

  const rect = { x0: W / 2 - 120, y0: H / 2 - 80, x1: W / 2 + 120, y1: H / 2 + 80 };
  const before = new Set(pickBoxIds(mesh, camera, W, H, rect, () => false));

  // 相机移动后用“相同屏幕矩形”重新选择，命中集合允许变化，
  // 但每个命中都必须满足当前画面下的投影判定——这正是区域随画面准确的含义
  camera.position.set(-50, 40, 60);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const after = pickBoxIds(mesh, camera, W, H, rect, () => false);

  assert.ok(after.length > 0);
  for (const id of after) {
    const p = projectInstance(mesh, id, camera, W, H);
    assert.ok(p.inFront);
    assert.ok(p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1);
  }
  // 视角变化确实改变了屏幕覆盖内容（ sanity check，阵列两侧差异明显）
  assert.ok([...after].some((id) => !before.has(id)) || before.size !== after.length);
});

test('相机背后的实例不会被框选误收', () => {
  const model = new FieldModel({ count: 25, cols: 5 });
  const mesh = buildMesh(model);
  const camera = new PerspectiveCamera(55, W / H, 0.1, 2000);
  // 贴近并看向外侧，使部分实例落在相机身后
  camera.position.set(0, 2, 2);
  camera.lookAt(0, 2, -100);
  camera.updateMatrixWorld(true);

  const fullScreen = { x0: 0, y0: 0, x1: W, y1: H };
  const hits = pickBoxIds(mesh, camera, W, H, fullScreen, () => false);
  for (const id of hits) {
    const p = projectInstance(mesh, id, camera, W, H);
    assert.ok(p.inFront, `实例 ${id} 不应在相机后方被选中`);
  }
  assert.ok(hits.length < model.count, '身后实例必须被排除');
});
