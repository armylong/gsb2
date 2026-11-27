/// <reference path="types.ts" />
namespace Adaptive {

  /**
   * 纯逻辑状态机: 决定每个小节是什么段落, 以及每条切换请求的生命周期.
   * 不接触音频时钟与 DOM, clickBeat 由 Transport 换算后传入, 方便单测.
   *
   * 关键模型 —— 预排与提交分离:
   *  - peekBar(bar): 纯函数, 只回答「bar 听起来会是什么段落」, 不改状态.
   *    Transport 用它做音频前瞻调度(最多提前 0.3s, 短于一个小节 2.5s).
   *  - onBarStart(bar): 小节下拍、听众真正听到时才提交, 推进 current/currentKind.
   * 因此「过门已经开始」严格等于过门的下拍时刻已经发声, 预排队列里排队等待的
   * 过门仍可被新请求取消, 不会被误判成进行中.
   *
   * 规则:
   *  - 主段中收到请求: 过门排在「点击所在小节的下一个小节边界」(clickBar+1).
   *  - 过门发声前又来请求: 旧请求标记 superseded, 其过门永不播放, 以最新请求为准.
   *  - 过门已经开始: 新请求标记 merged, 当前过门一定演完; 新目标在过门结束后的
   *    下一次转换里生效.
   */
  export class MusicStateMachine {
    private current: SectionId = 'calm';
    private currentKind: BarKind = 'main-calm';
    private pending: RequestRecord | null = null;
    private playing = false;
    private lastBar = -1;
    private seq = 0;
    private records: RequestRecord[] = [];
    private listeners: ((e: RequestEvent) => void)[] = [];

    onChange(fn: (e: RequestEvent) => void): void {
      this.listeners.push(fn);
    }

    private emit(e: RequestEvent): void {
      for (const fn of this.listeners) fn(e);
    }

    private makeRecord(target: SectionId, clickBeat: number, origin: RequestRecord['origin']): RequestRecord {
      const clickBar = Math.floor(clickBeat / BEATS_PER_BAR);
      return {
        id: ++this.seq,
        origin,
        target,
        sourceAtClick: this.current,
        clickBeat,
        clickBar,
        plannedFillBar: null,
        actualFillBar: null,
        status: 'pending',
        note: '',
      };
    }

    isPlaying(): boolean { return this.playing; }
    getCurrentSection(): SectionId { return this.current; }
    getCurrentKind(): BarKind { return this.currentKind; }
    getPending(): RequestRecord | null { return this.pending; }
    getRecords(): readonly RequestRecord[] { return this.records; }
    getLastBar(): number { return this.lastBar; }

    setPlaying(playing: boolean): void { this.playing = playing; }

    /**
     * 处理一次场景切换请求. 返回产生(或更新)的记录.
     */
    request(target: SectionId, origin: RequestRecord['origin'], clickBeat: number): RequestRecord {
      const rec = this.makeRecord(target, clickBeat, origin);
      this.records.push(rec);

      if (isFill(this.currentKind)) {
        // 规则 3: 过门已在下拍发声, 必须演完. 新请求并入, 等过门结束后再排下一次转换.
        const old = this.pending;
        if (old) {
          old.status = 'superseded';
          old.note = `过门进行中又被请求 #${rec.id} 的最新目标覆盖`;
          this.emit({ type: 'status', record: old });
        }
        rec.status = 'merged';
        rec.plannedFillBar = null;
        rec.note = `过门 ${this.currentKind} 已在播放, 必须演完; 本请求接管下一次转换`;
        this.pending = rec;
        this.emit({ type: 'request', record: rec });
        return rec;
      }

      if (target === this.current && this.pending === null) {
        rec.status = 'same-target';
        rec.note = '目标段落与当前段落一致, 无需过门';
        this.emit({ type: 'request', record: rec });
        return rec;
      }

      // 主段中: 过门排在点击小节的下一个小节边界(可解释的边界).
      rec.plannedFillBar = rec.clickBar + 1;
      rec.note = `预计在 bar ${rec.plannedFillBar} 边界(拍 ${rec.plannedFillBar * BEATS_PER_BAR})插入过门`;

      if (this.pending) {
        // 规则 2: 两次点击都在切换之前, 旧请求被覆盖, 被取消的过门不播放.
        const old = this.pending;
        old.status = 'superseded';
        old.note = `在拍 ${clickBeat.toFixed(2)} 被请求 #${rec.id} 覆盖, 原定 bar ${old.plannedFillBar} 的过门未播放`;
        this.pending = rec;
        this.emit({ type: 'request', record: rec, superseded: old, invalidateFromBar: old.plannedFillBar ?? undefined });
        this.emit({ type: 'status', record: old });
      } else {
        this.pending = rec;
        this.emit({ type: 'request', record: rec });
      }
      return rec;
    }

    /**
     * 纯函数: 前瞻规划 bar 会是什么段落, 不修改任何状态.
     * 不变量: 前瞻窗口(0.3s)短于一个小节(2.5s), peek 一个小节时,
     * 它之前所有小节的提交都已发生, 因此决策所需状态均已确定.
     */
    peekBar(bar: number): BarKind {
      if (this.pending && bar === this.pending.plannedFillBar) {
        return this.pending.target === this.current
          ? mainKind(this.current)
          : fillKind(this.current);
      }
      if (isFill(this.currentKind) && this.pending) {
        // 过门的下一小节: 先落目标主段; 并入请求的新过门在再下一个边界(提交时挂牌).
        return mainKind(this.current);
      }
      return mainKind(this.current);
    }

    /**
     * 小节下拍(听众真正听到)时提交一次, 返回该小节规划与伴随事件.
     */
    onBarStart(bar: number): BarArrival {
      const events: RequestEvent[] = [];
      let kind: BarKind = mainKind(this.current);
      let related: RequestRecord | null = null;

      if (this.pending && bar === this.pending.plannedFillBar) {
        const rec = this.pending;
        related = rec;
        if (rec.target === this.current) {
          // 挂起请求到点时目标已是当前段落(典型: 反向点击取消了切换).
          kind = mainKind(this.current);
          rec.status = 'same-target';
          rec.note = `计划边界 bar ${bar} 到达时, 目标已是当前段落, 不插过门`;
          events.push({ type: 'status', record: rec });
          this.pending = null;
        } else {
          // 规则 1: 过门在整小节边界发声, 结束后正好落在目标段落.
          kind = fillKind(this.current);
          rec.status = 'locked';
          rec.actualFillBar = bar;
          rec.note = `过门在 bar ${bar} 边界(拍 ${bar * BEATS_PER_BAR})锁定发声`;
          events.push({ type: 'status', record: rec });
          this.current = rec.target;
          this.currentKind = kind;
          rec.status = 'effective';
          rec.note = `过门在 bar ${bar} 整小节边界播放, bar ${bar + 1} 起进入${rec.target === 'lively' ? '热闹区' : '静区'}`;
          events.push({ type: 'status', record: rec });
          this.pending = null;
        }
      } else if (isFill(this.currentKind) && this.pending) {
        // 上一小节是过门, 且有 merged 请求接管: 本小节先演目标主段, 新转换排到再下一个边界.
        const rec = this.pending;
        related = rec;
        kind = mainKind(this.current);
        if (rec.target === this.current) {
          rec.status = 'same-target';
          rec.note = '过门终点段落即请求目标, 无需再次转换';
          events.push({ type: 'status', record: rec });
          this.pending = null;
        } else {
          rec.plannedFillBar = bar + 1;
          rec.status = 'pending';
          rec.note = `过门已演完, 新转换按请求 #${rec.id} 排在 bar ${bar + 1} 边界(拍 ${(bar + 1) * BEATS_PER_BAR})`;
          events.push({ type: 'status', record: rec });
        }
      } else {
        kind = mainKind(this.current);
      }

      this.lastBar = bar;
      this.currentKind = kind;
      return { bar, kind, record: related, events };
    }

    /** 规则 4: 从头开始清理所有旧请求. */
    reset(): RequestEvent[] {
      const events: RequestEvent[] = [];
      for (const r of this.records) {
        if (r.status === 'pending' || r.status === 'locked' || r.status === 'merged') {
          r.status = 'cleared';
          r.note = '从头开始, 挂起请求被清理';
          events.push({ type: 'status', record: r });
        }
      }
      this.records = [];
      this.pending = null;
      this.current = 'calm';
      this.currentKind = 'main-calm';
      this.lastBar = -1;
      this.seq = 0;
      for (const e of events) this.emit(e);
      return events;
    }
  }
}
