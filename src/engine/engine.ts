import { beatToTime } from './chart.ts';
import { gradeDelta } from './judge.ts';
import type {
  CandidateInfo,
  Chart,
  Grade,
  InputEvent,
  JudgementRow,
  RuntimeTarget,
  ScoreSummary,
} from './types.ts';

/**
 * 判定引擎。纯逻辑：
 *  - 只认绝对歌曲时间戳，update(t) 推进到哪算到哪，与帧率/rAF 完全无关；
 *  - 真人输入和重放输入走同一个 queueInput 通道；
 *  - 所有判法都落 JudgementRow，界面和测试只消费这份流水。
 */
export class Engine {
  readonly chart: Chart;
  readonly targets: RuntimeTarget[];
  readonly log: JudgementRow[] = [];
  /** 引擎当前时间（秒，歌曲轴）。 */
  now = 0;
  paused = false;

  private queue: InputEvent[] = [];
  /** 轨 → 正在按住的目标。一次 down 只会挂一个。 */
  private activeDown = new Map<string, RuntimeTarget>();
  private seq = 0;

  constructor(chart: Chart) {
    this.chart = chart;
    this.targets = chart.targets.map((t) => ({
      ...t,
      state: 'pending' as const,
      finalGrade: null,
      lastDeltaMs: null,
    }));
  }

  get config() {
    return this.chart.config;
  }

  /** 目标头拍时刻（秒）。 */
  headAt(t: RuntimeTarget): number {
    return beatToTime(t.beat, this.config.bpm);
  }

  /** 长按尾拍时刻（秒）；tap 的尾等于头。 */
  tailAt(t: RuntimeTarget): number {
    return beatToTime(t.beat + t.lengthBeats, this.config.bpm);
  }

  /** 外部（真人或重放）投递一次输入。允许比 now 早（立刻处理）或提前入队。 */
  queueInput(e: InputEvent): void {
    this.queue.push(e);
  }

  /** 推进到歌曲时间 t（秒）。同一 t 重复调用是幂等的。 */
  update(t: number): void {
    if (this.paused) return;
    if (t < this.now) {
      // seek 之外不允许倒带；倒带请走 seek()，那里有明确的状态清理规则。
      return;
    }
    this.now = t;
    this.drainInput();
    this.scanAuto();
  }

  // --------------------------------------------------------------- 输入处理

  private drainInput(): void {
    // 时刻相同按入队顺序；这保证重放脚本的确定性。
    this.queue.sort((a, b) => a.t - b.t);
    while (this.queue.length && this.queue[0].t <= this.now + 1e-9) {
      const e = this.queue.shift()!;
      if (e.kind === 'down') this.handleDown(e);
      else this.handleUp(e);
    }
  }

  private handleDown(e: InputEvent): void {
    // 该轨已经按住：重复 down 记 ignored，不影响任何板。
    if (this.activeDown.has(e.lane)) {
      this.pushRow(e, null, 'ignored', null, { note: '该轨已有按住中的事件，重复按下忽略' });
      return;
    }

    // 候选 = 窗口内所有未结算板的头拍（含异轨，仅用于复盘展示）。
    const all = this.targets.filter((t) => t.state === 'pending');
    const candidates: CandidateInfo[] = [];
    const sameLane: { t: RuntimeTarget; delta: number }[] = [];

    for (const t of all) {
      const at = this.headAt(t);
      const delta = e.t - at;
      if (Math.abs(delta) <= this.config.goodWindow + 1e-9) {
        candidates.push({
          targetId: t.id,
          lane: t.lane,
          part: 'head',
          at,
          deltaMs: delta * 1000,
          sameLane: t.lane === e.lane,
          won: false,
        });
        if (t.lane === e.lane) sameLane.push({ t, delta });
      }
    }

    if (sameLane.length === 0) {
      // 按多了：窗口里没有本轨待判板，不消耗任何目标。
      const note =
        candidates.length > 0
          ? '窗口内只有异轨地板，本次输入不抢占'
          : '判定窗口内没有待判地板';
      this.pushRow(e, null, 'ignored', null, { candidates, note });
      return;
    }

    // 同轨决胜：|Δ| 最小 → 更早拍位 → id 字典序。完全确定，无随机性。
    sameLane.sort((a, b) => {
      const c = Math.abs(a.delta) - Math.abs(b.delta);
      if (c !== 0) return c;
      if (a.t.beat !== b.t.beat) return a.t.beat - b.t.beat;
      return a.t.id.localeCompare(b.t.id);
    });
    const winner = sameLane[0].t;
    const winnerDelta = sameLane[0].delta;
    const grade = gradeDelta(winnerDelta, this.config.perfectWindow, this.config.goodWindow)!;

    this.markCandidates(candidates, winner.id);
    if (winner.lengthBeats > 0) {
      // 长按：头拍先记账，进入 held，等 up / 尾拍 / 暂停 / seek 收尾。
      winner.state = 'held';
      winner.lastDeltaMs = winnerDelta * 1000;
      this.activeDown.set(e.lane, winner);
      this.pushRow(e, winner, grade, winnerDelta * 1000, { candidates, kind: 'head' });
    } else {
      winner.state = 'done';
      winner.finalGrade = grade;
      winner.lastDeltaMs = winnerDelta * 1000;
      this.pushRow(e, winner, grade, winnerDelta * 1000, { candidates });
    }
  }

  private handleUp(e: InputEvent): void {
    const held = this.activeDown.get(e.lane);
    if (!held) {
      // 没有对应按住：静默丢弃（抬手本身不是一次“击打”，不刷日志噪音）。
      return;
    }
    this.activeDown.delete(e.lane);
    const tail = this.tailAt(held);
    const delta = e.t - tail;
    const g = gradeDelta(delta, this.config.perfectWindow, this.config.goodWindow);
    const grade: Grade = g ?? 'miss';
    held.state = 'done';
    held.finalGrade = grade;
    held.lastDeltaMs = delta * 1000;
    this.pushRow(
      { ...e, kind: 'up' },
      held,
      grade,
      delta * 1000,
      { kind: 'tail', note: g ? '在尾拍窗口内松手' : '尾拍窗口外松手，长按提前/滞后释放' },
    );
  }

  // --------------------------------------------------------------- 自动结算

  private scanAuto(): void {
    for (const t of this.targets) {
      const head = this.headAt(t);
      if (t.state === 'pending') {
        // 严格大于窗口才 miss：恰好压线的输入仍有资格命中（闭区间）。
        if (this.now - head > this.config.goodWindow + 1e-9) {
          t.state = 'done';
          t.finalGrade = 'miss';
          t.lastDeltaMs = null;
          this.pushRow({ t: head, kind: 'down', lane: t.lane }, t, 'miss', null, {
            source: 'auto',
            note: '超过 good 窗口仍无输入，自动 miss',
          });
        }
      } else if (t.state === 'held') {
        const tail = this.tailAt(t);
        if (this.now >= tail - 1e-9) {
          // 跨过尾拍还按着：尾拍自动 perfect 收掉（头拍成绩保持在流水里）。
          this.activeDown.delete(t.lane);
          t.state = 'done';
          t.finalGrade = 'perfect';
          t.lastDeltaMs = 0;
          this.pushRow({ t: tail, kind: 'up', lane: t.lane }, t, 'perfect', 0, {
            source: 'auto',
            kind: 'tail',
            note: '按住跨过尾拍，尾拍自动 perfect 结算',
          });
        }
      }
    }
  }

  // --------------------------------------------------------------- 暂停 / 跳转

  /**
   * 暂停清理规则（明确、可复现）：
   * 所有 held 目标在暂停时刻 t 按“尾拍释放”规则立即结算——
   * 在尾拍窗口内松手按窗口给档，否则 miss；暂停后不存在任何残留按住状态。
   */
  pause(t: number): void {
    this.update(t);
    for (const [lane, target] of [...this.activeDown.entries()]) {
      const tail = this.tailAt(target);
      const delta = t - tail;
      const g = gradeDelta(delta, this.config.perfectWindow, this.config.goodWindow);
      const grade: Grade = g ?? 'miss';
      this.activeDown.delete(lane);
      target.state = 'done';
      target.finalGrade = grade;
      target.lastDeltaMs = delta * 1000;
      this.pushRow({ t, kind: 'up', lane }, target, grade, delta * 1000, {
        source: 'pause',
        kind: 'tail',
        note: '暂停瞬间强制释放按住事件',
      });
    }
    this.queue = [];
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /**
   * 从某一小节（0 基）重新练习。两类目标分开处理：
   *  - 头拍 >= 小节起点：重置为 pending 并删掉历史流水（这一段要重练）；
   *    若此刻仍 held，先补一条 seek 来源的强制释放记录，再随重置一起删掉。
   *  - 头拍 < 起点但仍 held（长按跨越跳转点，或被遗留的按住）：
   *    头拍已过去无法重练，尾拍按 miss 强制收尾，状态 done。
   *  - 清空输入队列与按住状态；小节之前已完成的成绩保留。
   */
  seekToMeasure(measure: number): void {
    const startBeat = measure * this.config.beatsPerMeasure;
    const startT = beatToTime(startBeat, this.config.bpm);

    // 第一步：所有 held 一律强制松手，不允许任何按住状态跨越 seek。
    for (const [lane, t] of [...this.activeDown.entries()]) {
      this.activeDown.delete(lane);
      this.pushRow({ t: this.now, kind: 'up', lane }, t, 'miss', null, {
        source: 'seek',
        kind: 'tail',
        note: `跳转小节，按住事件未到尾拍即清理（跳到第 ${measure + 1} 小节）`,
      });
      if (t.beat + 1e-9 < startBeat) {
        // 头拍在跳转点之前：保留 miss 收尾，不再参与重练。
        t.state = 'done';
        t.finalGrade = 'miss';
        t.lastDeltaMs = null;
      }
    }

    // 第二步：头拍 >= 起点的目标全部重置，并删掉对应流水。
    const resetIds = new Set<string>();
    for (const t of this.targets) {
      if (t.beat + 1e-9 >= startBeat) {
        resetIds.add(t.id);
        t.state = 'pending';
        t.finalGrade = null;
        t.lastDeltaMs = null;
      }
    }
    for (let i = this.log.length - 1; i >= 0; i--) {
      const row = this.log[i];
      if (row.targetId && resetIds.has(row.targetId)) this.log.splice(i, 1);
    }
    this.queue = [];
    this.activeDown.clear();
    this.now = startT;
    this.paused = false;
  }

  // --------------------------------------------------------------- 汇总 / 工具

  summary(): ScoreSummary {
    const s: ScoreSummary = { perfect: 0, good: 0, miss: 0, ignored: 0, total: 0, accuracy: 0 };
    for (const row of this.log) {
      if (row.targetId === null) {
        if (row.grade === 'ignored') s.ignored++;
        continue;
      }
      s[row.grade === 'perfect' ? 'perfect' : row.grade === 'good' ? 'good' : 'miss']++;
    }
    s.total = this.targets.reduce((n, t) => n + (t.lengthBeats > 0 ? 2 : 1), 0);
    const judged = s.perfect + s.good + s.miss;
    s.accuracy = judged === 0 ? 0 : (s.perfect + s.good) / s.total;
    return s;
  }

  /** 最近一条命中/失误（UI 闪光用）。 */
  lastJudgement(): JudgementRow | null {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const row = this.log[i];
      if (row.grade !== 'ignored') return row;
    }
    return null;
  }

  private markCandidates(candidates: CandidateInfo[], winnerId: string): void {
    for (const c of candidates) {
      if (c.targetId === winnerId) {
        c.won = true;
      } else if (!c.sameLane) {
        c.reason = '异轨输入不可抢占';
      } else {
        c.reason = '同轨存在 |Δ| 更小的候选';
      }
    }
  }

  private pushRow(
    e: { t: number; kind: InputEvent['kind']; lane: string },
    target: RuntimeTarget | null,
    grade: Grade,
    deltaMs: number | null,
    opts: {
      source?: JudgementRow['source'];
      kind?: JudgementRow['kind'];
      candidates?: CandidateInfo[];
      note?: string;
    } = {},
  ): void {
    this.log.push({
      seq: this.seq++,
      t: e.t,
      source: opts.source ?? 'input',
      kind: opts.kind ?? e.kind,
      lane: e.lane,
      targetId: target ? target.id : null,
      grade,
      deltaMs,
      candidates: opts.candidates,
      note: opts.note,
    });
  }
}
