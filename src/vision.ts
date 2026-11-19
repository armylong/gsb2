import { axialToOffset, cellsInRange, hexDistance, intermediateCells } from './hex';
import { cellKey, GameMap, isOpaqueTerrain } from './map';
import type {
  Axial,
  Cell,
  CellExplanation,
  CellKey,
  Unit,
  UnitExplanation,
  UnitId,
  VisionSnapshot,
} from './types';

export interface BlockingCell {
  q: number;
  r: number;
  terrain: 'wall' | 'door';
  doorOpen?: boolean;
}

export interface LineOfSight {
  visible: boolean;
  /** Cells the centre-to-centre segment genuinely crosses, endpoints excluded, ordered from source. */
  crossed: Axial[];
  blocker: BlockingCell | null;
}

/**
 * Terrain-aware line of sight. Geometry comes from `intermediateCells`, which
 * applies the documented "interior only" rule: a segment that merely runs
 * along an edge or clips a corner does not enter that cell, so the cell is
 * transparent. The first opaque cell on the interior path is the blocker and
 * remains listed in `crossed`, which is how the blocker itself stays visible.
 */
export function computeLineOfSight(map: GameMap, from: Axial, to: Axial): LineOfSight {
  const distance = hexDistance(from.q, from.r, to.q, to.r);
  if (distance === 0) return { visible: true, crossed: [], blocker: null };

  const crossed = intermediateCells(from, to).map(({ q, r }) => ({ q, r }));
  for (const cell of crossed) {
    const model = map.get(cell.q, cell.r);
    if (!model) continue;
    if (!isOpaqueTerrain(model.terrain, model.doorOpen)) continue;
    return {
      visible: false,
      crossed,
      blocker: {
        q: model.q,
        r: model.r,
        terrain: model.terrain as 'wall' | 'door',
        ...(model.doorOpen === undefined ? {} : { doorOpen: model.doorOpen }),
      },
    };
  }
  return { visible: true, crossed, blocker: null };
}

export interface TerrainMemory {
  terrain: 'floor' | 'wall' | 'door';
  doorOpen?: boolean;
}

export class VisionEngine {
  private snapshot: VisionSnapshot = {
    visible: new Set(),
    sources: new Map(),
    perUnit: new Map(),
    revision: 0,
  };
  private explored = new Set<CellKey>();
  /**
   * Terrain as it was last *seen*. Explored cells render from this snapshot, so
   * an edit made in the dark is not visible until the cell is seen again.
   */
  private memory = new Map<CellKey, TerrainMemory>();

  get revision(): number {
    return this.snapshot.revision;
  }

  get current(): VisionSnapshot {
    return this.snapshot;
  }

  get exploredCells(): ReadonlySet<CellKey> {
    return this.explored;
  }

  /** Terrain remembered from exploration, `undefined` when never seen. */
  remembered(q: number, r: number): TerrainMemory | undefined {
    return this.memory.get(cellKey(q, r));
  }

  isVisible(q: number, r: number): boolean {
    return this.snapshot.visible.has(cellKey(q, r));
  }

  isExplored(q: number, r: number): boolean {
    return this.explored.has(cellKey(q, r));
  }

  sourcesFor(q: number, r: number): readonly UnitId[] {
    return this.snapshot.sources.get(cellKey(q, r)) ?? [];
  }

  visibleBy(unitId: UnitId, q: number, r: number): boolean {
    return this.snapshot.perUnit.get(unitId)?.has(cellKey(q, r)) ?? false;
  }

  /**
   * Full recompute from the map + units. Explored cells extend, never shrink.
   *
   * Every in-map cell within a unit's radius is tested independently. The cell
   * is visible when the interior of the centre-to-centre segment contains no
   * opaque cell. The target's own interior is excluded from that test, so an
   * occluder that is itself the target is visible while anything past it is not.
   */
  recompute(map: GameMap, units: readonly Unit[]): VisionSnapshot {
    const perUnit = new Map<UnitId, Set<CellKey>>();
    const sources = new Map<CellKey, UnitId[]>();
    const visible = new Set<CellKey>();
    const seenCells: Cell[] = [];

    for (const unit of units) {
      const seen = new Set<CellKey>();
      const origin: Axial = { q: unit.q, r: unit.r };
      for (const cell of cellsInRange(unit.q, unit.r, unit.radius)) {
        if (!map.isInsideMap(cell.q, cell.r)) continue;
        if (hexDistance(unit.q, unit.r, cell.q, cell.r) > unit.radius) continue;
        if (cell.q !== unit.q || cell.r !== unit.r) {
          if (!computeLineOfSight(map, origin, cell).visible) continue;
        }
        const model = map.get(cell.q, cell.r)!;
        const key = cellKey(cell.q, cell.r);
        seen.add(key);
        if (!visible.has(key)) {
          visible.add(key);
          seenCells.push(model);
        }
        appendSource(sources, key, unit.id);
      }
      perUnit.set(unit.id, seen);
    }

    // Snapshot terrain for everything currently seen, so explored cells keep
    // showing the world as it was when the scout last looked at it.
    for (const cell of seenCells) {
      this.explored.add(cellKey(cell.q, cell.r));
      const remembered: TerrainMemory = { terrain: cell.terrain };
      if (cell.doorOpen !== undefined) remembered.doorOpen = cell.doorOpen;
      this.memory.set(cellKey(cell.q, cell.r), remembered);
    }

    this.snapshot = { visible, sources, perUnit, revision: this.snapshot.revision + 1 };
    return this.snapshot;
  }

  resetExplored(): void {
    this.explored.clear();
    this.memory.clear();
    this.snapshot = {
      visible: new Set(),
      sources: new Map(),
      perUnit: new Map(),
      revision: this.snapshot.revision + 1,
    };
  }

}

function appendSource(sources: Map<CellKey, UnitId[]>, key: CellKey, id: UnitId): void {
  const list = sources.get(key);
  if (!list) sources.set(key, [id]);
  else if (!list.includes(id)) list.push(id);
}

/**
 * Hover / test explanation. Terrain state and vision state only — enemy data is
 * deliberately absent so a hidden enemy cannot be inferred from this object.
 */
export function explainCell(
  map: GameMap,
  units: readonly Unit[],
  vision: VisionEngine,
  q: number,
  r: number,
): CellExplanation {
  const model = map.get(q, r);
  const perUnit: UnitExplanation[] = units.map((unit) => {
    const distance = hexDistance(unit.q, unit.r, q, r);
    const inRadius = distance <= unit.radius;
    const los = computeLineOfSight(map, { q: unit.q, r: unit.r }, { q, r });
    let reason: UnitExplanation['reason'];
    if (distance === 0) reason = 'self';
    else if (!inRadius) reason = 'out-of-range';
    else if (los.blocker) reason = 'blocked';
    else reason = 'visible';
    // A blocker beyond the scout's radius is itself unknown, so it must not be
    // reported: otherwise hovering a far cell would reveal unseen terrain.
    const blockerKnown =
      los.blocker !== null &&
      hexDistance(unit.q, unit.r, los.blocker.q, los.blocker.r) <= unit.radius;
    return {
      unitId: unit.id,
      distance,
      inRadius,
      visible: reason === 'self' || reason === 'visible',
      reason,
      blocker: blockerKnown ? { ...los.blocker! } : null,
    };
  });

  const visible = vision.isVisible(q, r);
  let state: CellExplanation['state'];
  if (visible) state = 'visible';
  else if (vision.isExplored(q, r)) state = 'explored';
  else state = 'unexplored';

  // Only a currently visible cell reports live terrain; explored cells report
  // the snapshot taken when they were last seen; unexplored cells report null.
  let terrain: CellExplanation['terrain'] = null;
  let doorOpen: boolean | undefined;
  if (visible) {
    terrain = model ? model.terrain : null;
    doorOpen = model?.doorOpen;
  } else if (state === 'explored') {
    const remembered = vision.remembered(q, r);
    if (remembered) {
      terrain = remembered.terrain;
      doorOpen = remembered.doorOpen;
    }
  }

  const explanation: CellExplanation = {
    q,
    r,
    col: axialToOffset(q, r).col,
    row: axialToOffset(q, r).row,
    inMap: Boolean(model),
    state,
    terrain,
    sources: perUnit.filter((u) => u.visible).map((u) => u.unitId),
    perUnit,
    enemy: null,
  };
  if (doorOpen !== undefined) explanation.doorOpen = doorOpen;
  return explanation;
}

/** A cell is a legal step for a unit when adjacent, walkable and inside the map. */
export function canStep(map: GameMap, from: Axial, to: Axial): boolean {
  if (hexDistance(from.q, from.r, to.q, to.r) !== 1) return false;
  return map.isWalkable(to.q, to.r);
}
