import { LevelDef, ParadeDef, Layout } from './model.js';
import { simulate, cloneLayout, layoutConflict, SimResult } from './sim.js';

export type Phase = 'edit' | 'playing' | 'done';

export class Game {
  parade: ParadeDef;
  committed: Layout;          // 已生效布置(演出按它结算)
  staged: Layout;             // 编辑中的暂存布置(预计效果按它算)
  undoStack: { layout: Layout; moves: number }[] = [];
  roundIdx = 0;
  t = 0;
  phase: Phase = 'edit';
  paused = false;
  speed = 2;
  autoAll = false;            // 一键从头演出:自动连播各轮
  movesLeft: number;
  selectedChair: string | null = null;
  inspectedViewer: string | null = null;
  message = '';
  private simCache = new Map<string, SimResult>();
  roundStarts: number[];

  constructor(private level: LevelDef, parade: ParadeDef) {
    this.parade = parade;
    this.committed = cloneLayout(level.initialLayout);
    this.staged = cloneLayout(level.initialLayout);
    this.movesLeft = level.movesPerIntermission;
    this.roundStarts = [];
    let g = 0;
    for (const r of parade.rounds) { this.roundStarts.push(g); g += r.duration; }
  }

  get round() { return this.parade.rounds[this.roundIdx]; }
  get globalT() { return this.roundStarts[this.roundIdx] + this.t; }
  get totalDuration() { return this.roundStarts[this.roundStarts.length - 1] + this.parade.rounds[this.parade.rounds.length - 1].duration; }

  private simOf(layout: Layout): SimResult {
    const key = JSON.stringify(layout);
    let s = this.simCache.get(key);
    if (!s) { s = simulate(this.level, this.parade, layout); this.simCache.set(key, s); }
    return s;
  }
  /** 已生效布置的整场结算(演出日志、最终结果都按它)。 */
  committedSim(): SimResult { return this.simOf(this.committed); }
  /** 暂存布置的预计效果。 */
  stagedSim(): SimResult { return this.simOf(this.staged); }

  stagedMoveCount(): number {
    let n = 0;
    for (let i = 0; i < this.staged.chairs.length; i++) {
      const a = this.committed.chairs[i], b = this.staged.chairs[i];
      if (a.holeId !== b.holeId || a.viewerId !== b.viewerId) n++;
    }
    return n;
  }

  private canEdit(): boolean { return this.phase === 'edit'; }

  /** 暂存:把椅子搬到某个孔位(可能制造同孔冲突,应用时按规则保持原布置)。 */
  stageMove(chairId: string, holeId: string): void {
    if (!this.canEdit()) return;
    const c = this.staged.chairs.find(c => c.id === chairId)!;
    if (c.holeId === holeId) return;
    if (this.stagedMoveCount() >= this.movesLeft) { this.message = `本轮只剩 ${this.movesLeft} 次移动,先应用或撤销`; return; }
    c.holeId = holeId;
    this.message = '';
  }

  /** 暂存:两把椅子互换观众(换人)。 */
  stageSwapViewers(aId: string, bId: string): void {
    if (!this.canEdit() || aId === bId) return;
    if (this.stagedMoveCount() >= this.movesLeft) { this.message = `本轮只剩 ${this.movesLeft} 次移动,先应用或撤销`; return; }
    const a = this.staged.chairs.find(c => c.id === aId)!;
    const b = this.staged.chairs.find(c => c.id === bId)!;
    [a.viewerId, b.viewerId] = [b.viewerId, a.viewerId];
    this.message = '';
  }

  /** 暂存:旋转椅子(不消耗移动次数)。 */
  rotate(chairId: string, dir: 1 | -1): void {
    if (!this.canEdit()) return;
    const c = this.staged.chairs.find(c => c.id === chairId)!;
    c.facing += dir * Math.PI / 4;
  }

  discardStaged(): void {
    this.staged = cloneLayout(this.committed);
    this.message = '已放弃暂存的改动';
  }

  /** 应用暂存布置并开演。同孔冲突 → 保持原布置。 */
  applyAndPlay(): void {
    if (this.phase !== 'edit') return;
    const conflict = layoutConflict(this.staged);
    if (conflict) {
      this.message = `${conflict}:保持原来的布置`;
      this.staged = cloneLayout(this.committed);
      return;
    }
    const moves = this.stagedMoveCount();
    if (moves > this.movesLeft) { this.message = '移动次数不足'; return; }
    this.undoStack.push({ layout: cloneLayout(this.committed), moves });
    this.movesLeft -= moves;
    this.committed = cloneLayout(this.staged);
    this.phase = 'playing';
    this.paused = false;
    this.t = 0;
    this.autoAll = false;
    this.message = '';
  }

  undo(): void {
    const u = this.undoStack.pop();
    if (!u) { this.message = '没有可撤销的操作'; return; }
    this.committed = u.layout;
    this.staged = cloneLayout(u.layout);
    this.movesLeft += u.moves;
    this.phase = 'edit';
    this.autoAll = false;
    this.message = '已撤销上一次布置';
  }

  /** 一键从头演出:按当前已生效布置从第一轮连播到结束。 */
  replayAll(): void {
    this.roundIdx = 0;
    this.t = 0;
    this.autoAll = true;
    this.paused = false;
    this.phase = 'playing';
    this.message = '';
  }

  resetLayout(): void {
    this.committed = cloneLayout(this.level.initialLayout);
    this.staged = cloneLayout(this.level.initialLayout);
    this.undoStack = [];
    this.roundIdx = 0;
    this.t = 0;
    this.movesLeft = this.level.movesPerIntermission;
    this.phase = 'edit';
    this.autoAll = false;
    this.message = '已重置为初始布置';
  }

  update(dt: number): void {
    if (this.phase !== 'playing' || this.paused) return;
    this.t += dt * this.speed;
    const round = this.round;
    if (this.t < round.duration) return;
    if (this.roundIdx < this.parade.rounds.length - 1) {
      if (this.autoAll) { this.roundIdx++; this.t = 0; }
      else {
        this.roundIdx++;
        this.t = 0;
        this.phase = 'edit';
        this.movesLeft = this.level.movesPerIntermission;
        this.staged = cloneLayout(this.committed);
      }
    } else {
      this.phase = 'done';
      this.autoAll = false;
      this.t = round.duration;
    }
  }

  /** 从记录跳回某一全局时刻。 */
  jumpTo(g: number): void {
    let ri = this.roundStarts.length - 1;
    for (let i = 0; i < this.roundStarts.length; i++) {
      if (g < this.roundStarts[i]) { ri = i - 1; break; }
      if (i === this.roundStarts.length - 1) ri = i;
    }
    ri = Math.max(0, ri);
    this.roundIdx = ri;
    this.t = Math.min(g - this.roundStarts[ri], this.parade.rounds[ri].duration);
    this.phase = 'playing';
    this.paused = true;
    this.autoAll = false;
  }
}
