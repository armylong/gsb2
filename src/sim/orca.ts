/**
 * ORCA(最优互惠避障)线性规划,约定与 RVO2 一致但半平面方向取左手法系:
 *
 *   可行半平面: cross(line.dir, X - line.point) >= 0
 *
 * 速度候选被限制在以原点为圆心、maxSpeed 为半径的圆盘内。
 * LP1/LP2/LP3 的结构移植自 RVO2 的经典实现,LP3 失败时采用失败线方向回退,
 * 模拟层另有位置硬投影兜底,因此数值退化不会导致穿墙。
 */
import { Vec, add, sub, mul, dot, cross, lenSq, norm, clamp, EPS } from './math';

export interface Line {
  dir: Vec; // 单位方向
  point: Vec; // 边界上一点
}

/** 在满足 lines[0..lineNo) 的前提下,把速度约束到第 lineNo 条线的边界上 */
function linearProgram1(
  lines: Line[],
  lineNo: number,
  radius: number,
  optVelocity: Vec,
  directionOpt: boolean,
): [boolean, Vec] {
  const line = lines[lineNo];
  const dotProduct = dot(line.point, line.dir);
  const discriminant =
    dotProduct * dotProduct + radius * radius - lenSq(line.point);

  if (discriminant < 0) {
    return [false, optVelocity];
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  let tLeft = -dotProduct - sqrtDiscriminant;
  let tRight = -dotProduct + sqrtDiscriminant;

  for (let i = 0; i < lineNo; i++) {
    const denominator = cross(line.dir, lines[i].dir);
    const numerator = cross(lines[i].dir, sub(line.point, lines[i].point));

    if (Math.abs(denominator) <= EPS) {
      // 平行线且方向相反 → 无解
      if (numerator < 0) {
        return [false, optVelocity];
      }
      continue;
    }

    const t = numerator / denominator;
    if (denominator >= 0) {
      tRight = Math.min(tRight, t);
    } else {
      tLeft = Math.max(tLeft, t);
    }
    if (tLeft > tRight) {
      return [false, optVelocity];
    }
  }

  let t: number;
  if (directionOpt) {
    t = dot(optVelocity, line.dir) > 0 ? tRight : tLeft;
  } else {
    t = clamp(dot(line.dir, sub(optVelocity, line.point)), tLeft, tRight);
  }
  return [true, add(line.point, mul(line.dir, t))];
}

interface Lp2Result {
  ok: boolean;
  vel: Vec;
  failIndex: number;
}

/** 求距 optVelocity 最近(或方向最优)的可行速度 */
function linearProgram2(
  lines: Line[],
  radius: number,
  optVelocity: Vec,
  directionOpt: boolean,
): Lp2Result {
  let vel: Vec;
  if (directionOpt) {
    vel = mul(norm(optVelocity), radius);
  } else if (lenSq(optVelocity) > radius * radius) {
    vel = mul(norm(optVelocity), radius);
  } else {
    vel = { ...optVelocity };
  }

  for (let i = 0; i < lines.length; i++) {
    // 处于该线不可行侧时才需要修正
    if (cross(lines[i].dir, sub(lines[i].point, vel)) > 0) {
      const [ok, newVel] = linearProgram1(
        lines,
        i,
        radius,
        optVelocity,
        directionOpt,
      );
      if (!ok) {
        return { ok: false, vel, failIndex: i };
      }
      vel = newVel;
    }
  }
  return { ok: true, vel, failIndex: -1 };
}

/**
 * 三维式松弛:LP2 无解时,在速度圆上最小化最大违约量。
 * 静态障碍线排在列表前面,这里只会松弛代理间约束。
 */
function linearProgram3(
  lines: Line[],
  beginLine: number,
  radius: number,
  result: Vec,
): Vec {
  let distance = 0;
  let curr = result;

  for (let i = beginLine; i < lines.length; i++) {
    if (cross(lines[i].dir, sub(lines[i].point, curr)) > distance) {
      const projLines = lines.slice(0, i);
      // 第 i 条线的左法向指向可行侧,作为圆周上的最优方向
      const pref: Vec = { x: -lines[i].dir.y, y: lines[i].dir.x };
      const lp2 = linearProgram2(projLines, radius, pref, true);

      let newResult: Vec;
      if (lp2.ok) {
        newResult = lp2.vel;
      } else {
        // 前期约束彼此冲突:沿失败线的方向,在更少约束下重求
        const failLine = projLines[lp2.failIndex];
        const alt: Vec = { x: -failLine.dir.y, y: failLine.dir.x };
        const lp2b = linearProgram2(
          projLines.slice(0, lp2.failIndex),
          radius,
          alt,
          true,
        );
        newResult = lp2b.ok ? lp2b.vel : curr;
      }

      curr = newResult;
      distance = cross(lines[i].dir, sub(lines[i].point, curr));
    }
  }
  return curr;
}

/** 圆盘约束下求解 ORCA,返回最终可行速度 */
export function solveOrca(lines: Line[], preferred: Vec, maxSpeed: number): Vec {
  const lp2 = linearProgram2(lines, maxSpeed, preferred, false);
  if (lp2.ok) {
    return lp2.vel;
  }
  return linearProgram3(lines, lp2.failIndex, maxSpeed, lp2.vel);
}
