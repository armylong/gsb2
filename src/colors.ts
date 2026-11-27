/**
 * Pane colours.
 *
 * Eight categorical hues from the validated dark/light categorical order
 * (adjacent-pair CVD ΔE ≥ 8 in both modes). A pane that the notch splits into
 * two polygons keeps one id, so it keeps one colour — that is the visual cue
 * for "same number, two pieces".
 */

export type Theme = 'dark' | 'light';

const DARK = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#0ca30c', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
];
const LIGHT = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];

export function colorForSlot(slot: number, theme: Theme = 'dark'): string {
  const palette = theme === 'dark' ? DARK : LIGHT;
  return palette[((slot % palette.length) + palette.length) % palette.length]!;
}

/** Default colour for a piece id: deterministic, stable across sessions. */
export function colorForPiece(id: number, theme: Theme = 'dark'): string {
  return colorForSlot(id - 1, theme);
}

export function pieceColorHex(id: number, theme: Theme = 'dark'): string {
  return colorForPiece(id, theme);
}

/** CSS colour with alpha, for canvas fills. */
export function colorForPieceAlpha(id: number, alpha: number, theme: Theme = 'dark'): string {
  const hex = colorForPiece(id, theme);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Text ink chosen for legibility on a given fill (palette rule). */
export function inkOnFill(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#0b0b0b' : '#ffffff';
}

export function palettePreview(theme: Theme): { slot: number; hex: string }[] {
  const p = theme === 'dark' ? DARK : LIGHT;
  return p.map((hex, i) => ({ slot: i + 1, hex }));
}

/**
 * Composite identity for more than eight panes.
 *
 * The categorical order is eight fixed hues; generating a ninth hue would break
 * CVD separation. Instead each hue carries a texture channel: the first circuit
 * is plain, the second hatches at 45°, the third at 135° — the two permitted
 * directional angles. With 20 points at most, ids 1–8 are plain, 9–16 hatched,
 * 17–20 cross-hatched, and each id still keeps a single stable colour + texture.
 */
export type Texture = 0 | 1 | 2;

export function textureFor(id: number): Texture {
  const cycle = Math.floor((Math.max(1, id) - 1) / 8);
  return (cycle % 3) as Texture;
}

export interface PaneStyle {
  hex: string;
  /** Base hue slot, 0-based. */
  slot: number;
  texture: Texture;
  /** Index within the palette circuit, used for direct labels. */
  cycle: number;
}

export function paneStyle(id: number, theme: Theme = 'dark'): PaneStyle {
  const slot = ((id - 1) % 8 + 8) % 8;
  return {
    hex: colorForSlot(slot, theme),
    slot,
    texture: textureFor(id),
    cycle: Math.floor(Math.max(1, id - 1) / 8),
  };
}

