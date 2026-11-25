/**
 * AudioWorklet 处理器：在音频线程里跑同一个 VoiceEngine。
 *
 * 实时试听与离线渲染共用 VoiceEngine 这一份逐采样代码，
 * 所以手动按键听到的振幅过程与序列曲线同源。
 *
 * 注意：本文件运行在 AudioWorkletGlobalScope，没有 DOM 类型，
 * 下面显式声明 worklet 全局。
 */
import { VoiceEngine } from './VoiceEngine';
import { DEFAULT_TIMBRE } from './types';

// AudioWorklet 全局作用域（AudioWorkletGlobalScope）不在 DOM lib 里，显式声明
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

/** 振幅上报间隔（采样），约每 12ms 一帧，够画曲线又不淹没消息通道 */
const AMP_REPORT_INTERVAL = 512;

class EnvelopeVoiceProcessor extends AudioWorkletProcessor {
  private voice: VoiceEngine;
  private sampleCount = 0;
  private lastAmp = -1;

  constructor() {
    super();
    this.voice = new VoiceEngine(DEFAULT_TIMBRE, sampleRate);
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: 'noteOn'; velocity?: number }
        | { type: 'noteOff' }
        | { type: 'params'; mode: 'pending' | 'live'; params: Parameters<VoiceEngine['setParamsLive']>[0] }
        | { type: 'reset' };
      switch (msg.type) {
        case 'noteOn':
          this.voice.noteOn(msg.velocity ?? 1);
          break;
        case 'noteOff':
          this.voice.noteOff();
          break;
        case 'params':
          if (msg.mode === 'live') this.voice.setParamsLive(msg.params);
          else this.voice.setParamsPending(msg.params);
          break;
        case 'reset':
          this.voice.reset();
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const mono = channels[0];
    for (let i = 0; i < mono.length; i++) {
      const s = this.voice.process();
      for (let c = 0; c < channels.length; c++) channels[c][i] = s;
      this.sampleCount++;
      if (this.sampleCount % AMP_REPORT_INTERVAL === 0) {
        const amp = this.voice.amplitude();
        // 空闲时振幅恒为 0，只在变化时上报，避免无谓唤醒主线程重渲染
        if (amp !== this.lastAmp) {
          this.lastAmp = amp;
          this.port.postMessage({ type: 'amp', amp });
        }
      }
    }
    return true;
  }
}

registerProcessor('envelope-voice', EnvelopeVoiceProcessor);
