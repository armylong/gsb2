import { describe, expect, it } from 'vitest';
import { ACCESSORY_SCRIPTS } from '../data/test-scripts';
import { SCRIPTS } from '../data/scripts';
import { getLevel } from '../data/levels';
import { runScript } from './script';
import { cellId, formatScript, parseCellId, parseScript } from './script-format';

describe('操作串文本格式', () => {
  it('格子标签往返', () => {
    expect(cellId({ x: 0, y: 0 })).toBe('A1');
    expect(cellId({ x: 2, y: 4 })).toBe('C5');
    expect(parseCellId('F6')).toEqual({ x: 5, y: 5 });
    expect(() => parseCellId('1A')).toThrow();
    expect(() => parseCellId('A0')).toThrow();
  });

  it('内置操作串可以解析、执行并通过', () => {
    for (const script of [...SCRIPTS, ...ACCESSORY_SCRIPTS]) {
      const level = getLevel(script.levelId);
      const run = runScript(level, script);
      expect(run.passed, `${script.name} 未通过`).toBe(true);
    }
  });

  it('规范化文本再次解析后行为一致', () => {
    for (const script of SCRIPTS) {
      const text = formatScript(script);
      const reparsed = parseScript(text);
      expect(reparsed.steps).toHaveLength(script.steps.length);
      const level = getLevel(script.levelId);
      const a = runScript(level, script);
      const b = runScript(level, reparsed);
      expect(b.passed).toBe(true);
      expect(b.state.inkLeft).toEqual(a.state.inkLeft);
      expect(b.state.cells).toEqual(a.state.cells);
    }
  });

  it('解析报错会指出行号', () => {
    const text = ['@name 坏串', '@level four-corner-flower', 'stamp hook rust at 9Z rot 0 flip 0'].join('\n');
    expect(() => parseScript(text)).toThrow(/第 3 行/);
  });

  it('缺少元信息会报错', () => {
    expect(() => parseScript('stamp hook rust at A1 rot 0 flip 0')).toThrow(/@name/);
  });
});
