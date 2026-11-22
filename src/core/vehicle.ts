import { type Pose, type Vec2, dist } from './geometry.ts';
import {
  type PortId,
  type TrackNetwork,
  portA,
  portB,
  splitPort,
} from './network.ts';
import {
  type BranchChoice,
  type ExitDecision,
  type FlipExplanation,
  type SwitchState,
  explainBranchFlip,
  resolveExit,
} from './switch.ts';

/**
 * 车辆模拟。
 *
 * 速度模型 (需求 2):
 * - 车辆状态里的 s 是 "沿轨段的弧长 (world unit)"。每帧 s += v * dt。
 * - 车辆按弧长前进, 与轨段的参数取值 (line 的长度、arc 的半径/扫角) 无关。
 * - 跨越节点时剩余弧长结转给下一段 (carry-over), 所以段长、曲率不同不会产生
 *   "这段走得快、那段走得慢" 的现象。const 速度由 settings.speed 决定。
 *
 * 故障安全 (需求 4):
 * - 每帧开始时若网络存在 error (断开/非法转角), 立即进入 braking, 以固定减速度
 *   减速; 制动期间不允许越过节点入口, 最多停在节点边缘。
 * - 正常行驶到节点时, 若该转接角超限, 同样停在节点入口并记 fault。
 * - 节点没有驶出段 => 正常停站 (finished)。
 */

export const DEFAULT_SPEED = 150; // world units / s
export const BRAKE_DECEL = 320; // world units / s²

export type VehicleStatus = 'idle' | 'running' | 'braking' | 'stopped' | 'finished';

export interface LegRecord {
  segmentId: string;
  startOdo: number;
  endOdo: number;
  length: number;
  /** 从哪个节点驶入该段。 */
  viaNodeId: string | null;
  /** 该次通过分叉时使用的道岔位置。 */
  viaChoice: BranchChoice | null;
  completed: boolean;
}

export type SimEventKind = 'enter' | 'exit' | 'switch' | 'fault' | 'stop' | 'finish' | 'start' | 'blocked';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  message: string;
}

export interface SimulationSettings {
  speed: number;
  brakeDecel: number;
}

export interface VehicleSummary {
  segmentId: string;
  s: number;
  segmentLength: number;
  odometer: number;
  speed: number;
  status: VehicleStatus;
  pose: Pose;
  next: ExitDecision | null;
  fault: string | null;
  elapsed: number;
}

export interface BranchStatus {
  /** 车辆正驶向该节点 (当前段末端就是它) 且尚未到达。 */
  approaching: boolean;
  /** 距节点入口的剩余弧长。 */
  remaining: number;
  /** 车辆已从该节点驶出 => 本次选择已锁定; 值为提交的出射端口。 */
  committedPort: PortId | null;
  /** 该节点最近一次通过记录 (端口 + 道岔位置 + 里程)。 */
  lastPass: { port: PortId; choice: BranchChoice; odometer: number } | null;
}

export class VehicleSim {
  network: TrackNetwork;
  switches: Map<string, SwitchState>;
  settings: SimulationSettings;

  segmentId: string;
  s: number;
  speed: number;
  status: VehicleStatus = 'idle';
  odometer = 0;
  elapsed = 0;
  legs: LegRecord[] = [];
  events: SimEvent[] = [];
  lastDecision: ExitDecision | null = null;
  /** 每个节点最近一次被通过的记录, 用于解释 "本次已锁定"。 */
  lastPass: Map<string, { port: PortId; choice: BranchChoice; odometer: number }> = new Map();
  faultReason: string | null = null;

  constructor(
    network: TrackNetwork,
    switches: Map<string, SwitchState>,
    settings: SimulationSettings = { speed: DEFAULT_SPEED, brakeDecel: BRAKE_DECEL },
  ) {
    this.network = network;
    this.switches = switches;
    this.settings = settings;
    this.segmentId = network.start.segmentId;
    this.s = network.start.s;
    this.speed = 0;
    this.resetLegs();
  }

  private resetLegs(): void {
    const seg = this.network.segments.get(this.segmentId);
    this.legs = [
      {
        segmentId: this.segmentId,
        startOdo: 0,
        endOdo: 0,
        length: seg?.length ?? 0,
        viaNodeId: this.network.entryNodeOf(this.segmentId) ?? null,
        viaChoice: null,
        completed: false,
      },
    ];
  }

  get segment() {
    return this.network.segments.get(this.segmentId);
  }

  get pose(): Pose {
    const seg = this.segment;
    if (!seg) return { pos: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
    return seg.poseAtS(this.s);
  }

  get hasTrack(): boolean {
    return this.segment !== undefined;
  }

  get currentLeg(): LegRecord {
    return this.legs[this.legs.length - 1]!;
  }

  get remaining(): number {
    const seg = this.segment;
    return seg ? Math.max(0, seg.length - this.s) : 0;
  }

  start(): boolean {
    if (this.status === 'running' || this.status === 'braking') return false;
    if (!this.segment) {
      this.status = 'stopped';
      this.faultReason = '画布上没有轨段, 先画一条轨道再发车';
      this.emit('blocked', this.faultReason);
      return false;
    }
    if (this.network.isBlocked()) {
      this.status = 'stopped';
      this.faultReason = this.network.errors[0]?.message ?? '网络校验未通过';
      this.emit('blocked', `无法发车: ${this.faultReason}`);
      return false;
    }
    this.status = 'running';
    this.speed = this.settings.speed;
    this.faultReason = null;
    this.emit('start', `发车, 恒定线速度 ${this.settings.speed.toFixed(0)} 单位/秒`);
    return true;
  }

  pause(): void {
    if (this.status === 'running') {
      this.status = 'stopped';
      this.speed = 0;
      this.emit('stop', '手动暂停');
    }
  }

  setSpeed(speed: number): void {
    this.settings.speed = Math.max(1, speed);
    if (this.status === 'running') this.speed = this.settings.speed;
  }

  reset(): void {
    this.segmentId = this.network.start.segmentId;
    this.s = this.network.start.s;
    this.speed = 0;
    if (!this.segment) {
      this.status = 'idle';
      this.odometer = 0;
      this.elapsed = 0;
      this.lastDecision = null;
      this.lastPass = new Map();
      this.faultReason = null;
      this.events = [];
      this.legs = [];
      return;
    }
    this.speed = 0;
    this.status = 'idle';
    this.odometer = 0;
    this.elapsed = 0;
    this.lastDecision = null;
    this.lastPass = new Map();
    this.faultReason = null;
    this.events = [];
    this.resetLegs();
  }

  /** 轨段被编辑后替换网络; 保留车辆位置并重新做安全检查。 */
  rebind(network: TrackNetwork, switches: Map<string, SwitchState>): void {
    this.network = network;
    this.switches = switches;
    if (network.segments.size === 0) {
      this.segmentId = '';
      this.s = 0;
      this.speed = 0;
      this.status = 'stopped';
      this.faultReason = '画布上已没有轨段';
      this.legs = [];
      this.emit('fault', this.faultReason);
      return;
    }
    if (!network.segments.has(this.segmentId)) {
      this.segmentId = network.start.segmentId;
      this.s = network.start.s;
      this.speed = 0;
      this.status = 'stopped';
      this.faultReason = `当前轨段已被移除, 车辆退回起点段 ${this.segmentId}`;
      this.resetLegs();
      this.emit('fault', this.faultReason);
      return;
    }
    const seg = this.segment!;
    if (this.s > seg.length) {
      this.s = seg.length;
      this.speed = 0;
      this.status = 'stopped';
      this.faultReason = '轨段变短, 车辆被限制在段末';
      this.emit('fault', this.faultReason);
    }
    this.currentLeg.length = seg.length;
    if (network.isBlocked()) {
      const msg = network.errors[0]?.message ?? '网络校验未通过';
      if (this.status === 'running') {
        this.beginBrake(`轨段编辑后校验失败: ${msg}`);
      } else if (this.status !== 'braking') {
        this.status = 'stopped';
        if (this.faultReason === null) this.faultReason = msg;
        this.emit('blocked', `停车中, 校验失败: ${msg}`);
      }
      return;
    }
    // 网络已修好: 清故障提示, 但保持停车, 由用户再次发车。
    if (this.status === 'braking' || this.status === 'stopped') {
      this.speed = 0;
      this.faultReason = null;
      this.emit('blocked', '网络校验通过, 可重新发车');
    }
  }

  /**
   * 道岔切换 (需求 3)。返回解释文本。
   */
  setSwitch(nodeId: string, choice: BranchChoice): FlipExplanation {
    const sw = this.switches.get(nodeId);
    if (!sw) return { affectsCurrentPass: false, message: `节点 ${nodeId} 没有道岔` };
    if (!sw.switchable) return { affectsCurrentPass: false, message: `节点 ${nodeId} 不是分叉, 无可切换方向` };
    const from = sw.choice;
    if (from === choice) {
      return {
        affectsCurrentPass: false,
        message: `道岔 ${nodeId} 已在${choice === 'alternate' ? '备选' : '主'}位, 无需切换`,
      };
    }
    const status = this.branchStatus(nodeId);
    sw.choice = choice;
    const explanation = explainBranchFlip({
      nodeId,
      approaching: status.approaching,
      remainingToNode: status.remaining,
      committedPort: status.committedPort,
      from,
      to: choice,
    });
    this.emit('switch', explanation.message);
    return explanation;
  }

  /** 车辆相对某节点的状态, 用于判断切换是 "已进" 还是 "未进"。 */
  branchStatus(nodeId: string): BranchStatus {
    const exitNode = this.network.exitNodeOf(this.segmentId);
    // 只要还在驶向该节点的段上 (含暂停/制动中), 都算 "未进节点"; 恢复行驶后切换仍会生效。
    // finished 表示已在该节点停站 (且该节点无出射), 不再算 "将驶向"。
    const approaching = exitNode === nodeId && this.status !== 'finished';
    if (approaching) {
      return { approaching: true, remaining: this.remaining, committedPort: null, lastPass: this.lastPass.get(nodeId) ?? null };
    }
    // 已驶离: 当前段的 A 端若正是该节点, 用当前段入口作为本次提交;
    // 否则用该节点最近一次通过的记录 (车辆可能已经开出好几段)。
    const entryNode = this.network.entryNodeOf(this.segmentId);
    const committedPort = entryNode === nodeId ? portA(this.segmentId) : (this.lastPass.get(nodeId)?.port ?? null);
    return {
      approaching: false,
      remaining: this.remaining,
      committedPort,
      lastPass: this.lastPass.get(nodeId) ?? null,
    };
  }

  /** 预览当前段末的下一段选择。 */
  previewExit(preferChoice?: BranchChoice): ExitDecision | null {
    return resolveExit(this.network, this.switches, this.segmentId, preferChoice);
  }

  /** 当前段末的转接是否合法; 返回 null 表示合法或没有出射。 */
  private transitionError(nodeId: string): string | null {
    const junction = this.network.junctions.get(nodeId);
    if (!junction) return `节点 ${nodeId} 不存在`;
    if (junction.outgoing.length === 0) return null; // 正常终点
    const decision = resolveExit(this.network, this.switches, this.segmentId);
    if (!decision || !decision.ok) return `节点 ${nodeId} 没有可用出射段`;
    const angle = this.network.transitionAngle(this.segmentId, decision.segmentId);
    if (angle === null) return `节点 ${nodeId} 目标段 ${decision.segmentId} 不存在`;
    const limit = this.network.transitionLimitDeg(nodeId);
    if (angle > limit + 1e-9) {
      return `节点 ${nodeId} 非法转角 ${angle.toFixed(1)}° (${this.segmentId} -> ${decision.segmentId}, 上限 ${limit.toFixed(0)}°)`;
    }
    return null;
  }

  private beginBrake(reason: string): void {
    if (this.status !== 'braking') {
      this.status = 'braking';
      this.faultReason = reason;
      this.emit('fault', reason);
    }
  }

  private emit(kind: SimEventKind, message: string): void {
    this.events.push({ t: this.elapsed, kind, message });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
  }

  /**
   * 推进 dt 秒, 返回本次产生的新事件。
   */
  step(dt: number): SimEvent[] {
    const before = this.events.length;
    if (dt <= 0) return [];
    if (this.status !== 'running' && this.status !== 'braking') return [];
    this.elapsed += dt;

    // 故障安全: 网络层任何 error 先制动。
    if (this.status === 'running' && this.network.isBlocked()) {
      this.beginBrake(`网络校验失败: ${this.network.errors[0]?.message ?? '未知错误'}`);
    }

    let budget: number;
    if (this.status === 'braking') {
      const v0 = this.speed;
      const v1 = Math.max(0, v0 - this.settings.brakeDecel * dt);
      budget = ((v0 + v1) / 2) * dt;
      this.speed = v1;
    } else {
      this.speed = this.settings.speed;
      budget = this.speed * dt;
    }

    let guard = 0;
    while (budget > 1e-9 && guard < 128) {
      guard += 1;
      const seg = this.segment;
      if (!seg) {
        this.status = 'stopped';
        this.faultReason = '当前轨段不存在';
        break;
      }
      const remain = Math.max(0, seg.length - this.s);

      if (budget < remain) {
        this.s += budget;
        this.odometer += budget;
        this.currentLeg.endOdo = this.odometer;
        budget = 0;
        break;
      }

      // 到达段末: 判断能否通过节点。
      const nodeId = this.network.exitNodeOf(this.segmentId);
      if (!nodeId) {
        this.s = seg.length;
        this.odometer += remain;
        this.currentLeg.endOdo = this.odometer;
        this.speed = 0;
        this.status = 'stopped';
        this.faultReason = `轨段 ${this.segmentId} 末端未连接, 车辆停在线路尽头`;
        this.emit('fault', this.faultReason);
        budget = 0;
        break;
      }

      // 制动中禁止越过节点入口。
      if (this.status === 'braking') {
        this.s = seg.length;
        this.odometer += remain;
        this.currentLeg.endOdo = this.odometer;
        this.speed = 0;
        this.status = 'stopped';
        this.emit('stop', `制动完成于节点 ${nodeId} 入口, 未进入节点`);
        budget = 0;
        break;
      }

      const transitionError = this.transitionError(nodeId);
      if (transitionError) {
        this.s = seg.length;
        this.odometer += remain;
        this.currentLeg.endOdo = this.odometer;
        this.speed = 0;
        this.status = 'stopped';
        this.faultReason = transitionError;
        this.emit('fault', `车辆停在节点 ${nodeId} 入口: ${transitionError}`);
        budget = 0;
        break;
      }

      const decision = resolveExit(this.network, this.switches, this.segmentId);
      if (!decision) {
        this.s = seg.length;
        this.odometer += remain;
        this.currentLeg.endOdo = this.odometer;
        this.speed = 0;
        this.status = 'stopped';
        this.faultReason = `节点 ${nodeId} 无有效出射`;
        this.emit('stop', this.faultReason);
        budget = 0;
        break;
      }
      if (!decision.ok) {
        this.s = seg.length;
        this.odometer += remain;
        this.currentLeg.endOdo = this.odometer;
        this.currentLeg.completed = true;
        this.speed = 0;
        this.status = 'finished';
        this.emit('finish', `到达节点 ${nodeId}: ${decision.reason}`);
        budget = 0;
        break;
      }

      // 提交本次选择并结转剩余弧长。
      budget -= remain;
      this.odometer += remain;
      this.s = seg.length;
      this.currentLeg.endOdo = this.odometer;
      this.currentLeg.completed = true;
      this.emit('exit', `驶离 ${this.segmentId} -> 节点 ${nodeId} (${decision.reason})`);

      this.lastPass.set(nodeId, {
        port: decision.port,
        choice: decision.isBranch ? decision.choice : 'primary',
        odometer: this.odometer,
      });
      this.segmentId = decision.segmentId;
      this.s = 0;
      this.lastDecision = decision;
      const nextSeg = this.segment;
      if (!nextSeg) {
        this.status = 'stopped';
        this.faultReason = `目标轨段 ${decision.segmentId} 不存在`;
        this.emit('fault', this.faultReason);
        budget = 0;
        break;
      }
      this.legs.push({
        segmentId: this.segmentId,
        startOdo: this.odometer,
        endOdo: this.odometer,
        length: nextSeg.length,
        viaNodeId: nodeId,
        viaChoice: decision.isBranch ? decision.choice : null,
        completed: false,
      });
      this.emit('enter', `进入 ${this.segmentId} (经 ${nodeId})`);
    }

    if (this.status === 'braking' && this.speed <= 1e-6) {
      this.speed = 0;
      this.status = 'stopped';
      this.emit('stop', `已安全制动, 原因: ${this.faultReason ?? '未知'}`);
    }

    return this.events.slice(before);
  }

  /** 已完成的实际行程 (按段)。 */
  completedRoute(): Array<{
    segmentId: string;
    length: number;
    viaNodeId: string | null;
    viaChoice: BranchChoice | null;
  }> {
    return this.legs
      .filter((l) => l.completed)
      .map((l) => ({
        segmentId: l.segmentId,
        length: l.length,
        viaNodeId: l.viaNodeId,
        viaChoice: l.viaChoice,
      }));
  }

  /** 当前所在 (未完成) 段摘要。 */
  activeLeg(): { segmentId: string; length: number; progress: number; viaNodeId: string | null } {
    const seg = this.segment;
    return {
      segmentId: this.segmentId,
      length: seg?.length ?? 0,
      progress: this.s,
      viaNodeId: this.currentLeg.viaNodeId,
    };
  }

  summary(): VehicleSummary {
    return {
      segmentId: this.segmentId,
      s: this.s,
      segmentLength: this.segment?.length ?? 0,
      odometer: this.odometer,
      speed: this.speed,
      status: this.status,
      pose: this.pose,
      next: this.previewExit(),
      fault: this.faultReason,
      elapsed: this.elapsed,
    };
  }

  near(pos: Vec2, radius = 20): boolean {
    return dist(this.pose.pos, pos) <= radius;
  }

  currentJunctions(): { entry: string | undefined; exit: string | undefined } {
    return {
      entry: this.network.entryNodeOf(this.segmentId),
      exit: this.network.exitNodeOf(this.segmentId),
    };
  }

  /** 仅测试/调试用: 当前段两端的端口。 */
  currentPorts(): { a: PortId; b: PortId } {
    return { a: portA(this.segmentId), b: portB(this.segmentId) };
  }

  /** 仅测试/调试用。 */
  static describePort(port: PortId): { segmentId: string; end: 'A' | 'B' } {
    return splitPort(port);
  }
}
