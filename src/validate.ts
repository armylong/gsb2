import * as THREE from 'three';
import { computeFrames, signedAngle, transportStep, FrameSet } from './frames';
import { buildPipe, PipeData, PipeParams } from './pipe';
import { toOBJ, countOBJ } from './obj';

export interface CheckResult {
  name: string;
  expected: string;
  measured: string;
  pass: boolean;
}

/** 相邻环法向绕切向的最大转角（弧度） */
function maxNormalStep(frames: FrameSet, closed: boolean): number {
  const n = frames.normals.length;
  const span = closed ? n : n - 1;
  let max = 0;
  for (let i = 0; i < span; i++) {
    const i1 = (i + 1) % n;
    const a = Math.abs(signedAngle(frames.normals[i], frames.normals[i1], frames.tangents[i1]));
    if (a > max) max = a;
  }
  return max;
}

/** 环上任意两顶点的最大距离（截面外接直径） */
function ringDiameter(data: PipeData, ring: number): number {
  let max = 0;
  const base = ring * data.sides * 3;
  for (let a = 0; a < data.sides; a++) {
    for (let b = a + 1; b < data.sides; b++) {
      const ia = base + a * 3, ib = base + b * 3;
      const dx = data.positions[ia] - data.positions[ib];
      const dy = data.positions[ia + 1] - data.positions[ib + 1];
      const dz = data.positions[ia + 2] - data.positions[ib + 2];
      max = Math.max(max, Math.hypot(dx, dy, dz));
    }
  }
  return max;
}

const DEG = 180 / Math.PI;

/**
 * 可重复的数值验证。所有用例由程序生成，结果与当前参数联动。
 */
export function runValidation(current: {
  samplePoints: THREE.Vector3[];
  params: PipeParams;
  pipe: PipeData;
  /** 闭环采样时"末点-首点"的实测距离（闭环曲线应为 0）；非闭环可省略 */
  seamGap?: number;
}): CheckResult[] {
  const results: CheckResult[] = [];
  const { params, pipe } = current;

  // --- 1. 直线路径截面尺寸 ---
  {
    const straight = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10)];
    const curve = new THREE.CatmullRomCurve3(straight, false, 'centripetal');
    const pts = curve.getSpacedPoints(8);
    const frames = computeFrames(pts, false);
    const testParams: PipeParams = { ...params, closed: false, caps: false };
    const data = buildPipe(frames, testParams);
    const measured = ringDiameter(data, 4);
    const expected = 2 * params.radius;
    const tol = Math.max(1e-4, expected * 1e-4);
    results.push({
      name: '直线路径截面外接直径',
      expected: `${expected.toFixed(4)} ± ${tol.toExponential(1)}`,
      measured: measured.toFixed(6),
      pass: Math.abs(measured - expected) <= tol,
    });

    // --- 2. 直线路径相邻截面朝向变化（应为 0，无扭转） ---
    const twist = maxNormalStep(frames, false);
    results.push({
      name: '直线路径相邻截面朝向最大变化',
      expected: '0° ± 0.001°',
      measured: `${(twist * DEG).toExponential(3)}°`,
      pass: twist <= 1e-5,
    });
  }

  // --- 3. 当前路径相邻截面朝向最大变化（平滑性参考） ---
  {
    const frames = pipe.frames;
    const step = maxNormalStep(frames, params.closed);
    results.push({
      name: '当前路径相邻截面朝向最大变化',
      expected: '< 30°（无突跳）',
      measured: `${(step * DEG).toFixed(4)}°`,
      pass: step < Math.PI / 6,
    });
  }

  // --- 4. 闭环接缝：位置与朝向 ---
  {
    // 当前是闭环就验当前路径，否则用内置方环测试路径
    let seamFrames: FrameSet;
    let posErr: number;
    let label: string;
    if (params.closed) {
      seamFrames = pipe.frames;
      posErr = current.seamGap ?? 0;
      label = '当前闭环';
    } else {
      const loop = [
        new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 2, 0.5),
        new THREE.Vector3(-2, 0, 0), new THREE.Vector3(0, -2, -0.5),
      ];
      const curve = new THREE.CatmullRomCurve3(loop, true, 'centripetal');
      const sampled = curve.getSpacedPoints(24); // 25 个点，末点应与首点重合
      posErr = sampled[0].distanceTo(sampled[24]);
      seamFrames = computeFrames(sampled.slice(0, 24), true);
      label = '内置闭环';
    }
    const n = seamFrames.points.length;
    // 朝向误差：从末环法向再传输回首环切平面，与首环法向的夹角
    const predicted = transportStep(
      seamFrames.normals[n - 1], seamFrames.tangents[n - 1], seamFrames.tangents[0],
    );
    const orientErr = Math.abs(signedAngle(predicted, seamFrames.normals[0], seamFrames.tangents[0]));
    results.push({
      name: `闭环接缝位置误差（${label}）`,
      expected: '0 ± 1e-6（共享顶点）',
      measured: posErr.toExponential(3),
      pass: posErr <= 1e-6,
    });
    results.push({
      name: `闭环接缝朝向误差（${label}）`,
      expected: '0° ± 0.001°',
      measured: `${(orientErr * DEG).toExponential(3)}°`,
      pass: orientErr <= 1e-5,
    });
    // 网格拓扑：末环三角形应直接引用第 0 环顶点
    if (params.closed) {
      const sides = pipe.sides;
      let wrapped = false;
      for (let i = 0; i < pipe.indices.length; i += 3) {
        const a = pipe.indices[i], b = pipe.indices[i + 1], c = pipe.indices[i + 2];
        const ringOf = (v: number) => Math.floor(v / sides);
        const rings = [ringOf(a), ringOf(b), ringOf(c)];
        if (rings.includes(pipe.ringCount - 1) && rings.includes(0)) { wrapped = true; break; }
      }
      results.push({
        name: '闭环接缝网格拓扑闭合',
        expected: '末环与首环共享顶点',
        measured: wrapped ? '共享顶点，无重复环' : '未闭合',
        pass: wrapped,
      });
    }
  }

  // --- 5. 导出与预览的顶点/面数一致 ---
  {
    const obj = toOBJ(pipe);
    const counts = countOBJ(obj);
    results.push({
      name: '导出 OBJ 顶点数 = 预览顶点数',
      expected: `${pipe.vertexCount}`,
      measured: `${counts.vertices}`,
      pass: counts.vertices === pipe.vertexCount,
    });
    results.push({
      name: '导出 OBJ 三角形数 = 预览三角形数',
      expected: `${pipe.triangleCount}`,
      measured: `${counts.faces}`,
      pass: counts.faces === pipe.triangleCount,
    });
  }

  return results;
}
