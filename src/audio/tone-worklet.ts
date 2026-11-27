// AudioWorklet 全局环境（AudioWorkletProcessor/registerProcessor/sampleRate）
// 由浏览器注入，DOM lib 不含其类型；用 @ts-nocheck 避免全局声明被编译进 worklet 包。
// @ts-nocheck
/**
 * 实时双纯音工作节点：调用与离线渲染完全相同的内核。
 *
 * 主线程通过 port 消息更新频率/相位/路由；节点输出立体声 L/R。
 */
import {
  createBlockOutput,
  createKernelState,
  renderBlock,
} from '../dsp/kernel';

interface WorkletMessage {
  type: 'freqs' | 'gains' | 'mode' | 'resetPhase' | 'master';
  freqs?: [number, number];
  gains?: [number, number];
  mode?: RouteMode;
  phases?: [number, number];
  master?: number;
}

class ToneProcessor extends AudioWorkletProcessor {
  private state: KernelState;
  private buf = createBlockOutput(128);
  private targetFreqs: [number, number];
  private blockCount = 0;

  constructor() {
    super();
    this.state = createKernelState(
      { freq: 440, phase: 0, gain: 0.2 },
      { freq: 443, phase: 0, gain: 0.2 },
      'split',
    );
    this.targetFreqs = [440, 443];
    this.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const m = e.data;
      switch (m.type) {
        case 'freqs':
          if (m.freqs) this.targetFreqs = m.freqs;
          break;
        case 'gains':
          if (m.gains) this.state.gains = m.gains;
          break;
        case 'mode':
          if (m.mode && m.mode !== this.state.mode) {
            this.state.mode = m.mode;
          }
          break;
        case 'resetPhase':
          if (m.phases) this.state.phases = [...m.phases];
          break;
        case 'master':
          if (typeof m.master === 'number') this.state.master = m.master;
          break;
      }
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    renderBlock(this.state, 128, sampleRate, this.targetFreqs, this.buf);
    out[0].set(this.buf.left);
    out[1].set(this.buf.right);
    if (out[2]) out[2].set(this.buf.sumRef);

    this.blockCount++;
    if (this.blockCount % 3 === 0) {
      // 每 3 块（约 8ms@128）上报一次；块内再做跨步降采样，
      // 绘图有效采样率约 6 kHz，足够画 1.2 kHz 以内纯音的包络与粗略波形
      const stride = 8;
      const m = Math.ceil(128 / stride);
      const pick = (src: Float32Array): Float32Array => {
        const out = new Float32Array(m);
        for (let i = 0, j = 0; i < src.length; i += stride, j++) out[j] = src[i];
        return out;
      };
      const left = pick(this.buf.left);
      const right = pick(this.buf.right);
      const sumRef = pick(this.buf.sumRef);
      const phaseDiff = pick(this.buf.phaseDiff);
      const freqA = pick(this.buf.freqA);
      const freqB = pick(this.buf.freqB);
      const envelope = pick(this.buf.envelope);
      this.port.postMessage(
        {
          left,
          right,
          sumRef,
          phaseDiff,
          freqA,
          freqB,
          envelope,
          phases: this.state.phases,
        },
        [left.buffer, right.buffer, sumRef.buffer, phaseDiff.buffer, freqA.buffer, freqB.buffer, envelope.buffer],
      );
    }
    return true;
  }
}

registerProcessor('tone-processor', ToneProcessor);
