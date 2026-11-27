import type { ToneEngine } from './engine';
import {
  analyzeSeam,
  renderSegment,
  segmentWav,
  toAudioBuffer,
  type SeamInfo,
  type SegmentSpec,
} from './segment';
import { downloadBlob } from '../dsp/wav';
import type { OfflineResult } from '../dsp/kernel';

/**
 * 选段状态机：离线渲染（与实时引擎同一内核）→ WAV 导出 → 两种循环试听。
 *
 * reset：每轮重新从设定起点相位开始（循环播放同一缓冲，缓冲首样本即设定相位）。
 * cont ：硬循环，末样本直接接回首样本，可直接观察接缝处相位是否接上。
 */
export class SegmentController {
  spec: SegmentSpec;
  result: OfflineResult | null = null;
  buffer: AudioBuffer | null = null;
  seam: SeamInfo | null = null;
  loopMode: 'reset' | 'cont' = 'reset';
  private source: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private startOffset = 0;
  private raf = 0;
  private onPlayPos: ((p: number | null) => void) | null = null;

  constructor(
    private engine: ToneEngine,
    spec: SegmentSpec,
  ) {
    this.spec = spec;
  }

  setPlayPosCallback(cb: (p: number | null) => void) {
    this.onPlayPos = cb;
  }

  render(sampleRate: number) {
    this.result = renderSegment(this.spec, sampleRate);
    this.stopLoop();
    this.buffer = toAudioBuffer(this.result, this.engine.ctx!);
    this.seam = analyzeSeam(this.spec, this.result);
    return { result: this.result, seam: this.seam };
  }

  exportWav(bitDepth: 16 | 32) {
    if (!this.result) throw new Error('请先渲染选段');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(segmentWav(this.result, bitDepth), `beats_${stamp}.wav`);
  }

  async playLoop() {
    if (!this.buffer) throw new Error('请先渲染选段');
    this.stopLoop();
    // reset 与 cont 用同一缓冲；区别只在讲解与接缝高亮：
    // reset 模式下用户可随时"倒回段首"，每轮听到的起点都是设定相位；
    // cont 模式下硬循环的接缝保持原样，暴露相位不连续。
    this.source = await this.engine.playBuffer(this.buffer, true, 0);
    this.startCtxTime = this.engine.ctx!.currentTime;
    this.startOffset = 0;
    this.tick();
  }

  /** 倒回段首重听：停止当前实例，从 offset=0 重新起播 */
  async rewind() {
    if (!this.buffer) return;
    this.stopLoop();
    this.source = await this.engine.playBuffer(this.buffer, true, 0);
    this.startCtxTime = this.engine.ctx!.currentTime;
    this.startOffset = 0;
    this.tick();
  }

  stopLoop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* 已停止 */
      }
      this.source.disconnect();
      this.source = null;
    }
    cancelAnimationFrame(this.raf);
    this.onPlayPos?.(null);
  }

  private tick = () => {
    if (!this.buffer || !this.engine.ctx) return;
    const elapsed = this.engine.ctx.currentTime - this.startCtxTime + this.startOffset;
    const dur = this.buffer.duration;
    const pos = this.loopMode === 'reset' ? elapsed % dur : elapsed % dur;
    this.onPlayPos?.(Math.min(1, pos / dur));
    this.raf = requestAnimationFrame(this.tick);
  };

  get isPlaying() {
    return this.source !== null;
  }
}
