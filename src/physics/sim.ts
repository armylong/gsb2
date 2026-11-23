// 纸片滑翔仿真核心。
// 关键设计：物理以固定步长 FIXED_DT 推进，渲染帧率只决定每帧取多少步，
// 因此改绘制帧率、切后台再回来，落点与失速时刻都一致（确定性）。
import {
  Vec2,
  add,
  clamp,
  deg2rad,
  dot,
  fromAngle,
  len,
  normalize,
  rad2deg,
  scale,
  sub,
  wrapAngle,
} from './vec';
import {
  Contact,
  TerrainSeg,
  buildSegments,
  deepestContact,
  groundHeightAt,
} from './terrain';
import { CrosswindConfig, DEFAULT_CROSSWIND, DEFAULT_THERMAL, ThermalConfig, sampleWind } from './wind';

export const FIXED_DT = 0.01; // 固定物理步长（秒）
const GRAVITY = 9.81;

export interface SimParams {
  mass: number; // 纸片质量（kg）
  radius: number; // 碰撞圆半径（米）
  wingArea: number; // 纸片参考面积 S（米²）
  liftSlope: number; // 升力线斜率 dCL/dα（1/弧度），小迎角时 CL = liftSlope * α
  cd0: number; // 零升阻力系数
  cdInduced: number; // 诱导阻力系数（乘 α²）
  alphaCriticalDeg: number; // 失速临界迎角（度）
  stallHoldTime: number; // 进入/退出失速需要维持的时间（秒），防止临界点抖动
  recoveryAirspeed: number; // 退出失速要求的最小空速（米/秒）
  pitchRate: number; // 手动/脚本俯仰角速度（度/秒）
  pitchMinDeg: number;
  pitchMaxDeg: number;
  maxGroundSpeed: number; // 低于该速度且接地判为停住（米/秒）
  hardLandingSpeed: number; // 法向冲击超过该速度判为硬着陆（米/秒）
  restitution: number; // 地面反弹系数
  friction: number; // 地面切向摩擦保留比例
  contactCooldown: number; // 同段接触事件最小间隔（秒）
}

const AIR_DENSITY = 1.225;

export const DEFAULT_PARAMS: SimParams = {
  mass: 0.08,
  radius: 1.4,
  wingArea: 0.22,
  liftSlope: 3.2,
  cd0: 0.035,
  cdInduced: 1.1,
  alphaCriticalDeg: 18,
  stallHoldTime: 0.25,
  recoveryAirspeed: 4.5,
  pitchRate: 60,
  pitchMinDeg: -60,
  pitchMaxDeg: 45,
  maxGroundSpeed: 0.6,
  hardLandingSpeed: 7.5,
  restitution: 0.12,
  friction: 0.55,
  contactCooldown: 0.3,
};

export interface LogEvent {
  t: number;
  type: 'stall-enter' | 'stall-exit' | 'contact' | 'hard-landing' | 'stop';
  message: string;
  readings: Record<string, number>;
}

export interface TrailPoint {
  t: number;
  x: number;
  y: number;
  stalled: boolean;
}

export interface GliderState {
  pos: Vec2;
  vel: Vec2; // 相对地面的速度
  pitch: number; // 俯仰角（弧度），0 = 水平，抬头为正
  alpha: number; // 迎角（弧度）
  airspeed: number; // 相对空气的速度大小
  groundSpeed: number; // 相对地面的速度大小
  wind: Vec2; // 当前位置的风
  velAir: Vec2; // 相对空气的速度
  stalled: boolean;
  grounded: boolean;
  stopped: boolean;
  simTime: number;
}

/** 固定操控样例：输入是仿真时间的函数，与渲染帧率无关 */
export interface Scenario {
  id: string;
  label: string;
  description: string;
  start: Vec2;
  startSpeed: number;
  startPitchDeg: number;
  /** 返回该时刻的俯仰指令：-1 压头 / 0 中立 / +1 抬头 */
  pitchCommand: (t: number) => number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'thermal-climb',
    label: '样例A：借暖气团爬升绕台',
    description: '压头进谷积累空速 → 暖气团中抬头爬升 → 跨侧风区压头 → 飘到着陆台',
    start: { x: 12, y: groundHeightAt(12) + 40 },
    startSpeed: 13,
    startPitchDeg: -6,
    pitchCommand: (t) => {
      // 时间窗按实际到达位置标定：t≈14s 到暖气团边缘(x≈88)。
      // 强上升气流会把迎角瞬间推高，进气流瞬间给一个很短的微压脉冲，随后保持中立由气流托起
      if (t < 14) return 0; // 中立滑翔，保持 5m/s 配平速度
      if (t < 14.6) return -0.3; // 短脉冲压头（约 -10°），抑制进气流时的迎角突增
      if (t < 24.5) return 0; // 气团核心保持姿态，靠上升气流爬升
      if (t < 25.4) return -0.3; // 出气团轻压一下保速
      if (t < 28.5) return 0.22; // 短而柔地拉回平飞
      if (t < 33) return -0.15; // 迎风区保持微俯冲：迎风会抬高迎角与空速，抬头容易失速
      if (t < 37) return 0; // 出侧风区后回到中立，靠自然滑翔率缓降
      if (t < 40.5) return 0.12; // 近台柔和抬头减速，做浅降（幅度小，避免拉失速）
      return -0.12; // 临台微压，避免拉飘
    },
  },
  {
    id: 'stall-recover',
    label: '样例B：故意拉失速再改出',
    description: '持续抬头越过临界迎角触发失速，随后压头、空速恢复后自动退出',
    start: { x: 12, y: groundHeightAt(12) + 40 },
    startSpeed: 13,
    startPitchDeg: -4,
    pitchCommand: (t) => {
      if (t < 2.2) return 1; // 持续抬头，越过临界迎角进入失速
      if (t < 8) return -1; // 压头俯冲，积累空速等待自动改出
      if (t < 13) return 0.4; // 改出后小幅抬头找回滑翔姿态
      return -0.2;
    },
  },
];

export class Simulation {
  params: SimParams;
  thermal: ThermalConfig;
  crosswind: CrosswindConfig;
  segs: TerrainSeg[];
  scenario: Scenario;

  pos: Vec2;
  vel: Vec2;
  pitch: number;
  stalled = false;
  grounded = false;
  stopped = false;
  simTime = 0;

  alpha = 0;
  airspeed = 0;
  groundSpeed = 0;
  wind: Vec2 = { x: 0, y: 0 };
  velAir: Vec2 = { x: 0, y: 0 };

  events: LogEvent[] = [];
  trail: TrailPoint[] = [];
  private stallTimer = 0; // >0 计“满足失速条件”的持续时间，<0 计“满足改出条件”
  private lastContactAt = new Map<string, number>();
  private stepIndex = 0;

  constructor(
    scenario: Scenario,
    params: SimParams = DEFAULT_PARAMS,
    thermal: ThermalConfig = DEFAULT_THERMAL,
    crosswind: CrosswindConfig = DEFAULT_CROSSWIND,
  ) {
    this.scenario = scenario;
    this.params = { ...params };
    this.thermal = { ...thermal };
    this.crosswind = { ...crosswind };
    this.segs = buildSegments();
    this.pos = { ...scenario.start };
    this.vel = fromAngle(deg2rad(scenario.startPitchDeg));
    this.vel = scale(this.vel, scenario.startSpeed);
    this.pitch = deg2rad(scenario.startPitchDeg);
    this.recordTrail();
  }

  /** 推进一段真实时间：内部按固定步长切分，剩余时间留到下次（accumulator 模式） */
  advance(realDt: number, maxSteps = 200): number {
    let budget = realDt;
    let steps = 0;
    while (budget >= FIXED_DT && steps < maxSteps && !this.stopped) {
      this.step(FIXED_DT);
      budget -= FIXED_DT;
      steps++;
    }
    return budget;
  }

  get state(): GliderState {
    return {
      pos: { ...this.pos },
      vel: { ...this.vel },
      pitch: this.pitch,
      alpha: this.alpha,
      airspeed: this.airspeed,
      groundSpeed: this.groundSpeed,
      wind: { ...this.wind },
      velAir: { ...this.velAir },
      stalled: this.stalled,
      grounded: this.grounded,
      stopped: this.stopped,
      simTime: this.simTime,
    };
  }

  private log(type: LogEvent['type'], message: string, readings: Record<string, number>) {
    this.events.push({ t: this.simTime, type, message, readings });
  }

  private step(dt: number) {
    const p = this.params;
    this.simTime += dt;
    this.stepIndex++;

    // 1. 俯仰控制（脚本输入是时间的确定性函数）
    if (!this.grounded) {
      const cmd = this.scenario.pitchCommand(this.simTime);
      this.pitch += deg2rad(p.pitchRate) * clamp(cmd, -1, 1) * dt;
      this.pitch = clamp(this.pitch, deg2rad(p.pitchMinDeg), deg2rad(p.pitchMaxDeg));
    }

    // 2. 风与空速（相对空气的速度 = 地速 - 风速）
    this.wind = sampleWind(this.pos, this.thermal, this.crosswind);
    this.velAir = sub(this.vel, this.wind);
    this.airspeed = len(this.velAir);
    this.groundSpeed = len(this.vel);

    // 3. 迎角：纸片弦线方向与来流方向之差
    const chord = fromAngle(this.pitch);
    let alpha = 0;
    if (this.airspeed > 0.5) {
      const flowDir = normalize(this.velAir);
      alpha = wrapAngle(Math.atan2(chord.y, chord.x) - Math.atan2(flowDir.y, flowDir.x));
    }
    this.alpha = alpha;
    const alphaDeg = rad2deg(alpha);

    // 4. 失速状态机：进入/退出都要维持 stallHoldTime，临界角附近不会逐帧抖动
    const wantStall = alphaDeg > p.alphaCriticalDeg || this.airspeed < 2.5;
    const canRecover = alphaDeg < p.alphaCriticalDeg - 3 && this.airspeed >= p.recoveryAirspeed;
    if (!this.stalled && wantStall) {
      this.stallTimer += dt;
      if (this.stallTimer >= p.stallHoldTime) {
        this.stalled = true;
        this.stallTimer = 0;
        this.log('stall-enter', '进入失速：抬头过度 / 空速不足', {
          t: this.simTime,
          alphaDeg,
          airspeed: this.airspeed,
          pitchDeg: rad2deg(this.pitch),
        });
      }
    } else if (this.stalled) {
      if (canRecover) {
        this.stallTimer += dt;
        if (this.stallTimer >= p.stallHoldTime) {
          this.stalled = false;
          this.stallTimer = 0;
          this.log('stall-exit', '退出失速：迎角与空速恢复', {
            t: this.simTime,
            alphaDeg,
            airspeed: this.airspeed,
            pitchDeg: rad2deg(this.pitch),
          });
        }
      } else {
        this.stallTimer = 0;
      }
    } else {
      this.stallTimer = 0;
    }

    // 5. 气动力：标准系数形式 L=CL·q·S、D=CD·q·S，q=½ρv²；失速后升力塌陷、阻力激增
    const force: Vec2 = { x: 0, y: -GRAVITY * p.mass };
    if (this.airspeed > 0.5) {
      const flowDir = normalize(this.velAir);
      const perp: Vec2 = { x: -flowDir.y, y: flowDir.x }; // 来流左转 90°
      const q = 0.5 * AIR_DENSITY * this.airspeed * this.airspeed;
      const ac = deg2rad(p.alphaCriticalDeg);
      let cl: number;
      let cd: number;
      if (!this.stalled) {
        cl = p.liftSlope * alpha;
        cd = p.cd0 + p.cdInduced * alpha * alpha;
      } else {
        // 失速：升力随超出临界迎角而塌陷到残余 18%；阻力按平板模型 sin²α 收敛并封顶，
        // 保证俯冲时终端空速能积累到改出阈值，而不是陷入无法改出的深度失速
        const clCrit = p.liftSlope * ac;
        const over = Math.max(0, Math.abs(alpha) - ac);
        cl = Math.sign(alpha) * clCrit * Math.max(0.18, 1 - over / ac);
        cd = 0.15 + 1.05 * Math.sin(2 * Math.abs(alpha)) ** 2;
      }
      const liftMag = cl * q * p.wingArea;
      const dragMag = cd * q * p.wingArea;
      force.x += perp.x * liftMag - flowDir.x * dragMag;
      force.y += perp.y * liftMag - flowDir.y * dragMag;
    }

    // 6. 半隐式欧拉积分
    this.vel = add(this.vel, scale(force, dt / p.mass));
    // 速度封顶：保证单步位移 ≤ 半径的 60%，配合子步扫掠，任何情况下都穿不过地形，
    // 同时把单步子步数限制在个位数，避免极端速度带来的性能爆炸（正常飞行 5~12m/s 远低于上限）
    const speed = len(this.vel);
    const speedCap = (p.radius * 0.6) / dt;
    if (speed > speedCap) this.vel = scale(this.vel, speedCap / speed);

    // 7. 扫掠碰撞：把本步位移按“不超过碰撞半径 60%”切成若干子步逐步检测，
    //    任意高速下每段位移都短于圆的直径，纸片不可能穿过地形线段
    this.grounded = false;
    this.resolveCollisions(scale(this.vel, dt), dt);

    // 8. 刷新读数并记录轨迹
    this.wind = sampleWind(this.pos, this.thermal, this.crosswind);
    this.velAir = sub(this.vel, this.wind);
    this.airspeed = len(this.velAir);
    this.groundSpeed = len(this.vel);
    if (this.stepIndex % 4 === 0) this.recordTrail();
  }

  /**
   * 扫掠碰撞解析：把位移 delta 细分为多个子步，每个子步先尝试移动再做静态圆-线段检测。
   * 子步长度上限为碰撞半径的 60%，因此无论速度多大都不会跨过地形线段。
   */
  private resolveCollisions(delta: Vec2, dt: number) {
    const p = this.params;
    const dist = len(delta);
    const maxStep = p.radius * 0.6;
    // 速度已封顶，正常情况下子步为 1~2 个；上限 8 仅作防御性兜底
    const subSteps = Math.min(8, Math.max(1, Math.ceil(dist / maxStep)));
    const step = scale(delta, 1 / subSteps);

    let firstContact: Contact | null = null;
    let hitNormalSpeed = 0;

    for (let s = 0; s < subSteps; s++) {
      this.pos = add(this.pos, step);
      let guard = 0;
      // 角点处可能同时压入两段，循环把所有穿透推出
      while (guard++ < 6) {
        const hit = deepestContact(this.pos, p.radius, this.segs);
        if (!hit) break;
        if (!firstContact) {
          firstContact = hit;
          hitNormalSpeed = Math.max(0, -dot(this.vel, hit.normal));
        }
        // 仅沿法线推出穿透量（作用在当前位置，不会再出现旧位置瞬移问题）
        this.pos = add(this.pos, scale(hit.normal, hit.depth + 1e-4));
        const vn = dot(this.vel, hit.normal);
        if (vn < 0) {
          const n = hit.normal;
          const normalComp = scale(n, vn);
          const tangentComp = sub(this.vel, normalComp);
          this.vel = add(scale(normalComp, -p.restitution), scale(tangentComp, p.friction));
        }
        this.grounded = true;
      }
    }

    if (firstContact) {
      this.handleContact(firstContact, hitNormalSpeed, dt);
    }

    // 停住判定：接地且总速度足够小
    if (this.grounded && len(this.vel) < p.maxGroundSpeed && !this.stopped) {
      // 反弹/摩擦后圆心可能只在“贴脸”距离，放大一点半径也要拿到所在段名
      const here = deepestContact(this.pos, p.radius * 1.5, this.segs);
      const segName = here ? here.seg.name : '未知地面';
      const finalSpeed = len(this.vel);
      const finalAirspeed = this.airspeed;
      this.vel = { x: 0, y: 0 };
      this.stopped = true;
      this.recordTrail();
      this.log('stop', `停住：碰到「${segName}」`, {
        t: this.simTime,
        x: this.pos.x,
        y: this.pos.y,
        groundSpeed: finalSpeed,
        airspeed: finalAirspeed,
      });
    }
  }

  private handleContact(contact: Contact, normalSpeed: number, _dt: number) {
    const p = this.params;
    const key = contact.seg.name;
    const last = this.lastContactAt.get(key) ?? -Infinity;
    const cooled = this.simTime - last > p.contactCooldown;

    if (normalSpeed >= p.hardLandingSpeed) {
      this.log('hard-landing', `硬着陆：撞向「${contact.seg.name}」`, {
        t: this.simTime,
        normalSpeed,
        groundSpeed: this.groundSpeed,
        x: contact.point.x,
        y: contact.point.y,
      });
      this.lastContactAt.set(key, this.simTime);
      return;
    }

    if (cooled) {
      // 掠过斜坡 / 蹭到平台边缘等接触事件
      const kindLabel =
        contact.seg.kind === 'platform-edge'
          ? '掠过平台边缘'
          : contact.seg.kind === 'slope'
            ? '掠过山坡斜坡'
            : contact.seg.kind === 'platform-top'
              ? '接触着陆台台面'
              : '接触地面';
      this.log('contact', `${kindLabel}：${contact.seg.name}`, {
        t: this.simTime,
        normalSpeed,
        groundSpeed: this.groundSpeed,
        x: contact.point.x,
        y: contact.point.y,
      });
      this.lastContactAt.set(key, this.simTime);
    }
  }

  private recordTrail() {
    this.trail.push({
      t: this.simTime,
      x: this.pos.x,
      y: this.pos.y,
      stalled: this.stalled,
    });
  }
}

/** 给渲染层用的风场采样网格 */
export function sampleWindGrid(
  nx: number,
  ny: number,
  thermal: ThermalConfig,
  cross: CrosswindConfig,
): { pos: Vec2; wind: Vec2 }[] {
  const out: { pos: Vec2; wind: Vec2 }[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const pos = {
        x: ((i + 0.5) / nx) * 300,
        y: ((j + 0.5) / ny) * 180,
      };
      const w = sampleWind(pos, thermal, cross);
      if (len(w) > 0.05) out.push({ pos, wind: w });
    }
  }
  return out;
}
