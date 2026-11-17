import * as THREE from 'three';
import { FrameSet } from './frames';
import { PipeParams } from './pipe';

export interface PathWarning {
  /** 关联的路径段索引（采样点 i 到 i+1），用于在中心线上高亮 */
  segment: number;
  kind: 'curvature' | 'spacing' | 'control-points';
  message: string;
}

/**
 * 检查两类问题：
 * 1. 弯曲过急：局部曲率半径 < 管道半径，管道会自我挤压/重叠；
 * 2. 采样过近：相邻采样点距离异常小（通常由控制点靠太近引起），截面可能互相穿插。
 * 判断只基于曲率与间距，竖直段本身不会触发。
 */
export function analyzePath(
  frames: FrameSet,
  params: PipeParams,
  controlPoints: THREE.Vector3[],
): PathWarning[] {
  const warnings: PathWarning[] = [];
  const pts = frames.points;
  const n = pts.length;

  // --- 相邻采样间距 ---
  let totalLen = 0;
  const segLen: number[] = [];
  const segCount = params.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const d = pts[i].distanceTo(pts[(i + 1) % n]);
    segLen.push(d);
    totalLen += d;
  }
  const avg = totalLen / Math.max(1, segCount);
  const minSpacing = Math.max(1e-4, avg * 0.02);
  for (let i = 0; i < segCount; i++) {
    if (segLen[i] < minSpacing) {
      warnings.push({
        segment: i,
        kind: 'spacing',
        message: `采样段 #${i} 长度过小（${segLen[i].toExponential(2)}，平均 ${avg.toFixed(3)}）：` +
          `相邻截面几乎重合，可能互相穿插。通常是控制点靠得太近。`,
      });
    }
  }

  // --- 局部曲率半径 ---
  // 用相邻两段的方向变化估计：ρ ≈ ds / dθ
  const curvatureRadius: number[] = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const iPrev = params.closed ? (i - 1 + n) % n : i - 1;
    const iNext = params.closed ? (i + 1) % n : i + 1;
    if (iPrev < 0 || iNext >= n) continue; // 开放路径端点不检查
    const v1 = pts[i].clone().sub(pts[iPrev]);
    const v2 = pts[iNext].clone().sub(pts[i]);
    const l1 = v1.length(), l2 = v2.length();
    if (l1 < 1e-9 || l2 < 1e-9) continue; // 间距警告已覆盖
    const dTheta = v1.normalize().angleTo(v2.normalize());
    const ds = (l1 + l2) / 2;
    const rho = dTheta < 1e-9 ? Infinity : ds / dTheta;
    curvatureRadius[i] = rho;
    if (rho < params.radius) {
      warnings.push({
        segment: params.closed ? i : Math.min(i, segCount - 1),
        kind: 'curvature',
        message: `采样点 #${i} 弯曲过急：曲率半径 ${rho.toFixed(3)} < 管道半径 ${params.radius}，` +
          `管道内侧会挤压重叠。可调小半径或把控制点移开。`,
      });
    }
  }

  // --- 控制点两两过近 ---
  for (let i = 0; i < controlPoints.length; i++) {
    for (let j = i + 1; j < controlPoints.length; j++) {
      if (params.closed && i === 0 && j === controlPoints.length - 1 && controlPoints.length <= 3) continue;
      const d = controlPoints[i].distanceTo(controlPoints[j]);
      if (d < 1e-3) {
        warnings.push({
          segment: 0,
          kind: 'control-points',
          message: `控制点 P${i} 与 P${j} 距离过近（${d.toExponential(2)}），可能导致采样退化。`,
        });
      }
    }
  }

  return warnings;
}
