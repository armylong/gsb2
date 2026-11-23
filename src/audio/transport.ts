import { beatToTime, secondsPerBeat } from '../engine/chart.ts';
import type { ChartConfig } from '../engine/types.ts';
import { Synth } from './synth.ts';

/**
 * 传输层：把“歌曲时间轴”接到 AudioContext 时钟上。
 *  - 歌曲时间 songTime 是唯一权威时间，引擎/画面都读它；
 *  - audioOffsetSec 只移动声音相对画面的位置（正=声音晚），判定不读它；
 *  - 节拍声用 25ms 轮询 + 120ms 前瞻调度，暂停时取消所有未发声节点。
 */
export class Transport {
  private synth: Synth;
  private ctx: AudioContext;
  config: ChartConfig;

  state: 'stopped' | 'running' | 'paused' = 'stopped';
  /** 歌曲时间轴当前时刻（秒）。 */
  songTime = 0;
  /** 手动音频偏移（秒）：声音时刻 = 歌曲时刻 + offset。 */
  audioOffsetSec = 0;
  /** 是否播放半拍镲片（方便听细分）。 */
  subdivisionHats = false;
  /** 节拍预览开关（暂停/重放模拟时可关）。 */
  metronomeOn = true;

  /** running 起点：ctxTimeOrigin 对应 songOrigin。 */
  private ctxTimeOrigin = 0;
  private songOrigin = 0;
  private nextBeatIndex = 0;
  private nextHalfIndex = 0;
  private timer: number | null = null;
  private durationSec: number;

  constructor(ctx: AudioContext, config: ChartConfig, durationSec: number) {
    this.ctx = ctx;
    this.synth = new Synth(ctx);
    this.config = config;
    this.durationSec = durationSec;
  }

  setConfig(config: ChartConfig, durationSec: number): void {
    this.config = config;
    this.durationSec = durationSec;
  }

  setVolume(v: number): void {
    this.synth.setVolume(v);
  }

  setOffset(sec: number): void {
    // 改偏移时重新锚定原点，让 songTime 不跳、声音位置平滑切换。
    if (this.state === 'running') {
      const songNow = this.songTime;
      this.ctxTimeOrigin = this.ctx.currentTime;
      this.songOrigin = songNow;
    }
    this.audioOffsetSec = sec;
  }

  /** 当前歌曲时间（秒），停止时停在 songTime。 */
  currentSongTime(): number {
    if (this.state !== 'running') return this.songTime;
    return this.songOrigin + (this.ctx.currentTime - this.ctxTimeOrigin);
  }

  async start(fromSongTime = this.songTime): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.songTime = fromSongTime;
    this.songOrigin = fromSongTime;
    this.ctxTimeOrigin = this.ctx.currentTime;
    this.nextBeatIndex = Math.floor(fromSongTime / secondsPerBeat(this.config.bpm));
    this.nextHalfIndex = this.nextBeatIndex * 2;
    this.state = 'running';
    this.runScheduler();
  }

  pause(): number {
    const t = this.currentSongTime();
    this.songTime = t;
    this.state = 'paused';
    this.stopScheduler();
    this.synth.cancelPending(); // 规则：未发出的节拍声全部撤掉
    return t;
  }

  resume(): void {
    if (this.state !== 'paused') return;
    void this.start(this.songTime);
  }

  stop(): void {
    this.state = 'stopped';
    this.songTime = 0;
    this.stopScheduler();
    this.synth.cancelPending();
  }

  /** 跳到歌曲时间（秒）。由外部先做引擎 seek，再调它对齐声音。 */
  seek(songTime: number): void {
    this.songTime = songTime;
    this.synth.cancelPending();
    if (this.state === 'running') {
      this.songOrigin = songTime;
      this.ctxTimeOrigin = this.ctx.currentTime;
      this.nextBeatIndex = Math.floor(songTime / secondsPerBeat(this.config.bpm));
      this.nextHalfIndex = this.nextBeatIndex * 2;
    }
  }

  blip(good: boolean): void {
    if (this.state === 'running') this.synth.scheduleBlip(this.ctx.currentTime, good);
  }

  private stopScheduler(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private runScheduler(): void {
    this.stopScheduler();
    const lookahead = 0.12;
    const tick = (): void => {
      if (this.state !== 'running') return;
      const horizonSong = this.currentSongTime() + lookahead;
      const spb = secondsPerBeat(this.config.bpm);
      const totalBeats = this.config.measures * this.config.beatsPerMeasure;

      // 整拍：首拍 accent。
      while (this.nextBeatIndex < totalBeats) {
        const beatSong = beatToTime(this.nextBeatIndex, this.config.bpm);
        if (beatSong > horizonSong) break;
        const at = this.ctxTimeOrigin + (beatSong - this.songOrigin) + this.audioOffsetSec;
        const accent = this.nextBeatIndex % this.config.beatsPerMeasure === 0;
        if (this.metronomeOn) this.synth.scheduleBeat(at, accent, false);
        this.nextBeatIndex++;
      }

      // 半拍镲片（可选），不与整拍重叠。
      if (this.subdivisionHats) {
        while (this.nextHalfIndex < totalBeats * 2) {
          const halfSong = (this.nextHalfIndex * spb) / 2;
          if (halfSong > horizonSong) break;
          if (this.nextHalfIndex % 2 === 1) {
            const at =
              this.ctxTimeOrigin + (halfSong - this.songOrigin) + this.audioOffsetSec;
            if (this.metronomeOn) this.synth.scheduleBeat(at, false, true);
          }
          this.nextHalfIndex++;
        }
      }

      // 播完自动停（停在末尾，不偷偷循环）。
      if (this.currentSongTime() >= this.durationSec) {
        this.songTime = this.durationSec;
        this.state = 'stopped';
        this.stopScheduler();
      }
    };
    tick();
    this.timer = window.setInterval(tick, 25);
  }
}
