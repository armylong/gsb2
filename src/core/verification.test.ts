import { describe, expect, it } from 'vitest';
import { LEVELS, getLevel } from '../data/levels';
import { SCRIPTS, scriptsForLevel } from '../data/scripts';
import { createGame, evaluate, previewStamp, stamp, toggleMask, undo, colorOfLayers } from './game';
import { mapHoles, transformHole, uniqueOrientations } from './geometry';
import { runScript } from './script';
import { validateLevel } from './validate';
import type { GameState, LevelDef, StampRequest } from './types';

function req(level: LevelDef, stencilId: string, ink: string, pivot: { x: number; y: number }, rotation = 0, flipped = false): StampRequest {
  const found = level.stencils.find((s) => s.id === stencilId);
  if (!found) throw new Error(`missing stencil ${stencilId}`);
  return { stencilId, ink, pivot, orientation: { rotation, flipped } };
}

function colorAt(level: LevelDef, state: GameState, x: number, y: number): string {
  return colorOfLayers(level, state.cells[y * level.width + x]!.layers);
}

describe('关卡数据', () => {
  for (const level of LEVELS) {
    it(`${level.name} 通过校验`, () => {
      expect(() => validateLevel(level)).not.toThrow();
    });
    it(`${level.name} 的所有模板都有可用的朝向`, () => {
      for (const stencil of level.stencils) {
        const shapes = uniqueOrientations(stencil);
        expect(shapes.length).toBeGreaterThan(0);
        for (const shape of shapes) expect(shape.cells.length).toBe(stencil.holes.length);
      }
    });
  }
});

describe('模板几何', () => {
  const hook = {
    id: 'h',
    name: 'h',
    holes: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
    ],
  };
  it('翻面把横枝换到另一侧', () => {
    expect(transformHole({ x: 1, y: 0 }, { rotation: 0, flipped: false })).toEqual({ x: 1, y: 0 });
    expect(transformHole({ x: 1, y: 0 }, { rotation: 0, flipped: true })).toEqual({ x: -1, y: 0 });
  });
  it('旋转与翻面组合保持孔数且不重复', () => {
    for (const shape of uniqueOrientations(hook)) {
      const keys = new Set(shape.cells.map((c) => `${c.x},${c.y}`));
      expect(keys.size).toBe(4);
    }
  });
  it('定位点随平移移动', () => {
    const cells = mapHoles(hook, { x: 4, y: 5 }, { rotation: 0, flipped: true });
    expect(cells).toEqual([
      { x: 4, y: 5 },
      { x: 3, y: 5 },
      { x: 4, y: 6 },
      { x: 4, y: 7 },
    ]);
  });
  it('旋转三次回到原位', () => {
    const a = transformHole({ x: 2, y: -1 }, { rotation: 0, flipped: false });
    const b = transformHole({ x: 2, y: -1 }, { rotation: 4, flipped: false });
    expect(a).toEqual(b);
  });
});

describe('盖印规则', () => {
  const level = getLevel('four-corner-flower');

  it('墨量不足时整次拒绝，棋盘与墨量都不变', () => {
    const initial = createGame(level);
    // 人为把铁锈压到只够 3 格，而十字需要接触 5 格。
    const before: GameState = { ...initial, inkLeft: { ...initial.inkLeft, rust: 3 } };
    const request = req(level, 'plus', 'rust', { x: 2, y: 2 });
    const preview = previewStamp(level, before, request);
    expect(preview.cost).toBe(5);
    expect(preview.inkRemaining).toBe(3);
    expect(preview.canApply).toBe(false);
    const result = stamp(level, before, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient-ink');
    expect(before.cells.every((c) => c.layers.length === 0)).toBe(true);
    expect(before.inkLeft.rust).toBe(3);
  });

  it('同一格反复盖色会再次计费', () => {
    let state = createGame(level);
    const first = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.game;
    const second = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.cost).toBe(5);
    expect(second.game.inkLeft.rust).toBe(level.budget.rust! - 10);
    const center = second.game.cells[2 * level.width + 2]!;
    expect(center.layers.length).toBe(2);
  });

  it('同色重复不改变颜色，但仍记录墨层', () => {
    let state = createGame(level);
    const result = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    if (!result.ok) throw new Error('stamp failed');
    state = result.game;
    const again = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    if (!again.ok) throw new Error('stamp failed');
    expect(colorAt(level, again.game, 2, 2)).toBe('rust');
    expect(again.game.cells[2 * level.width + 2]!.layers).toHaveLength(2);
  });

  it('没有接触任何格时不能盖印', () => {
    const state = createGame(level);
    const result = stamp(level, state, req(level, 'hook', 'rust', { x: -5, y: -5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-contact');
  });

  it('盖到保留格会判失败并记录新弄脏的格', () => {
    const state = createGame(level);
    const result = stamp(level, state, req(level, 'elbow', 'rust', { x: 1, y: 1 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.game.status).toBe('failed');
    expect(result.game.failure?.newCells).toEqual([{ x: 1, y: 1 }]);
    expect(result.game.failure?.cells).toEqual([{ x: 1, y: 1 }]);
  });

  it('挡墨纸阻止沾墨，拿掉后原色保留', () => {
    let state = createGame(level);
    const base = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    if (!base.ok) throw new Error('stamp failed');
    state = base.game;
    const covered = toggleMask(level, state, 2, 2);
    if (!covered.ok) throw new Error(covered.message);
    state = covered.game;
    const blocked = stamp(level, state, req(level, 'plus', 'indigo', { x: 2, y: 2 }));
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    state = blocked.game;
    expect(colorAt(level, state, 2, 2)).toBe('rust');
    expect(colorAt(level, state, 1, 2)).toBe('violet');
    const removed = toggleMask(level, state, 2, 2);
    if (!removed.ok) throw new Error(removed.message);
    expect(colorAt(level, removed.game, 2, 2)).toBe('rust');
    expect(removed.game.mask[2 * level.width + 2]).toBe(false);
  });

  it('撤回一印返还用量并恢复状态', () => {
    let state = createGame(level);
    const before = { ink: state.inkLeft.rust ?? 0, stampNo: state.stampNo };
    const result = stamp(level, state, req(level, 'plus', 'rust', { x: 2, y: 2 }));
    if (!result.ok) throw new Error('stamp failed');
    state = result.game;
    expect(state.inkLeft.rust).toBe(before.ink - 5);
    const undone = undo(state);
    if (!undone) throw new Error('undo failed');
    expect(undone.game.inkLeft.rust).toBe(before.ink);
    expect(undone.game.stampNo).toBe(before.stampNo);
    expect(undone.game.cells.every((c) => c.layers.length === 0)).toBe(true);
    expect(undone.game.history).toHaveLength(0);
  });

  it('撤回挡墨纸也能成立', () => {
    let state = createGame(level);
    const covered = toggleMask(level, state, 1, 1);
    if (!covered.ok) throw new Error(covered.message);
    state = covered.game;
    const undone = undo(state);
    if (!undone) throw new Error('undo failed');
    expect(undone.game.mask.some(Boolean)).toBe(false);
    expect(undone.game.history).toHaveLength(0);
  });

  it('预览不消耗墨量', () => {
    const state = createGame(level);
    const preview = previewStamp(level, state, req(level, 'plus', 'indigo', { x: 2, y: 2 }));
    expect(preview.cost).toBe(5);
    expect(state.inkLeft.indigo).toBe(5);
    expect(state.stampNo).toBe(0);
    expect(state.cells.every((c) => c.layers.length === 0)).toBe(true);
  });

  it('无法在失败或完成状态继续盖印', () => {
    let state = createGame(level);
    const fail = stamp(level, state, req(level, 'elbow', 'rust', { x: 1, y: 1 }));
    if (!fail.ok) throw new Error('stamp failed');
    state = fail.game;
    const next = stamp(level, state, req(level, 'plus', 'indigo', { x: 2, y: 2 }));
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toBe('not-playing');
  });
});

describe('叠色表', () => {
  for (const level of LEVELS) {
    it(`${level.name} 的叠色表闭合且只会产生调色板内的颜色`, () => {
      const paletteIds = new Set(level.palette.map((p) => p.id));
      const colors = new Set<string>([level.paperColor, ...level.inks.map((ink) => ink.color)]);
      const queue = [...colors];
      while (queue.length) {
        const color = queue.shift()!;
        for (const ink of level.inks) {
          const result = level.mix[`${color}|${ink.color}`];
          expect(result, `缺少 ${color}|${ink.color}`).toBeDefined();
          if (!result) continue;
          expect(paletteIds.has(result), `${color}|${ink.color} → ${result} 不在调色板`).toBe(true);
          if (!colors.has(result)) {
            colors.add(result);
            queue.push(result);
          }
        }
      }
    });
  }

  it('三层叠印结果由关卡表决定，不依赖墨的实际颜色', () => {
    const level = getLevel('four-corner-flower');
    const state = createGame(level);
    const steps = [
      req(level, 'plus', 'rust', { x: 2, y: 2 }),
      req(level, 'plus', 'indigo', { x: 2, y: 2 }),
      req(level, 'plus', 'rust', { x: 2, y: 2 }),
    ];
    let current = state;
    for (const step of steps) {
      const result = stamp(level, current, step);
      if (!result.ok) throw new Error(result.message);
      current = result.game;
    }
    expect(colorAt(level, current, 2, 2)).toBe('violet');
    expect(current.cells[2 * level.width + 2]!.layers).toHaveLength(3);
  });
});

describe('样图判定', () => {
  it('错色与沾墨保留格都会导致未完成', () => {
    const level = getLevel('four-corner-flower');
    const state = createGame(level);
    const evaluation = evaluate(level, state);
    expect(evaluation.solved).toBe(false);
    expect(evaluation.mismatches.length).toBeGreaterThan(0);
    expect(evaluation.cleanViolations).toHaveLength(0);
  });
});

describe('验证操作串', () => {
  for (const script of SCRIPTS) {
    it(`${script.name} 全步骤通过`, () => {
      const level = getLevel(script.levelId);
      const run = runScript(level, script);
      for (const step of run.steps) {
        expect(step.checks.every((c) => c.pass), `${step.label}: ${step.checks.filter((c) => !c.pass).map((c) => c.detail).join(' / ')}`).toBe(true);
      }
      expect(run.passed).toBe(true);
      expect(run.evaluation.solved).toBe(true);
    });
  }

  it('第一关操作串覆盖翻面、墨量刚好与保留格失败', () => {
    const script = scriptsForLevel('four-corner-flower')[0]!;
    const stampSteps = script.steps.filter((s) => s.kind === 'stamp') as Extract<(typeof script.steps)[number], { kind: 'stamp' }>[];
    expect(stampSteps.some((s) => s.flipped && s.expect.ok)).toBe(true);
    expect(stampSteps.some((s) => s.expect.ok && s.expect.inkLeft === 0)).toBe(true);
    expect(stampSteps.some((s) => s.expect.ok && s.expect.status === 'failed')).toBe(true);
    expect(stampSteps.some((s) => !s.expect.ok && s.expect.reason === 'insufficient-ink')).toBe(true);
  });

  it('第二关操作串覆盖挡墨纸保护与收回', () => {
    const script = scriptsForLevel('guarded-heart')[0]!;
    expect(script.steps.some((s) => s.kind === 'mask' && s.expect.masked)).toBe(true);
    expect(script.steps.some((s) => s.kind === 'mask' && !s.expect.masked && s.expect.cellColor)).toBe(true);
  });

  it('重放同一操作串得到相同结果', () => {
    const level = getLevel('four-corner-flower');
    const first = runScript(level, scriptsForLevel(level.id)[0]!);
    const second = runScript(level, scriptsForLevel(level.id)[0]!);
    expect(first.state.stampNo).toBe(second.state.stampNo);
    expect(first.state.inkLeft).toEqual(second.state.inkLeft);
    expect(first.state.cells).toEqual(second.state.cells);
    expect(first.state.status).toBe('solved');
  });
});
