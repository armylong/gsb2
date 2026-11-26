import type { ClickEvent, PlaySettings, TimbreName, VoiceName } from '../core/types';
import { Timeline } from '../core/timeline';
import { renderClick } from '../core/synth';

/**
 * 实时试听播放器。
 *
 * 设计要点:
 *  - 调度单位是 ClickEvent 的 q 坐标, 与表格、WAV 导出共用同一个 Timeline,
 *    所以中途跳播、循环、从渐变中间开始, 拍点位置都与表一致。
 *  - 每个发声点在响之前 ~200ms 才读取当前音色/音量快照建节点,
 *    播放中调音量或音色不会重排已经响过的一拍。
 *  - 循环按 q 取模, 循环边界上不重复排边界拍。
 */

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;

export interface PlayerState {
  playing: boolean;
  /** 当前播放头 q */
  q: number;
  t: number;
  barIndex: number;
  beatInBar: number;
}

export type PlayerListener = (state: PlayerState) => void;

export class MetronomePlayer {
  private ctx: AudioContext | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private events: ClickEvent[] = [];
  private pointer = 0;
  private fired = new Set<number>();
  private activeSources = new Set<AudioBufferSourceNode>();
  private timer: number | null = null;
  private raf = 0;
  private listeners = new Set<PlayerListener>();

  private anchorCtxTime = 0;
  private anchorQ = 0;
  private anchorPerf = 0;
  private loopQ0 = 0;
  private loopQ1 = 0;
  private looping = false;
  /** AudioContext 无法真正运行 (如无音频设备) 时回退到 performance 时钟 */
  private fallbackMode = false;

  constructor(
    private timeline: Timeline,
    private getSettings: () => PlaySettings,
  ) {
    this.events = timeline.buildEvents();
  }

  /** 工程被编辑后替换时间线; 保留播放头的 q (小节位置), 秒数由新时间线重算 */
  replaceTimeline(timeline: Timeline, keepQ: number): void {
    this.timeline = timeline;
    this.events = timeline.buildEvents();
    const q = Math.min(keepQ, Math.max(0, timeline.totalQ));
    this.anchorQ = q;
    this.anchorCtxTime = this.ctx ? this.ctx.currentTime : 0;
    this.loopQ0 = 0;
    this.loopQ1 = timeline.totalQ;
    this.pointer = this.events.findIndex((e) => e.q >= q - 1e-9);
    if (this.pointer < 0) this.pointer = this.events.length;
    this.fired.clear();
    this.emit();
  }

  subscribe(fn: PlayerListener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  get isPlaying(): boolean {
    return this.playing;
  }
  private playing = false;

  get currentQ(): number {
    return this.anchorQ;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  private snapshot(): PlayerState {
    const q = this.playheadQ();
    const bar = this.timeline.barAt(Math.min(q, this.timeline.totalQ - 1e-9));
    const beatInBar = (q - bar.qStart) + 1;
    return {
      playing: this.isPlaying,
      q,
      t: this.timeline.qToTime(Math.min(q, this.timeline.totalQ)),
      barIndex: bar.index,
      beatInBar,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    this.listeners.forEach((fn) => fn(s));
  }

  /** 当前播放头 q: 由音频时钟与锚点反推, 循环时按区间取模; ctx 不可用时回退 performance 时钟 */
  private playheadQ(): number {
    if (!this.playing) return this.anchorQ;
    let elapsed: number;
    if (this.fallbackMode || !this.ctx || this.ctx.state !== 'running') {
      elapsed = (performance.now() - this.anchorPerf) / 1000;
    } else {
      elapsed = this.ctx.currentTime - this.anchorCtxTime;
    }
    const t0 = this.timeline.qToTime(this.anchorQ);
    let t = t0 + elapsed;
    if (this.looping) {
      const a = this.timeline.qToTime(this.loopQ0);
      const b = this.timeline.qToTime(this.loopQ1);
      if (b > a) t = a + (((t - a) % (b - a)) + (b - a)) % (b - a);
    }
    return this.timeline.timeToQ(Math.min(t, this.timeline.totalTime));
  }

  setLoop(q0: number, q1: number): void {
    this.looping = q1 > q0;
    this.loopQ0 = q0;
    this.loopQ1 = q1;
  }

  clearLoop(): void {
    this.looping = false;
  }

  /** 从指定 q 开始播放 (或恢复) */
  async play(q?: number): Promise<void> {
    const ctx = this.ensureContext();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* 无音频设备等环境: 进入回退时钟模式, 播放头仍可演示 */
    }
    this.fallbackMode = ctx.state !== 'running';
    if (this.playing && q === undefined) return;

    const startQ = q ?? this.playheadQ();
    this.anchorQ = Math.min(Math.max(0, startQ), this.timeline.totalQ);
    this.anchorPerf = performance.now() + 20;
    this.anchorCtxTime = ctx.currentTime + 0.02;
    this.pointer = this.events.findIndex((e) => e.q >= this.anchorQ - 1e-9);
    if (this.pointer < 0) this.pointer = this.events.length;
    this.fired.clear();
    this.playing = true;

    if (this.timer === null) {
      this.timer = window.setInterval(() => this.scheduleTick(), LOOKAHEAD_MS);
    }
    const loop = () => {
      this.emit();
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
    this.emit();
  }

  pause(): void {
    const q = this.playheadQ();
    this.playing = false;
    this.anchorQ = this.looping
      ? Math.min(q, this.loopQ1 - 1e-6)
      : Math.min(q, this.timeline.totalQ);
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        /* 已结束的节点 stop 会抛错, 忽略 */
      }
    }
    this.activeSources.clear();
    this.fired.clear();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit();
  }

  stop(): void {
    this.pause();
    this.anchorQ = 0;
    this.pointer = 0;
    this.emit();
  }

  /** 跳播: 播放中立刻在新位置继续; 暂停时只移动播放头 */
  seek(q: number): void {
    const clamped = Math.min(Math.max(0, q), this.timeline.totalQ);
    if (this.isPlaying) {
      void this.play(clamped);
    } else {
      this.anchorQ = clamped;
      this.pointer = this.events.findIndex((e) => e.q >= clamped - 1e-9);
      if (this.pointer < 0) this.pointer = this.events.length;
      this.fired.clear();
      this.emit();
    }
  }

  /** 试听单个音色 (面板上的「试音」按钮) */
  previewVoice(name: VoiceName): void {
    const ctx = this.ensureContext();
    void ctx.resume();
    const voice = this.getSettings().voices[name];
    const buf = this.getBuffer(name, voice.timbre, voice.pitch);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = voice.volume;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    const at = ctx.currentTime + 0.01;
    src.start(at);
  }

  private getBuffer(name: VoiceName, timbre: TimbreName, pitch: number): AudioBuffer {
    const ctx = this.ensureContext();
    const key = `${name}:${timbre}:${pitch}`;
    let buf = this.bufferCache.get(key);
    if (!buf) {
      const settings = this.getSettings().voices[name];
      const pcm = renderClick({ ...settings, timbre, pitch }, name, ctx.sampleRate);
      buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
      buf.copyToChannel(new Float32Array(pcm), 0);
      this.bufferCache.set(key, buf);
    }
    return buf;
  }

  private scheduleTick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return;
    const horizonCtx = ctx.currentTime + SCHEDULE_AHEAD_S;
    const nowPerf = performance.now() / 1000;

    let guard = 0;
    while (guard++ < 512) {
      if (this.pointer >= this.events.length) {
        if (!this.looping) {
          // 非循环: 等最后一响播完即停 (两种时钟都覆盖)
          const finished = this.fallbackMode
            ? nowPerf * 1000 > this.anchorPerf + this.timeline.totalTime * 1000 + 50
            : ctx.currentTime > this.timeline.qToTime(this.timeline.totalQ) + 0.05;
          if (finished) {
            this.pause();
            this.anchorQ = this.timeline.totalQ;
            this.emit();
          }
          break;
        }
        this.pointer = 0;
        this.fired.clear();
      }
      const ev = this.events[this.pointer];
      if (this.fired.has(ev.q)) {
        this.pointer += 1;
        continue;
      }
      // 循环区间外的事件直接跳过
      if (this.looping && (ev.q < this.loopQ0 - 1e-9 || ev.q >= this.loopQ1 - 1e-9)) {
        this.pointer += 1;
        continue;
      }
      if (ev.kind === 'sub' && !this.getSettings().playSubdivisions) {
        this.fired.add(ev.q);
        this.pointer += 1;
        continue;
      }
      if (this.fallbackMode) {
        // 无音频设备: 仍按时间窗口推进并标记, 保证播放头/循环逻辑可验证
        const tEv = this.timeline.qToTime(ev.q);
        const tAnchor = this.timeline.qToTime(this.anchorQ);
        const whenPerf = (this.anchorPerf + (tEv - tAnchor) * 1000) / 1000;
        if (whenPerf > nowPerf + SCHEDULE_AHEAD_S) break;
        this.fired.add(ev.q);
        this.pointer += 1;
        continue;
      }
      const whenCtx = this.eventCtxTime(ev);
      if (whenCtx > horizonCtx) break;
      this.trigger(ev, whenCtx);
      this.fired.add(ev.q);
      this.pointer += 1;
    }
  }

  /** 事件 q -> AudioContext 时间; 处理循环回绕 (同一拍在下一轮的时间) */
  private eventCtxTime(ev: ClickEvent): number {
    let tEv = this.timeline.qToTime(ev.q);
    const tAnchor = this.timeline.qToTime(this.anchorQ);
    if (this.looping) {
      const a = this.timeline.qToTime(this.loopQ0);
      const b = this.timeline.qToTime(this.loopQ1);
      const span = b - a;
      let tAnch = tAnchor;
      tAnch = a + (((tAnch - a) % span) + span) % span;
      if (tEv < tAnch - 1e-9) tEv += span;
      tEv = a + (((tEv - a) % span) + span) % span;
      if (tEv + 1e-9 < tAnch) tEv += span;
    }
    return this.anchorCtxTime + (tEv - tAnchor);
  }

  /** 建节点的瞬间才读取音量/音色快照; 已排队的节点不受之后调参影响 */
  private trigger(ev: ClickEvent, whenCtx: number): void {
    const ctx = this.ctx!;
    const voice = this.getSettings().voices[ev.kind];
    const buf = this.getBuffer(ev.kind, voice.timbre, voice.pitch);
    const src = ctx.createBufferSource();    const gain = ctx.createGain();
    gain.gain.value = voice.volume;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start(whenCtx);
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
    };
  }

  dispose(): void {
    this.pause();
    this.bufferCache.clear();
    this.listeners.clear();
    void this.ctx?.close();
    this.ctx = null;
  }
}
