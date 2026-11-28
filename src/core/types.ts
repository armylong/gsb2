/** 共用类型：坐标、朝向、关卡、墨层与棋局状态。 */

export interface Coord {
  x: number;
  y: number;
}

/** 以模板定位点为圆心的朝向。先左右翻面，再顺时针旋转。 */
export interface Orientation {
  /** 顺时针旋转次数，0..3，每格 90°。 */
  rotation: number;
  flipped: boolean;
}

export const NO_ORIENTATION: Orientation = { rotation: 0, flipped: false };

export function orientationKey(o: Orientation): string {
  return `${(((o.rotation % 4) + 4) % 4)}${o.flipped ? 'f' : 'n'}`;
}

export function cloneOrientation(o: Orientation): Orientation {
  return { rotation: o.rotation, flipped: o.flipped };
}

export type InkId = string;
export type ColorId = string;
export type StencilId = string;

export interface InkDef {
  id: InkId;
  name: string;
  /** 调色板中的单层颜色 id。 */
  color: ColorId;
  /** 色弱辅助符号。 */
  symbol: string;
  note?: string;
}

export interface PaletteEntry {
  id: ColorId;
  name: string;
  css: string;
  /** 深色格子上用浅字，浅色格子上用深字。 */
  inkOn: 'light' | 'dark';
  symbol: string;
}

export interface StencilDef {
  id: StencilId;
  name: string;
  /** 孔位，相对定位点的本地坐标（y 向下），未旋转、未翻面。 */
  holes: Coord[];
  note?: string;
}

/** 样图单元格：free=不限, clean=必须保持干净, 其它值为要求的最终颜色 id。 */
export type PlanToken = 'free' | 'clean' | ColorId;

export interface LevelDef {
  id: string;
  name: string;
  subtitle: string;
  width: number;
  height: number;
  inks: InkDef[];
  paperColor: ColorId;
  palette: PaletteEntry[];
  /**
   * 叠色关系：键为 `当前颜色|本次墨色`，值为盖上去之后的颜色。
   * 缺失的组合按“新墨原色覆盖”处理；纸白与同色重复必须在表中。
   */
  mix: Record<string, ColorId>;
  budget: Record<InkId, number>;
  stencils: StencilDef[];
  /** 行优先：plan[y][x]。 */
  plan: PlanToken[][];
  hint: string;
  /** 推荐盖印次数，用作结算评价。 */
  parStamps: number;
}

export interface CellLayer {
  ink: InkId;
  /** 从 1 开始的盖印序号。 */
  stampNo: number;
  stencilId: StencilId;
  orientation: Orientation;
  /** 本次盖印的模板定位点。 */
  pivot: Coord;
}

export interface Cell {
  /** 从早到晚的墨层；重复同色也会留下记录（但不改变颜色）。 */
  layers: CellLayer[];
}

export type GameStatus = 'playing' | 'failed' | 'solved';

export interface FailureInfo {
  stampNo: number;
  /** 当前所有被沾墨的保留格。 */
  cells: Coord[];
  /** 本次盖印新弄脏的保留格。 */
  newCells: Coord[];
}

export interface Snapshot {
  cells: Cell[];
  inkLeft: Record<InkId, number>;
  mask: boolean[];
  stampNo: number;
  status: GameStatus;
  failure: FailureInfo | null;
}

export interface StampAction {
  kind: 'stamp';
  stampNo: number;
  stencilId: StencilId;
  ink: InkId;
  orientation: Orientation;
  pivot: Coord;
  cost: number;
  contacted: Coord[];
  inked: Coord[];
  masked: Coord[];
  offBoard: Coord[];
  cleanContacts: Coord[];
  before: Snapshot;
}

export interface MaskAction {
  kind: 'mask';
  x: number;
  y: number;
  wasMasked: boolean;
  before: Snapshot;
}

export type Action = StampAction | MaskAction;

export interface GameState {
  levelId: string;
  cells: Cell[];
  inkLeft: Record<InkId, number>;
  mask: boolean[];
  stampNo: number;
  history: Action[];
  status: GameStatus;
  failure: FailureInfo | null;
}

export interface StampRequest {
  stencilId: StencilId;
  ink: InkId;
  orientation: Orientation;
  pivot: Coord;
}

export interface CellAssessment {
  x: number;
  y: number;
  requirement: 'free' | 'clean' | 'exact';
  targetColor: ColorId | null;
  currentColor: ColorId;
  layerCount: number;
  exact: boolean;
  cleanViolated: boolean;
}

export interface Evaluation {
  cells: CellAssessment[];
  exactTotal: number;
  exactMatched: number;
  mismatches: Coord[];
  cleanViolations: Coord[];
  solved: boolean;
}
