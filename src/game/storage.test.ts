import { describe, expect, it } from 'vitest';
import { applyDemoScript, createGame, openRound, toRoundView } from './engine';
import { COLLISION_LAB } from './scenarios';
import {
  SAVES_KEY,
  addSave,
  createSave,
  defaultSaveLabel,
  loadSaves,
  parseSaves,
  removeSave,
  serializeSaves,
} from './storage';
import type { StorageLike } from './types';

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  raw(key: string): string | null {
    return this.data.get(key) ?? null;
  }
}

describe('存档格式', () => {
  it('开选前存档恢复后只暴露该阶段可见的信息', () => {
    const storage = new MemoryStorage();
    const game = applyDemoScript(createGame(COLLISION_LAB));
    const save = createSave(game, 'blue', null, new Date('2026-11-23T10:00:00.000Z'));
    addSave(storage, save);

    const restored = loadSaves(storage)[0];
    expect(restored).toBeDefined();
    expect(restored?.viewTeam).toBe('blue');
    expect(restored?.game.phase).toBe('selecting');

    const view = toRoundView(restored!.game, restored!.viewTeam);
    expect(view.phase).toBe('selecting');
    expect(view.selections.blue.primary).toBe('r1-pot');
    expect(view.selections.red.primary).toBeNull();
    expect(view.selections.gold.primary).toBeNull();
    expect(view.result).toBeNull();
  });

  it('开牌后存档恢复后公开所有选择与裁定', () => {
    const storage = new MemoryStorage();
    const game = openRound(applyDemoScript(createGame(COLLISION_LAB)));
    const save = createSave(game, 'red', '开牌后复原', new Date('2026-11-23T11:00:00.000Z'));
    addSave(storage, save);

    const restored = loadSaves(storage)[0];
    expect(restored?.game.phase).toBe('opened');
    const view = toRoundView(restored!.game, 'red');
    expect(view.phase).toBe('opened');
    expect(view.selections.blue.primary).toBe('r1-pot');
    expect(view.result?.assignments.length).toBeGreaterThan(0);
    expect(view.result?.priority).toEqual(['red', 'blue', 'gold']);
  });

  it('默认标签包含场景、轮次和阶段', () => {
    const game = createGame(COLLISION_LAB);
    expect(defaultSaveLabel(game)).toContain('撞选试验场');
    expect(defaultSaveLabel(game)).toContain('第 1 轮');
    expect(defaultSaveLabel(game)).toContain('开选前');
    const opened = openRound(applyDemoScript(game));
    expect(defaultSaveLabel(opened)).toContain('开牌后');
  });

  it('新增与删除都写回存储', () => {
    const storage = new MemoryStorage();
    const game = createGame(COLLISION_LAB);
    addSave(storage, createSave(game, 'observer', '存档甲'));
    addSave(storage, createSave(game, 'red', '存档乙'));
    expect(storage.raw(SAVES_KEY)).not.toBeNull();
    const saved = loadSaves(storage);
    expect(saved).toHaveLength(2);
    expect(saved[0]?.label).toBe('存档乙');
    const removed = removeSave(storage, saved[0]!.id);
    expect(removed).toHaveLength(1);
    expect(loadSaves(storage)).toHaveLength(1);
  });

  it('损坏的存储内容被忽略而不是抛错', () => {
    expect(parseSaves('not json')).toEqual([]);
    expect(parseSaves('{"saves":[{"oops":true}]}')).toEqual([]);
    const storage = new MemoryStorage();
    storage.setItem(SAVES_KEY, '{broken');
    expect(loadSaves(storage)).toEqual([]);
  });

  it('序列化后可重新解析', () => {
    const game = createGame(COLLISION_LAB);
    const save = createSave(game, 'gold', null);
    const parsed = parseSaves(serializeSaves([save]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.game.seed).toBe(game.seed);
  });
});
