/**
 * 应用状态: 场景参数、时间轴、检查区间与扫描结果的单一数据源。
 * 姿态只由归一化时刻 t 决定, 与播放速度/帧率无关; 任何参数变更都重扫碰撞。
 */
import { getPose, rad, type Mechanism, type Sequence } from '../core/kinematics';
import {
  type CollisionEvent,
  type LiveContact,
  type ObstacleSpec,
  contactsAt,
  scanCollisions,
} from '../core/collision';
import {
  ALL_SCENARIOS,
  type Scenario,
  cloneScenario,
  getScenario,
} from '../core/scenarios';
import type { Vec3 } from '../core/math3d';

export interface AppState {
  scenarioId: string;
  scenarioName: string;
  mechanism: Mechanism;
  obstacles: ObstacleSpec[];
  /** 当前归一化时刻 */
  t: number;
  /** 检查区间 (碰撞扫描与扫掠体都只覆盖该区间) */
  range: [number, number];
  playing: boolean;
  /** 播放速度, 全程用时秒数 (只影响播放, 不影响姿态-时刻映射) */
  cycleSeconds: number;
  /** 扫掠体采样数 */
  sweepSamples: number;
  contactTol: number;
  grazingTol: number;
  scanSteps: number;
  showSweep: boolean;
  selectedObstacleId: string | null;
  events: CollisionEvent[];
  liveContacts: LiveContact[];
}

export type Listener = (s: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initialId = ALL_SCENARIOS[0].id) {
    const sc = getScenario(initialId);
    this.state = this.freshState(sc);
    this.rescan();
  }

  private freshState(sc: Scenario): AppState {
    return {
      scenarioId: sc.id,
      scenarioName: sc.name,
      mechanism: sc.mechanism,
      obstacles: sc.obstacles,
      t: 0,
      range: [...sc.initialRange] as [number, number],
      playing: false,
      cycleSeconds: 6,
      sweepSamples: 60,
      contactTol: 1,
      grazingTol: 1,
      scanSteps: 1200,
      showSweep: true,
      selectedObstacleId: null,
      events: [],
      liveContacts: [],
    };
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** 重新扫描碰撞并刷新当前姿态接触; 所有几何参数变更后调用 */
  rescan(): void {
    const s = this.state;
    const result = scanCollisions(s.mechanism, s.obstacles, {
      range: s.range,
      steps: s.scanSteps,
      contactTol: s.contactTol,
      grazingTol: s.grazingTol,
    });
    s.events = result.events;
    s.liveContacts = contactsAt(
      s.mechanism,
      s.obstacles,
      s.t,
      s.contactTol,
      s.grazingTol,
    );
    this.emit();
  }

  loadScenario(id: string): void {
    const sc = getScenario(id);
    this.state = this.freshState(sc);
    this.rescan();
  }

  setT(t: number): void {
    const s = this.state;
    s.t = Math.max(0, Math.min(1, t));
    s.liveContacts = contactsAt(
      s.mechanism,
      s.obstacles,
      s.t,
      s.contactTol,
      s.grazingTol,
    );
    this.emit();
  }

  setRange(range: [number, number]): void {
    const lo = Math.max(0, Math.min(range[0], range[1]));
    const hi = Math.min(1, Math.max(range[0], range[1]));
    this.state.range = [lo, hi];
    if (this.state.t < lo || this.state.t > hi) {
      this.state.t = Math.max(lo, Math.min(hi, this.state.t));
    }
    this.rescan();
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
    this.emit();
  }

  setCycleSeconds(sec: number): void {
    this.state.cycleSeconds = Math.max(0.5, sec);
    this.emit();
  }

  setShowSweep(v: boolean): void {
    this.state.showSweep = v;
    this.emit();
  }

  setSweepSamples(n: number): void {
    this.state.sweepSamples = Math.max(4, Math.min(240, Math.round(n)));
    this.emit();
  }

  setTolerance(contactTol: number, grazingTol: number): void {
    this.state.contactTol = Math.max(0, contactTol);
    this.state.grazingTol = Math.max(0, grazingTol);
    this.rescan();
  }

  setSequence(seq: Sequence): void {
    this.state.mechanism.sequence = seq;
    this.rescan();
  }

  setDoorAngleRange(degStart: number, degEnd: number): void {
    this.state.mechanism.door.angleRange = [rad(degStart), rad(degEnd)];
    this.rescan();
  }

  setTrayAngleRange(degStart: number, degEnd: number): void {
    this.state.mechanism.tray.angleRange = [rad(degStart), rad(degEnd)];
    this.rescan();
  }

  setDoorPivot(p: Vec3): void {
    this.state.mechanism.door.pivot = [...p] as Vec3;
    this.rescan();
  }

  selectObstacle(id: string | null): void {
    this.state.selectedObstacleId = id;
    this.emit();
  }

  moveObstacle(id: string, center: Vec3): void {
    const o = this.state.obstacles.find((x) => x.id === id);
    if (!o) return;
    o.center = [...center] as Vec3;
    this.rescan();
  }

  setObstacleSize(id: string, size: Vec3): void {
    const o = this.state.obstacles.find((x) => x.id === id);
    if (!o) return;
    o.size = [...size] as Vec3;
    this.rescan();
  }

  addObstacle(): void {
    const n = this.state.obstacles.length + 1;
    this.state.obstacles.push({
      id: `obs-user-${Date.now()}`,
      name: `障碍${n}`,
      center: [200, 0, 300],
      size: [120, 300, 120],
    });
    this.rescan();
  }

  removeObstacle(id: string): void {
    this.state.obstacles = this.state.obstacles.filter((o) => o.id !== id);
    if (this.state.selectedObstacleId === id) this.state.selectedObstacleId = null;
    this.rescan();
  }

  /** 导出/回跳共用: 由事件时刻回到同一姿态 */
  jumpToT(t: number): void {
    this.setT(t);
  }

  currentPose() {
    return getPose(this.state.mechanism, this.state.t);
  }

  snapshotScenario(): Scenario {
    const s = this.state;
    return cloneScenario({
      id: s.scenarioId,
      name: s.scenarioName,
      description: '',
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      initialRange: s.range,
    });
  }
}
