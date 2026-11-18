// 纯物理仿真模块：不依赖 DOM，浏览器页面与 Node 验证脚本共用。
import {
  World, Vec2, Box, Circle, Chain, WheelJoint,
  type Body,
} from 'planck';

// ---- 常量（米 / 千克 / 秒）----
export const FIXED_DT = 1 / 120;        // 固定物理步长，帧率无关的关键
export const WHEEL_RADIUS = 0.35;
export const WHEEL_MASS = 25;
export const TRAVEL = 0.25;             // 悬挂最大压缩 / 伸展行程（±m）
export const CHASSIS_HW = 1.1;          // 车身半宽
export const CHASSIS_HH = 0.25;         // 车身半高
export const ANCHOR_DX = 0.8;           // 悬挂锚点相对车身中心
export const ANCHOR_DY = -0.2;
export const DROP_HEIGHT = 0.45;        // 落车初始离地高度
export const DRIVE_SPEED = 12;          // 驱动目标速度 m/s
export const MAX_SPEED = 20;            // 样例速度上限 m/s
export const GRAVITY = 9.8;
export const SPAWN_X = 4;

export type TerrainKind = 'flat' | 'slopes' | 'bump';
export type DriveMode = 'coast' | 'forward' | 'reverse' | 'brake';

export interface SimParams {
  stiffness: number;   // 每个悬挂的弹簧刚度 N/m
  damping: number;     // 每个悬挂的阻尼 N·s/m
  chassisMass: number; // 车身质量 kg
}

export const DEFAULT_PARAMS: SimParams = {
  stiffness: 30000,
  damping: 2600,
  chassisMass: 800,
};

export interface Sim {
  world: World;
  chassis: Body;
  wheels: [Body, Body];       // [左(后/驱动), 右(前)]
  joints: [WheelJoint, WheelJoint];
  terrainPts: Vec2[];
  heightAt: (x: number) => number;
  terrain: TerrainKind;
  params: SimParams;
  time: number;
  drive: DriveMode;
}

// ---- 地形 ----
export function heightAt(kind: TerrainKind, x: number): number {
  switch (kind) {
    case 'flat':
      return 0;
    case 'slopes':
      // 连续缓坡：最大坡度约 3°
      return 0.9 * Math.sin(0.05 * x) + 0.5 * Math.sin(0.013 * x + 1.7);
    case 'bump': {
      // 单个凸起：x∈[18,21]，高 0.28m 的半正弦包
      if (x >= 18 && x <= 21) return 0.28 * Math.sin((Math.PI * (x - 18)) / 3);
      return 0;
    }
  }
}

function buildTerrain(kind: TerrainKind): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = -60; x <= 500; x += 0.25) {
    pts.push(new Vec2(x, heightAt(kind, x)));
  }
  return pts;
}

// ---- 参数映射：k/c -> WheelJoint 的 frequencyHz / dampingRatio ----
// Box2D WheelJoint 的弹簧按关节约化质量 μ 定义：k = μ·ω²。
// μ 由车身/车轮质量与锚点几何决定（含车身转动惯量项），这里解析求出，
// 使用户设置的 k、c 就是弹簧力 F = -k·x - c·ẋ 里的真实系数。
function reducedMass(p: SimParams): number {
  const mC = p.chassisMass;
  const iC = (mC * (4 * CHASSIS_HW * CHASSIS_HW + 4 * CHASSIS_HH * CHASSIS_HH)) / 12;
  const invMu = 1 / mC + 1 / WHEEL_MASS + (ANCHOR_DX * ANCHOR_DX) / iC;
  return 1 / invMu;
}

export function springFromParams(p: SimParams): { frequencyHz: number; dampingRatio: number } {
  const mu = reducedMass(p);
  const omega = Math.sqrt(p.stiffness / mu);
  return {
    frequencyHz: Math.max(0.1, omega / (2 * Math.PI)),
    dampingRatio: Math.min(2, Math.max(0.02, p.damping / (2 * Math.sqrt(p.stiffness * mu)))),
  };
}

// 平地静止时的理论压缩量（每轮）：m_s * g / k
export function staticCompression(p: SimParams): number {
  return (p.chassisMass / 2) * GRAVITY / p.stiffness;
}

function makeWheelJoint(
  chassis: Body, wheel: Body, params: SimParams,
): WheelJoint {
  const { frequencyHz, dampingRatio } = springFromParams(params);
  const joint = new WheelJoint(
    {
      enableMotor: true,
      motorSpeed: 0,
      maxMotorTorque: 0,
      frequencyHz,
      dampingRatio,
      // 注：planck 的 WheelJoint 不带内建行程限位，
      // 最大压缩/伸展由 enforceTravelLimits() 以硬止挡方式强制执行。
    },
    chassis,
    wheel,
    wheel.getPosition(),
    new Vec2(0, 1), // 轴沿车身竖直方向，平移为正 = 压缩
  );
  return joint;
}

export function createSim(params: SimParams, terrain: TerrainKind): Sim {
  const world = new World({ gravity: new Vec2(0, -GRAVITY) });

  const terrainPts = buildTerrain(terrain);
  const ground = world.createBody();
  ground.createFixture(new Chain(terrainPts, false), { friction: 0.9 });

  // 落车初始位置：轮底离地 DROP_HEIGHT，两次重置完全一致
  const wheelY = (dx: number) =>
    heightAt(terrain, SPAWN_X + dx) + WHEEL_RADIUS + DROP_HEIGHT;
  const chassisY = Math.max(wheelY(-ANCHOR_DX), wheelY(ANCHOR_DX)) - ANCHOR_DY;

  const chassis = world.createBody({
    type: 'dynamic',
    position: new Vec2(SPAWN_X, chassisY),
  });
  chassis.createFixture(new Box(CHASSIS_HW, CHASSIS_HH), {
    density: params.chassisMass / (4 * CHASSIS_HW * CHASSIS_HH),
    friction: 0.3,
  });

  const mkWheel = (dx: number): Body => {
    const w = world.createBody({
      type: 'dynamic',
      position: new Vec2(SPAWN_X + dx, chassisY + ANCHOR_DY),
    });
    w.createFixture(new Circle(WHEEL_RADIUS), {
      density: WHEEL_MASS / (Math.PI * WHEEL_RADIUS * WHEEL_RADIUS),
      friction: 1.2,
    });
    return w;
  };
  const wheels: [Body, Body] = [mkWheel(-ANCHOR_DX), mkWheel(ANCHOR_DX)];

  const joints: [WheelJoint, WheelJoint] = [
    world.createJoint(makeWheelJoint(chassis, wheels[0], params)) as WheelJoint,
    world.createJoint(makeWheelJoint(chassis, wheels[1], params)) as WheelJoint,
  ];

  return {
    world, chassis, wheels, joints, terrainPts,
    heightAt: (x) => heightAt(terrain, x),
    terrain, params: { ...params }, time: 0, drive: 'coast',
  };
}

// 运行中改参数：只改弹簧系数与车身密度，下一步即按新参数计算，
// 物理状态（位置/速度）不变，不残留任何上一组参数的力。
export function applyParams(sim: Sim, params: SimParams): void {
  sim.params = { ...params };
  const { frequencyHz, dampingRatio } = springFromParams(params);
  for (const j of sim.joints) {
    j.setSpringFrequencyHz(frequencyHz);
    j.setSpringDampingRatio(dampingRatio);
  }
  const fixture = sim.chassis.getFixtureList();
  if (fixture) {
    fixture.setDensity(params.chassisMass / (4 * CHASSIS_HW * CHASSIS_HH));
    sim.chassis.resetMassData();
  }
}

export function setDrive(sim: Sim, mode: DriveMode): void {
  sim.drive = mode;
}

function applyDrive(sim: Sim): void {
  // 后轮（左轮）驱动
  const joint = sim.joints[0];
  const vx = sim.chassis.getLinearVelocity().x;
  switch (sim.drive) {
    case 'forward':
      if (vx < MAX_SPEED) {
        joint.enableMotor(true);
        joint.setMotorSpeed(-DRIVE_SPEED / WHEEL_RADIUS);
        joint.setMaxMotorTorque(800);
      } else {
        joint.enableMotor(false); // 限速：超过样例速度上限则停止驱动
      }
      break;
    case 'reverse':
      if (vx > -MAX_SPEED / 2) {
        joint.enableMotor(true);
        joint.setMotorSpeed((DRIVE_SPEED * 0.5) / WHEEL_RADIUS);
        joint.setMaxMotorTorque(500);
      } else {
        joint.enableMotor(false);
      }
      break;
    case 'brake':
      joint.enableMotor(true);
      joint.setMotorSpeed(0);
      joint.setMaxMotorTorque(1500);
      break;
    case 'coast':
      joint.enableMotor(false); // 无驱动滑行
      break;
  }
}

export function step(sim: Sim, dt: number = FIXED_DT): void {
  applyDrive(sim);
  sim.world.step(dt);
  enforceTravelLimits(sim);
  sim.time += dt;
}

// 悬挂硬止挡：把平移量钳制在 [-TRAVEL, TRAVEL] 内。
// 位置修正与法向速度冲量都按质量比在车轮与车身间分配（动量守恒），
// 因此越过凸起时悬挂不会超行程，也不会与车身脱开。
function enforceTravelLimits(sim: Sim): void {
  for (let i = 0; i < 2; i++) {
    const joint = sim.joints[i];
    const t = joint.getJointTranslation();
    const clamped = Math.max(-TRAVEL, Math.min(TRAVEL, t));
    if (t === clamped) continue;

    const chassis = sim.chassis;
    const wheel = sim.wheels[i];
    const axis = chassis.getWorldVector(new Vec2(0, 1)); // 单位向量，指向压缩方向
    const mW = wheel.getMass();
    const mC = chassis.getMass();
    const err = t - clamped; // 超出量（带符号）

    // 位置修正：按质量比分摊
    const wp = wheel.getPosition();
    const cp = chassis.getPosition();
    const wShare = mC / (mW + mC);
    const cShare = mW / (mW + mC);
    wheel.setPosition(new Vec2(wp.x - err * axis.x * wShare, wp.y - err * axis.y * wShare));
    chassis.setPosition(new Vec2(cp.x + err * axis.x * cShare, cp.y + err * axis.y * cShare));

    // 速度修正：若仍在向限位深处运动，则沿轴消除相对速度（非弹性止挡）
    const rel = joint.getJointSpeed();
    if ((t > TRAVEL && rel > 0) || (t < -TRAVEL && rel < 0)) {
      const vW = wheel.getLinearVelocity();
      const vC = chassis.getLinearVelocity();
      wheel.setLinearVelocity(new Vec2(
        vW.x - rel * axis.x * wShare, vW.y - rel * axis.y * wShare));
      chassis.setLinearVelocity(new Vec2(
        vC.x + rel * axis.x * cShare, vC.y + rel * axis.y * cShare));
    }
  }
}

// 悬挂压缩量（m），正值 = 压缩，负值 = 伸展
export function getCompression(sim: Sim, i: 0 | 1): number {
  return sim.joints[i].getJointTranslation();
}

export function wheelInContact(sim: Sim, i: 0 | 1): boolean {
  for (let ce = sim.wheels[i].getContactList(); ce; ce = ce.next) {
    if (ce.contact.isTouching()) return true;
  }
  return false;
}

export function getSpeed(sim: Sim): number {
  return sim.chassis.getLinearVelocity().x;
}
