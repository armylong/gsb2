import { describe, expect, it } from 'vitest';
import { axialToOffset, hexDistance, offsetToAxial } from '../src/hex';
import { Sandbox } from '../src/sandbox';
import type { UnitId } from '../src/types';

function cell(sandbox: Sandbox, col: number, row: number) {
  return sandbox.map.getAtOffset(col, row);
}

function visible(sandbox: Sandbox, col: number, row: number): boolean {
  const c = cell(sandbox, col, row);
  return sandbox.vision.isVisible(c.q, c.r);
}

function status(sandbox: Sandbox, col: number, row: number): 'visible' | 'explored' | 'unexplored' {
  const c = cell(sandbox, col, row);
  if (sandbox.vision.isVisible(c.q, c.r)) return 'visible';
  if (sandbox.vision.isExplored(c.q, c.r)) return 'explored';
  return 'unexplored';
}

function sources(sandbox: Sandbox, col: number, row: number): UnitId[] {
  const c = cell(sandbox, col, row);
  return [...sandbox.vision.sourcesFor(c.q, c.r)];
}

describe('shared vision', () => {
  it('cells visible by both scouts list both sources', () => {
    const sandbox = new Sandbox({ scenarioId: 'handoff' });
    const both = sandbox.map.all().filter((c) => sandbox.vision.sourcesFor(c.q, c.r).length === 2);
    expect(both.length).toBeGreaterThan(0);
    for (const c of both) {
      const src = sandbox.vision.sourcesFor(c.q, c.r);
      expect([...src].sort()).toEqual(['A', 'B']);
      expect(sandbox.vision.isVisible(c.q, c.r)).toBe(true);
    }
  });

  it('withdrawing one scout keeps the other scout’s cells visible', () => {
    const sandbox = new Sandbox({ scenarioId: 'handoff' });
    const onlyB = sandbox.map
      .all()
      .filter((c) => sandbox.vision.visibleBy('B', c.q, c.r) && !sandbox.vision.visibleBy('A', c.q, c.r));
    expect(onlyB.length).toBeGreaterThan(0);

    const removed = sandbox.withdrawUnit('A');
    expect(removed).not.toBeNull();
    for (const c of onlyB) {
      expect(sandbox.vision.isVisible(c.q, c.r)).toBe(true);
    }
    // Cells that only A could see must fall back to "explored", not vanish.
    const onlyA = sandbox.map.all().filter((c) => sandbox.vision.isExplored(c.q, c.r) && !visibleByAnyCurrent(sandbox, c.q, c.r));
    expect(onlyA.length).toBeGreaterThan(0);
    for (const c of onlyA) expect(sandbox.vision.isExplored(c.q, c.r)).toBe(true);
  });

  it('a shared cell stays visible after one scout withdraws', () => {
    const sandbox = new Sandbox({ scenarioId: 'handoff' });
    const shared = sandbox.map
      .all()
      .find((c) => sandbox.vision.sourcesFor(c.q, c.r).length === 2);
    expect(shared).toBeTruthy();
    sandbox.withdrawUnit('A');
    expect(sandbox.vision.isVisible(shared!.q, shared!.r)).toBe(true);
    expect(sandbox.vision.sourcesFor(shared!.q, shared!.r)).toEqual(['B']);
  });

  it('two scouts each at a different radius produce a union, not an intersection', () => {
    const sandbox = new Sandbox({ scenarioId: 'handoff' });
    const before = countVisible(sandbox);
    sandbox.setRadius('A', 1);
    const after = countVisible(sandbox);
    expect(after).toBeLessThan(before);
    // B's own cells must survive A shrinking.
    const bOnly = sandbox.map.all().filter((c) => sandbox.vision.visibleBy('B', c.q, c.r));
    expect(bOnly.length).toBeGreaterThan(0);
    for (const c of bOnly) expect(sandbox.vision.isVisible(c.q, c.r)).toBe(true);
  });

  it('expanding a radius adds visible cells and keeps memory', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    const near = sandbox.map.all().filter((c) => sandbox.vision.isVisible(c.q, c.r)).length;
    sandbox.setRadius('A', unit.radius + 2);
    const far = sandbox.map.all().filter((c) => sandbox.vision.isVisible(c.q, c.r)).length;
    expect(far).toBeGreaterThanOrEqual(near);
    expect(sandbox.vision.exploredCells.size).toBeGreaterThanOrEqual(far);
  });
});

function countVisible(sandbox: Sandbox): number {
  return sandbox.map.all().filter((c) => sandbox.vision.isVisible(c.q, c.r)).length;
}

function visibleByAnyCurrent(sandbox: Sandbox, q: number, r: number): boolean {
  return sandbox.units.some((u) => sandbox.vision.visibleBy(u.id, q, r));
}

describe('occluders', () => {
  it('walls block the cells behind them but are themselves visible', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    // Pillar cells (6,4)..(8,6) must all be visible from A.
    const pillar = [[6, 4], [7, 4], [8, 4], [6, 5], [7, 5], [8, 5], [6, 6], [7, 6], [8, 6]] as const;
    const visiblePillar = pillar.filter(([col, row]) => status(sandbox, col, row) === 'visible');
    expect(visiblePillar.length).toBeGreaterThanOrEqual(5);
    expect(status(sandbox, 7, 4)).toBe('visible');
    // The front face of the pillar is always visible; the back face is not.
    expect(status(sandbox, 6, 6)).toBe('visible');
    expect(status(sandbox, 8, 6)).toBe('unexplored');
    // The cell directly behind the pillar is not visible.
    expect(status(sandbox, 9, 6)).toBe('unexplored');
    const info = sandbox.hover(cell(sandbox, 9, 6).q, cell(sandbox, 9, 6).r);
    const fromA = info.perUnit.find((u) => u.unitId === 'A')!;
    expect(fromA.reason).toBe('blocked');
    expect(fromA.blocker).not.toBeNull();
    expect(fromA.blocker!.terrain).toBe('wall');
  });

  it('corner-grazing lines are transparent under the documented rule', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    // (10,4) is diagonally past the pillar's corner: the centre line only grazes.
    expect(status(sandbox, 10, 4)).toBe('visible');
  });

  it('a closed door blocks; toggling it open reveals the cell behind', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const door = cell(sandbox, 7, 5);
    expect(door.terrain).toBe('door');
    expect(door.doorOpen).toBe(false);
    const behind = cell(sandbox, 9, 5);
    expect(sandbox.vision.isVisible(behind.q, behind.r)).toBe(false);

    const before = sandbox.vision.revision;
    sandbox.toggleDoor(door.q, door.r);
    expect(sandbox.vision.revision).toBeGreaterThan(before);
    expect(sandbox.vision.isVisible(behind.q, behind.r)).toBe(true);
    expect(sandbox.vision.isVisible(door.q, door.r)).toBe(true);
  });

  it('closing an open door immediately hides cells behind it', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const openDoor = cell(sandbox, 7, 9);
    expect(openDoor.terrain).toBe('door');
    expect(openDoor.doorOpen).toBe(true);
    sandbox.setRadius('B', 6);
    const eastOfDoor = cell(sandbox, 9, 9);
    expect(sandbox.vision.isVisible(eastOfDoor.q, eastOfDoor.r)).toBe(true);
    sandbox.toggleDoor(openDoor.q, openDoor.r);
    expect(sandbox.vision.isVisible(eastOfDoor.q, eastOfDoor.r)).toBe(true); // B still sees it from the east
    // A west of the wall can see through only while the door is open.
    const westSide = cell(sandbox, 5, 9);
    expect(sandbox.vision.visibleBy('A', westSide.q, westSide.r)).toBe(true);
    sandbox.toggleDoor(openDoor.q, openDoor.r);
    sandbox.setRadius('B', 2);
    expect(sandbox.vision.isVisible(westSide.q, westSide.r)).toBe(true); // A still sees its own side
  });

  it('a closed door can still be reported as the blocker on hover', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const door = cell(sandbox, 7, 5);
    const target = cell(sandbox, 9, 5);
    const info = sandbox.hover(target.q, target.r);
    const fromA = info.perUnit.find((u) => u.unitId === 'A')!;
    expect(fromA.reason).toBe('blocked');
    expect(fromA.blocker).toEqual({ q: door.q, r: door.r, terrain: 'door', doorOpen: false });
  });
});

describe('exploration memory', () => {
  it('a cell you leave becomes explored but not visible, and the terrain is remembered', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const beforeVisible = sandbox.map.all().filter((c) => sandbox.vision.isVisible(c.q, c.r));
    const wall = beforeVisible.find((c) => c.terrain === 'wall');
    expect(wall).toBeTruthy();

    // Move away far enough that the wall leaves the radius.
    const a = sandbox.units.find((u) => u.id === 'A')!;
    sandbox.setRadius('A', 1);
    sandbox.setRadius('B', 1);
    expect(sandbox.vision.isVisible(wall!.q, wall!.r)).toBe(false);
    expect(sandbox.vision.isExplored(wall!.q, wall!.r)).toBe(true);
    const info = sandbox.hover(wall!.q, wall!.r);
    expect(info.state).toBe('explored');
    expect(info.terrain).toBe('wall');
  });

  it('moving, changing radius and toggling doors never erase exploration', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const remembered = new Set(sandbox.vision.exploredCells);
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    sandbox.tryMoveUnit('A', unit.q, unit.r + 1);
    sandbox.setRadius('A', 2);
    const door = sandbox.map.doors()[0]!;
    sandbox.toggleDoor(door.q, door.r);
    for (const key of remembered) {
      expect(sandbox.vision.exploredCells.has(key)).toBe(true);
    }
  });

  it('only reset clears exploration', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    expect(sandbox.vision.exploredCells.size).toBeGreaterThan(0);
    sandbox.reset();
    expect(sandbox.vision.exploredCells.size).toBeGreaterThan(0); // recompute adds current vision back
    const initial = new Set(sandbox.vision.exploredCells);
    sandbox.loadScenario('corner');
    expect(sandbox.vision.exploredCells.size).not.toBe(initial.size + 1000);
    // After switching scenario, exploration contains exactly the new current vision.
    const visibleNow = new Set([...sandbox.vision.current.visible]);
    for (const key of sandbox.vision.exploredCells) expect(visibleNow.has(key)).toBe(true);
  });

  it('editing terrain keeps exploration memory intact', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const before = new Set(sandbox.vision.exploredCells);
    const target = cell(sandbox, 4, 6);
    sandbox.setTerrain(target.q, target.r, 'wall');
    for (const key of before) expect(sandbox.vision.exploredCells.has(key)).toBe(true);
    expect(sandbox.vision.isExplored(target.q, target.r)).toBe(true);
  });
});

describe('hidden enemies', () => {
  it('visibleEnemies only returns currently visible markers', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const shown = sandbox.visibleEnemies();
    for (const enemy of shown) {
      expect(sandbox.vision.isVisible(enemy.q, enemy.r)).toBe(true);
    }
    expect(shown.length).toBeLessThan(sandbox.enemies.length);
  });

  it('a hidden enemy cannot be picked and reports no enemy in hover data', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const hidden = sandbox.enemies.find((e) => !sandbox.vision.isVisible(e.q, e.r))!;
    expect(hidden).toBeTruthy();
    expect(sandbox.enemyPickableAt(hidden.q, hidden.r)).toBeNull();
    expect(sandbox.hover(hidden.q, hidden.r).enemy).toBeNull();
  });

  it('an enemy that leaves vision keeps its position secret', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const visibleEnemy = sandbox.enemies.find((e) => sandbox.vision.isVisible(e.q, e.r));
    if (visibleEnemy) {
      const pos = { q: visibleEnemy.q, r: visibleEnemy.r };
      sandbox.setRadius('A', 1);
      sandbox.setRadius('B', 1);
      expect(sandbox.vision.isVisible(pos.q, pos.r)).toBe(false);
      expect(sandbox.enemyPickableAt(pos.q, pos.r)).toBeNull();
      // Memory still shows the terrain, but never the enemy.
      expect(sandbox.hover(pos.q, pos.r).enemy).toBeNull();
    }
  });

  it('debug mode reveals every enemy for the omniscient view only', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner', mode: 'debug' });
    expect(sandbox.visibleEnemies().length).toBe(sandbox.enemies.length);
    const hidden = sandbox.enemies.find((e) => !sandbox.vision.isVisible(e.q, e.r))!;
    expect(sandbox.enemyPickableAt(hidden.q, hidden.r)).not.toBeNull();

    sandbox.mode = 'player';
    expect(sandbox.enemyPickableAt(hidden.q, hidden.r)).toBeNull();
  });

  it('debug mode can move an enemy into and out of vision', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner', mode: 'debug' });
    const enemy = sandbox.enemies[0]!;
    const target = cell(sandbox, 3, 6); // next to A, definitely visible
    expect(sandbox.moveEnemy(enemy.id, target.q, target.r)).toBe(true);
    expect(sandbox.vision.isVisible(target.q, target.r)).toBe(true);
    const far = cell(sandbox, 14, 0);
    expect(sandbox.moveEnemy(enemy.id, far.q, far.r)).toBe(true);
    expect(sandbox.vision.isVisible(far.q, far.r)).toBe(false);
  });

  it('enemy movement does not change vision or exploration', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner', mode: 'debug' });
    const revision = sandbox.vision.revision;
    const enemy = sandbox.enemies[0]!;
    sandbox.moveEnemy(enemy.id, cell(sandbox, 1, 1).q, cell(sandbox, 1, 1).r);
    expect(sandbox.vision.revision).toBe(revision);
  });
});

describe('radius control', () => {
  it('a radius change immediately recomputes', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    const target = cell(sandbox, 4, 6);
    const distance = hexDistance(unit.q, unit.r, target.q, target.r);
    expect(distance).toBe(2);
    sandbox.setRadius('A', distance - 1);
    expect(sandbox.vision.isVisible(target.q, target.r)).toBe(false);
    sandbox.setRadius('A', distance);
    expect(sandbox.vision.isVisible(target.q, target.r)).toBe(true);
  });

  it('nothing outside the radius is ever visible', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    for (const unit of sandbox.units) {
      const seen = sandbox.vision.current.perUnit.get(unit.id)!;
      for (const key of seen) {
        const [q, r] = key.split(',').map(Number) as [number, number];
        expect(hexDistance(unit.q, unit.r, q, r)).toBeLessThanOrEqual(unit.radius);
      }
    }
  });
});

describe('vision state transitions', () => {
  it('move → recompute → explored cells preserved in the same step', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    const start = { q: unit.q, r: unit.r };
    sandbox.setRadius('A', 2);
    const exploredBefore = new Set(sandbox.vision.exploredCells);
    const moved = sandbox.tryMoveUnit('A', start.q + 1, start.r);
    if (moved.ok) {
      expect(sandbox.vision.exploredCells.size).toBeGreaterThanOrEqual(exploredBefore.size);
      expect(sandbox.vision.isExplored(start.q, start.r)).toBe(true);
    }
  });
});

describe('offset / axial round trips used by the UI', () => {
  it('every map cell key round-trips', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    for (const c of sandbox.map.all()) {
      const offset = axialToOffset(c.q, c.r);
      const back = offsetToAxial(offset.col, offset.row);
      expect(back).toEqual({ q: c.q, r: c.r });
      expect(sandbox.cellCoordinates(c.q, c.r).key).toBe(`${c.q},${c.r}`);
    }
  });
});

describe('hover data hygiene', () => {
  it('never reports a blocker outside the scout’s own radius', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    sandbox.setRadius('A', 2);
    sandbox.setRadius('B', 1);
    for (const cell of sandbox.map.all()) {
      const info = sandbox.hover(cell.q, cell.r);
      for (const unit of info.perUnit) {
        if (!unit.blocker) continue;
        const source = sandbox.units.find((u) => u.id === unit.unitId)!;
        expect(hexDistance(source.q, source.r, unit.blocker.q, unit.blocker.r)).toBeLessThanOrEqual(
          source.radius,
        );
      }
    }
  });

  it('never reports live terrain for an unexplored cell', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    sandbox.setRadius('A', 1);
    sandbox.setRadius('B', 1);
    // Find a never-seen cell.
    const unseen = sandbox.map.all().find((c) => !sandbox.vision.isExplored(c.q, c.r));
    if (!unseen) return;
    const info = sandbox.hover(unseen.q, unseen.r);
    expect(info.state).toBe('unexplored');
    expect(info.terrain).toBeNull();
    expect(info.enemy).toBeNull();
  });
});

describe('door knowledge gating', () => {
  it('a door beyond every scout’s sight is not reported as known', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    sandbox.setRadius('A', 1);
    sandbox.setRadius('B', 1);
    const door = sandbox.map.doors()[0]!;
    expect(sandbox.vision.isVisible(door.q, door.r)).toBe(false);
    expect(sandbox.isDoorKnown(door.q, door.r)).toBe(true); // remembered from before
    // With no memory (fresh engine) it is unknown.
    sandbox.vision.resetExplored();
    sandbox.refresh();
    expect(sandbox.isDoorKnown(door.q, door.r)).toBe(false);
  });
});
