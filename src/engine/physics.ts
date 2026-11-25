import {
  add,
  angleDiff,
  clamp,
  cross,
  dot,
  fromAngle,
  len,
  normalize,
  perp,
  rad2deg,
  scale,
  smoothstep,
  sub,
  vec,
  wrapAngle,
  type Vec2,
} from '../vec';
import type { Boat, BoatReadout, Inputs, WindState } from './types';

/**
 * 角度约定（屏幕坐标，顺时针为正）：
 * - heading：船头方向
 * - AWA（表观风角）：船头 -> 表观风"来流方向"的带符号夹角，0 = 正对风眼，
 *   正值 = 风从右舷来（右舷受风），±180 = 正顺风
 * - 帆桁角：世界坐标；平衡位置总在来风的下风侧
 */

export const PHYS = {
  /** 帆气动压力合并系数（含 0.5*rho*S）。 */
  kSail: 1.0,
  maxLift: 1.4,
  stallAoaDeg: 24,
  dragAtZeroAoa: 0.05,
  dragAtStall: 1.2,
  /** 收满帆时相对真风的目标攻角（度）：对准升力高效区。 */
  trimTightDeg: 18,
  /** 完全松帆时帆桁相对中心线的最大张开角（度，顺风时用）。 */
  boomMaxDeg: 80,
  /** 帆桁跟随平衡位置的速率 rad/s。 */
  boomRate: 2.4,

  /** 船体纵向阻力（F = c * v * |v|）。 */
  hullDragFwd: 1.1,
  /** 横向阻力（稳向板），线性 + 二次。 */
  hullDragSideLin: 55.0,
  hullDragSideQuad: 25.0,

  /** 满舵转向速率 rad/s。 */
  rudderRate: 0.8,
  rudderSpeedHalf: 1.0,
  /** 过风时即使失速也保留的最小转向速率（rad/s，满舵比例）。 */
  tackCarryRate: 0.45,
  tackMomentumDecay: 8.0,
  sternwayRudder: 0.7,

  /** 风眼内/外边界（度，相对真风角）。 */
  noGoInnerDeg: 18,
  noGoOuterDeg: 26,
  /** 失速时表观风把船缓慢推向下风的系数。 */
  backingCoeff: 0.12,
};

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * 帆桁平衡角（世界坐标）。
 * 下风侧由真风角 twa 锁定（不随会变号的表观风翻转）；攻角相对*表观风*调节（真实调帆方式）。
 * 帆索：sheet=0 收满 -> 相对表观风保持 trimTight 高效攻角；
 * sheet=1 松满 -> 帆桁收到中心线，攻角变大到失速、飘帆、推力下降。
 */
export function equilibriumBoom(
  heading: number,
  windFromAngle: number,
  awa: number,
  sheet: number,
): number {
  const twa = wrapAngle(angleDiff(windFromAngle, heading));
  const s = clamp(sheet, 0, 1);
  // 下风侧只由真风角决定：twa>0 -> 帆桁偏负（左舷）；twa<0 -> 偏正
  const sign = twa >= 0 ? -1 : 1;
  const absAwa = Math.abs(awa);
  // 收满时 boom 与表观风夹 trimTight；松满时 boom 贴中心线（与表观风夹整个 |AWA|）
  const tight = Math.max(0, absAwa - deg(PHYS.trimTightDeg));
  const loose = absAwa;
  const boomOff = sign * (tight + (loose - tight) * s);
  return wrapAngle(heading + boomOff);
}

export interface SailForceResult {
  force: Vec2;
  aoa: number;
  luffing: boolean;
  boomOffset: number;
  fill: number;
}

/**
 * 帆的受力（世界坐标），标准翼型升阻模型：
 *   升力 = q·Cl(α)，方向垂直*表观风*，把帆吸向背风面；
 *   阻力 = q·Cd(α)，方向始终与表观风同向（永不推动船，保证顺风不超过风速）。
 * α 为帆桁与来流的攻角。风眼内按 fill 削弱升力。
 */
export function computeSailForce(
  heading: number,
  boomAngle: number,
  apparentWind: Vec2,
  fill: number,
): SailForceResult {
  const va = len(apparentWind);
  const ef = fromAngle(boomAngle);
  const flowDir = va > 1e-6 ? scale(apparentWind, -1 / va) : vec(1, 0); // 来流方向

  // 攻角：帆桁 -> 来流方向的带符号角
  const aoa = wrapAngle(Math.atan2(cross(ef, flowDir), dot(ef, flowDir)));
  const aoaAbs = Math.abs(aoa);
  const stall = deg(PHYS.stallAoaDeg);

  const clMag = (() => {
    // 真实翼型：AoA=0 时无升力，线性升到 stall 处的峰值，失速后回落
    if (aoaAbs <= stall) {
      // 用平滑曲线，小攻角升力弱、接近 stall 最高效
      return PHYS.maxLift * Math.sin((Math.PI / 2) * Math.min(1, aoaAbs / stall));
    }
    return PHYS.maxLift * Math.max(0.35, 1 - 0.6 * ((aoaAbs - stall) / (Math.PI / 2 - stall)));
  })();
  const cl = -clMag * Math.sign(aoa || 1);
  const cd =
    PHYS.dragAtZeroAoa +
    (PHYS.dragAtStall - PHYS.dragAtZeroAoa) * smoothstep(0, Math.PI / 2, aoaAbs);

  const q = PHYS.kSail * va * va;
  // 升力方向：来流顺时针 90°（屏幕系 perp）。攻角符号已含在 cl 里，这里不再乘 sign
  const liftDir = perp(flowDir);
  // 阻力方向：与表观风（空气运动）同向
  const dragDir = va > 1e-6 ? scale(apparentWind, 1 / va) : vec(0, 0);

  const fLift = scale(liftDir, cl * q * fill);
  const fDrag = scale(dragDir, cd * q);
  let force = add(fLift, fDrag);

  // 风眼失速：表观风缓慢把船推向下风（向后侧漂），船不会凭空停死
  if (fill < 0.999) {
    force = add(force, scale(apparentWind, PHYS.backingCoeff * (1 - fill)));
  }

  const luffing = aoaAbs < deg(4) || fill < 0.5;
  return { force, aoa, luffing, boomOffset: angleDiff(heading, boomAngle), fill };
}

/** 单步推进船体（水流在 world 层叠加）。 */
export function stepBoat(
  boat: Boat,
  input: Inputs,
  wind: WindState,
  dt: number,
): BoatReadout {
  const h = boat.heading;
  const eh = fromAngle(h);
  const sideV = perp(eh); // 右舷

  // ---- 表观风 = 真风 - 对水速度 ----
  const trueWind = fromAngle(wind.dir, wind.speed);
  const apparentWind = sub(trueWind, boat.vel);
  const flowDir = len(apparentWind) > 1e-6 ? normalize(scale(apparentWind, -1)) : eh;
  // 标准 AWA：0 = 正对风眼，正 = 风从右舷来
  const awa = wrapAngle(Math.atan2(dot(flowDir, sideV), dot(flowDir, eh)));
  const apparentSpeed = len(apparentWind);
  const windFrom = wrapAngle(wind.dir + Math.PI); // 风眼方向

  // ---- 风眼失速因子。用真风角（船头 vs 风眼）判定，避免船速→表观风→fill 的正反馈 ----
  const twaAbs = Math.abs(wrapAngle(angleDiff(h, windFrom)));
  const targetFill = smoothstep(deg(PHYS.noGoInnerDeg), deg(PHYS.noGoOuterDeg), twaAbs);
  // 进风眼失速稍慢（有惯性），转出来重新吃风要快
  const fillRate = targetFill < boat.fill ? 1.2 : 3.5;
  boat.fill += (targetFill - boat.fill) * (1 - Math.exp(-fillRate * dt));
  // 迟滞：进入内风眼置位，必须完全驶出外风眼才清除，杜绝边界抖动
  if (twaAbs < deg(PHYS.noGoInnerDeg)) boat.inIronsHeld = true;
  else if (twaAbs > deg(PHYS.noGoOuterDeg) + deg(2)) boat.inIronsHeld = false;
  const inNoGo = boat.inIronsHeld;
  const inIrons = twaAbs < deg(PHYS.noGoInnerDeg) && len(boat.vel) < 0.9;

  // ---- 帆桁带惯性跟随下风侧平衡位置 ----
  const boomTarget = equilibriumBoom(h, windFrom, awa, input.sheet);
  let boomDiff = angleDiff(boat.boomAngle, boomTarget);
  // 帆桁穿过中心线（换舷）时也只是一次普通的带速扫过，不做瞬间翻转
  const maxBoomStep = PHYS.boomRate * dt;
  if (Math.abs(boomDiff) <= maxBoomStep) boat.boomAngle = boomTarget;
  else boat.boomAngle = wrapAngle(boat.boomAngle + Math.sign(boomDiff) * maxBoomStep);
  void boomDiff;

  // ---- 帆受力并分解到船体坐标 ----
  const sail = computeSailForce(h, boat.boomAngle, apparentWind, boat.fill);
  const fForward = dot(sail.force, eh);
  const fSideRaw = dot(sail.force, sideV);

  // ---- 阻力 + 积分。稳向板横向阻力独立建模，几乎抵消横推但留几度侧漂 ----
  const vFwd = dot(boat.vel, eh);
  const vSide = dot(boat.vel, sideV);
  const dragSide = -(PHYS.hullDragSideLin * vSide + PHYS.hullDragSideQuad * vSide * Math.abs(vSide));
  const accel = add(
    scale(eh, fForward - PHYS.hullDragFwd * vFwd * Math.abs(vFwd)),
    scale(sideV, fSideRaw + dragSide),
  );
  boat.vel = add(boat.vel, scale(accel, dt));

  // ---- 打舵：舵效随船速，倒车反舵 ----
  const speed = len(boat.vel);
  const authority = speed / (speed + PHYS.rudderSpeedHalf);
  const reverse = vFwd < -0.15 ? -PHYS.sternwayRudder : 1;
  const targetYaw = input.rudder * PHYS.rudderRate * authority * reverse;
  boat.yawRate += (targetYaw - boat.yawRate) * (1 - Math.exp(-6 * dt));

  // ---- 过风动量：no-go 内打舵时恒定维持转向穿过风眼；一旦驶出外边界立即清零 ----
  if (inNoGo && Math.abs(input.rudder) > 0.2) {
    const carry = input.rudder * PHYS.tackCarryRate;
    boat.tackMomentum += (carry - boat.tackMomentum) * (1 - Math.exp(-6 * dt));
  } else if (!inNoGo) {
    boat.tackMomentum = 0; // 驶出风眼，舵立刻拿回全部控制权
  } else {
    boat.tackMomentum *= Math.exp(-PHYS.tackMomentumDecay * dt);
  }
  boat.heading = wrapAngle(boat.heading + (boat.yawRate + boat.tackMomentum) * dt);

  // AWA<0 风从右舷来 = 右舷受风；AWA>0 风从左舷来 = 左舷受风
  const tack: BoatReadout['tack'] =
    Math.abs(awa) < deg(3) ? 'none' : awa < 0 ? 'starboard' : 'port';

  return {
    apparentWind,
    apparentSpeed,
    awa,
    aoa: sail.aoa,
    sailForce: sail.force,
    sailForceMag: len(sail.force),
    boomOffset: sail.boomOffset,
    luffing: sail.luffing,
    leeway: vSide,
    sog: len(boat.vel),
    stw: len(boat.vel),
    cog: h,
    vmgUpwind: dot(boat.vel, fromAngle(windFrom)),
    inNoGo,
    inIrons,
    tack,
    current: vec(0, 0),
  };
}

/** 补上水流后的对地读数。 */
export function finalizeReadout(readout: BoatReadout, boat: Boat, current: Vec2): BoatReadout {
  const ground = add(boat.vel, current);
  readout.current = current;
  readout.sog = len(ground);
  readout.cog = len(ground) > 0.05 ? Math.atan2(ground.y, ground.x) : boat.heading;
  return readout;
}

export function makeBoat(pos: Vec2, heading: number): Boat {
  return {
    pos: { ...pos },
    heading,
    vel: vec(0, 0),
    yawRate: 0,
    boomAngle: heading,
    fill: 1,
    tackMomentum: 0,
    inIronsHeld: false,
    contact: vec(0, 0),
  };
}

export function describeAwa(awa: number): string {
  const a = Math.abs(rad2deg(awa));
  if (a < PHYS.noGoInnerDeg) return '风眼（失速）';
  if (a < PHYS.noGoOuterDeg) return '迎风边缘';
  if (a < 60) return '近迎风';
  if (a < 105) return '横风';
  if (a < 150) return '侧顺风';
  return '顺风';
}
