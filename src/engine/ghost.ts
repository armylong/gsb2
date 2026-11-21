/**
 * 幻影录制与回放。
 * 帧时间戳全部使用模拟时钟，因此暂停期间不会产生新帧，
 * 回放时按模拟时钟取帧 —— 幻影与当前车的计时天然同步、暂停时一起冻结。
 */
import { Vec2 } from './geometry';
import { Path, Keyframe } from './path';
import { LapSession, GateEvent } from './session';

export interface GhostFrame {
  t: number;
  pos: Vec2;
  angle: number;
}

export class Recorder {
  private frames: GhostFrame[] = [];
  recording = false;

  start(): void {
    this.frames = [];
    this.recording = true;
  }

  stop(): GhostFrame[] {
    this.recording = false;
    return this.frames;
  }

  /** 每个模拟步调用（暂停时会话不推进时钟，录制也跳过该帧） */
  capture(session: LapSession): void {
    if (!this.recording || session.paused) return;
    this.frames.push({ t: session.time, pos: session.pos, angle: session.angle });
  }

  get frameCount(): number {
    return this.frames.length;
  }
}

export class Ghost {
  readonly path: Path;
  /** 幻影本地时钟起点（模拟时钟），用于把全局时间换算成本地时间 */
  readonly baseTime: number;

  constructor(frames: GhostFrame[], baseTime = 0) {
    if (frames.length < 2) throw new Error('幻影至少需要 2 帧');
    const keyframes: Keyframe[] = frames.map((f) => ({
      t: f.t - baseTime,
      pos: f.pos,
      angle: f.angle,
    }));
    this.path = new Path(keyframes);
    this.baseTime = baseTime;
  }

  get duration(): number {
    return this.path.duration;
  }

  /** 给全局模拟时钟，返回幻影位姿；超出片段时长返回 null（隐藏） */
  sampleAt(sessionTime: number): { pos: Vec2; angle: number } | null {
    const local = sessionTime - this.baseTime;
    if (local < 0 || local > this.path.duration) return null;
    return this.path.sampleAt(local);
  }
}

/**
 * 从一条已知有效路线离线录制一圈幻影（不依赖渲染帧率）。
 * 以固定小步长驱动 LapSession，截取从 G0 起步到完赛之间的帧并做时间归零。
 */
export function recordLapOffline(
  session: LapSession,
  route: Path,
  step = 1 / 240,
): { ghost: Ghost; events: GateEvent[] } {
  session.reset(route.frames[0].pos);
  const start = route.frames[0].t;
  const end = route.frames[route.frames.length - 1].t;
  const recorded: GhostFrame[] = [];
  let baseTime: number | null = null;

  for (let t = start; t < end - 1e-12; ) {
    const nt = Math.min(t + step, end);
    const dt = nt - t;
    const sample = route.sampleAt(nt);
    const produced = session.advance(dt, sample.pos, sample.angle);
    if (baseTime === null && produced.some((e) => e.kind === 'gate-hit' && e.gate === 0)) {
      baseTime = session.time - dt; // G0 触发在本步内，取步进起点做归零基准
    }
    if (baseTime !== null) {
      recorded.push({ t: session.time - baseTime, pos: session.pos, angle: session.angle });
    }
    const lap = produced.find((e) => e.kind === 'lap');
    if (lap) break;
    t = nt;
  }

  if (baseTime === null || recorded.length < 2) {
    throw new Error('该路线未产生有效圈，无法生成幻影');
  }
  return { ghost: new Ghost(recorded, 0), events: session.events };
}
