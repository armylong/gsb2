import { describe, expect, it } from 'vitest';
import { resolveRound, rotatePriority, validateChoice } from './draft';
import { autoPick } from './engine';
import { createRng, deriveSeed } from './rng';
import type { Choice, Specimen, TeamId } from './types';

const table: Specimen[] = [
  { id: 'a', name: '甲', glyph: '甲', category: '陶器', value: 4, note: '' },
  { id: 'b', name: '乙', glyph: '乙', category: '玉器', value: 5, note: '' },
  { id: 'c', name: '丙', glyph: '丙', category: '骨器', value: 3, note: '' },
];

function choices(partial: Partial<Record<TeamId, Choice>>): Record<TeamId, Choice> {
  return {
    red: partial.red ?? { primary: null, backup: null },
    blue: partial.blue ?? { primary: null, backup: null },
    gold: partial.gold ?? { primary: null, backup: null },
  };
}

describe('rotatePriority', () => {
  it('每轮左移一位并循环', () => {
    const base: TeamId[] = ['red', 'blue', 'gold'];
    expect(rotatePriority(base, 0)).toEqual(['red', 'blue', 'gold']);
    expect(rotatePriority(base, 1)).toEqual(['blue', 'gold', 'red']);
    expect(rotatePriority(base, 2)).toEqual(['gold', 'red', 'blue']);
    expect(rotatePriority(base, 3)).toEqual(['red', 'blue', 'gold']);
  });
});

describe('validateChoice', () => {
  it('拒绝无首选、不在桌面、备用与首选相同', () => {
    expect(validateChoice('赤陶队', { primary: null, backup: null }, table).ok).toBe(false);
    expect(validateChoice('赤陶队', { primary: 'z', backup: null }, table).ok).toBe(false);
    expect(validateChoice('赤陶队', { primary: 'a', backup: 'a' }, table).ok).toBe(false);
    expect(validateChoice('赤陶队', { primary: 'a', backup: null }, table).ok).toBe(true);
  });
});

describe('resolveRound', () => {
  it('首选相撞时后手拿不到, 但首选本身不进入备用池', () => {
    const result = resolveRound({
      roundIndex: 0,
      table,
      priority: ['red', 'blue', 'gold'],
      choices: choices({
        red: { primary: 'a', backup: null },
        blue: { primary: 'a', backup: 'b' },
        gold: { primary: 'c', backup: null },
      }),
    });
    expect(result.assignments.map((entry) => [entry.teamId, entry.specimenId, entry.via])).toEqual([
      ['red', 'a', 'primary'],
      ['gold', 'c', 'primary'],
      ['blue', 'b', 'backup'],
    ]);
    expect(result.misses).toHaveLength(0);
  });

  it('备用再撞时按优先顺序裁定, 落败方记录为备用已被拿走', () => {
    const result = resolveRound({
      roundIndex: 0,
      table,
      priority: ['red', 'blue', 'gold'],
      choices: choices({
        red: { primary: 'a', backup: 'b' },
        blue: { primary: 'a', backup: 'b' },
        gold: { primary: 'a', backup: 'b' },
      }),
    });
    const byTeam = new Map(result.assignments.map((entry) => [entry.teamId, entry]));
    expect(byTeam.get('red')?.specimenId).toBe('a');
    expect(byTeam.get('blue')?.specimenId).toBe('b');
    expect(byTeam.get('blue')?.via).toBe('backup');
    expect(byTeam.has('gold')).toBe(false);
    expect(result.misses).toEqual([
      {
        teamId: 'gold',
        primaryId: 'a',
        backupId: 'b',
        reason: 'backup-taken',
        primaryTakenBy: 'red',
        backupTakenBy: 'blue',
      },
    ]);
  });

  it('备用不能抢走首选已经分出的标本', () => {
    const result = resolveRound({
      roundIndex: 0,
      table,
      priority: ['blue', 'gold', 'red'],
      choices: choices({
        blue: { primary: 'a', backup: null },
        gold: { primary: 'c', backup: 'a' },
        red: { primary: 'b', backup: null },
      }),
    });
    const goldAssignment = result.assignments.find((entry) => entry.teamId === 'gold');
    expect(goldAssignment).toBeDefined();
    expect(goldAssignment?.specimenId).toBe('c');
    expect(result.misses).toEqual([]);

    const contested = resolveRound({
      roundIndex: 0,
      table,
      priority: ['blue', 'gold', 'red'],
      choices: choices({
        blue: { primary: 'a', backup: null },
        gold: { primary: 'a', backup: 'c' },
        red: { primary: 'c', backup: null },
      }),
    });
    const goldMiss = contested.misses.find((miss) => miss.teamId === 'gold');
    expect(goldMiss).toMatchObject({
      reason: 'backup-taken',
      backupId: 'c',
      backupTakenBy: 'red',
      primaryTakenBy: 'blue',
    });
  });

  it('没有备用与备用被拿走是两种不同记录', () => {
    const result = resolveRound({
      roundIndex: 0,
      table,
      priority: ['red', 'blue', 'gold'],
      choices: choices({
        red: { primary: 'a', backup: null },
        blue: { primary: 'a', backup: null },
        gold: { primary: 'a', backup: 'b' },
      }),
    });
    const blue = result.misses.find((miss) => miss.teamId === 'blue');
    const gold = result.misses.find((miss) => miss.teamId === 'gold');
    expect(blue?.reason).toBe('no-backup');
    expect(blue?.backupId).toBeNull();
    expect(gold).toBeUndefined();

    const blocked = resolveRound({
      roundIndex: 0,
      table,
      priority: ['red', 'blue', 'gold'],
      choices: choices({
        red: { primary: 'c', backup: null },
        blue: { primary: 'a', backup: null },
        gold: { primary: 'a', backup: 'c' },
      }),
    });
    const redAssignment = blocked.assignments.find((entry) => entry.teamId === 'red');
    const goldMiss = blocked.misses.find((miss) => miss.teamId === 'gold');
    expect(redAssignment?.specimenId).toBe('c');
    expect(goldMiss).toMatchObject({
      reason: 'backup-taken',
      primaryTakenBy: 'blue',
      backupTakenBy: 'red',
    });
  });

  it('同一件标本至多给一个队, 即使备用也在首选通过中落败', () => {
    const result = resolveRound({
      roundIndex: 1,
      table,
      priority: ['gold', 'red', 'blue'],
      choices: choices({
        red: { primary: 'b', backup: 'a' },
        blue: { primary: 'b', backup: 'a' },
        gold: { primary: 'b', backup: 'a' },
      }),
    });
    const specimenIds = result.assignments.map((entry) => entry.specimenId);
    expect(new Set(specimenIds).size).toBe(specimenIds.length);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0]).toMatchObject({ teamId: 'gold', specimenId: 'b', via: 'primary' });
    expect(result.assignments[1]).toMatchObject({ teamId: 'red', specimenId: 'a', via: 'backup' });
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0]).toMatchObject({ teamId: 'blue', reason: 'backup-taken' });
  });
});

describe('rng', () => {
  it('同种子序列完全一致, 不同种子通常不同', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sequenceA = Array.from({ length: 8 }, () => a());
    const sequenceB = Array.from({ length: 8 }, () => b());
    const sequenceC = Array.from({ length: 8 }, () => c());
    expect(sequenceA).toEqual(sequenceB);
    expect(sequenceA).not.toEqual(sequenceC);
  });

  it('派生种子稳定', () => {
    expect(deriveSeed(7, 1, 'red', 'set')).toBe(deriveSeed(7, 1, 'red', 'set'));
    expect(deriveSeed(7, 1, 'red', 'set')).not.toBe(deriveSeed(8, 1, 'red', 'set'));
  });
});

describe('自动队选择可重复性 (引擎层)', () => {
  it('同种子同历史下自动选择与裁定完全一致', () => {
    // 该用例直接调用 autoPick 以确认随机量只来自种子与局面.
    const table: Specimen[] = [
      { id: 'x', name: '甲', glyph: '甲', category: '陶器', value: 5, note: '' },
      { id: 'y', name: '乙', glyph: '乙', category: '玉器', value: 5, note: '' },
      { id: 'z', name: '丙', glyph: '丙', category: '骨器', value: 4, note: '' },
    ];
    const held = [
      { specimen: table[0]!, acquiredRound: 0, via: 'primary' as const },
    ];
    const args = {
      teamId: 'red' as const,
      strategy: 'set' as const,
      table,
      held,
      seed: 1234,
      roundIndex: 0,
    };
    const first = autoPick(args);
    const second = autoPick({ ...args });
    expect(second).toEqual(first);
    const otherSeed = autoPick({ ...args, seed: 1235 });
    // 不同种子允许相同选择, 但同一局面必须稳定复现.
    expect(otherSeed).toBeDefined();
  });
});
