import {
  Mat4,
  Vec3,
  cross,
  dot,
  invertMat4,
  mat4Mul,
  mat4Perspective,
  mat4LookAt,
  ndcToRay,
  normalize,
  orbitEye,
  orbitUp,
  rayPlaneY0,
  sub,
  transformVec4,
} from './math3d';
import {
  BOARD_D,
  BOARD_W,
  ClippedGeometry,
  Diagonal,
  buildClippedGeometry,
  buildCorners,
  worldToBoardUV,
} from './board';
import { RenderView } from './glview';

export interface CameraState {
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
  fovDeg: number;
  near: number;
  far: number;
  diagonal: Diagonal;
}

export interface TestHarness {
  setCamera(s: CameraState): void;
  render(): ClippedGeometry;
  viewPerspective(): RenderView;
  viewAffine(): RenderView;
  viewProj(): Mat4;
  aspect(): number;
}

interface Line {
  cls: 't-pass' | 't-fail' | 't-group' | '';
  text: string;
}

let lines: Line[] = [];
let passCount = 0;
let failCount = 0;

function group(name: string) {
  lines.push({ cls: 't-group', text: name });
}
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passCount++;
    lines.push({ cls: 't-pass', text: `  ✓ ${name}${detail ? ' — ' + detail : ''}` });
  } else {
    failCount++;
    lines.push({ cls: 't-fail', text: `  ✗ ${name}${detail ? ' — ' + detail : ''}` });
  }
}

// 独立于项目矩阵函数的投影推导，用来复核 projectToNDC
function independentProject(
  p: Vec3,
  eye: Vec3,
  target: Vec3,
  up: Vec3,
  fovDeg: number,
  aspect: number
): [number, number] {
  const f = normalize(sub(target, eye));
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  const q = sub(p, eye);
  const xCam = dot(q, s);
  const yCam = dot(q, u);
  const depth = dot(q, f); // 沿视线方向的正深度
  const focal = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [(focal / aspect) * xCam / depth, focal * yCam / depth];
}

export function runSelfTest(h: TestHarness): { html: string; passed: boolean } {
  lines = [];
  passCount = 0;
  failCount = 0;
  const corners = buildCorners();

  // ---- 1. 已知相机下的投影点核对 ------------------------------------------
  group('1. 已知投影点：矩阵投影 vs 独立公式 / 射线反投影');
  const cam: CameraState = {
    azimuthDeg: 24,
    elevationDeg: 31,
    distance: 13,
    fovDeg: 52,
    near: 0.3,
    far: 120,
    diagonal: 'A',
  };
  h.setCamera(cam);
  h.render();
  const vp = h.viewProj();
  const eye = orbitEye({
    azimuthDeg: cam.azimuthDeg,
    elevationDeg: cam.elevationDeg,
    distance: cam.distance,
    target: [0, 0, 0],
  });
  const up = orbitUp({
    azimuthDeg: cam.azimuthDeg,
    elevationDeg: cam.elevationDeg,
    distance: cam.distance,
    target: [0, 0, 0],
  });
  const aspect = h.aspect();
  const probes: Vec3[] = [
    [0, 0, 0],
    [BOARD_W / 2, 0, -BOARD_D / 2],
    [-BOARD_W / 2, 0, BOARD_D / 2],
    [2.3, 0, -1.7],
    [-4.1, 0, 2.6],
  ];
  let maxErr = 0;
  for (const p of probes) {
    const c = transformVec4(vp, p[0], p[1], p[2]);
    const got: [number, number] = [c[0] / c[3], c[1] / c[3]];
    const want = independentProject(p, eye, [0, 0, 0], up, cam.fovDeg, aspect);
    maxErr = Math.max(maxErr, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
  }
  check('5 个已知点 NDC 与独立推导一致', maxErr < 1e-5, `最大偏差 ${maxErr.toExponential(2)}`);

  // 射线反投影：NDC -> 射线 -> y=0 平面，应还原原世界点
  const invVP = invertMat4(vp);
  let rayErr = 0;
  for (const p of probes) {
    const c = transformVec4(vp, p[0], p[1], p[2]);
    const ndc: [number, number] = [c[0] / c[3], c[1] / c[3]];
    const ray = ndcToRay(invVP, ndc[0], ndc[1]);
    const hit = rayPlaneY0(ray.origin, ray.dir)!;
    rayErr = Math.max(rayErr, Math.hypot(hit[0] - p[0], hit[2] - p[2]));
  }
  check('NDC 反投影射线还原世界坐标', rayErr < 1e-4, `最大偏差 ${rayErr.toExponential(2)}`);

  // ---- 2. 透视通道 GPU 读回 = 理论 uv -------------------------------------
  group('2. GPU 实际读回：透视通道应等于板上真实纹理位置');
  const vPer = h.viewPerspective();
  const vAff = h.viewAffine();
  const [wPx, hPx] = vPer.deviceSize;
  const sampleUVs: [number, number][] = [];
  for (const [cu, cv] of [
    [0.22, 0.31],
    [0.5, 0.5],
    [0.74, 0.66],
    [0.37, 0.82],
    [0.9, 0.12],
  ]) {
    sampleUVs.push([cu, cv]);
  }
  let perMaxErr = 0;
  let tested = 0;
  for (const [u, v] of sampleUVs) {
    const world: Vec3 = [u * BOARD_W - BOARD_W / 2, 0, v * BOARD_D - BOARD_D / 2];
    const c = transformVec4(vp, world[0], world[1], world[2]);
    if (c[3] <= 0) continue;
    const ndcX = c[0] / c[3];
    const ndcY = c[1] / c[3];
    if (Math.abs(ndcX) > 0.97 || Math.abs(ndcY) > 0.97) continue;
    const dx = (ndcX * 0.5 + 0.5) * wPx;
    const dy = (0.5 - ndcY * 0.5) * hPx;
    const rb = vPer.readUV(dx, dy);
    if (!rb.valid) continue;
    tested++;
    perMaxErr = Math.max(perMaxErr, Math.abs(rb.uv[0] - u), Math.abs(rb.uv[1] - v));
  }
  check(`透视通道 ${tested} 个取样点读回 uv 与理论值吻合`, tested >= 4 && perMaxErr < 0.01,
    `最大偏差 ${perMaxErr.toFixed(4)}`);

  // ---- 3. 平行面对镜头：两通道必须一致 -------------------------------------
  group('3. 板面平行于镜头：透视通道与屏幕直接插值读数应相同');
  h.setCamera({ ...cam, azimuthDeg: 0, elevationDeg: 90, distance: 14, fovDeg: 45 });
  h.render();
  const vpFlat = h.viewProj();
  let parallelMaxDiff = 0;
  let parallelN = 0;
  for (const [u, v] of sampleUVs) {
    const world: Vec3 = [u * BOARD_W - BOARD_W / 2, 0, v * BOARD_D - BOARD_D / 2];
    const c = transformVec4(vpFlat, world[0], world[1], world[2]);
    const ndcX = c[0] / c[3];
    const ndcY = c[1] / c[3];
    const dx = (ndcX * 0.5 + 0.5) * wPx;
    const dy = (0.5 - ndcY * 0.5) * hPx;
    const a = vPer.readUV(dx, dy);
    const b = vAff.readUV(dx, dy);
    if (a.valid && b.valid) {
      parallelN++;
      parallelMaxDiff = Math.max(
        parallelMaxDiff,
        Math.abs(a.uv[0] - b.uv[0]),
        Math.abs(a.uv[1] - b.uv[1])
      );
    }
  }
  check(`平行面 ${parallelN} 点两通道读数一致`, parallelN >= 4 && parallelMaxDiff < 0.012,
    `最大偏差 ${parallelMaxDiff.toFixed(4)}`);

  // ---- 4. 斜放时：仿射通道受对角线影响，透视通道不受 -----------------------
  group('4. 强透视斜放：换对角线，仿射读数应变化、透视读数应不变');
  const tilt: CameraState = {
    azimuthDeg: -32,
    elevationDeg: 22,
    distance: 12,
    fovDeg: 55,
    near: 0.3,
    far: 120,
    diagonal: 'A',
  };
  h.setCamera(tilt);
  const geomA = h.render();
  const vpTilt = h.viewProj();
  const probe: Vec3 = [0.72 * BOARD_W - BOARD_W / 2, 0, 0.35 * BOARD_D - BOARD_D / 2];
  const cTilt = transformVec4(vpTilt, probe[0], probe[1], probe[2]);
  const dxT = ((cTilt[0] / cTilt[3]) * 0.5 + 0.5) * wPx;
  const dyT = (0.5 - (cTilt[1] / cTilt[3]) * 0.5) * hPx;
  const perA = vPer.readUV(dxT, dyT);
  const affA = vAff.readUV(dxT, dyT);

  h.setCamera({ ...tilt, diagonal: 'B' });
  h.render();
  const perB = vPer.readUV(dxT, dyT);
  const affB = vAff.readUV(dxT, dyT);
  const perDiagDelta =
    perA.valid && perB.valid
      ? Math.abs(perA.uv[0] - perB.uv[0]) + Math.abs(perA.uv[1] - perB.uv[1])
      : NaN;
  const affDiagDelta =
    affA.valid && affB.valid
      ? Math.abs(affA.uv[0] - affB.uv[0]) + Math.abs(affA.uv[1] - affB.uv[1])
      : NaN;
  check('透视通道换对角线后读数不变', perA.valid && perB.valid && perDiagDelta < 0.01,
    `读数差 ${perDiagDelta.toFixed(4)}`);
  check('仿射通道换对角线后读数发生变化', affA.valid && affB.valid && affDiagDelta > 0.02,
    `读数差 ${affDiagDelta.toFixed(4)}`);
  check('斜放时两通道本身读数不同', affA.valid && perA.valid &&
    (Math.abs(affA.uv[0] - perA.uv[0]) + Math.abs(affA.uv[1] - perA.uv[1])) > 0.02);

  // ---- 5. 近裁面切入板子：不翻面、保留区域仍可读 ---------------------------
  group('5. 近裁面截进板子：几何不翻转，剩余部分仍正常渲染');
  const clip: CameraState = {
    azimuthDeg: 18,
    elevationDeg: 7,
    distance: 6.5,
    fovDeg: 60,
    near: 4.2,
    far: 120,
    diagonal: 'A',
  };
  h.setCamera(clip);
  const geomClip = h.render();
  let badW = 0;
  let badNdc = 0;
  for (const t of geomClip.triangles) {
    for (const vx of t) {
      if (vx.clip[3] <= 1e-6) badW++;
      const nx = vx.clip[0] / vx.clip[3];
      const ny = vx.clip[1] / vx.clip[3];
      if (nx < -1.0001 || nx > 1.0001 || ny < -1.0001 || ny > 1.0001) badNdc++;
    }
  }
  // 原始角点中应当存在被近裁面剔除/截断的情形
  const vpClip = h.viewProj();
  const rawClip = buildClippedGeometry(vpClip, corners, 'A');
  const truncated = rawClip.triangles.length > 2 || geomClip.edges.length > 4;
  check('近裁面确实截进了板子（三角形被切开）', truncated,
    `输出三角形 ${geomClip.triangles.length} 个，边段 ${geomClip.edges.length} 条`);
  check('所有保留顶点 w>0（没有点被翻到相机前面）', badW === 0, `异常点 ${badW}`);
  check('所有保留顶点 NDC 落在 [-1,1]', badNdc === 0, `越界点 ${badNdc}`);

  // 扫描画面中心区域，两套通道都应仍能读到有效 uv
  let livePer = 0;
  let liveAff = 0;
  for (let i = 0; i < 400; i++) {
    const x = (0.1 + 0.8 * ((i * 37) % 100) / 100) * wPx;
    const y = (0.1 + 0.8 * ((i * 53) % 100) / 100) * hPx;
    if (vPer.readUV(x, y).valid) livePer++;
    if (vAff.readUV(x, y).valid) liveAff++;
  }
  check('裁剪后两通道都保留了可读区域', livePer > 20 && liveAff > 20,
    `有效取样 透视 ${livePer} / 仿射 ${liveAff}`);

  const html = lines
    .map((l) => `<div class="${l.cls}">${l.text}</div>`)
    .join('');
  const summary = `<div class="${failCount === 0 ? 't-pass' : 't-fail'}">` +
    `合计 ${passCount} 通过 / ${failCount} 失败</div>`;
  return { html: summary + html, passed: failCount === 0 };
}

// 供外部复用：构造 viewProj
export function makeViewProj(s: CameraState, aspect: number): Mat4 {
  const eye = orbitEye({
    azimuthDeg: s.azimuthDeg,
    elevationDeg: s.elevationDeg,
    distance: s.distance,
    target: [0, 0, 0],
  });
  const view = mat4LookAt(eye, [0, 0, 0], orbitUp({
    azimuthDeg: s.azimuthDeg,
    elevationDeg: s.elevationDeg,
    distance: s.distance,
    target: [0, 0, 0],
  }));
  const proj = mat4Perspective(s.fovDeg, aspect, s.near, s.far);
  return mat4Mul(proj, view);
}

export { worldToBoardUV };
