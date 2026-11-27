/// <reference path="types.ts" />
/// <reference path="state-machine.ts" />
/// <reference path="audio-engine.ts" />
namespace Adaptive {

  /**
   * 传输层: Web Audio 前瞻调度器 + 状态机 + 音频引擎.
   * 节拍完全由 AudioContext 时钟驱动; 暂停即 suspend 上下文,
   * currentTime 冻结, 拍位与挂起请求原样保留.
   */
  export class Transport {
    private engine = new AudioEngine();
    private sm = new MusicStateMachine();
    private timer: number | null = null;
    private playing = false;

    private nextBar = 0;          // 下一个待排小节(前瞻游标)
    private committedBar = -1;    // 已下拍提交的小节(听众真正听到的)
    private nextBarTime = 0;     // 该小节第一拍的 AudioContext 绝对时间
    private originAudioTime = 0; // 拍 0 对应的 AudioContext 时间
    private barKinds: BarKind[] = [];
    private uiListeners: ((e: RequestEvent) => void)[] = [];

    private static readonly LOOKAHEAD_SEC = 0.3;
    private static readonly TIMER_MS = 25;

    constructor() {
      this.sm.onChange((e) => {
        // 请求覆盖了尚未发声的小节规划: 停掉预排声音并回滚调度游标,
        // 让 tick 按新规划重新排, 保证被取消的过门绝不发声.
        // (已下拍的小节不会出现在 invalidate 范围里, committedBar 无需改动)
        if (e.invalidateFromBar !== undefined && e.invalidateFromBar < this.nextBar) {
          this.engine.cancelFromBar(e.invalidateFromBar);
          this.barKinds.length = Math.min(this.barKinds.length, e.invalidateFromBar);
          this.nextBar = e.invalidateFromBar;
          this.nextBarTime = this.beatToAudioTime(this.nextBar * BEATS_PER_BAR);
        }
        for (const fn of this.uiListeners) fn(e);
      });
    }

    get state(): MusicStateMachine { return this.sm; }
    get audio(): AudioEngine { return this.engine; }
    get isPlaying(): boolean { return this.playing; }

    onRequestEvent(fn: (e: RequestEvent) => void): void { this.uiListeners.push(fn); }

    beatToAudioTime(beat: number): number {
      return this.originAudioTime + beat * SECONDS_PER_BEAT;
    }

    /** 当前听到的拍位(暂停时上下文冻结, 该值自然停住). */
    currentBeat(): number {
      return Math.max(0, (this.engine.currentTime - this.originAudioTime) / SECONDS_PER_BEAT);
    }

    kindAtBar(bar: number): BarKind | null {
      return this.barKinds[bar] ?? null;
    }

    async start(): Promise<void> {
      if (this.playing) return;
      await this.engine.resume();
      this.originAudioTime = this.engine.currentTime + 0.15;
      this.nextBar = 0;
      this.committedBar = -1;
      this.nextBarTime = this.originAudioTime;
      this.barKinds = [];
      this.sm.setPlaying(true);
      this.playing = true;
      this.timer = window.setInterval(() => this.tick(), Transport.TIMER_MS);
    }

    async pause(): Promise<void> {
      if (!this.playing) return;
      if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
      this.playing = false;
      this.sm.setPlaying(false);
      await this.engine.suspend(); // 冻结音频时钟, 已排声音与拍位一并挂起
    }

    async resume(): Promise<void> {
      if (this.playing) return;
      await this.engine.resume(); // 时钟从冻结点继续, origin/nextBarTime 无需修正
      this.sm.setPlaying(true);
      this.playing = true;
      this.timer = window.setInterval(() => this.tick(), Transport.TIMER_MS);
    }

    /** 从头开始: 停掉全部预排声音, 清理全部请求, 回到静区第 0 小节. */
    reset(): void {
      if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
      this.playing = false;
      this.engine.cancelAll();
      this.sm.reset();
      this.sm.setPlaying(false);
      this.barKinds = [];
      this.nextBar = 0;
      this.committedBar = -1;
      this.nextBarTime = 0;
      this.originAudioTime = 0;
    }

    setVolume(v: number): void { this.engine.setVolume(v); }

    /** 用户/脚本点击下一场景; 返回请求记录(含预计与实际生效拍位). */
    request(target: SectionId, origin: RequestRecord['origin'] = 'user'): RequestRecord {
      return this.sm.request(target, origin, this.currentBeat());
    }

    /** 测试钩子: 手动驱动一次前瞻调度(生产环境由内部 setInterval 驱动). */
    debugTick(): void { this.tick(); }

    private tick(): void {
      const now = this.engine.currentTime;

      // 1) 提交: 已到下拍时刻的小节才推进状态机(听众真正听到的边界).
      while (this.committedBar + 1 < this.nextBar &&
             this.beatToAudioTime((this.committedBar + 1) * BEATS_PER_BAR) <= now) {
        const bar = this.committedBar + 1;
        this.sm.onBarStart(bar);
        this.committedBar = bar;
      }

      // 2) 前瞻: 用纯函数 peekBar 规划未来小节并预排声音, 不改变状态机状态.
      const horizon = now + Transport.LOOKAHEAD_SEC;
      while (this.nextBarTime < horizon) {
        const kind = this.sm.peekBar(this.nextBar);
        this.engine.scheduleBar(this.nextBar, this.nextBarTime, kind);
        this.barKinds[this.nextBar] = kind;
        this.nextBar += 1;
        this.nextBarTime += SECONDS_PER_BAR;
      }
    }
  }
}
