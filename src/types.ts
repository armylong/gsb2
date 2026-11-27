/**
 * Core data types shared by geometry, layout, rendering and export.
 *
 * World coordinates are millimetres with y pointing **down** (canvas convention).
 * The frame lives in the first quadrant, (0,0) = top-left of the window.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A closed ring, stored without the repeated closing vertex. */
export type Ring = Pt[];

/** outer ring first, then holes */
export type Poly = Ring[];

/** Non-overlapping polygon collection (a piece may be split by the notch). */
export type MultiPoly = Poly[];

export interface FrameSpec {
  /** Kind is only used for display / diagnostics wording. */
  kind: 'rect' | 'notch';
  /** Outer boundary of the glazed area, y-down. Notch is cut into this ring. */
  ring: Ring;
  width: number;
  height: number;
  /** Descriptive notch, if any (in world mm). */
  notch?: {
    side: 'top' | 'right' | 'bottom' | 'left';
    start: number;
    end: number;
    depth: number;
  };
}

export interface PointSpec {
  /** Stable display id, 1-based. Also used for colours in the current session. */
  id: number;
  x: number;
  y: number;
  /**
   * Power-diagram weight, in mm². Larger weight expands the cell.
   * Equal weights produce an ordinary Voronoi diagram.
   */
  weight: number;
}

export interface Piece {
  id: number;
  /** Clipped to the frame. A notch can make one id occupy several disjoint polygons. */
  polygons: MultiPoly;
  /** Total area inside the frame, mm². */
  area: number;
  /** Number of disjoint parts (1 or 2 in the provided demos). */
  parts: number;
  /** Label anchor (pole of inaccessibility) per polygon part. */
  labelAnchors: Pt[];
}

export interface SeamInfo {
  /** Plain descriptive offset relative to equal weights. */
  equalWeightOffsetMm: number;
  /** Signed shift along i→j: positive means the seam sits closer to j. */
  shiftTowardJ: number;
  /** True when the two weights are so close the seam is effectively unshifted. */
  nearTie: boolean;
}

export interface LayoutEdge {
  pieceId: number;
  a: Pt;
  b: Pt;
  length: number;
  kind: 'frame' | 'shared';
  /** Neighbour across the seam; null for a frame edge. */
  otherId: number | null;
  /** Midpoint. */
  mid: Pt;
  /** Unit normal pointing to the "positive" side used for probe sampling. */
  normal: Pt;
  seam?: SeamInfo;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'empty-territory'
    | 'points-too-close'
    | 'point-outside-frame'
    | 'point-in-notch'
    | 'area-mismatch'
    | 'coincident-points';
  pointIds: number[];
  message: string;
  detail: string;
}

export interface LayoutStats {
  frameArea: number;
  pieceAreaTotal: number;
  difference: number;
  /** Relative difference (0 = exact). */
  relativeDifference: number;
  exact: boolean;
  pieceCount: number;
  emptyPieceIds: number[];
  partCount: number;
}

export interface Layout {
  frame: FrameSpec;
  points: PointSpec[];
  pieces: Piece[];
  edges: LayoutEdge[];
  diagnostics: Diagnostic[];
  stats: LayoutStats;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Saved input, used to restore a baseline snapshot. */
  input: { frame: FrameSpec; points: PointSpec[] };
}

export interface QueryResult {
  id: number | null;
  /** Distance to the seam between id and runnerUp, in mm. */
  gapMm: number;
  /** True when inside the display-critical band around the winning seam. */
  tie: boolean;
  runnerUp: number | null;
}

export type Theme = 'dark' | 'light';
