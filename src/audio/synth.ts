// 程序合成节拍声：不加载任何采样，全部用振荡器/噪声实时拼。
// 三种声音：kick（普通拍）、accent（小节第一拍，kick+金属音）、hat（细分拍，可选）。

interface ScheduledVoice {
  nodes: AudioScheduledSourceNode[];
  when: number;
}

export class Synth {
  private ctx: AudioContext;
  private master: GainNode;
  private pending = new Set<ScheduledVoice>();
  /** 主音量 0..1。 */
  volume = 0.8;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** 底鼓：频率快速下滑的正弦 + 短振幅包络。 */
  private kick(when: number, gain: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.22);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.25);
    this.track({ nodes: [osc], when });
  }

  /** 重音金属音：三角波短促高打亮，和 kick 叠加成小节首拍。 */
  private bell(when: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.25, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.2);
    this.track({ nodes: [osc], when });
  }

  /** 镲片：高通噪声爆音。 */
  private hat(when: number): void {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
    src.connect(hp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + 0.06);
    this.track({ nodes: [src], when });
  }

  private track(voice: ScheduledVoice): void {
    this.pending.add(voice);
    for (const n of voice.nodes) {
      n.onended = () => this.pending.delete(voice);
    }
  }

  /** 在 AudioContext 时间 when 上安排一个节拍声。 */
  scheduleBeat(when: number, accent: boolean, hat: boolean): void {
    if (when < this.ctx.currentTime - 0.02) return; // 已过去的不补
    this.kick(when, accent ? 0.9 : 0.65);
    if (accent) this.bell(when);
    if (hat) this.hat(when);
  }

  /** 输入命中的轻脆反馈音（跟判定走，不参与节拍调度）。 */
  scheduleBlip(when: number, good: boolean): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(good ? 660 : 330, when);
    g.gain.setValueAtTime(0.08, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.1);
  }

  /** 停掉所有还没发声的声音（暂停/跳转时调用，保证声画对齐）。 */
  cancelPending(): void {
    const nowT = this.ctx.currentTime;
    for (const voice of this.pending) {
      if (voice.when >= nowT - 0.01) {
        for (const n of voice.nodes) {
          try {
            n.stop();
          } catch {
            /* 已经开始/结束的节点 stop 会抛错，忽略 */
          }
        }
      }
    }
    this.pending.clear();
  }
}
