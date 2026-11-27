// 无头浏览器自检入口：固定画布尺寸，跑完整 self-test，把结果写到页面文本里。
import { makeCheckerCanvas, buildClippedGeometry, buildCorners } from './board';
import { makeViewProj, runSelfTest, CameraState, TestHarness } from './selftest';
import { RenderView } from './glview';
import { Mat4 } from './math3d';
import { ClippedGeometry } from './board';

const checker = makeCheckerCanvas();
const c1 = document.getElementById('c1') as HTMLCanvasElement;
const c2 = document.getElementById('c2') as HTMLCanvasElement;
const viewPer = new RenderView(c1, checker);
const viewAff = new RenderView(c2, checker);
const corners = buildCorners();

let state: CameraState = {
  azimuthDeg: 24, elevationDeg: 31, distance: 13,
  fovDeg: 52, near: 0.3, far: 120, diagonal: 'A',
};
let geom: ClippedGeometry | null = null;
let vp: Mat4 | null = null;

const harness: TestHarness = {
  setCamera(s) { state = { ...s }; },
  viewPerspective: () => viewPer,
  viewAffine: () => viewAff,
  viewProj: () => vp!,
  aspect: () => {
    const [w, h] = viewPer.deviceSize;
    return w / h;
  },
  render() {
    vp = makeViewProj(state, harness.aspect());
    geom = buildClippedGeometry(vp, corners, state.diagonal);
    viewPer.render(geom, false);
    viewAff.render(geom, true);
    return geom;
  },
};

const log = document.getElementById('log')!;
try {
  harness.render();
  const result = runSelfTest(harness);
  const plain = result.html
    .replace(/<div class="t-group">/g, '\n## ')
    .replace(/<div class="t-pass">/g, '\nPASS  ')
    .replace(/<div class="t-fail">/g, '\nFAIL  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&/g, '&');
  log.textContent = (result.passed ? 'ALL_TESTS_PASSED' : 'SOME_TESTS_FAILED') + plain;
  log.className = result.passed ? 'ok' : 'bad';
  document.title = result.passed ? 'PASS' : 'FAIL';
  // 挂到 window，方便 CDP 读取
  (window as unknown as Record<string, unknown>).__TEST_RESULT__ = result.passed;
} catch (err) {
  log.textContent = 'EXCEPTION: ' + (err as Error).stack;
  log.className = 'bad';
  document.title = 'FAIL';
  (window as unknown as Record<string, unknown>).__TEST_RESULT__ = false;
}
