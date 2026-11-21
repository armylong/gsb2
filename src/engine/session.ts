/**
 * 计时会话 + 闸门状态机（纯逻辑，无 DOM）。
 *
 * 规则：
 *  1. 必须先正向通过起点 G0，会话才进入"计圈中"；此前的穿越一律记为"未起步"。
 *  2. 计圈中必须按 G0→G1→G2→G3 的固定顺序正向通过。
 *  3. 反向穿越 = 逆行；正向但顺序不对 = 跳关；共线重叠 = 贴住闸门滑行，不算通过。
 *  4. 逆行/跳关使当前圈作废（invalid），需要重新正向通过 G0 才能开始新一圈。
 *  5. 一帧内的多次命中按位移参数 u 排序，保证同帧事件顺序与空间顺序一致。
 *  6. 触发时刻 = 上一帧时刻 + dt*u，是 sub-frame 插值结果，与显示帧率无关。
 */
import { Track } from './track';
import { Vec2, analyzeSweep, GateHit } from './geometry';

export type SessionMode = 'idle' | 'running' | 'invalid';

export type GateEventKind =
  | 'gate-hit' // 正常顺序通过
  | 'gate-reverse' // 逆行
  | 'gate-skip' // 跳关（顺序错误）
  | 'gate-overlap' // 共线重叠，未真正穿越
  | 'gate-ignored' // 未起步时的穿越
  | 'lap'; // 完赛

export interface GateEvent {
  kind: GateEventKind;
  gate: number;
  /** 模拟时钟时刻（秒，暂停冻结） */
  time: number;
  /** 交点坐标 */
  point: Vec2;
  forward: boolean;
  overlap: boolean;
  message: string;
  /** 事件发生时状态机模式 */
  mode: SessionMode;
  /** 完赛事件携带的圈速 */
  lapTime?: number;
}

export interface LapRecord {
  index: number;
  /** 相对本圈起点 G0 的各闸门时刻 */
  gateTimes: number[];
  total: number;
}

const GATE_COUNT = 4;

class LapValidator {
  mode: SessionMode = 'idle';
  /** 本圈下一扇期望闸门的索引 */
  expected = 0;
  /** 本圈起点 G0 的模拟时刻 */
  lapStart = 0;
  gateTimes: number[] = [];
  lapCount = 0;
  laps: LapRecord[] = [];

  reset(): void {
    this.mode = 'idle';
    this.expected = 0;
    this.lapStart = 0;
    this.gateTimes = [];
  }

  /** 处理一次扫掠命中，返回要追加的事件（可能多条） */
  handle(hit: GateHit, time: number, point: Vec2): GateEvent[] {
    const out: GateEvent[] = [];
    const gate = hit.gate;
    const forward = hit.forward;

    if (hit.overlap) {
      out.push({
        kind: 'gate-overlap',
        gate,
        time,
        point,
        forward,
        overlap: true,
        mode: this.mode,
        message: `G${gate} 共线重叠：移动方向与闸门平行且在线上滑行，没有从一侧跨到另一侧，不产生计时触发`,
      });
      return out;
    }

    if (!forward) {
      out.push({
        kind: 'gate-reverse',
        gate,
        time,
        point,
        forward: false,
        overlap: false,
        mode: this.mode,
        message:
          this.mode === 'running'
            ? `G${gate} 逆行：当前圈要求正向通过 G${this.expected}，反向穿越使本圈作废，需重新正向通过 G0 起步`
            : `G${gate} 逆行：反向通过闸门，不满足顺时针方向要求，当前会话状态 ${this.mode}`,
      });
      if (this.mode === 'running') this.invalidate();
      return out;
    }

    // 正向穿越
    if (this.mode === 'idle') {
      if (gate === 0) {
        this.startLap(time);
        out.push(this.hitEvent(gate, time, point, `G0 正向通过，计圈开始（t=${time.toFixed(4)}s）`));
      } else {
        out.push({
          kind: 'gate-ignored',
          gate,
          time,
          point,
          forward: true,
          overlap: false,
          mode: 'idle',
          message: `G${gate} 未起步：必须先正向通过起点 G0 才能开始计圈，本次穿越不计成绩`,
        });
      }
      return out;
    }

    if (this.mode === 'invalid') {
      if (gate === 0) {
        this.startLap(time);
        out.push(this.hitEvent(gate, time, point, `G0 重新正向通过，开始新一圈（旧圈已作废）`));
      } else {
        out.push({
          kind: 'gate-ignored',
          gate,
          time,
          point,
          forward: true,
          overlap: false,
          mode: 'invalid',
          message: `G${gate} 忽略：当前圈已作废，需重新正向通过 G0 起步后本闸门才会被承认`,
        });
      }
      return out;
    }

    // running
    if (gate !== this.expected) {
      out.push({
        kind: 'gate-skip',
        gate,
        time,
        point,
        forward: true,
        overlap: false,
        mode: 'running',
        message: `G${gate} 跳关：本圈下一扇应为 G${this.expected}，顺序被跳过/打乱，本圈作废，需重新正向通过 G0`,
      });
      this.invalidate();
      return out;
    }

    this.gateTimes[gate] = time - this.lapStart;
    out.push(
      this.hitEvent(
        gate,
        time,
        point,
        `G${gate} 顺序通过（本圈第 ${gate + 1}/${GATE_COUNT} 个检查点，分段计时 ${(time - this.lapStart).toFixed(4)}s）`,
      ),
    );

    if (gate === GATE_COUNT - 1) {
      const total = time - this.lapStart;
      const record: LapRecord = {
        index: this.lapCount + 1,
        gateTimes: [...this.gateTimes],
        total,
      };
      this.lapCount += 1;
      this.laps.push(record);
      out.push({
        kind: 'lap',
        gate,
        time,
        point,
        forward: true,
        overlap: false,
        mode: 'running',
        lapTime: total,
        message: `完赛：第 ${record.index} 圈有效，圈速 ${total.toFixed(4)}s（由 sub-frame 插值触发时刻计算）`,
      });
      this.mode = 'idle';
      this.expected = 0;
      this.gateTimes = [];
      return out;
    }

    this.expected += 1;
    return out;
  }

  private startLap(time: number): void {
    this.mode = 'running';
    this.expected = 1;
    this.lapStart = time;
    this.gateTimes = [0];
  }

  private invalidate(): void {
    this.mode = 'invalid';
    this.expected = -1;
    this.gateTimes = [];
  }

  private hitEvent(gate: number, time: number, point: Vec2, message: string): GateEvent {
    return {
      kind: 'gate-hit',
      gate,
      time,
      point,
      forward: true,
      overlap: false,
      mode: this.mode,
      message,
    };
  }
}

export class LapSession {
  readonly validator = new LapValidator();
  /** 模拟时钟（秒），pause 期间 advance 不推进它 */
  time = 0;
  pos: Vec2;
  angle = 0;
  paused = false;
  events: GateEvent[] = [];
  /** 每次 advance 后新增事件的起始下标，UI 增量读取用 */
  eventSerial = 0;

  constructor(private readonly track: Track, startPos?: Vec2) {
    this.pos = startPos ?? track.positionAt(track.gates[0].fraction - 0.01);
  }

  get mode(): SessionMode {
    return this.validator.mode;
  }
  get expected(): number {
    return this.validator.expected;
  }
  get lapCount(): number {
    return this.validator.lapCount;
  }
  get laps(): LapRecord[] {
    return this.validator.laps;
  }
  get lapStart(): number {
    return this.validator.lapStart;
  }
  get currentLapElapsed(): number {
    return this.validator.mode === 'running' ? this.time - this.validator.lapStart : 0;
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  reset(startPos?: Vec2): void {
    this.time = 0;
    this.paused = false;
    this.events = [];
    this.eventSerial = 0;
    this.validator.reset();
    this.pos = startPos ?? this.track.positionAt(this.track.gates[0].fraction - 0.01);
    this.angle = 0;
  }

  /**
   * 推进一个模拟步。
   * @param dt 本步时长（秒）。dt 多大都安全：扫掠线段保证高速跨闸不丢触发。
   * @param nextPos 本步结束位置
   * @param angle 本步结束车头角
   *
   * 暂停语义：整个模拟冻结——时钟不推进、位置不更新、不做闸门判定。
   * 上层在暂停时不会推进回放路径，因此恢复后从原处继续，圈速与无暂停完全一致。
   */
  advance(dt: number, nextPos: Vec2, angle: number): GateEvent[] {
    const produced: GateEvent[] = [];
    if (this.paused) {
      this.eventSerial = this.events.length;
      return produced;
    }
    if (dt > 0) {
      const hits: GateHit[] = [];
      for (const gate of this.track.gates) {
        const hit = analyzeSweep(this.pos, nextPos, gate.a, gate.b, gate.tangent);
        if (hit) hits.push({ ...hit, gate: gate.index });
      }
      // 同帧多命中：按位移参数 u 排序（同 u 保持闸门索引顺序）
      hits.sort((p, q) => p.u - q.u || p.gate - q.gate);
      for (const hit of hits) {
        const hitTime = this.time + dt * hit.u;
        const events = this.validator.handle(hit, hitTime, hit.point);
        for (const e of events) {
          this.events.push(e);
          produced.push(e);
        }
      }
      this.time += dt;
    }
    this.pos = nextPos;
    this.angle = angle;
    this.eventSerial = this.events.length;
    return produced;
  }
}
