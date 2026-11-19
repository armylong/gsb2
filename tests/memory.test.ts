import { describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox';

describe('terrain memory', () => {
  it('explored cells report the terrain they were last seen with', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const probe = sandbox.map.getAtOffset(3, 8);
    expect(sandbox.vision.isVisible(probe.q, probe.r)).toBe(true);
    expect(sandbox.map.getAtOffset(3, 8).terrain).toBe('floor');
    const seenAs = sandbox.hover(probe.q, probe.r);
    expect(seenAs.state).toBe('visible');
    expect(seenAs.terrain).toBe('floor');

    // Shrink both scouts until the cell is out of sight but still remembered.
    sandbox.setRadius('A', 1);
    sandbox.setRadius('B', 1);
    const remembered = sandbox.hover(probe.q, probe.r);
    expect(remembered.state).toBe('explored');
    expect(remembered.terrain).toBe('floor');
    expect(remembered.sources).toEqual([]);
  });

  it('an edit made outside vision does not leak into memory until seen again', () => {
    const sandbox = new Sandbox({ scenarioId: 'sandbox' });
    const probe = sandbox.map.getAtOffset(3, 8);
    sandbox.setRadius('A', 1);
    sandbox.setRadius('B', 1);
    expect(sandbox.hover(probe.q, probe.r).terrain).toBe('floor');

    sandbox.setTerrain(probe.q, probe.r, 'wall');
    expect(sandbox.vision.isVisible(probe.q, probe.r)).toBe(false);
    // Player still remembers the floor … memory is terrain-as-seen.
    expect(sandbox.hover(probe.q, probe.r).terrain).toBe('floor');

    // Bring the scout back so the cell is seen again: memory updates.
    sandbox.setRadius('A', 6);
    expect(sandbox.vision.isVisible(probe.q, probe.r)).toBe(true);
    expect(sandbox.hover(probe.q, probe.r).terrain).toBe('wall');
    sandbox.setRadius('A', 1);
    expect(sandbox.hover(probe.q, probe.r).terrain).toBe('wall');
  });

  it('a door’s remembered state follows the last observation', () => {
    const sandbox = new Sandbox({ scenarioId: 'door' });
    sandbox.setRadius('B', 1);
    const door = sandbox.map.getAtOffset(7, 5);
    expect(sandbox.hover(door.q, door.r).doorOpen).toBe(false);
    sandbox.toggleDoor(door.q, door.r);
    expect(sandbox.hover(door.q, door.r).doorOpen).toBe(true);
  });
});
