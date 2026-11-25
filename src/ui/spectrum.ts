import type { Sideband } from '../audio/sidebands';

/**
 * 实时频谱视图: 画出 AnalyserNode 的 FFT 幅度谱,
 * 并在预测的侧带位置叠加竖线(别名侧带用红色)。
 */
export class SpectrumView {
  private ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private analyser: AnalyserNode | null = null;
  private data: Float32Array = new Float32Array(0);
  private markers: Sideband[] = [];
  private sampleRate = 48000;

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no 2d context');
    this.ctx = c;
    this.drawIdle();
  }

  attachAnalyser(analyser: AnalyserNode, sampleRate: number): void {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.data = new Float32Array(analyser.frequencyBinCount);
    this.start();
  }

  setMarkers(markers: Sideband[]): void {
    this.markers = markers;
  }

  private get w(): number {
    return this.canvas.width;
  }
  private get h(): number {
    return this.canvas.height;
  }

  private start(): void {
    const loop = () => {
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  private freqToX(hz: number): number {
    // 线性频率轴 0..Nyquist
    return (hz / (this.sampleRate / 2)) * this.w;
  }

  private dbToY(db: number): number {
    const minDb = -100;
    const maxDb = -10;
    const k = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
    return this.h - k * this.h;
  }

  private drawIdle(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#0d1322';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#5a6b8c';
    ctx.font = '14px sans-serif';
    ctx.fillText('按下任意音符后显示实时频谱', 16, this.h / 2);
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#0d1322';
    ctx.fillRect(0, 0, this.w, this.h);

    // 网格 + 频率刻度
    ctx.strokeStyle = '#1d2740';
    ctx.fillStyle = '#5a6b8c';
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    const nyquist = this.sampleRate / 2;
    for (let khz = 0; khz <= Math.floor(nyquist / 1000); khz++) {
      const x = this.freqToX(khz * 1000);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
      ctx.stroke();
      if (khz % 2 === 0) ctx.fillText(`${khz}k`, x + 3, this.h - 4);
    }

    if (this.analyser) {
      this.analyser.getFloatFrequencyData(this.data);
      ctx.strokeStyle = '#d7e3ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const binHz = nyquist / (this.data.length - 1);
      for (let i = 0; i < this.data.length; i++) {
        const x = this.freqToX(i * binHz);
        const y = this.dbToY(this.data[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 侧带预测竖线
    for (const sb of this.markers) {
      const x = this.freqToX(sb.audibleHz);
      ctx.strokeStyle = sb.aliased ? '#ff5d5d' : sb.order === 0 ? '#7dffa8' : '#7aa2ff';
      ctx.lineWidth = sb.order === 0 ? 2 : 1;
      ctx.globalAlpha = Math.min(1, 0.35 + Math.max(0, (sb.levelDb + 60) / 60));
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nyquist 边界提示文字
    ctx.fillStyle = '#ff5d5d';
    ctx.fillText(`Nyquist ${(nyquist / 1000).toFixed(1)}k`, this.w - 96, 14);
  }
}
