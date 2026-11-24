// 游戏运行状态：时间推进、玩家移动、扫雪观察、推断链维护。
// 玩家自己的脚步不留痕（玩家是追踪者，不是被追踪对象），
// 所有观察只读取题面生成时就确定下来的足迹栈。

import { buildImpressions, getScenario } from './scenarios.js';
import { observeCell } from './snow.js';
import {
  ChainEntry,
  ChainGapEntry,
  ChainObsEntry,
  Impression,
  Observation,
  ScenarioDef,
  VisibleImpression,
  Zone,
} from './types.js';

export const SCAN_RADIUS = 1; // 扫雪：以玩家为中心的切比雪夫半径
/** 同一格两次扫雪之间的冷却（分钟），避免零成本反复刷 */
export const SCAN_COOLDOWN = 6;
/** 一次扫雪让时间前进的分钟数 */
export const SCAN_TIME_COST = 3;

export class GameState {
  readonly scenario: ScenarioDef;
  /** 足迹栈，key = "x,y"，按时间升序 */
  readonly impressions: Map<string, Impression[]>;
  /** 当前游戏时刻（分钟，相对题面起点） */
  now: number;
  px: number;
  py: number;
  /** 已观察记录：key = "x,y" → 最近一次观察 */
  readonly observations = new Map<string, Observation>();
  /** 推断链 */
  chain: ChainEntry[] = [];
  /** 每格上次扫雪时刻，用于冷却 */
  private lastScan = new Map<string, number>();

  constructor(scenarioId: string, seedOverride?: string) {
    const base = getScenario(scenarioId);
    this.scenario =
      seedOverride && seedOverride.trim().length > 0
        ? { ...base, seed: seedOverride.trim() }
        : base;
    this.impressions = buildImpressions(this.scenario);
    this.now = this.scenario.initialTime;
    this.px = this.scenario.playerStart[0];
    this.py = this.scenario.playerStart[1];
  }

  key(x: number, y: number): string {
    return `${x},${y}`;
  }

  zoneAt(x: number, y: number): Zone {
    if (x < 0 || y < 0 || x >= this.scenario.width || y >= this.scenario.height) {
      return Zone.Block;
    }
    return this.scenario.zones[y][x];
  }

  canWalk(x: number, y: number): boolean {
    return this.zoneAt(x, y) !== Zone.Block;
  }

  /** 尝试移动一步；阻挡或出界返回 false。移动会踩实目标格并完成一次近距离观察。 */
  move(dx: number, dy: number): boolean {
    const nx = this.px + dx;
    const ny = this.py + dy;
    if (!this.canWalk(nx, ny)) return false;
    this.px = nx;
    this.py = ny;
    this.recordObservation(nx, ny, true);
    return true;
  }

  /** 直接走到某相邻格（点击移动用） */
  moveTo(x: number, y: number): boolean {
    const dx = x - this.px;
    const dy = y - this.py;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
    return this.move(dx, dy);
  }

  private recordObservation(x: number, y: number, stepped: boolean): void {
    const stack = this.impressions.get(this.key(x, y));
    const impressions: VisibleImpression[] = observeCell(stack, this.now);
    this.observations.set(this.key(x, y), {
      x,
      y,
      atTime: this.now,
      stepped,
      impressions,
    });
  }

  /**
   * 扫雪：观察以玩家为中心 SCAN_RADIUS 内的全部格子（不含玩家所在格，
   * 那格踩入时已观察）。时间前进 SCAN_TIME_COST，每格有冷却。
   * 返回实际完成观察的格子列表。
   */
  scan(): Array<{ x: number; y: number; cooled: boolean }> {
    const result: Array<{ x: number; y: number; cooled: boolean }> = [];
    this.advance(SCAN_TIME_COST);
    for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = this.px + dx;
        const y = this.py + dy;
        if (!this.canWalk(x, y)) continue;
        const k = this.key(x, y);
        const last = this.lastScan.get(k);
        const cooled = last === undefined || this.now - last >= SCAN_COOLDOWN;
        if (cooled) {
          this.recordObservation(x, y, false);
          this.lastScan.set(k, this.now);
        }
        result.push({ x, y, cooled });
      }
    }
    return result;
  }

  /** 时间快进（分钟），积雪随之覆盖；旧观察记录保留其历史快照 */
  advance(minutes: number): void {
    this.now += Math.max(0, Math.round(minutes));
  }

  /** 取某格当前的可见足迹（从新到旧），不写观察记录 */
  peek(x: number, y: number): VisibleImpression[] {
    return observeCell(this.impressions.get(this.key(x, y)), this.now);
  }

  isObserved(x: number, y: number): boolean {
    return this.observations.has(this.key(x, y));
  }

  getObservation(x: number, y: number): Observation | undefined {
    return this.observations.get(this.key(x, y));
  }

  // ----- 推断链 -----

  /**
   * 往推断链追加一个观察格。
   * 必须是已观察过的格子；与上一目的格必须相邻（中间允许已有一个跳格）。
   * pick 为叠踩格中从新到旧的足迹下标。
   */
  addObsEntry(x: number, y: number, pick = 0): { ok: boolean; reason?: string } {
    const obs = this.getObservation(x, y);
    if (!obs) return { ok: false, reason: '这一格还没有观察记录，先踩过去或扫雪。' };
    if (obs.impressions.length === 0) {
      return { ok: false, reason: '这一格当前看不到任何足迹，不能作为线索。' };
    }
    if (pick < 0 || pick >= obs.impressions.length) {
      return { ok: false, reason: '选定的足迹编号不存在。' };
    }
    const last = this.chain[this.chain.length - 1];
    if (last) {
      const check = this.checkAdjacency(last, x, y);
      if (!check.ok) return check;
    }
    const entry: ChainObsEntry = { kind: 'obs', x, y, pick };
    this.chain.push(entry);
    return { ok: true };
  }

  /** 追加一个跳格：允许跳过恰好一格不确定的区域，下一格必须落在两步之外 */
  addGap(): { ok: boolean; reason?: string } {
    const last = this.chain[this.chain.length - 1];
    if (!last) return { ok: false, reason: '推断链还没有起点，不能先跳格。' };
    if (last.kind === 'gap') return { ok: false, reason: '不能连续跳两格。' };
    const gap: ChainGapEntry = { kind: 'gap' };
    this.chain.push(gap);
    return { ok: true };
  }

  removeLastEntry(): void {
    this.chain.pop();
  }

  clearChain(): void {
    this.chain = [];
  }

  private checkAdjacency(
    last: ChainEntry,
    x: number,
    y: number,
  ): { ok: boolean; reason?: string } {
    if (last.kind === 'gap') {
      // 跳格后：与跳格前的观察点必须恰好相距两步（曼哈顿距离 2，直线）
      const prev = this.chain[this.chain.length - 2];
      if (!prev || prev.kind !== 'obs') {
        return { ok: false, reason: '跳格前缺少有效线索。' };
      }
      const dist = Math.abs(prev.x - x) + Math.abs(prev.y - y);
      if (dist !== 2) {
        return { ok: false, reason: '跳格后必须落在距上一条线索恰好两格的位置。' };
      }
      return { ok: true };
    }
    const dist = Math.abs(last.x - x) + Math.abs(last.y - y);
    if (dist !== 1) {
      return { ok: false, reason: '相邻线索必须在上下左右相邻格；不确定就先插入跳格。' };
    }
    return { ok: true };
  }
}
