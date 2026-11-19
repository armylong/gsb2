import { ACTION_MAP, ActionId, BindingMap, SceneId, defaultBindings } from './bindings';
import { EngineEvent, InputEngine } from './engine';
import {
  CHECKPOINT_INTERVAL,
  Checkpoint,
  MAX_TICKS,
  RecEvent,
  Recording,
  ReplayResult,
  checkpointsEqual,
  recordingHash,
  runReplay,
  snapshotOf,
} from './recording';
import { Simulation } from './sim';

export interface LogEntry {
  tick: number;
  text: string;
}

export interface Playback {
  rec: Recording;
  ptr: number;
  playing: boolean;
  speed: number;
  acc: number;
  done: boolean;
  result: ReplayResult | null;
  firstDivergence: { tick: number } | null;
}

interface ScriptOp {
  tick: number;
  run: () => void;
}

/**
 * World：把输入引擎、模拟、录制、回放接在一起。
 * UI 与测试都通过它交互，保证「页面行为」与「可运行验证」是同一份逻辑。
 */
export class World {
  engine: InputEngine;
  sim: Simulation;
  log: LogEntry[] = [];

  recording: { name: string; events: RecEvent[]; checkpoints: Checkpoint[]; initial: Recording['initial'] } | null =
    null;
  recordings: Recording[] = [];
  /** 录像内容哈希 → 校验结果；录像被修改后哈希变化，旧结果自然失效 */
  verifications = new Map<string, ReplayResult>();

  playback: Playback | null = null;
  private script: ScriptOp[] = [];
  private scriptBase = 0;

  constructor(bindings?: BindingMap) {
    this.engine = new InputEngine(bindings ?? defaultBindings());
    this.sim = new Simulation();
    this.engine.subscribe((e) => this.onEngineEvent(e));
  }

  private pushLog(text: string) {
    this.log.push({ tick: this.sim.state.tick, text });
    if (this.log.length > 60) this.log.shift();
  }

  private recEvent(e: RecEvent) {
    if (!this.recording) return;
    if (this.sim.state.tick >= MAX_TICKS) return;
    this.recording.events.push(e);
  }

  private onEngineEvent(e: EngineEvent) {
    const t = this.sim.state.tick;
    if (e.type === 'actionDown') {
      this.sim.actionDown(e.action);
      this.recEvent({ tick: t, type: 'down', action: e.action });
    } else if (e.type === 'actionUp') {
      this.sim.actionUp(e.action);
      this.recEvent({ tick: t, type: 'up', action: e.action });
    } else if (e.type === 'edge') {
      this.pushLog(`${ACTION_MAP[e.action].label} 触发`);
      if (e.action === 'pause') {
        if (this.engine.scene === 'game') {
          this.sim.fireEdge('pause');
          this.recEvent({ tick: t, type: 'edge', action: 'pause' });
          // 暂停时清除按住状态，避免恢复后残留
          this.engine.clearAll();
        } else {
          // 菜单场景下「暂停」= 返回游戏
          this.setScene('game');
        }
      } else {
        this.sim.fireEdge(e.action);
        this.recEvent({ tick: t, type: 'edge', action: e.action });
      }
    }
  }

  setScene(scene: SceneId) {
    if (this.engine.scene === scene) return;
    this.engine.setScene(scene);
    this.sim.state.scene = scene;
    this.sim.releaseAll();
    this.recEvent({ tick: this.sim.state.tick, type: 'scene', scene });
    this.pushLog(`切换到${scene === 'game' ? '游戏' : '菜单'}场景`);
  }

  /** 窗口失焦：清除按住状态 */
  handleBlur() {
    this.engine.clearAll();
    this.sim.releaseAll();
  }

  // ---------- 录制 ----------

  startRecording(name?: string) {
    this.stopPlayback();
    this.recording = {
      name: name ?? `录像 ${new Date().toLocaleTimeString()}`,
      events: [],
      checkpoints: [],
      initial: { x: this.sim.state.x, y: this.sim.state.y, scene: this.sim.state.scene },
    };
    this.pushLog('开始录制');
  }

  stopRecording(): Recording | null {
    const r = this.recording;
    if (!r) return null;
    this.recording = null;
    const rec: Recording = {
      version: 1,
      name: r.name,
      durationTicks: this.sim.state.tick,
      initial: r.initial,
      events: r.events,
      checkpoints: r.checkpoints,
      final: snapshotOf(this.sim.state),
    };
    this.recordings.push(rec);
    this.pushLog(`录制完成（${(rec.durationTicks / 60).toFixed(1)} 秒）`);
    return rec;
  }

  get isRecording() {
    return this.recording !== null;
  }

  /** 修改录像事件（编辑动作/删除事件）。修改后内容哈希变化，旧校验结果自动失效。 */
  mutateRecording(rec: Recording, mutate: (events: RecEvent[]) => void) {
    mutate(rec.events);
    rec.events.sort((a, b) => a.tick - b.tick);
    this.verifications.delete(recordingHash(rec));
  }

  verificationFor(rec: Recording): ReplayResult | null {
    return this.verifications.get(recordingHash(rec)) ?? null;
  }

  // ---------- 回放 ----------

  /** 校验通过后才会调用；回放期间真实按键被忽略 */
  startPlayback(rec: Recording) {
    this.stopRecording();
    this.stopPlayback();
    this.engine.enabled = false;
    this.engine.clearAll();
    this.sim.reset({ x: rec.initial.x, y: rec.initial.y, scene: rec.initial.scene });
    this.playback = { rec, ptr: 0, playing: true, speed: 1, acc: 0, done: false, result: null, firstDivergence: null };
    this.pushLog(`回放「${rec.name}」`);
  }

  stopPlayback() {
    if (!this.playback) return;
    this.playback = null;
    this.engine.enabled = true;
    this.engine.clearAll();
    this.sim.reset({ scene: 'game' });
    if (this.engine.scene !== 'game') this.engine.setScene('game');
  }

  playbackStep() {
    if (this.playback) this.playback.playing = false;
    this.advancePlayback(1);
  }

  private advancePlayback(ticks: number) {
    const pb = this.playback;
    if (!pb || pb.done) return;
    for (let i = 0; i < ticks && !pb.done; i++) {
      const s = this.sim.state;
      while (pb.ptr < pb.rec.events.length && pb.rec.events[pb.ptr].tick <= s.tick) {
        const e = pb.rec.events[pb.ptr++];
        if (e.type === 'down') this.sim.actionDown(e.action);
        else if (e.type === 'up') this.sim.actionUp(e.action);
        else if (e.type === 'edge') this.sim.fireEdge(e.action);
        else s.scene = e.scene;
      }
      this.sim.step();
      if (s.tick % CHECKPOINT_INTERVAL === 0) {
        const expected = pb.rec.checkpoints.find((c) => c.tick === s.tick);
        if (expected && !checkpointsEqual(expected, snapshotOf(s)) && !pb.firstDivergence) {
          pb.firstDivergence = { tick: s.tick };
        }
      }
      if (s.tick >= pb.rec.durationTicks) {
        pb.done = true;
        pb.playing = false;
        const result = runReplay(pb.rec);
        pb.result = result;
        this.verifications.set(recordingHash(pb.rec), result);
        this.pushLog(result.match ? '回放完成：与录制结果一致' : `回放完成：在 tick ${result.firstDivergence?.tick} 出现差异`);
      }
    }
  }

  // ---------- 脚本（演示用） ----------

  runScript(ops: ScriptOp[]) {
    this.scriptBase = this.sim.state.tick;
    this.script = ops.map((o) => ({ ...o }));
  }

  // ---------- 主循环 ----------

  tick() {
    // 脚本操作（演示）
    const now = this.sim.state.tick - this.scriptBase;
    while (this.script.length > 0 && this.script[0].tick <= now) {
      this.script.shift()!.run();
    }
    if (this.playback) {
      const pb = this.playback;
      if (pb.playing && !pb.done) {
        pb.acc += pb.speed;
        const n = Math.floor(pb.acc);
        pb.acc -= n;
        this.advancePlayback(n);
      }
      return;
    }
    this.sim.step();
    if (this.recording) {
      if (this.sim.state.tick % CHECKPOINT_INTERVAL === 0) {
        this.recording.checkpoints.push(snapshotOf(this.sim.state));
      }
      if (this.sim.state.tick >= MAX_TICKS) this.stopRecording();
    }
  }
}
