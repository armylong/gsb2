import { describe, expect, it } from 'vitest';
import { createDemoConfig } from '../src/engine/demo';
import { validateConfig } from '../src/engine/validate';
import {
  loadFromStorage,
  saveToStorage,
  serializeConfig,
  STORAGE_KEY,
  tryApplyConfig,
  tryApplyConfigText,
} from '../src/engine/config-store';

function clone() {
  return JSON.parse(JSON.stringify(createDemoConfig())) as Record<string, unknown>;
}

describe('配置校验', () => {
  it('内置配置合法', () => {
    const result = validateConfig(createDemoConfig());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('拒绝缺失状态引用', () => {
    const raw = clone();
    (raw.transitions as Array<Record<string, unknown>>)[0].to = 'missing-state';
    const result = validateConfig(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('引用了不存在的状态: missing-state');
  });

  it('拒绝非法时长', () => {
    for (const duration of [0, -100, Number.NaN, '1200']) {
      const raw = clone();
      (raw.states as Array<Record<string, unknown>>)[0].durationMs = duration;
      const result = validateConfig(raw);
      expect(result.ok, `duration=${String(duration)}`).toBe(false);
      expect(result.errors.join()).toContain('durationMs');
    }
  });

  it('拒绝越界事件时间', () => {
    const raw = clone();
    const states = raw.states as Array<Record<string, unknown>>;
    (states[0].events as Array<Record<string, unknown>>)[0].timeMs = 1400;
    const result = validateConfig(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('越界');

    const raw2 = clone();
    const states2 = raw2.states as Array<Record<string, unknown>>;
    (states2[0].events as Array<Record<string, unknown>>)[1].timeMs = -1;
    expect(validateConfig(raw2).ok).toBe(false);
  });

  it('拒绝非法初始状态与非法进度', () => {
    const raw = clone();
    raw.initialState = 'nope';
    expect(validateConfig(raw).errors.join()).toContain('initialState');

    const raw2 = clone();
    (raw2.transitions as Array<Record<string, unknown>>)[0].progress = 1.4;
    expect(validateConfig(raw2).errors.join()).toContain('[0, 1]');
  });

  it('拒绝重复 id 和未知事件类型', () => {
    const raw = clone();
    const states = raw.states as Array<Record<string, unknown>>;
    (states[1].events as Array<Record<string, unknown>>)[0].id = 'idle-breathe-a';
    expect(validateConfig(raw).errors.join()).toContain('事件 id 重复');

    const raw2 = clone();
    const states2 = raw2.states as Array<Record<string, unknown>>;
    (states2[0].events as Array<Record<string, unknown>>)[0].kind = 'explosion';
    expect(validateConfig(raw2).errors.join()).toContain('kind');
  });

  it('非对象输入直接失败', () => {
    expect(validateConfig(null).ok).toBe(false);
    expect(validateConfig([]).ok).toBe(false);
    expect(validateConfig('{"a":1}').ok).toBe(false);
  });
});

describe('应用与保留已有配置', () => {
  it('校验失败时整体拒绝, 返回原配置', () => {
    const current = createDemoConfig();
    const raw = clone();
    (raw.states as Array<Record<string, unknown>>)[0].durationMs = -5;
    const result = tryApplyConfig(current, raw);
    expect(result.applied).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.config).toBe(current);
    expect(serializeConfig(result.config)).toBe(serializeConfig(createDemoConfig()));
  });

  it('JSON 语法错误时不破坏已有配置', () => {
    const current = createDemoConfig();
    const result = tryApplyConfigText(current, '{ "states": [');
    expect(result.applied).toBe(false);
    expect(result.errors[0]).toContain('JSON 解析失败');
    expect(result.config).toBe(current);
  });

  it('合法配置被规范化后应用', () => {
    const current = createDemoConfig();
    const raw = clone();
    raw.name = '我的配置';
    (raw.states as Array<Record<string, unknown>>)[0].durationMs = 2000;
    const result = tryApplyConfig(current, raw);
    expect(result.applied).toBe(true);
    expect(result.config.name).toBe('我的配置');
    expect(result.config.states[0].durationMs).toBe(2000);
    // 深拷贝: 修改结果不影响传入对象
    result.config.states[0].name = '改名';
    expect((raw.states as Array<Record<string, unknown>>)[0].name).not.toBe('改名');
  });
});

describe('保存与载入', () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      map,
    };
  }

  it('保存后可原样载入', () => {
    const storage = memoryStorage();
    const config = createDemoConfig();
    expect(saveToStorage(storage, config).ok).toBe(true);
    expect(storage.map.get(STORAGE_KEY)).toContain('几何角色示例');
    const loaded = loadFromStorage(storage, createDemoConfig());
    expect(loaded.found).toBe(true);
    expect(loaded.applied).toBe(true);
    expect(loaded.config).toEqual(config);
  });

  it('已存配置损坏时保留当前配置', () => {
    const storage = memoryStorage();
    const current = createDemoConfig();
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, name: '坏', states: [] }));
    const loaded = loadFromStorage(storage, current);
    expect(loaded.found).toBe(true);
    expect(loaded.applied).toBe(false);
    expect(loaded.config).toBe(current);
  });

  it('没有保存时返回明确提示', () => {
    const loaded = loadFromStorage(memoryStorage(), createDemoConfig());
    expect(loaded.found).toBe(false);
    expect(loaded.errors[0]).toContain('尚无已保存配置');
  });

  it('存储不可用不抛出', () => {
    expect(saveToStorage(null, createDemoConfig()).ok).toBe(false);
    expect(loadFromStorage(null, createDemoConfig()).applied).toBe(false);
  });
});
