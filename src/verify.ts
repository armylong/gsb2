import * as THREE from 'three';
import {
  EPS, expectedDisparity, readPoint, StereoParams, StereoRig, validateParams,
} from './stereo';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const P = (over: Partial<StereoParams> = {}): StereoParams => ({
  baseline: 0.24,
  convergence: 12,
  fov: 70,
  near: 0.5,
  far: 80,
  ...over,
});

function rigOf(p: StereoParams, aspect = 16 / 9): StereoRig {
  const rig = new StereoRig(p);
  rig.setAspect(aspect);
  // 应用固定姿态：rig 不旋转，Three 相机默认看向局部 −Z（即约定的前方）
  rig.update();
  return rig;
}

/** 在给定正深度 depth 处构造世界点（rig 位于原点无旋转，前方为 −Z） */
function pointAt(rig: StereoRig, x: number, y: number, depth: number): THREE.Vector3 {
  return rig.root.localToWorld(new THREE.Vector3(x, y, -depth));
}

/** 在相机后方（+Z 侧）构造世界点 */
function behindPoint(rig: StereoRig, x: number, y: number, back = 2): THREE.Vector3 {
  return rig.root.localToWorld(new THREE.Vector3(x, y, back));
}

export function runGeometryChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const check = (name: string, cond: boolean, detail: string) =>
    out.push({ name, pass: cond, detail });

  // 1. 零基线：左右画面完全一致，视差恒为 0
  {
    const rig = rigOf(P({ baseline: 0 }));
    const r = readPoint(rig, pointAt(rig, 1, 1, 8), 800, 5);
    check('零基线：双眼读数完全一致且视差为 0',
      r.visibility === 'both' && r.disparity !== null &&
      Math.abs(r.disparity) < EPS.ndc &&
      Math.abs((r.left.ndc!.x) - (r.right.ndc!.x)) < EPS.ndc,
      `d=${r.disparity?.toExponential(2)}，ndcΔx=${(r.left.ndc!.x - r.right.ndc!.x).toExponential(2)}`);
  }

  // 2. 会聚面零视差：不同位置、不同宽高比下 d 均为 0
  {
    let worst = 0;
    for (const aspect of [0.5, 1, 16 / 9, 2.5]) {
      const rig = rigOf(P(), aspect);
      for (const [x, y] of [[-3, 0.5], [0, 2], [3.1, -0.4]] as const) {
        const r = readPoint(rig, pointAt(rig, x, y, 12), 900, 5);
        worst = Math.max(worst, Math.abs(r.disparity ?? NaN));
      }
    }
    check('会聚面：左右水平归一化位置相同（d=0），且与宽高比无关',
      worst < EPS.ndc, `max|d|=${worst.toExponential(2)}（容差 ${EPS.ndc}）`);
  }

  // 3. 近/远符号：会聚面前 d>0，会聚面后 d<0
  {
    const rig = rigOf(P());
    const near = readPoint(rig, pointAt(rig, 0, 1, 6), 800, 5);
    const far = readPoint(rig, pointAt(rig, 0, 1, 24), 800, 5);
    check('视差符号：近物 d>0（交叉），远物 d<0（非交叉）',
      (near.disparity ?? 0) > 0 && (far.disparity ?? 0) < 0,
      `d(6m)=${near.disparity?.toFixed(5)}，d(24m)=${far.disparity?.toFixed(5)}`);
  }

  // 4. 同一深度水平视差一致：相同深度、不同 x/y 的标记 d 相等
  {
    const rig = rigOf(P());
    const a = readPoint(rig, pointAt(rig, -2.5, 0.3, 8), 800, 5);
    const b = readPoint(rig, pointAt(rig, 2.5, 2.1, 8), 800, 5);
    const diff = Math.abs((a.disparity ?? 0) - (b.disparity ?? 0));
    check('同一深度：不同水平位置的标记水平视差一致',
      diff < EPS.ndc, `Δd=${diff.toExponential(2)}`);
  }

  // 5. 公式对照与尺寸换算：d 与视口宽度无关，像素视差 = d×W
  {
    const rig = rigOf(P());
    const pt = pointAt(rig, 1, 1, 7.5);
    const r800 = readPoint(rig, pt, 800, 5);
    const r1400 = readPoint(rig, pt, 1400, 5);
    const expected = expectedDisparity(P(), 7.5)!;
    const dConsistent = Math.abs((r800.disparity ?? 0) - (r1400.disparity ?? 0)) < EPS.ndc;
    const formulaOk = (r800.formulaError ?? 1) < EPS.ndc;
    const pxOk800 = Math.abs((r800.pixelDisparity ?? 0) - expected * 800) < EPS.pixel;
    const pxOk1400 = Math.abs((r1400.pixelDisparity ?? 0) - expected * 1400) < EPS.pixel;
    check('尺寸换算：归一化视差不随视口宽度变化，像素视差=d×W，且与闭式公式吻合',
      dConsistent && formulaOk && pxOk800 && pxOk1400,
      `d800=${r800.disparity?.toFixed(6)} d1400=${r1400.disparity?.toFixed(6)} ` +
      `公式=${expected.toFixed(6)} 公式误差=${r800.formulaError?.toExponential(1)}`);
  }

  // 6. 裁剪边界：near 内 / far 外 → clipped；恰在边界上可见；不可见点无视差
  {
    const rig = rigOf(P());
    const inside = readPoint(rig, pointAt(rig, 0, 0, 0.3), 800, 5);   // < near(0.5)
    const beyond = readPoint(rig, pointAt(rig, 0, 0, 90), 800, 5);    // > far(80)
    const atNear = readPoint(rig, pointAt(rig, 0, 0, 0.5), 800, 5);
    const atFar = readPoint(rig, pointAt(rig, 0, 0, 80), 800, 5);
    check('裁剪边界：near 内/far 外标记 clipped 且不产生视差，边界点可见',
      inside.visibility === 'clipped' && inside.disparity === null &&
      beyond.visibility === 'clipped' && beyond.disparity === null &&
      atNear.visibility === 'both' && atFar.visibility === 'both',
      `0.3m→${inside.visibility}，90m→${beyond.visibility}，边界→${atNear.visibility}/${atFar.visibility}`);
  }

  // 7. 相机后方：behind，无读数
  {
    const rig = rigOf(P());
    const r = readPoint(rig, behindPoint(rig, 0, 0, 2), 800, 5);
    check('相机后方：标记 behind 且不产生视差',
      r.visibility === 'behind' && r.disparity === null,
      `visibility=${r.visibility}`);
  }

  // 8. 单眼可见：点落在两眼离轴视锥之间的间隙中，仅一只眼可见
  {
    const p8 = P({ baseline: 1.0, fov: 40 });
    const rig = rigOf(p8);
    // 深度 depth 处的水平视锥边界（局部 X，米）：
    //   中心 = ex + sh·(depth/near)，半宽 = depth·tan(HFOV/2)
    //   左眼 sh = +(b/2)(near/zc)，右眼 sh = −(b/2)(near/zc)
    const depth = 2;
    const tanH = Math.tan(THREE.MathUtils.degToRad(p8.fov) / 2);
    const edgeAt = (eye: 'left' | 'right') => {
      const ex = eye === 'left' ? -p8.baseline / 2 : p8.baseline / 2;
      const sh = (eye === 'left' ? 1 : -1) * (p8.baseline / 2) * (p8.near / p8.convergence);
      const center = ex + sh * (depth / p8.near);
      const half = depth * tanH;
      return { lo: center - half, hi: center + half };
    };
    const L = edgeAt('left');
    const R = edgeAt('right');
    // 左视锥右缘与右视锥左缘之间的开区间（存在间隙时）
    const gapPointX = L.hi < R.lo ? (L.hi + R.lo) / 2 : Math.max(L.hi, R.lo) + 0.05;
    const r = readPoint(rig, pointAt(rig, gapPointX, 0, depth), 800, 5);
    check('单眼可见：仅一只眼视锥覆盖时状态为 left/right-only 且无视差',
      (r.visibility === 'left-only' || r.visibility === 'right-only') && r.disparity === null,
      `间隙[${L.hi.toFixed(3)}, ${R.lo.toFixed(3)}]m 取 x=${gapPointX.toFixed(3)}m → ${r.visibility}`);
  }

  // 9. 参数校验：非法组合被拒绝
  {
    const bad: [string, StereoParams][] = [
      ['near≥far', P({ near: 50, far: 40 })],
      ['会聚面在 near 内', P({ near: 1, convergence: 0.5 })],
      ['会聚面在 far 外', P({ far: 10, convergence: 12 })],
      ['负基线', P({ baseline: -0.1 })],
      ['视角越界', P({ fov: 200 })],
    ];
    const allRejected = bad.every(([, q]) => validateParams(q) !== null);
    const goodAccepted = validateParams(P()) === null;
    check('参数校验：非法组合拒绝、合法组合通过',
      allRejected && goodAccepted,
      `非法用例拒绝=${allRejected}，默认参数通过=${goodAccepted}`);
  }

  return out;
}
