import { describe, expect, it } from 'vitest';
import { defaultBindings, findConflict, resolveActive } from '../core/bindings';
import { InputEngine, EngineEvent } from '../core/engine';
import { chordSatisfied } from '../core/keys';

function makeEngine() {
  const bindings = defaultBindings();
  bindings.game.interact = { code: 'KeyE', modifiers: [] };
  bindings.game.dash = { code: 'KeyE', modifiers: ['Shift'] };
  const engine = new InputEngine(bindings);
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events, bindings };
}

const edges = (events: EngineEvent[]) => events.filter((e) => e.type === 'edge').map((e) => (e as { action: string }).action);

describe('绑定冲突', () => {
  it('同场景完全重复绑定被检出', () => {
    const b = defaultBindings();
    expect(findConflict(b, 'game', 'interact', { code: 'KeyW', modifiers: [] })).toBe('moveUp');
    expect(findConflict(b, 'game', 'interact', { code: 'KeyE', modifiers: [] })).toBeNull();
  });

  it('不同场景允许复用同一按键', () => {
    const b = defaultBindings();
    // 菜单场景绑定 KeyW 不与游戏场景的 KeyW 冲突
    expect(findConflict(b, 'menu', 'interact', { code: 'KeyW', modifiers: [] })).toBeNull();
  });

  it('修饰键不同不算重复', () => {
    const b = defaultBindings();
    b.game.dash = { code: 'KeyE', modifiers: ['Shift'] };
    expect(findConflict(b, 'game', 'interact', { code: 'KeyE', modifiers: [] })).toBeNull();
  });
});

describe('组合键满足与优先级', () => {
  it('修饰键必须按下才满足', () => {
    const chord = { code: 'KeyE', modifiers: ['Shift' as const] };
    expect(chordSatisfied(chord, new Set(['KeyE']))).toBe(false);
    expect(chordSatisfied(chord, new Set(['KeyE', 'ShiftLeft']))).toBe(true);
    expect(chordSatisfied(chord, new Set(['KeyE', 'ShiftRight']))).toBe(true);
  });

  it('单键与组合同时满足时只激活更具体的组合', () => {
    const b = defaultBindings();
    b.game.interact = { code: 'KeyE', modifiers: [] };
    b.game.dash = { code: 'KeyE', modifiers: ['Shift'] };
    const active = resolveActive(b, 'game', new Set(['KeyE', 'ShiftLeft']));
    expect(active.has('dash')).toBe(true);
    expect(active.has('interact')).toBe(false);
    // 只按 E 时交互激活
    const active2 = resolveActive(b, 'game', new Set(['KeyE']));
    expect(active2.has('interact')).toBe(true);
    expect(active2.has('dash')).toBe(false);
  });
});

describe('按下边沿与修饰键释放', () => {
  it('边沿动作只触发一次，系统重复按键不重复触发', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('KeyE');
    engine.keyDown('KeyE'); // 模拟系统 repeat
    engine.keyDown('KeyE');
    expect(edges(events)).toEqual(['interact']);
    engine.keyUp('KeyE');
    engine.keyDown('KeyE');
    expect(edges(events)).toEqual(['interact', 'interact']);
  });

  it('Shift+E 触发冲刺而非交互', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('ShiftLeft');
    engine.keyDown('KeyE');
    expect(edges(events)).toEqual(['dash']);
  });

  it('先按 E 再补按 Shift：交互被冲刺取代', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('KeyE');
    engine.keyDown('ShiftLeft');
    expect(edges(events)).toEqual(['interact', 'dash']);
  });

  it('松开修饰键不会凭空产生一次单键交互', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('ShiftLeft');
    engine.keyDown('KeyE');
    engine.keyUp('ShiftLeft'); // E 仍按住：单键交互进入激活但被抑制
    expect(edges(events)).toEqual(['dash']);
    engine.keyUp('KeyE');
    engine.keyDown('KeyE'); // 完全松开后重新按下才触发
    expect(edges(events)).toEqual(['dash', 'interact']);
  });

  it('持续动作按下激活、松开释放', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('KeyW');
    expect(engine.getActive().has('moveUp')).toBe(true);
    engine.keyUp('KeyW');
    expect(engine.getActive().has('moveUp')).toBe(false);
    expect(events.some((e) => e.type === 'actionUp' && e.action === 'moveUp')).toBe(true);
  });
});

describe('失焦与场景切换', () => {
  it('失焦清除所有按住状态并释放动作', () => {
    const { engine, events } = makeEngine();
    engine.keyDown('KeyW');
    engine.keyDown('KeyE');
    engine.clearAll();
    expect(engine.getPressed().size).toBe(0);
    expect(engine.getActive().size).toBe(0);
    expect(events.filter((e) => e.type === 'actionUp').length).toBe(2);
    // 失焦后残留的 keyup 不应出错
    engine.keyUp('KeyW');
    expect(engine.getActive().size).toBe(0);
  });

  it('切换场景释放旧场景按住的动作，且新场景边沿动作不凭空触发', () => {
    const { engine, events, bindings } = makeEngine();
    bindings.menu.interact = { code: 'KeyW', modifiers: [] }; // 菜单里 W 是交互
    engine.keyDown('KeyW'); // 游戏里 W 是上移
    expect(engine.getActive().has('moveUp')).toBe(true);
    engine.setScene('menu');
    expect(engine.getActive().has('moveUp')).toBe(false);
    expect(events.some((e) => e.type === 'actionUp' && e.action === 'moveUp')).toBe(true);
    // W 仍按住，菜单的交互被激活但不触发边沿
    expect(engine.getActive().has('interact')).toBe(true);
    expect(edges(events)).toEqual([]);
    engine.keyUp('KeyW');
    engine.keyDown('KeyW');
    expect(edges(events)).toEqual(['interact']);
  });

  it('引擎禁用期间忽略真实按键（回放隔离）', () => {
    const { engine } = makeEngine();
    engine.enabled = false;
    engine.keyDown('KeyE');
    expect(engine.getActive().size).toBe(0);
  });
});
