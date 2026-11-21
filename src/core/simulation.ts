import { CameraRig } from './camera.ts';
import { evalPath, type Scenario } from './scenario.ts';
import type { ActorState, CameraConfig, Snapshot, Vec2 } from './types.ts';

export const VIEWPORT_W = 960;
export const VIEWPORT_H = 600;

/**
 * 固定步长仿真: 整个系统只在 step() 里推进, 不碰墙钟与随机数,
 * 因此同一配置下单步、暂停、回放都有逐 tick 完全一致的结果。
 */
export class Simulation {
  readonly scenario: Scenario;
  readonly camera: CameraRig;
  readonly fps: number;
  readonly dt: number;

  t = 0;
  tick = 0;
  followIds: Set<string>;
  actorStates: Map<string, ActorState>;
  snapshots: Snapshot[] = [];

  constructor(scenario: Scenario, config: CameraConfig, fps: number, followIds?: string[]) {
    this.scenario = scenario;
    this.fps = fps;
    this.dt = 1 / fps;
    this.camera = new CameraRig(config, VIEWPORT_W, VIEWPORT_H);
    this.followIds = new Set(
      followIds ??
        scenario.actors.filter((a) => a.id !== 'C').map((a) => a.id),
    );
    this.actorStates = new Map();
    for (const a of scenario.actors) {
      const p = evalPath(a.path, 0, a.loop);
      this.actorStates.set(a.id, { id: a.id, x: p.x, y: p.y, dragging: false });
    }
    this.recordInitial(); // t=0: 相机直接对齐(snap), 首帧就在合法范围内
  }

  private actorWorldList() {
    return this.scenario.actors.map((a) => {
      const s = this.actorStates.get(a.id)!;
      return { id: a.id, x: s.x, y: s.y, radius: a.radius };
    });
  }

  /** t=0 首帧: 未初始化的相机会在 update 内直接 snap, 不产生入画滑动 */
  private recordInitial(): void {
    const all = this.actorWorldList();
    const targets = all
      .filter((a) => this.followIds.has(a.id))
      .map((a) => ({ x: a.x, y: a.y }));
    const diag = this.camera.update(this.dt, targets, all);
    this.snapshots.push({
      t: 0,
      actors: all.map((a) => ({ id: a.id, x: a.x, y: a.y })),
      camera: { ...diag, followIds: [...this.followIds] },
    });
  }

  actorById(id: string) {
    return this.scenario.actors.find((a) => a.id === id);
  }

  setFollow(ids: string[]): void {
    this.followIds = new Set(ids);
  }

  toggleFollow(id: string): void {
    if (this.followIds.has(id)) this.followIds.delete(id);
    else this.followIds.add(id);
  }

  /** 命中检测: 返回最上层(后绘制)且包含该世界坐标的角色 id */
  pick(p: Vec2): string | null {
    for (let i = this.scenario.actors.length - 1; i >= 0; i--) {
      const a = this.scenario.actors[i];
      const s = this.actorStates.get(a.id)!;
      if (Math.hypot(s.x - p.x, s.y - p.y) <= a.radius) return a.id;
    }
    return null;
  }

  beginDrag(id: string): void {
    this.actorStates.get(id)!.dragging = true;
  }

  setDragPosition(id: string, p: Vec2): void {
    const s = this.actorStates.get(id)!;
    s.x = p.x;
    s.y = p.y;
  }

  /** 松手后角色从当前世界时间对应的路径点继续走(确定性规则) */
  endDrag(id: string): void {
    const s = this.actorStates.get(id)!;
    s.dragging = false;
    const a = this.actorById(id)!;
    const p = evalPath(a.path, this.t, a.loop);
    s.x = p.x;
    s.y = p.y;
  }

  /** 推进一个固定步长 */
  step(): Snapshot {
    this.tick += 1;
    this.t = this.tick * this.dt;

    for (const a of this.scenario.actors) {
      const s = this.actorStates.get(a.id)!;
      if (!s.dragging) {
        const p = evalPath(a.path, this.t, a.loop);
        s.x = p.x;
        s.y = p.y;
      }
    }

    const all = this.actorWorldList();
    const targets = all
      .filter((a) => this.followIds.has(a.id))
      .map((a) => ({ x: a.x, y: a.y }));

    const diag = this.camera.update(this.dt, targets, all);

    const snap: Snapshot = {
      t: this.t,
      actors: all.map((a) => ({ id: a.id, x: a.x, y: a.y })),
      camera: {
        ...diag,
        followIds: [...this.followIds],
      },
    };
    this.snapshots.push(snap);
    return snap;
  }

  /** 跑到时长上限后返回全部快照 */
  runFull(): Snapshot[] {
    const n = Math.round(this.scenario.duration * this.fps);
    while (this.tick < n) this.step();
    return this.snapshots;
  }

  /** 最近一条快照 */
  current(): Snapshot {
    return this.snapshots[this.snapshots.length - 1];
  }
}

/**
 * 用指定帧率离线重跑整条样例(回放与多帧率对比用)。
 * 同一场景 + 同一配置在任何调用方处都得到逐 tick 确定的快照序列。
 */
export function recordRun(
  scenario: Scenario,
  config: CameraConfig,
  fps: number,
  followIds?: string[],
): Snapshot[] {
  const sim = new Simulation(scenario, config, fps, followIds);
  return sim.runFull();
}

/** 在快照序列中按时间二分查找最接近的一帧 */
export function snapshotAt(run: Snapshot[], t: number): Snapshot {
  let lo = 0;
  let hi = run.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (run[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(run[lo - 1].t - t) < Math.abs(run[lo].t - t)) {
    return run[lo - 1];
  }
  return run[lo];
}
