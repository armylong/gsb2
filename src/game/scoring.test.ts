import { describe, expect, it } from 'vitest';
import { collectHoldings, computeStandings, scoreTeam, setTierForCount } from './scoring';
import type { RoundResult, Specimen, TeamId } from './types';

function specimen(id: string, category: Specimen['category'], value: number): Specimen {
  return { id, name: id, glyph: id, category, value, note: '' };
}

function round(
  roundIndex: number,
  table: Specimen[],
  taken: Array<{ teamId: TeamId; id: string; via?: 'primary' | 'backup' }>,
): RoundResult {
  return {
    roundIndex,
    priority: ['red', 'blue', 'gold'],
    table,
    choices: {
      red: { primary: null, backup: null },
      blue: { primary: null, backup: null },
      gold: { primary: null, backup: null },
    },
    assignments: taken.map((entry, index) => ({
      teamId: entry.teamId,
      specimenId: entry.id,
      via: entry.via ?? 'primary',
      order: index + 1,
    })),
    misses: [],
    trace: [],
  };
}

describe('setTierForCount', () => {
  it('按件数分档', () => {
    expect(setTierForCount(0)).toBe('none');
    expect(setTierForCount(1)).toBe('none');
    expect(setTierForCount(2)).toBe('pair');
    expect(setTierForCount(3)).toBe('triad');
    expect(setTierForCount(4)).toBe('quad');
    expect(setTierForCount(9)).toBe('quad');
  });
});

describe('scoreTeam', () => {
  it('二件套给每件 +2, 三件套给每件 +5', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 4), specimen('p2', '陶器', 3)], [
        { teamId: 'red', id: 'p1' },
        { teamId: 'red', id: 'p2' },
      ]),
      round(1, [specimen('p3', '陶器', 2), specimen('j1', '玉器', 6)], [
        { teamId: 'red', id: 'p3' },
      ]),
    ];
    const detail = scoreTeam(history, 'red');
    expect(detail.score.baseTotal).toBe(9);
    expect(detail.score.setBonusTotal).toBe(15);
    expect(detail.score.total).toBe(24);
    expect(detail.score.items.map((item) => item.setBonus)).toEqual([5, 5, 5]);
    expect(detail.score.categories).toEqual([
      {
        category: '陶器',
        itemIds: ['p1', 'p2', 'p3'],
        count: 3,
        tier: 'triad',
        perItemBonus: 5,
        totalBonus: 15,
      },
    ]);
  });

  it('单件没有成套加成', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 4), specimen('j1', '玉器', 6)], [
        { teamId: 'red', id: 'p1' },
        { teamId: 'blue', id: 'j1' },
      ]),
    ];
    const red = scoreTeam(history, 'red').score;
    expect(red.total).toBe(4);
    expect(red.setBonusTotal).toBe(0);
    expect(red.items[0]?.reasons.join(' ')).toContain('无成套加成');
  });

  it('逐件计分来由能解释本体与成套加成', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 4), specimen('p2', '陶器', 3)], [
        { teamId: 'gold', id: 'p1', via: 'backup' },
        { teamId: 'gold', id: 'p2' },
      ]),
    ];
    const detail = scoreTeam(history, 'gold');
    const line = detail.bySpecimen.get('p1');
    expect(line).toBeDefined();
    expect(line?.base).toBe(4);
    expect(line?.setBonus).toBe(2);
    expect(line?.total).toBe(6);
    expect(line?.reasons).toEqual([
      '本体价值 4',
      '陶器 2 件成套 (二件套): +2',
      '第 1 轮以备用递补获得',
    ]);
  });

  it('弃权回合不影响其他队伍的分', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 5)], [{ teamId: 'blue', id: 'p1' }]),
    ];
    expect(collectHoldings(history, 'red')).toHaveLength(0);
    expect(scoreTeam(history, 'red').score.total).toBe(0);
    expect(scoreTeam(history, 'blue').score.total).toBe(5);
  });
});

describe('computeStandings', () => {
  it('总分并列时标记平分', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 5), specimen('j1', '玉器', 5)], [
        { teamId: 'red', id: 'p1' },
        { teamId: 'blue', id: 'j1' },
      ]),
    ];
    const standings = computeStandings(history);
    expect(standings.isTie).toBe(true);
    expect(standings.topScore).toBe(5);
    expect(standings.tiedTeamIds).toEqual(['red', 'blue']);
    expect(standings.roundsPlayed).toBe(1);
  });

  it('唯一最高分不算平分', () => {
    const history = [
      round(0, [specimen('p1', '陶器', 5), specimen('j1', '玉器', 9)], [
        { teamId: 'red', id: 'p1' },
        { teamId: 'blue', id: 'j1' },
      ]),
    ];
    const standings = computeStandings(history);
    expect(standings.isTie).toBe(false);
    expect(standings.tiedTeamIds).toEqual(['blue']);
  });
});
