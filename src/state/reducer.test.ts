import { describe, expect, it } from 'vitest';
import { createInitialState, labReducer } from './reducer';
import type { LabState } from './reducer';
import type { SaveFile, StorageLike } from '../game/types';
import { SAVES_KEY, createSave } from '../game/storage';
import { COLLISION_LAB } from '../game/scenarios';
import { createGame, openRound, applyDemoScript } from '../game/engine';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

function initial(viewer: LabState['viewer'] = 'observer'): LabState {
  return { ...createInitialState(null), viewer };
}

describe('视角权限', () => {
  it('旁观者不能替队伍选牌', () => {
    const state = initial('observer');
    const next = labReducer(state, {
      type: 'select',
      teamId: 'red',
      patch: { primary: 'r1-pot' },
    });
    expect(next.game).toBe(state.game);
    expect(next.notice?.kind).toBe('error');
  });

  it('队伍只能改自己的选择', () => {
    const state = initial('red');
    const own = labReducer(state, {
      type: 'select',
      teamId: 'red',
      patch: { primary: 'r1-pot' },
    });
    expect(own.game.selections.red.primary).toBe('r1-pot');

    const other = labReducer(state, {
      type: 'select',
      teamId: 'blue',
      patch: { primary: 'r1-pot' },
    });
    expect(other.game.selections.blue.primary).toBeNull();
    expect(other.notice?.kind).toBe('error');
  });

  it('旁观者不能确认队伍的选择', () => {
    const state = initial('observer');
    const next = labReducer(state, { type: 'confirm', teamId: 'red' });
    expect(next.notice?.kind).toBe('error');
  });

  it('确认前有缺项会给出错误提示而不是开牌', () => {
    const state = initial('red');
    const next = labReducer(state, { type: 'confirm', teamId: 'red' });
    expect(next.notice?.kind).toBe('error');
    expect(next.game.selections.red.confirmed).toBe(false);
  });

  it('开牌后不能再改选或确认', () => {
    const opened = openRound(applyDemoScript(createGame(COLLISION_LAB)));
    const state: LabState = { ...initial('red'), game: opened };
    const attempted = labReducer(state, {
      type: 'select',
      teamId: 'red',
      patch: { primary: 'r1-dou' },
    });
    expect(attempted.game).toBe(state.game);
    const confirmed = labReducer(state, { type: 'confirm', teamId: 'red' });
    expect(confirmed.game).toBe(state.game);
  });

  it('开牌后不能再切换手动/自动或策略', () => {
    const opened = openRound(applyDemoScript(createGame(COLLISION_LAB)));
    const state: LabState = { ...initial('observer'), game: opened };
    const next = labReducer(state, { type: 'set-control', teamId: 'red', control: 'auto' });
    expect(next.notice?.kind).toBe('error');
    expect(next.game.teams.find((team) => team.id === 'red')?.control).toBe('manual');
  });

  it('队伍只能调整自己的手动/自动配置, 旁观者可以替所有队调整', () => {
    const asRed = initial('red');
    const foreign = labReducer(asRed, { type: 'set-control', teamId: 'blue', control: 'auto' });
    expect(foreign.notice?.kind).toBe('error');

    const asObserver = initial('observer');
    const allowed = labReducer(asObserver, {
      type: 'set-control',
      teamId: 'blue',
      control: 'auto',
    });
    expect(allowed.game.teams.find((team) => team.id === 'blue')?.control).toBe('auto');
  });
});

describe('存档恢复', () => {
  it('开选前存档恢复后保持该阶段权限', () => {
    const storage = new MemoryStorage();
    const game = applyDemoScript(createGame(COLLISION_LAB));
    const save: SaveFile = createSave(game, 'blue', '开选前', new Date('2026-11-23T00:00:00Z'));
    storage.setItem(SAVES_KEY, JSON.stringify({ version: 1, saves: [save] }));

    const state = labReducer(createInitialState(storage), { type: 'set-viewer', viewer: 'observer' });
    const loaded = labReducer(state, { type: 'load', saveId: save.id });
    expect(loaded.viewer).toBe('blue');
    expect(loaded.game.phase).toBe('selecting');

    // 恢复为蓝队视角后, 蓝队仍可撤回并改选.
    const unconfirmed = labReducer(loaded, { type: 'unconfirm', teamId: 'blue' });
    expect(unconfirmed.game.selections.blue.confirmed).toBe(false);
    const changed = labReducer(unconfirmed, {
      type: 'select',
      teamId: 'blue',
      patch: { primary: 'r1-bi' },
    });
    expect(changed.game.selections.blue.primary).toBe('r1-bi');

    // 但不能动别队.
    const foreign = labReducer(changed, {
      type: 'select',
      teamId: 'red',
      patch: { primary: 'r1-dou' },
    });
    expect(foreign.notice?.kind).toBe('error');
    expect(foreign.game.selections.red.primary).toBe('r1-pot');
  });

  it('开牌后存档恢复后完全只读, 但可进入下一轮', () => {
    const storage = new MemoryStorage();
    const game = openRound(applyDemoScript(createGame(COLLISION_LAB)));
    const save = createSave(game, 'gold', '开牌后', new Date('2026-11-23T00:00:00Z'));
    storage.setItem(SAVES_KEY, JSON.stringify({ version: 1, saves: [save] }));

    const state = labReducer(createInitialState(storage), { type: 'load', saveId: save.id });
    expect(state.game.phase).toBe('opened');
    expect(state.viewer).toBe('gold');

    const attempted = labReducer(state, {
      type: 'select',
      teamId: 'gold',
      patch: { primary: 'r1-dou' },
    });
    expect(attempted.game).toBe(state.game);

    const advanced = labReducer(state, { type: 'next-round' });
    expect(advanced.game.roundIndex).toBe(1);
    expect(advanced.game.phase).toBe('selecting');
    expect(advanced.game.selections.red.primary).toBeNull();
  });

  it('不存在的存档给出错误提示而不是崩溃', () => {
    const state = initial('observer');
    const next = labReducer(state, { type: 'load', saveId: 'missing' });
    expect(next.notice?.kind).toBe('error');
    expect(next.game).toBe(state.game);
  });

  it('保存后存档出现在列表并写入存储', () => {
    const storage = new MemoryStorage();
    const state: LabState = { ...initial('red'), saveLabel: '测试存档' };
    const next = labReducer(state, { type: 'save', storage });
    expect(next.saves).toHaveLength(1);
    expect(next.saves[0]?.label).toBe('测试存档');
    expect(next.saves[0]?.viewTeam).toBe('red');
    expect(storage.getItem(SAVES_KEY)).toContain('测试存档');
  });
});
