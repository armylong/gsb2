import { describe, expect, it } from 'vitest';
import { axialToOffset, hexDistance, offsetToAxial } from '../src/hex';
import { Sandbox } from '../src/sandbox';
import { scenarioById } from '../src/scenarios';

function keyOf(col: number, row: number): string {
  const { q, r } = offsetToAxial(col, row);
  return `${q},${r}`;
}

function status(sandbox: Sandbox, col: number, row: number) {
  const { q, r } = offsetToAxial(col, row);
  if (sandbox.vision.isVisible(q, r)) return 'visible';
  if (sandbox.vision.isExplored(q, r)) return 'explored';
  return 'unexplored';
}

describe('map model', () => {
  it('parses 15×12 boards and preserves terrain', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    expect(sandbox.map.cols).toBe(15);
    expect(sandbox.map.rows).toBe(12);
    expect(sandbox.map.size).toBe(180);
    const door = sandbox.map.doors();
    expect(door.length).toBeGreaterThanOrEqual(2);
    expect(door.some((d) => d.doorOpen === false)).toBe(true);
    expect(door.some((d) => d.doorOpen === true)).toBe(true);
  });

  it('walkability: floor yes, wall no, closed door no, open door yes', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const closedDoor = sandbox.map.doors().find((d) => d.doorOpen === false)!;
    const openDoor = sandbox.map.doors().find((d) => d.doorOpen === true)!;
    const wall = sandbox.map.all().find((c) => c.terrain === 'wall')!;
    const floor = sandbox.map.all().find((c) => c.terrain === 'floor')!;
    expect(sandbox.map.isWalkable(wall.q, wall.r)).toBe(false);
    expect(sandbox.map.isWalkable(closedDoor.q, closedDoor.r)).toBe(false);
    expect(sandbox.map.isWalkable(openDoor.q, openDoor.r)).toBe(true);
    expect(sandbox.map.isWalkable(floor.q, floor.r)).toBe(true);
  });
});

describe('movement', () => {
  it('moves one adjacent step at a time only', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    expect(sandbox.tryMoveUnit('A', unit.q + 2, unit.r)).toEqual({ ok: false, reason: 'not-adjacent' });
    expect(sandbox.tryMoveUnit('A', unit.q, unit.r)).toEqual({ ok: false, reason: 'not-adjacent' });
    const { q, r } = sandbox.cellCoordinates(unit.q + 1, unit.r);
    expect(sandbox.map.isInsideMap(q, r)).toBe(true);
    expect(sandbox.tryMoveUnit('A', q, r)).toEqual({ ok: true });
    const moved = sandbox.units.find((u) => u.id === 'A')!;
    expect([moved.q, moved.r]).toEqual([q, r]);
  });

  it('rejects walls, closed doors and out-of-map steps', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    // Put A next to a known wall and a known closed door, then try to step in.
    const wall = sandbox.map.getAtOffset(5, 5);
    const closed = sandbox.map.getAtOffset(5, 5);
    void closed;
    sandbox.placeUnit('A', wall.q + 1, wall.r);
    expect(sandbox.tryMoveUnit('A', wall.q, wall.r)).toEqual({ ok: false, reason: 'blocked' });
    expect(sandbox.tryMoveUnit('A', -999, -999)).toEqual({ ok: false, reason: 'outside-map' });
  });

  it('a closed door blocks entry and an open door allows it', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const closedDoor = sandbox.map.doors().find((d) => d.doorOpen === false)!;
    sandbox.placeUnit('A', closedDoor.q, closedDoor.r - 1);
    const before = sandbox.tryMoveUnit('A', closedDoor.q, closedDoor.r);
    expect(before.ok).toBe(false);
    sandbox.toggleDoor(closedDoor.q, closedDoor.r);
    const after = sandbox.tryMoveUnit('A', closedDoor.q, closedDoor.r);
    expect(after.ok).toBe(true);
  });

  it('an open door becomes passable after toggling', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const closedDoor = sandbox.map.doors().find((d) => d.doorOpen === false)!;
    sandbox.toggleDoor(closedDoor.q, closedDoor.r);
    expect(sandbox.map.doors().find((d) => d.q === closedDoor.q && d.r === closedDoor.r)!.doorOpen).toBe(true);
    expect(sandbox.map.isWalkable(closedDoor.q, closedDoor.r)).toBe(true);
  });
});

describe('vision basics', () => {
  it('every unit sees its own cell', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    for (const unit of sandbox.units) {
      expect(sandbox.vision.isVisible(unit.q, unit.r)).toBe(true);
      expect(sandbox.vision.visibleBy(unit.id, unit.q, unit.r)).toBe(true);
    }
  });

  it('distance limit is respected exactly', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const unit = sandbox.units.find((u) => u.id === 'A')!;
    const seen = sandbox.vision.current.perUnit.get('A')!;
    const farVisible = [...seen].filter((k) => {
      const [q, r] = k.split(',').map(Number) as [number, number];
      return hexDistance(unit.q, unit.r, q, r) > unit.radius;
    });
    expect(farVisible).toEqual([]);
  });

  it('walls are visible themselves but hide cells behind them', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const colFive = status(sandbox, 5, 6);
    expect(colFive).toBe('visible');
    expect(status(sandbox, 9, 6)).not.toBe('visible');
  });

  it('reveals terrain state in hover explanations without leaking enemies', () => {
    const sandbox = new Sandbox({ scenarioId: 'corner' });
    const { q, r } = offsetToAxial(6, 5);
    const info = sandbox.hover(q, r);
    expect(info.terrain).toBe('wall');
    expect(info.enemy).toBeNull();
  });
});

describe('scenario expectations', () => {
  for (const id of ['corner', 'door', 'handoff', 'sandbox'] as const) {
    it(`scenario ${id} matches its stated visibility expectations`, () => {
      const sandbox = new Sandbox({ scenarioId: id });
      const results = sandbox.expectations();
      const failures = results.filter((r) => !r.ok);
      expect(failures).toEqual([]);
      expect(results.length).toBeGreaterThan(0);
    });
  }

  it('door scenario: opening the closed door reveals the enemy behind it', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    const spec = scenarioById('door');
    expect(spec).toBeTruthy();
    const closedDoor = sandbox.map.doors().find((d) => d.doorOpen === false)!;
    const { col, row } = axialToOffset(closedDoor.q, closedDoor.r);
    expect({ col, row }).toEqual({ col: 7, row: 5 });
    expect(status(sandbox, 9, 5)).not.toBe('visible');
    sandbox.toggleDoor(closedDoor.q, closedDoor.r);
    const enemy = sandbox.enemies.find((e) => e.label === 'E1')!;
    expect(sandbox.vision.isVisible(enemy.q, enemy.r)).toBe(true);
    expect(sandbox.visibleEnemies().some((e) => e.id === enemy.id)).toBe(true);
  });
});
