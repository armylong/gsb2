import { describe, expect, it } from 'vitest';
import {
  applyDemoScript,
  checkOpen,
  confirmSelection,
  createGame,
  openRound,
  nextRound,
  currentRound,
  currentPriority,
  toRoundView,
  setSelection,
  restartGame,
  isFinalRound,
} from './engine';
import { AUTO_DUEL, COLLISION_LAB, MIXED_TABLE, SCENARIOS } from './scenarios';
import { computeStandings } from './scoring';
import type { GameState } from './types';

function playRoundWithScript(state: GameState): GameState {
  const scripted = applyDemoScript(state);
  expect(checkOpen(scripted).canOpen).toBe(true);
  return openRound(scripted);
}

function playAll(state: GameState): GameState {
  let current = state;
  while (true) {
    current = playRoundWithScript(current);
    if (isFinalRound(current)) break;
    current = nextRound(current);
  }
  return current;
}

describe('COLLISION_LAB', () => {
  it('把对手的选择藏起来, 自己的选择在开选前可见', () => {
    const state = createGame(COLLISION_LAB);
    const scripted = applyDemoScript(state);
    const asRed = toRoundView(scripted, 'red');
    expect(asRed.selections.red.primary).toBe('r1-pot');
    expect(asRed.selections.red.hidden).toBe(false);
    expect(asRed.selections.blue.primary).toBeNull();
    expect(asRed.selections.blue.backup).toBeNull();
    expect(asRed.selections.blue.hidden).toBe(true);
    expect(asRed.selections.blue.confirmed).toBe(true);
    expect(asRed.result).toBeNull();

    const asObserver = toRoundView(scripted, 'observer');
    expect(asObserver.selections.red.primary).toBeNull();
    expect(asObserver.selections.blue.primary).toBeNull();
  });

  it('第 1 轮首选相撞: 先手拿走, 后手以备用递补', () => {
    const state = playRoundWithScript(createGame(COLLISION_LAB));
    const result = state.history[0];
    expect(result).toBeDefined();
    expect(result?.priority).toEqual(['red', 'blue', 'gold']);
    const byTeam = new Map(result?.assignments.map((entry) => [entry.teamId, entry]));
    expect(byTeam.get('red')).toMatchObject({ specimenId: 'r1-pot', via: 'primary' });
    expect(byTeam.get('blue')).toMatchObject({ specimenId: 'r1-bi', via: 'backup' });
    expect(byTeam.get('gold')).toMatchObject({ specimenId: 'r1-bone', via: 'primary' });
    expect(result?.misses).toHaveLength(0);
  });

  it('第 2 轮备用再撞: 赤陶两手落空, 记录为备用已被拿走', () => {
    const state = playAllRounds(2);
    const result = state.history[1];
    const byTeam = new Map(result?.assignments.map((entry) => [entry.teamId, entry]));
    expect(byTeam.get('blue')).toMatchObject({ specimenId: 'r2-cong', via: 'primary' });
    expect(byTeam.get('gold')).toMatchObject({ specimenId: 'r2-pot', via: 'backup' });
    expect(byTeam.has('red')).toBe(false);
    const redMiss = result?.misses.find((miss) => miss.teamId === 'red');
    expect(redMiss).toMatchObject({
      reason: 'backup-taken',
      primaryId: 'r2-cong',
      backupId: 'r2-pot',
      primaryTakenBy: 'blue',
      backupTakenBy: 'gold',
    });
  });

  it('第 3 轮区分没有合适备选与备选已被拿走', () => {
    const state = playAllRounds(3);
    const result = state.history[2];
    const blueMiss = result?.misses.find((miss) => miss.teamId === 'blue');
    expect(blueMiss).toMatchObject({ reason: 'no-backup', backupId: null });
    const redMiss = result?.misses.find((miss) => miss.teamId === 'red');
    expect(redMiss).toBeUndefined();
    expect(result?.assignments.find((entry) => entry.teamId === 'red')?.specimenId).toBe('r3-slip');
  });

  it('五轮后三队平分, 同一总分但件数可以不同', () => {
    const state = playAll(createGame(COLLISION_LAB));
    expect(state.phase).toBe('opened');
    expect(state.history).toHaveLength(5);
    const standings = computeStandings(state.history);
    expect(standings.isTie).toBe(true);
    expect(standings.tiedTeamIds).toEqual(['red', 'blue', 'gold']);
    const totals = standings.scores.map((score) => score.total);
    expect(totals).toEqual([29, 29, 29]);
    for (const score of standings.scores) {
      expect(score.categories.some((entry) => entry.tier === 'pair')).toBe(true);
      const itemSum = score.items.reduce((sum, item) => sum + item.total, 0);
      expect(itemSum).toBe(score.total);
      expect(score.baseTotal + score.setBonusTotal).toBe(score.total);
    }
    expect(standings.scores.map((score) => score.count)).toEqual([4, 4, 5]);
  });
});

function playAllRounds(count: number): GameState {
  let state = createGame(COLLISION_LAB);
  for (let index = 0; index < count; index += 1) {
    state = playRoundWithScript(state);
    if (index + 1 < count) {
      state = nextRound(state);
    }
  }
  return state;
}

describe('开牌门槛', () => {
  it('有队未确认时不能开牌', () => {
    const state = createGame(COLLISION_LAB);
    const partial = setSelection(state, 'red', { primary: 'r1-pot', backup: null });
    const confirmed = confirmSelection(partial, 'red');
    const check = checkOpen(confirmed);
    expect(check.canOpen).toBe(false);
    expect(check.pendingTeamIds).toEqual(['blue', 'gold']);
    expect(() => openRound(confirmed)).toThrow();
  });

  it('自动队提交后即视为确认', () => {
    const state = createGame(AUTO_DUEL);
    const check = checkOpen(state);
    expect(check.canOpen).toBe(true);
    expect(state.selections.red.source).toBe('auto');
    expect(state.selections.red.confirmed).toBe(true);
  });

  it('首选与备用相同时备用被清空', () => {
    const state = createGame(COLLISION_LAB);
    const next = setSelection(state, 'red', { primary: 'r1-pot', backup: 'r1-pot' });
    expect(next.selections.red.primary).toBe('r1-pot');
    expect(next.selections.red.backup).toBeNull();
  });

  it('开牌后不能改选', () => {
    const state = playRoundWithScript(createGame(COLLISION_LAB));
    const attempt = setSelection(state, 'red', { primary: 'r1-dou' });
    expect(attempt).toBe(state);
  });
});

describe('可重复性', () => {
  it('同种子、同选择下, 自动队伍选择与开牌结果完全一致', () => {
    const first = playAll(createGame(COLLISION_LAB));
    const second = playAll(createGame(COLLISION_LAB));
    expect(second.history).toEqual(first.history);
    expect(second.selections).toEqual(first.selections);
  });

  it('不同种子会改变自动队的选择', () => {
    const base = createGame(AUTO_DUEL);
    const differing = AUTO_DUEL.rounds[0]!;
    const changedSeed = Array.from({ length: 40 }, (_, offset) => AUTO_DUEL.seed + offset + 1).find(
      (seed) => {
        const candidate = createGame(AUTO_DUEL, { seed });
        return (
          candidate.selections.red.primary !== base.selections.red.primary ||
          candidate.selections.blue.primary !== base.selections.blue.primary ||
          candidate.selections.gold.primary !== base.selections.gold.primary ||
          candidate.selections.red.backup !== base.selections.red.backup ||
          candidate.selections.blue.backup !== base.selections.blue.backup ||
          candidate.selections.gold.backup !== base.selections.gold.backup
        );
      },
    );
    expect(differing.table.length).toBeGreaterThan(1);
    // 桌面只有 5 件且价值差异明显时, 不同种子未必改变首选; 但必须至少存在某个种子使选择不同.
    expect(changedSeed).toBeDefined();
    const sameSeedAgain = createGame(AUTO_DUEL, { seed: changedSeed });
    const repeated = createGame(AUTO_DUEL, { seed: changedSeed });
    expect(sameSeedAgain.selections).toEqual(repeated.selections);
  });

  it('重开后同种子恢复初始自动选择', () => {
    const state = playAll(createGame(AUTO_DUEL));
    const restarted = restartGame(state);
    const fresh = createGame(AUTO_DUEL);
    expect(restarted.selections).toEqual(fresh.selections);
    expect(restarted.history).toHaveLength(0);
    expect(restarted.roundIndex).toBe(0);
  });
});

describe('回合与优先顺序', () => {
  it('优先顺序每轮轮换', () => {
    let state = createGame(COLLISION_LAB);
    const seen: string[][] = [];
    for (let index = 0; index < 4; index += 1) {
      seen.push(currentPriority(state));
      state = nextRound(playRoundWithScript(state));
    }
    expect(seen).toEqual([
      ['red', 'blue', 'gold'],
      ['blue', 'gold', 'red'],
      ['gold', 'red', 'blue'],
      ['red', 'blue', 'gold'],
    ]);
  });

  it('场景内部标本 id 全局唯一', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.rounds.flatMap((round) => round.table.map((specimen) => specimen.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('混编场景中手动队未确认时不能开牌', () => {
    const state = createGame(MIXED_TABLE);
    expect(currentRound(state).title).toBe('人机同席');
    expect(checkOpen(state).pendingTeamIds).toEqual(['red']);
    expect(state.selections.blue.confirmed).toBe(true);
    expect(state.selections.gold.confirmed).toBe(true);
  });
});
