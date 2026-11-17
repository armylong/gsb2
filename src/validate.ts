/**
 * validate.ts —— 关键验证(纯数学,不依赖 DOM/three,浏览器与节点环境都能跑)
 *
 * 覆盖:
 *  V1 六面基向量正交规范且 r×u=d(方向约定自洽)
 *  V2 六面方向往返:网格中心 -> 3D 方向 -> 反查,面与 uv 一致
 *  V3 全部共享边:恰 12 条,24 条面边各出现一次,每面 4 条
 *  V4 边缘两侧方向一致性:配对刻度在 3D 空间是同一点,反向标记正确
 *  V5 反射定律:R = I - 2(N·I)N 的已知解析用例
 *  V6 旋转/翻转可逆性:displayToCanonical ∘ canonicalToDisplay 恒等
 *  V7 误转追踪:变换不改变物理命中面,但格子读数变化且可回溯
 *  V8 变换后接缝刻度仍逐点对应(错误设置下读数依然可解释)
 *  V9 物体旋转后反射方向随表面法线变化,且满足反射镜像恒等式
 */

import {
  FACE_ORDER, GRID,
  vsub, vcross, vdot, vlen, veq, vnorm, reflect,
  faceDef, faceBasis, vectorToFace, cellCenterDir,
  ALL_EDGES, SHARED_EDGES, edgePoint, sharedEdgeOf, neighborEdge,
  edgeTickReversed, neighborTick, displayTickCorrespondence, sidePoint,
  tickOnSide,
  displaySideToCanonical, canonicalSideToDisplay,
  canonicalToDisplay, displayToCanonical, sampleEnvironment,
  identityTransforms, type FaceId, type FaceTransform,
} from './facemath';

export interface ValidationCase {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  cases: ValidationCase[];
  get passed(): boolean;
}

function ok(id: string, name: string, detail: string): ValidationCase {
  return { id, name, passed: true, detail };
}
function fail(id: string, name: string, detail: string): ValidationCase {
  return { id, name, passed: false, detail };
}

const EPS = 1e-9;

export function runValidation(): ValidationReport {
  const cases: ValidationCase[] = [];

  /* V1 基向量自洽 */
  try {
    for (const id of FACE_ORDER) {
      const def = faceDef(id);
      const bases = [def.r, def.u, def.d];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(vlen(bases[i]) - 1) > EPS) throw new Error(`${id} 基向量非单位向量`);
        for (let j = i + 1; j < 3; j++) {
          if (Math.abs(vdot(bases[i], bases[j])) > EPS) throw new Error(`${id} 基向量不正交`);
        }
      }
      if (!veq(vcross(def.r, def.u), def.d)) throw new Error(`${id} 不满足 r×u=d`);
    }
    cases.push(ok('V1', '六面基向量正交规范(r×u=d)', '6 个面 × 3 个基向量全部通过'));
  } catch (e) { cases.push(fail('V1', '六面基向量正交规范(r×u=d)', (e as Error).message)); }

  /* V2 往返 */
  try {
    let checked = 0;
    for (const face of FACE_ORDER) {
      for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
          const dir = cellCenterDir(face, row, col);
          const back = vectorToFace(dir);
          if (back.face !== face) throw new Error(`${face} 格子(${row},${col}) 反查到 ${back.face}`);
          const u = (col + 0.5) / GRID;
          const v = (row + 0.5) / GRID;
          if (Math.abs(back.u - u) > 1e-9 || Math.abs(back.v - v) > 1e-9) {
            throw new Error(`${face}(${row},${col}) uv 往返偏差 ${back.u},${back.v}`);
          }
          checked++;
        }
      }
    }
    cases.push(ok('V2', '六面方向往返对应', `${checked} 个网格中心全部可逆`));
  } catch (e) { cases.push(fail('V2', '六面方向往返对应', (e as Error).message)); }

  /* V3 邻接完整性 */
  try {
    if (SHARED_EDGES.length !== 12) throw new Error(`共享边数量=${SHARED_EDGES.length},应为 12`);
    const seen = new Set<string>();
    for (const e of ALL_EDGES) {
      const k = `${e.face}:${e.side}`;
      if (seen.has(k)) throw new Error(`面边重复:${k}`);
      seen.add(k);
      const se = sharedEdgeOf(e);
      const nb = neighborEdge(e);
      if (nb.face === e.face) throw new Error(`${k} 邻接面是自身`);
      if (se.a.face === se.b.face) throw new Error(`共享边 #${se.id} 两侧同面`);
    }
    if (seen.size !== 24) throw new Error(`面边总数=${seen.size},应为 24`);
    for (const f of FACE_ORDER) {
      const count = SHARED_EDGES.filter((s) => s.a.face === f || s.b.face === f).length;
      if (count !== 4) throw new Error(`面 ${f} 共享边数=${count},应为 4`);
    }
    cases.push(ok('V3', '全部共享边邻接次序', '12 条共享边、24 条面边、每面 4 邻边完整'));
  } catch (e) { cases.push(fail('V3', '全部共享边邻接次序', (e as Error).message)); }

  /* V4 边缘两侧方向一致性 */
  try {
    for (const se of SHARED_EDGES) {
      const rev = edgeTickReversed(se.a, se.b);
      for (let tick = 0; tick <= GRID; tick++) {
        const tb = neighborTick(se.a, tick);
        const pa = edgePoint(se.a, tick);
        const pb = edgePoint(se.b, tb);
        if (!veq(pa, pb, 1e-9)) {
          throw new Error(`边#${se.id} 刻度 ${tick}↔${tb} 三维点不一致`);
        }
      }
      // 反向标记自检:端点交换
      const endA0 = edgePoint(se.a, 0);
      const endB0 = edgePoint(se.b, 0);
      const sameAtZero = veq(endA0, endB0);
      if (rev === sameAtZero) throw new Error(`边#${se.id} 反向标记与几何不符`);
    }
    cases.push(ok('V4', '边缘两侧方向一致性', '12 条边 × 9 个刻度逐点同点,反向标记正确'));
  } catch (e) { cases.push(fail('V4', '边缘两侧方向一致性', (e as Error).message)); }

  /* V5 反射定律解析用例
   * 约定:入射 I 从表面指向相机,反射 R 是环境采样方向(从表面指向环境)。
   * 正对面的镜面看到的是相机背后的环境,所以正入射时 R 与 I 反向。 */
  try {
    const r1 = reflect([0, 0, 1], [0, 0, 1]);
    if (!veq(r1, [0, 0, -1])) throw new Error('正入射环境方向应在相机背后 (0,0,-1)');
    const r2 = reflect(vnorm([1, 0, 1]), [0, 0, 1]);
    if (!veq(r2, vnorm([1, 0, -1]))) throw new Error('45° 入射解析值不符');
    const r3 = reflect(vnorm([1, 1, 0]), vnorm([1, 0, 0]));
    if (!veq(r3, vnorm([-1, 1, 0]))) throw new Error('斜面入射解析值不符');
    cases.push(ok('V5', '反射定律 R=I-2(N·I)N', '正入射、45° 入射、斜面入射三组解析用例通过'));
  } catch (e) { cases.push(fail('V5', '反射定律 R=I-2(N·I)N', (e as Error).message)); }

  /* V6 变换可逆 */
  try {
    const trs: FaceTransform[] = [0, 1, 2, 3].flatMap((rot) =>
      ([false, true] as boolean[]).map((flip) => ({ rot: rot as 0 | 1 | 2 | 3, flip })),
    );
    for (const tr of trs) {
      for (let i = 0; i <= GRID; i++) {
        for (let j = 0; j <= GRID; j++) {
          const p = { u: i / GRID, v: j / GRID };
          const back = displayToCanonical(canonicalToDisplay(p, tr), tr);
          if (Math.abs(back.u - p.u) > EPS || Math.abs(back.v - p.v) > EPS) {
            throw new Error(`rot=${tr.rot} flip=${tr.flip} 在 (${p.u},${p.v}) 不可逆`);
          }
        }
      }
    }
    cases.push(ok('V6', '旋转/翻转可逆性', '8 种变换 × 81 个采样点全部恒等'));
  } catch (e) { cases.push(fail('V6', '旋转/翻转可逆性', (e as Error).message)); }

  /* V7 误转追踪 */
  try {
    const dirs: { dir: [number, number, number]; face: FaceId }[] = [
      { dir: [1, 0.2, -0.3], face: 'px' },
      { dir: [-0.1, 1, 0.4], face: 'py' },
      { dir: [0.3, -0.2, 1], face: 'pz' },
    ];
    for (const { dir, face } of dirs) {
      const clean = sampleEnvironment(dir, identityTransforms());
      if (clean.face !== face || clean.mismatched) throw new Error(`干净环境读数异常:${face}`);
      const bad = identityTransforms();
      bad[face] = { rot: 1, flip: true };
      const hit = sampleEnvironment(dir, bad);
      if (hit.face !== face) throw new Error('变换不应改变物理命中面');
      if (!hit.mismatched) throw new Error('误转面未被标记 mismatched');
      // 旋转 90° + 翻转后显示格子必须离开原格(中心格除外,这三个方向都不在中心)
      if (hit.cellIdx === clean.cellIdx) throw new Error('误转后显示格子未移动');
      // 规范读数必须与干净环境完全一致 —— 可回溯
      if (hit.canonicalCellIdx !== clean.cellIdx) throw new Error('规范读数不可回溯');
    }
    cases.push(ok('V7', '误转面追踪与回溯', '物理命中面不变,规范格子可回溯,误转被标记'));
  } catch (e) { cases.push(fail('V7', '误转面追踪与回溯', (e as Error).message)); }

  /* V8 变换后接缝逐点对应:完整走 显示点→规范点→邻面规范点→邻面显示点 的往返 */
  try {
    const transforms = identityTransforms();
    transforms.px = { rot: 1, flip: false };
    transforms.nz = { rot: 2, flip: true };
    for (const se of SHARED_EDGES) {
      for (const e of [se.a, se.b]) {
        const trA = transforms[e.face];
        // 边身份由边中点映射确定,角点只在已知边上取刻度,避免角点歧义
        const canonSideA = displaySideToCanonical(e.side, trA);
        for (let tick = 0; tick <= GRID; tick++) {
          // 显示刻度 -> 规范位置
          const cA = displayToCanonical(sidePoint(e.side, tick), trA);
          const canonTickA = tickOnSide(canonSideA, cA);
          // 规范邻边与对应刻度
          const canonEdgeB = neighborEdge({ face: e.face, side: canonSideA });
          const canonTickB = neighborTick({ face: e.face, side: canonSideA }, canonTickA);
          const cB = sidePoint(canonEdgeB.side, canonTickB);
          // 邻面规范位置 -> 邻面显示位置
          const trB = transforms[canonEdgeB.face];
          const displaySideB = canonicalSideToDisplay(canonEdgeB.side, trB);
          const dB = canonicalToDisplay(cB, trB);
          const tickB = tickOnSide(displaySideB, dB);
          // 与公开 API 的读数一致
          const pair = displayTickCorrespondence(e, tick, transforms);
          if (pair.tickA !== tick || pair.tickB !== tickB) {
            throw new Error(`边#${se.id} API 刻度对(${pair.tickA},${pair.tickB})与往返结果(${tick},${tickB})不符`);
          }
          if (tickB < 0 || tickB > GRID) throw new Error('邻接刻度越界');
          // 几何核验:两侧规范点在立方盒上是同一 3D 位置
          const pA = faceBasis(e.face, cA.u, cA.v);
          const pB = faceBasis(canonEdgeB.face, cB.u, cB.v);
          if (!veq(pA, pB, 1e-9)) throw new Error(`边#${se.id} 变换后刻度 ${tick} 几何失配`);
        }
      }
    }
    cases.push(ok('V8', '变换后接缝刻度对应', '含误转面的全部边 × 刻度在 3D 仍逐点重合,API 读数一致'));
  } catch (e) { cases.push(fail('V8', '变换后接缝刻度对应', (e as Error).message)); }

  /* V9 物体旋转后反射方向随表面法线变化(环境固定) */
  try {
    // 局部法线 n0 绕 Y 转 90°:x -> -z、z -> x
    const n0: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const rotY90 = (v: [number, number, number]): [number, number, number] =>
      [v[2], v[1], -v[0]];
    const n1 = vnorm(rotY90(n0));
    if (!veq(n1, vnorm([Math.SQRT1_2, 0, -Math.SQRT1_2]))) {
      throw new Error('旋转后世界法线不符');
    }
    // 固定入射(相机不动),反射必须随法线改变
    const incident: [number, number, number] = vnorm([0.3, 0.4, 0.86]);
    const r0 = reflect(incident, n0);
    const r1 = reflect(incident, n1);
    if (veq(r0, r1)) throw new Error('法线旋转后反射方向未变化');
    const h0 = sampleEnvironment(r0, identityTransforms());
    const h1 = sampleEnvironment(r1, identityTransforms());
    // 两次命中都必须是合法面与合法格子
    for (const h of [h0, h1]) {
      if (h.row < 0 || h.row >= GRID || h.col < 0 || h.col >= GRID) throw new Error('命中格子越界');
      if (h.mismatched) throw new Error('干净环境不应标记误转');
    }
    // 反射向量满足反射定律的几何恒等式:R = I - 2(N·I)N,
    // 即 R-I 与法线共线(I 约定为表面→相机方向)
    const diff = vnorm(vsub(r1, incident));
    if (Math.abs(Math.abs(vdot(diff, n1)) - 1) > 1e-9) {
      throw new Error('R-I 不与法线共线,反射几何不成立');
    }
    cases.push(ok('V9', '旋转物体后反射方向与法线一致',
      `固定入射下命中面 ${h0.face} → ${h1.face},反射满足镜像恒等式`));
  } catch (e) { cases.push(fail('V9', '旋转物体后反射方向与法线一致', (e as Error).message)); }

  return {
    cases,
    get passed() { return cases.every((c) => c.passed); },
  };
}

