/**
 * 简单的鼓声合成：每一路一个音高，短促的衰减包络。
 * 所有已调度的发声体都登记在案，换代（gen 失效）时统一停掉，
 * 保证改完纸带后旧鼓点不会混进新试听。
 */
export class DrumKit {
  private ctx: AudioContext | null = null;
  private live: { osc: OscillatorNode; gen: number }[] = [];

  private ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  now(): number {
    return this.ensure().currentTime;
  }

  /** 在指定时刻敲某一路（0=高鼓 1=中鼓 2=低鼓） */
  hit(track: number, when: number, gen: number): void {
    const ctx = this.ensure();
    const freq = [660, 440, 180][track] ?? 330;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = track === 2 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, when + 0.12);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.8, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.2);
    this.live.push({ osc, gen });
    osc.onended = () => {
      this.live = this.live.filter((x) => x.osc !== osc);
    };
  }

  /** 停掉所有还在响 / 已排队的发声体（换摆法、停止、重新播放时调用） */
  silenceAll(): void {
    for (const { osc } of this.live) {
      try {
        osc.stop();
      } catch {
        /* 已停止的忽略 */
      }
    }
    this.live = [];
  }
}
