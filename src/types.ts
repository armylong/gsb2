/** Shared domain types. No imports here so every module can depend on it freely. */

export type Terrain = 'floor' | 'wall' | 'door';

export type CellKey = string;

export interface Axial {
  q: number;
  r: number;
}

/** 0-based odd-r offset coordinates, only used for display / scenario authoring. */
export interface Offset {
  col: number;
  row: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Cell {
  q: number;
  r: number;
  terrain: Terrain;
  /** Only meaningful for doors. `undefined` for other terrain. */
  doorOpen?: boolean;
}

export type UnitId = 'A' | 'B';

export interface Unit {
  id: UnitId;
  label: string;
  q: number;
  r: number;
  radius: number;
}

export interface Enemy {
  id: number;
  label: string;
  q: number;
  r: number;
}

export type ViewMode = 'player' | 'edit' | 'debug';

export type ExplorerState = 'unexplored' | 'explored' | 'visible';

export type VisibilityReason = 'visible' | 'out-of-range' | 'blocked' | 'self';

export interface UnitExplanation {
  unitId: UnitId;
  distance: number;
  inRadius: boolean;
  visible: boolean;
  reason: VisibilityReason;
  /** First blocking cell along the centre-to-centre segment, if any. */
  blocker: { q: number; r: number; terrain: Terrain; doorOpen?: boolean } | null;
}

export interface CellExplanation {
  q: number;
  r: number;
  col: number;
  row: number;
  inMap: boolean;
  state: ExplorerState;
  terrain: Terrain | null;
  doorOpen?: boolean;
  sources: UnitId[];
  perUnit: UnitExplanation[];
  /** Debug mode only. Always null in player/edit mode. */
  enemy: { id: number; label: string } | null;
}

export interface VisionSnapshot {
  visible: ReadonlySet<CellKey>;
  sources: ReadonlyMap<CellKey, readonly UnitId[]>;
  perUnit: ReadonlyMap<UnitId, ReadonlySet<CellKey>>;
  revision: number;
}
