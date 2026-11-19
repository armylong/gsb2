/**
 * Shared data model for the sprite atlas tool.
 *
 * All coordinates are pixels. Rectangles use a top-left origin with a
 * half-open convention: a rect covers [x, x + width) x [y, y + height).
 */

export const ATLAS_FORMAT = 'sprite-atlas/1' as const;
export const ANIMATION_FORMAT = 'sprite-atlas-animation/1' as const;

export type Rotation = 0 | 90 | 180 | 270;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PackSettings {
  /** Exact (and therefore maximum) page width in pixels. */
  pageWidth: number;
  /** Exact (and therefore maximum) page height in pixels. */
  pageHeight: number;
  /** Empty gap between the extruded slots of two frames, in pixels. */
  spacing: number;
  /** Empty border kept free on every page edge, in pixels. */
  margin: number;
  /** Edge replication (bleed guard) in pixels on every side of a trimmed frame. */
  extrude: number;
  /** Allow a trimmed frame to be packed rotated 90 degrees clockwise. */
  allowRotation: boolean;
}

export const DEFAULT_SETTINGS: PackSettings = {
  pageWidth: 1024,
  pageHeight: 1024,
  spacing: 2,
  margin: 4,
  extrude: 1,
  allowRotation: true,
};

/** A frame after import analysis, before packing. */
export interface SourceFrameInfo {
  /** Stable identity derived from content + source key. Never depends on import order. */
  id: string;
  /** Basename, for display only. */
  name: string;
  /** Normalized relative path (or upload key) that scopes the identity. */
  sourceKey: string;
  /** SHA-256 of the decoded RGBA pixels + dimensions. */
  contentHash: string;
  /** Original canvas size. Always preserved by trimming. */
  sourceSize: Size;
  /** Transparent bounds in original-canvas coordinates. Empty frames use 0x0. */
  trim: Rect;
  /** True when every pixel has alpha 0. Such frames are kept, never dropped. */
  empty: boolean;
  /** Local server URL for the source PNG preview. Not part of exports. */
  previewUrl: string;
}

/**
 * One frame in an atlas manifest.
 *
 * Reconstruction recipe (see also README.txt in the export):
 *   1. Crop `contentRect` from page `page` in page coordinates.
 *   2. That crop is the trimmed image rotated clockwise by `rotation` degrees.
 *      Rotate it counter-clockwise by the same amount to undo packing.
 *   3. Draw the result at (`trim.x`, `trim.y`) on a transparent canvas of
 *      `sourceSize`. Nothing is anchored to the packed position itself.
 */
export interface AtlasFrame {
  id: string;
  name: string;
  sourceKey: string;
  contentHash: string;
  sourceSize: Size;
  /** Transparent bounds in the original, unrotated canvas. */
  trim: Rect;
  empty: boolean;
  /** Clockwise rotation applied to the trimmed content before packing. */
  rotation: Rotation;
  /** Pixels of edge replication on each side inside `packedRect`. */
  extrude: number;
  /** Zero-based page index, or null when the frame could not be placed. */
  page: number | null;
  /** Full page-space slot including extrusion. Null when unplaced. */
  packedRect: Rect | null;
  /**
   * Effective content area in page coordinates. Equals `packedRect` inset by
   * `extrude` on each side, and has the rotated content dimensions.
   * Empty frames have a zero-sized content rect inside a 1x1 transparent slot.
   */
  contentRect: Rect | null;
  status: 'packed' | 'unplaced';
  /** Human-readable reason when status is `unplaced`. */
  issue?: string;
}

export interface AtlasPage {
  index: number;
  file: string;
  width: number;
  height: number;
}

export interface AtlasManifest {
  format: typeof ATLAS_FORMAT;
  settings: PackSettings;
  pages: AtlasPage[];
  frames: AtlasFrame[];
  summary: {
    total: number;
    packed: number;
    unplaced: number;
    empty: number;
  };
}

export interface PackIssue {
  code:
    | 'FRAME_TOO_LARGE'
    | 'INVALID_SETTINGS'
    | 'MISSING_SOURCE'
    | 'DUPLICATE_ID'
    | 'INVALID_SOURCE';
  frameId?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: VerificationCheck[];
  framesChecked: number;
  pagesChecked: number;
  /** Pixels whose RGB differs only where both sides are fully transparent. */
  ignoredTransparentPixels: number;
  warnings: string[];
}

export interface BuildPage {
  index: number;
  file: string;
  url: string;
  width: number;
  height: number;
}

export interface BuildResult {
  buildId: string;
  manifest: AtlasManifest;
  pages: BuildPage[];
  issues: PackIssue[];
  verification: VerificationReport;
}

export interface AnimationFrameRef {
  /** Stable frame identifier from the atlas manifest. */
  id: string;
  durationMs: number;
}

export interface AnimationSpec {
  format: typeof ANIMATION_FORMAT;
  name: string;
  loop: boolean;
  /**
   * Normalized pivot inside each frame's ORIGINAL canvas. The same pivot is
   * aligned across frames, so trimming can never introduce positional jumps.
   */
  anchor: Point;
  frames: AnimationFrameRef[];
}

export const DEFAULT_ANIMATION: AnimationSpec = {
  format: ANIMATION_FORMAT,
  name: 'animation',
  loop: true,
  anchor: { x: 0.5, y: 1 },
  frames: [],
};

export interface ImportRequestFile {
  name: string;
  sourceKey: string;
  dataBase64: string;
}

export interface ImportResult {
  frames: SourceFrameInfo[];
  rejected: { name: string; message: string }[];
  /** Files whose stable id already existed; nothing was overwritten. */
  duplicates: { name: string; sourceKey: string; id: string }[];
}

export interface PackRequest {
  settings: PackSettings;
  /** Ids returned by /api/import. Order is irrelevant; the packer sorts. */
  frameIds: string[];
}

export interface ExportRequest {
  buildId: string;
  animation: AnimationSpec;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
