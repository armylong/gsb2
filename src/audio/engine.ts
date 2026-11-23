import { Ledger } from '../model/ledger';
import {
  Mapping,
  RotationCounters,
  Sample,
  SampleStatus,
  TriggerPlan,
  dbToGain,
} from '../model/types';
import { planTrigger } from '../model/mapping';
import { getFile, putFile } from './storage';
import { BUILTIN_SYNTHS, renderSynth, synthSpec } from './synth';

export interface SampleState {
  status: SampleStatus;
  reason?: string;
}

interface LayerNode {
  sampleId: string;
  zoneId: string;
  variantId: string;
  variantIndex: number;
  weight: number;
  gain: number;
  source: AudioBufferSourceNode;
}

export interface VoiceView {
  id: number;
  pressId: number;
  startedAt: number;
  velocity: number;
  sampleIds: string[];
}

interface ActiveVoice {
  view: VoiceView;
  reason?: 'natural' | 'stolen' | 'released';
  nodes: LayerNode[];
  pending: number; // 尚未 onended 的 source 数
  done: boolean;
}

export interface SequenceStep {
  velocity: number;
  played: boolean;
  at: number;
}

export interface EngineSnapshot {
  initialized: boolean;
  sampleStates: Record<string, SampleState>;
  counters: RotationCounters;
  voices: VoiceView[];
  sequence: SequenceStep[];
  saving: boolean;
  lastSavedAt?: number;
}

const VELOCITY_FLOOR = 0.2;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterData: Uint8Array | null = null;

  private mapping: Mapping | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private states = new Map<string, SampleState>();
  private loadInflight = new Set<string>();

  private voices: ActiveVoice[] = [];
  private voiceSeq = 0;
  private pressSeq = 0;
  private counters: RotationCounters = {};
  private sequence: SequenceStep[] = [];

  readonly events = new Ledger<EngineEventPayload>(600);
  private listeners = new Set<() => void>();
  private cachedSnapshot: EngineSnapshot | null = null;

  private saving = false;
  private lastSavedAt: number | undefined;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.cachedSnapshot = null;
    this.listeners.forEach((fn) => fn());
  }

  isInitialized(): boolean {
    return this.ctx !== null;
  }

  /** 必须在用户手势中调用（浏览器自动播放策略） */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.analyser = analyser;
    this.meterData = new Uint8Array(analyser.fftSize);
    this.events.append('engine-init', { sampleRate: ctx.sampleRate, state: ctx.state });
    if (this.mapping) await this.preloadAll();
    this.emit();
  }

  // 箭头函数字段：会被 useSyncExternalStore 脱离实例调用，必须绑定 this。
  // 快照带缓存：没有 emit() 失效时返回同一引用，满足 useSyncExternalStore 的稳定性约定。
  getSnapshot = (): EngineSnapshot => {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      initialized: this.ctx !== null,
      sampleStates: Object.fromEntries(this.states),
      counters: { ...this.counters },
      voices: this.voices.map((v) => v.view),
      sequence: [...this.sequence],
      saving: this.saving,
      lastSavedAt: this.lastSavedAt,
    };
    return this.cachedSnapshot;
  };

  setSavedMeta(savedAt: number | undefined, saving = false): void {
    this.lastSavedAt = savedAt;
    this.saving = saving;
    this.emit();
  }

  /** 主表读数：0..1 RMS */
  readLevel(): number {
    if (!this.analyser || !this.meterData) return 0;
    this.analyser.getByteTimeDomainData(this.meterData);
    let sum = 0;
    for (let i = 0; i < this.meterData.length; i++) {
      const v = (this.meterData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.meterData.length);
  }

  setMapping(mapping: Mapping): void {
    const prev = this.mapping;
    this.mapping = mapping;
    // 清理已不在映射中的素材
    const live = new Set(mapping.samples.map((s) => s.id));
    for (const id of this.buffers.keys()) {
      if (!live.has(id)) this.buffers.delete(id);
    }
    for (const id of this.states.keys()) {
      if (!live.has(id)) this.states.delete(id);
    }
    // 新增区域的计数器从 0 开始；旧区域保留，保证编辑过程中序列语义连续
    if (prev) {
      const keep = new Set(mapping.zones.map((z) => z.id));
      for (const id of Object.keys(this.counters)) {
        if (!keep.has(id)) delete this.counters[id];
      }
    }
    if (this.ctx) void this.preloadAll();
    this.emit();
  }

  getMapping(): Mapping | null {
    return this.mapping;
  }

  getSampleState(id: string): SampleState {
    return this.states.get(id) ?? { status: 'idle' };
  }

  /** 主动预加载全部素材（单个失败不影响其它） */
  async preloadAll(): Promise<void> {
    if (!this.ctx || !this.mapping) return;
    await Promise.all(this.mapping.samples.map((s) => this.ensureSample(s)));
  }

  private setSampleState(id: string, state: SampleState): void {
    this.states.set(id, state);
    this.events.append('sample-status', { sampleId: id, ...state });
    this.emit();
  }

  /** 加载并解码素材，带 in-flight 去重，失败可查原因 */
  async ensureSample(sample: Sample): Promise<AudioBuffer | null> {
    const existing = this.buffers.get(sample.id);
    if (existing) return existing;
    if (this.loadInflight.has(sample.id)) {
      // 等待进行中的加载，不重复发起
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if (!this.loadInflight.has(sample.id)) resolve();
          else setTimeout(tick, 30);
        };
        tick();
      });
      return this.buffers.get(sample.id) ?? null;
    }
    if (!this.ctx) {
      this.setSampleState(sample.id, {
        status: 'error',
        reason: '音频引擎尚未初始化（先点击"启用音频"）',
      });
      return null;
    }
    this.loadInflight.add(sample.id);
    this.setSampleState(sample.id, { status: 'loading' });
    try {
      let buffer: AudioBuffer;
      if (sample.source.kind === 'builtin') {
        const spec = synthSpec(sample.source.synthId);
        if (!spec) throw new Error(`未知内置音色 ${sample.source.synthId}`);
        buffer = await renderSynth(this.ctx, spec);
      } else {
        const stored = await getFile(sample.source.blobId);
        if (!stored) throw new Error(`本地文件已不在 IndexedDB：${sample.source.fileName}`);
        const arr = await stored.blob.arrayBuffer();
        buffer = await this.decode(arr);
      }
      this.buffers.set(sample.id, buffer);
      this.setSampleState(sample.id, {
        status: 'ready',
        reason: `${buffer.duration.toFixed(2)}s · ${buffer.numberOfChannels}ch · ${buffer.sampleRate}Hz`,
      });
      return buffer;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.setSampleState(sample.id, { status: 'error', reason });
      return null;
    } finally {
      this.loadInflight.delete(sample.id);
    }
  }

  private async decode(arr: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ctx!;
    // Safari 旧版回调形式兜底
    if (typeof ctx.decodeAudioData === 'function' && ctx.decodeAudioData.length === 1) {
      return ctx.decodeAudioData(arr);
    }
    return new Promise((resolve, reject) => {
      ctx.decodeAudioData(
        arr,
        (buf) => resolve(buf),
        (err) => reject(err ?? new Error('decodeAudioData 失败，文件可能不是有效的 WAV/PCM')),
      );
    });
  }

  /** 入库一个本地上传文件并创建素材，随后立即开始加载 */
  async importUpload(file: File): Promise<Sample> {
    const id = `s_up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putFile({ id, name: file.name, blob: file, size: file.size, storedAt: Date.now() });
    const sample: Sample = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      source: { kind: 'upload', blobId: id, fileName: file.name },
      gainDb: 0,
    };
    if (this.ctx) void this.ensureSample(sample);
    else this.states.set(sample.id, { status: 'idle', reason: '引擎未初始化，启用音频后自动加载' });
    return sample;
  }

  /** 不经过键事件的素材独奏试听（素材库"听一下"按钮） */
  async previewSample(sample: Sample): Promise<void> {
    if (!this.ctx || !this.master) return;
    const buffer = (await this.ensureSample(sample)) ?? this.buffers.get(sample.id);
    if (!buffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = dbToGain(sample.gainDb);
    src.connect(g).connect(this.master);
    src.start();
    this.events.append('sample-preview', { sampleId: sample.id });
    this.emit();
  }

  /**
   * 触发一次播放。返回 pressId（松键时用），被拦下返回 null。
   * 每次调用恰好产生一条 trigger 事件（started 或 blocked），不会漏记或重复。
   */
  trigger(velocity: number): number | null {
    if (!this.ctx || !this.master || !this.mapping) return null;
    const pressId = ++this.pressSeq;
    const mapping = this.mapping;

    const { plan, nextCounters } = planTrigger(
      mapping,
      velocity,
      this.counters,
      (id) => this.getSampleState(id),
    );
    this.counters = nextCounters;
    this.sequence.push({ velocity: plan.velocity, played: !plan.blocked_, at: performance.now() });

    if (plan.blocked_) {
      this.events.append('trigger-blocked', { pressId, ...stripPlan(plan) });
      this.emit();
      return null;
    }
    if (mapping.maxVoices < 1) {
      this.events.append('trigger-blocked', {
        pressId,
        velocity: plan.velocity,
        blocked: [{ reason: 'polyphony-zero', detail: '最大同时播放数为 0' }],
        zones: [],
      });
      this.emit();
      return null;
    }

    // 超数：按最旧顺序偷声，被结束的声音逐条进台账
    while (this.voices.length >= mapping.maxVoices) {
      const oldest = this.voices.reduce((a, b) => (a.view.id < b.view.id ? a : b));
      this.stopVoice(oldest, 'stolen');
    }

    const voice = this.startVoice(pressId, plan, mapping);
    this.events.append('trigger-started', {
      pressId,
      voiceId: voice.view.id,
      velocity: plan.velocity,
      layers: voice.nodes.map((n) => ({
        zoneId: n.zoneId,
        variantId: n.variantId,
        variantIndex: n.variantIndex,
        sampleId: n.sampleId,
        weight: Number(n.weight.toFixed(4)),
        gain: Number(n.gain.toFixed(4)),
      })),
    });
    this.emit();
    return pressId;
  }

  private startVoice(pressId: number, plan: TriggerPlan, mapping: Mapping): ActiveVoice {
    const ctx = this.ctx!;
    const voiceId = ++this.voiceSeq;
    const velocityGain = VELOCITY_FLOOR + (1 - VELOCITY_FLOOR) * (plan.velocity / 127);
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = velocityGain;
    voiceGain.connect(this.master!);

    const nodes: LayerNode[] = [];
    const startAt = ctx.currentTime + 0.001;
    for (const layer of plan.zones) {
      const sample = mapping.samples.find((s) => s.id === layer.sampleId)!;
      const buffer = this.buffers.get(sample.id);
      if (!buffer) continue; // plan 已保证 ready，这里仅作类型兜底
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      const gain = layer.weight * dbToGain(sample.gainDb);
      g.gain.value = gain;
      src.connect(g).connect(voiceGain);
      src.start(startAt);
      nodes.push({
        sampleId: sample.id,
        zoneId: layer.zoneId,
        variantId: layer.variantId,
        variantIndex: layer.variantIndex,
        weight: layer.weight,
        gain,
        source: src,
      });
    }

    const voice: ActiveVoice = {
      view: {
        id: voiceId,
        pressId,
        startedAt: performance.now(),
        velocity: plan.velocity,
        sampleIds: nodes.map((n) => n.sampleId),
      },
      nodes,
      pending: nodes.length,
      done: false,
    };
    for (const n of nodes) {
      n.source.onended = () => {
        voice.pending -= 1;
        if (voice.pending <= 0 && !voice.done) this.finalizeVoice(voice);
      };
    }
    this.voices.push(voice);
    return voice;
  }

  /** 松键：只结束本次按下产生的声音，其它连按声音不受影响 */
  release(pressId: number): void {
    const mine = this.voices.filter((v) => v.view.pressId === pressId && !v.done);
    for (const v of mine) this.stopVoice(v, 'released');
    if (mine.length > 0) {
      this.events.append('release', { pressId, voiceIds: mine.map((v) => v.view.id) });
      this.emit();
    }
  }

  private stopVoice(voice: ActiveVoice, reason: 'stolen' | 'released'): void {
    if (voice.done) return;
    voice.reason = reason;
    for (const n of voice.nodes) {
      try {
        n.source.stop();
      } catch {
        /* 已停止的 source 再 stop 会抛错，忽略 */
      }
    }
    // onended 是异步的，立刻从活动列表摘掉，保证并发数判断准确
    this.voices = this.voices.filter((v) => v !== voice);
  }

  private finalizeVoice(voice: ActiveVoice): void {
    voice.done = true;
    this.voices = this.voices.filter((v) => v !== voice);
    this.events.append('voice-ended', {
      voiceId: voice.view.id,
      pressId: voice.view.pressId,
      reason: voice.reason ?? 'natural',
    });
    this.emit();
  }

  /** 停掉全部活动声音（手动停止按钮） */
  stopAll(): void {
    const all = [...this.voices];
    for (const v of all) this.stopVoice(v, 'released');
    if (all.length > 0) {
      this.events.append('stop-all', { voiceIds: all.map((v) => v.view.id) });
      this.emit();
    }
  }

  /** 重置轮转计数器与力度序列；正在响的声音保持独立，不被打断 */
  resetRotation(): void {
    this.counters = {};
    this.sequence = [];
    this.events.append('rotation-reset', { activeVoices: this.voices.length });
    this.emit();
  }

  getCounters(): RotationCounters {
    return { ...this.counters };
  }

  getSequence(): SequenceStep[] {
    return [...this.sequence];
  }

  /**
   * 按记录的原始时间间隔重放力度序列；重放前先重置计数器，
   * 因此相同序列 + 相同映射 => 相同变体选择（纯函数 planTrigger 保证）。
   */
  async replaySequence(): Promise<void> {
    if (!this.ctx || this.sequence.length === 0) return;
    const steps = [...this.sequence];
    this.resetRotation();
    this.events.append('replay-start', { count: steps.length });
    this.emit();
    const t0 = performance.now();
    const base = steps[0].at;
    for (const step of steps) {
      const wait = step.at - base - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.trigger(step.velocity);
    }
    this.events.append('replay-done', { count: steps.length });
    this.emit();
  }

  dispose(): void {
    for (const v of this.voices) {
      for (const n of v.nodes) {
        try {
          n.source.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.voices = [];
    void this.ctx?.close();
    this.ctx = null;
  }
}

function stripPlan(plan: TriggerPlan): {
  velocity: number;
  blocked: TriggerPlan['blocked'];
  zones: TriggerPlan['zones'];
} {
  return { velocity: plan.velocity, blocked: plan.blocked, zones: plan.zones };
}

export type EngineEventPayload =
  | { sampleRate: number; state: string }
  | { sampleId: string; status: string; reason?: string }
  | { sampleId: string }
  | TriggerEventPayload
  | { pressId?: number; voiceIds: number[] }
  | { voiceId: number; pressId: number; reason: string }
  | { activeVoices: number }
  | { count: number };

interface TriggerEventPayload {
  pressId: number;
  voiceId?: number;
  velocity?: number;
  blocked?: unknown;
  zones?: unknown;
  layers?: unknown;
}

export const BUILTIN_IDS = BUILTIN_SYNTHS.map((s) => s.id);
