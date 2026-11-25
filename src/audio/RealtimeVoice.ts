/**
 * RealtimeVoice —— AudioWorklet 的主线程封装，负责手动按键的实时试听。
 *
 * 序列回放走离线渲染（OfflineRenderer）以保证逐采样确定；
 * 这里只处理「按住听 / 松开 / 改参数实时过渡」的交互场景。
 */
import type { TimbreParams } from './types';
// ?worker 让 Vite 用 worker 打包管线把 worklet 处理成独立单文件
// （import 会被内联、TS 会被转译）；?worker&url 直接拿到脚本 URL
import envelopeWorkletUrl from './envelope-worklet.ts?worker&url';

export type AmpListener = (amp: number) => void;

export class RealtimeVoice {
  private node: AudioWorkletNode | null = null;
  private ampListeners = new Set<AmpListener>();

  /** 必须在用户手势里调用（浏览器自动播放策略）。 */
  async ensure(ctx: AudioContext): Promise<void> {
    if (this.node) {
      if (ctx.state === 'suspended') await ctx.resume();
      return;
    }
    // Vite worker 管线产物是单文件脚本（无 import 语句），addModule 可直接加载
    await ctx.audioWorklet.addModule(envelopeWorkletUrl);
    this.node = new AudioWorkletNode(ctx, 'envelope-voice', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'amp') {
        for (const l of this.ampListeners) l(e.data.amp as number);
      }
    };
    if (ctx.state === 'suspended') await ctx.resume();
  }

  onAmp(listener: AmpListener): () => void {
    this.ampListeners.add(listener);
    return () => this.ampListeners.delete(listener);
  }

  noteOn(velocity = 1): void {
    this.node?.port.postMessage({ type: 'noteOn', velocity });
  }

  noteOff(): void {
    this.node?.port.postMessage({ type: 'noteOff' });
  }

  /**
   * 发送参数变更。
   * mode='pending'：worklet 内挂起，下一次 noteOn 才生效，当前声音不变；
   * mode='live'：以当前电平为锚点重建当前段，平滑过渡，无瞬时跳变。
   */
  setParams(params: TimbreParams, mode: 'pending' | 'live'): void {
    this.node?.port.postMessage({ type: 'params', params, mode });
  }

  reset(): void {
    this.node?.port.postMessage({ type: 'reset' });
  }

  dispose(): void {
    this.node?.disconnect();
    this.node = null;
    this.ampListeners.clear();
  }
}

/**
 * 播放一段离线渲染好的 PCM。返回控制器，可暂停 / 恢复 / 停止。
 * 暂停只挂起调度，恢复后从原采样位置继续，各触发点的相对位置不变。
 */
export class PcmPlayer {
  private ctx: AudioContext;
  private buffer: AudioBuffer;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private onEnded: () => void;

  constructor(
    ctx: AudioContext,
    pcm: Float32Array,
    sampleRate: number,
    onEnded: () => void,
  ) {
    this.ctx = ctx;
    this.buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const channel = this.buffer.getChannelData(0);
    channel.set(pcm);
    this.onEnded = onEnded;
  }

  get duration(): number {
    return this.buffer.duration;
  }

  /** 当前播放位置（秒），暂停时停在暂停点。 */
  get position(): number {
    if (!this.source) return this.offset;
    return Math.min(this.buffer.duration, this.offset + this.ctx.currentTime - this.startedAt);
  }

  get isPlaying(): boolean {
    return this.source !== null;
  }

  async play(): Promise<void> {
    if (this.source) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.ctx.destination);
    src.onended = () => {
      // 手动 stop 也会触发；只在自然播完时回调
      if (this.source === src) {
        this.source = null;
        this.offset = 0;
        this.onEnded();
      }
    };
    this.startedAt = this.ctx.currentTime;
    src.start(0, this.offset);
    this.source = src;
  }

  pause(): void {
    if (!this.source) return;
    this.offset = this.position;
    const src = this.source;
    this.source = null;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* 已停止的节点再 stop 会抛错，忽略 */
    }
  }

  /**
   * 移动播放位置。播放中会从新位置无缝继续；暂停时只记录偏移。
   * 由于播的是同一份离线 PCM，任意偏移处的事件相对关系都与原渲染一致。
   */
  seek(time: number): void {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    this.offset = Math.max(0, Math.min(this.buffer.duration, time));
    if (wasPlaying) void this.play();
  }

  stop(): void {
    this.pause();
    this.offset = 0;
  }
}
