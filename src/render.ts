/**
 * Canvas rendering.
 *
 * Two passes:
 *  1. geometry — frame, glass fills, seams, overlay outlines, handles, arrows,
 *     all drawn in world millimetres under (translate, scale);
 *  2. annotation — numbers, tags, legends — drawn in screen pixels from world
 *     anchors, so text keeps a constant on-screen size at any zoom.
 */

import { colorForPiece, textureFor, type Theme } from './colors';
import { ringBBox } from './geometry';
import type { BoundaryPick } from './boundary';
import type { Layout, LayoutEdge, MultiPoly, Pt, Ring } from './types';

export interface ViewTransform {
  /** screen = world * scale + offset */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface RenderOptions {
  layout: Layout;
  baseline: Layout | null;
  theme: Theme;
  selectedId: number | null;
  showLabels: boolean;
  showSeams: boolean;
  showPoints: boolean;
  showGrid: boolean;
  overlay: boolean;
  preview: Layout | null;
  previewDelta: number;
  hoverWorld: Pt | null;
  hoverQueryId: number | null;
  hoverTie: boolean;
  hoverBoundary: LayoutEdge | null;
  pickedBoundary: BoundaryPick | null;
  cursorScreen: Pt | null;
}

export interface RenderMetrics {
  view: ViewTransform;
  width: number;
  height: number;
  dpr: number;
}

const PAGE: Record<Theme, string> = { dark: '#0d0d0d', light: '#f9f9f7' };
const SURFACE: Record<Theme, string> = { dark: '#1a1a19', light: '#fcfcfb' };
const INK: Record<Theme, string> = { dark: '#f0efec', light: '#0b0b0b' };
const MUTED = '#898781';
const ACCENT: Record<Theme, string> = { dark: '#3987e5', light: '#2a78d6' };
const CRITICAL = '#d03b3b';
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export function computeView(layout: Layout, cssW: number, cssH: number, padding = 52): ViewTransform {
  const { minX, minY, maxX, maxY } = ringBBox(layout.frame.ring);
  const fw = Math.max(maxX - minX, 1);
  const fh = Math.max(maxY - minY, 1);
  const availW = Math.max(cssW - padding * 2, 40);
  const availH = Math.max(cssH - padding * 2, 40);
  const scale = Math.min(availW / fw, availH / fh);
  const offsetX = (cssW - fw * scale) / 2 - minX * scale;
  const offsetY = (cssH - fh * scale) / 2 - minY * scale;
  return { scale, offsetX, offsetY };
}

export const toScreen = (p: Pt, v: ViewTransform): Pt => ({
  x: p.x * v.scale + v.offsetX,
  y: p.y * v.scale + v.offsetY,
});

export const toWorld = (p: Pt, v: ViewTransform): Pt => ({
  x: (p.x - v.offsetX) / v.scale,
  y: (p.y - v.offsetY) / v.scale,
});

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function ringPath(ctx: CanvasRenderingContext2D, ring: Ring): void {
  if (ring.length === 0) return;
  ctx.moveTo(ring[0]!.x, ring[0]!.y);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i]!.x, ring[i]!.y);
  ctx.closePath();
}

function polyPath(ctx: CanvasRenderingContext2D, mp: MultiPoly): void {
  for (const poly of mp) for (const ring of poly) ringPath(ctx, ring);
}

function edgeKey(a: Pt, b: Pt): string {
  const s = (p: Pt) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  const k1 = s(a) + '|' + s(b);
  const k2 = s(b) + '|' + s(a);
  return k1 < k2 ? k1 : k2;
}

/**
 * Directional hatch for the composite encoding past eight panes. Tone-on-tone,
 * at 45° (texture 1) or 135° (texture 2, which also adds the mirror), never
 * horizontal/vertical (those would read as gridlines).
 */
function drawTexture(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  id: number,
  tex: 1 | 2,
  view: ViewTransform,
  theme: Theme,
  fillAlpha: number,
): void {
  const box = ringBBox(L.frame.ring);
  const step = 7 / view.scale;
  const w = box.maxX - box.minX + box.maxY - box.minY;
  const color = withAlpha(colorForPiece(id, theme), Math.min(1, fillAlpha + 0.28));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4 / view.scale;
  ctx.beginPath();
  if (tex === 1) {
    for (let k = -w; k <= w; k += step) {
      ctx.moveTo(box.minX + k, box.minY);
      ctx.lineTo(box.minX + k + (box.maxY - box.minY), box.maxY);
    }
  } else {
    for (let k = -w; k <= w; k += step) {
      ctx.moveTo(box.minX + k, box.minY);
      ctx.lineTo(box.minX + k + (box.maxY - box.minY), box.maxY);
      ctx.moveTo(box.minX + k, box.maxY);
      ctx.lineTo(box.minX + k + (box.maxY - box.minY), box.minY);
    }
  }
  ctx.stroke();
  ctx.restore();
}
/** Unique shared seams (each seam is recorded on both sides of the pair). */
function uniqueShared(L: Layout): LayoutEdge[] {
  const seen = new Set<string>();
  const out: LayoutEdge[] = [];
  for (const e of L.edges) {
    if (e.kind !== 'shared') continue;
    const k = edgeKey(e.a, e.b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function render(
  ctx: CanvasRenderingContext2D,
  opts: RenderOptions,
  cssW: number,
  cssH: number,
  dpr: number,
  keepView?: ViewTransform | null,
): RenderMetrics {
  const theme = opts.theme;
  const view = keepView ?? computeView(opts.layout, cssW, cssH);
  const L = opts.layout;
  const baseline = opts.baseline;
  const overlay = opts.overlay && baseline !== null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = PAGE[theme];
  ctx.fillRect(0, 0, cssW, cssH);

  // ---------------- world-space geometry ----------------
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);

  ctx.beginPath();
  ringPath(ctx, L.frame.ring);
  ctx.fillStyle = SURFACE[theme];
  ctx.fill();

  const fillAlpha = overlay ? 0.26 : 0.62;
  for (const piece of L.pieces) {
    if (piece.parts === 0) continue;
    ctx.save();
    ctx.beginPath();
    polyPath(ctx, piece.polygons);
    ctx.clip('evenodd');
    ctx.fillStyle = withAlpha(colorForPiece(piece.id, theme), fillAlpha);
    ctx.fill('evenodd');
    // Composite identity past eight panes: hue × texture (45° / 135°).
    const tex = textureFor(piece.id);
    if (tex > 0) drawTexture(ctx, L, piece.id, tex as 1 | 2, view, theme, fillAlpha);
    ctx.restore();
  }

  if (opts.showGrid) drawGraticule(ctx, L, view, theme);

  if (overlay && baseline) drawBaselineOutlines(ctx, baseline, theme, view);

  if (opts.showSeams) drawSeams(ctx, L, theme, view);

  ctx.beginPath();
  ringPath(ctx, L.frame.ring);
  ctx.strokeStyle = INK[theme];
  ctx.lineWidth = 2.2 / view.scale;
  ctx.lineJoin = 'miter';
  ctx.stroke();

  if (opts.preview) drawSeamPreview(ctx, L, opts.preview, opts.selectedId, opts.previewDelta, view, theme);

  if (opts.hoverBoundary) {
    ctx.save();
    ctx.strokeStyle = withAlpha(MUTED, 0.9);
    ctx.lineWidth = 3 / view.scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(opts.hoverBoundary.a.x, opts.hoverBoundary.a.y);
    ctx.lineTo(opts.hoverBoundary.b.x, opts.hoverBoundary.b.y);
    ctx.stroke();
    ctx.restore();
  }

  if (opts.pickedBoundary) drawPickedBoundaryGeometry(ctx, opts.pickedBoundary, view, theme);

  if (opts.showPoints) drawHandles(ctx, L, opts, view, theme);

  ctx.restore();

  // ---------------- screen-space annotation ----------------
  if (opts.showLabels) drawLabelAnnotations(ctx, L, baseline, overlay, view, theme, opts.selectedId);
  if (opts.showPoints) drawHandleAnnotations(ctx, L, opts, view, theme);
  if (opts.preview && opts.selectedId !== null) drawSeamPreviewAnnotations(ctx, L, opts.preview, opts.selectedId, opts.previewDelta, view, theme);
  if (opts.pickedBoundary) drawPickedBoundaryAnnotations(ctx, opts.pickedBoundary, view, theme);
  drawScaleBar(ctx, view, cssH, theme);
  if (opts.cursorScreen && opts.hoverQueryId !== null) {
    drawCursorTag(ctx, opts.cursorScreen, opts.hoverQueryId, opts.hoverTie, view, theme, cssW);
  }

  return { view, width: cssW, height: cssH, dpr };
}

// ----------------------------------------------------------------------------
// Geometry pass

function drawSeams(ctx: CanvasRenderingContext2D, L: Layout, theme: Theme, view: ViewTransform): void {
  const seams = uniqueShared(L);
  const frameEdges = L.edges.filter((e) => e.kind === 'frame' && e.pieceId === Math.min(...L.edges.map((x) => x.pieceId)));
  ctx.save();
  ctx.lineCap = 'square';
  // Shared seams: solid, slightly heavier — the lead came between panes.
  ctx.strokeStyle = theme === 'dark' ? '#050505' : '#33322f';
  ctx.lineWidth = 1.6 / view.scale;
  ctx.beginPath();
  for (const e of seams) {
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
  }
  ctx.stroke();
  // Hairline of surface colour down the middle keeps two fills 2px apart.
  ctx.strokeStyle = withAlpha(SURFACE[theme], 0.5);
  ctx.lineWidth = 0.5 / view.scale;
  ctx.stroke();
  void frameEdges;
  ctx.restore();
}

function drawBaselineOutlines(
  ctx: CanvasRenderingContext2D,
  baseline: Layout,
  theme: Theme,
  view: ViewTransform,
): void {
  ctx.save();
  ctx.strokeStyle = theme === 'dark' ? '#c3c2b7' : '#52514e';
  ctx.lineWidth = 1.5 / view.scale;
  ctx.setLineDash([5 / view.scale, 4 / view.scale]);
  ctx.lineJoin = 'round';
  for (const piece of baseline.pieces) {
    if (piece.parts === 0) continue;
    ctx.beginPath();
    polyPath(ctx, piece.polygons);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSeamPreview(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  preview: Layout,
  selectedId: number | null,
  deltaW: number,
  view: ViewTransform,
  theme: Theme,
): void {
  if (selectedId === null) return;
  const accent = ACCENT[theme];
  const sel = L.points.find((p) => p.id === selectedId);
  if (!sel) return;

  // Predicted seam positions: dashed accent lines on the boosted layout.
  ctx.save();
  ctx.setLineDash([6 / view.scale, 4 / view.scale]);
  ctx.lineWidth = 1.7 / view.scale;
  ctx.strokeStyle = withAlpha(accent, 0.9);
  ctx.beginPath();
  const seen = new Set<string>();
  for (const e of preview.edges) {
    if (e.kind !== 'shared') continue;
    if (e.pieceId !== selectedId && e.otherId !== selectedId) continue;
    const k = edgeKey(e.a, e.b);
    if (seen.has(k)) continue;
    seen.add(k);
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Movement arrows: one per neighbour, at the midpoint of the current seam.
  const neighbours = new Map<number, LayoutEdge>();
  for (const e of L.edges) {
    if (e.kind !== 'shared' || e.pieceId !== selectedId || e.otherId === null) continue;
    if (!neighbours.has(e.otherId)) neighbours.set(e.otherId, e);
  }
  for (const [oid, e] of neighbours) {
    const other = L.points.find((p) => p.id === oid);
    if (!other) continue;
    const d = Math.hypot(other.x - sel.x, other.y - sel.y);
    const shift = d > 1e-9 ? deltaW / (2 * d) : 0;
    const dir = shift >= 0 ? 1 : -1;
    const lenMm = Math.max(10 / view.scale, Math.abs(shift));
    const tipX = e.mid.x + e.normal.x * lenMm * dir;
    const tipY = e.mid.y + e.normal.y * lenMm * dir;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 2.2 / view.scale;
    ctx.beginPath();
    ctx.moveTo(e.mid.x, e.mid.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    const ang = Math.atan2(tipY - e.mid.y, tipX - e.mid.x);
    const as = 7 / view.scale;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - as * Math.cos(ang - 0.55), tipY - as * Math.sin(ang - 0.55));
    ctx.lineTo(tipX - as * Math.cos(ang + 0.55), tipY - as * Math.sin(ang + 0.55));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawGraticule(ctx: CanvasRenderingContext2D, L: Layout, view: ViewTransform, theme: Theme): void {
  const step = 20;
  ctx.save();
  ctx.strokeStyle = withAlpha(INK[theme], 0.1);
  ctx.lineWidth = 0.5 / view.scale;
  ctx.beginPath();
  for (let x = step; x < L.frame.width - 1e-9; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, L.frame.height);
  }
  for (let y = step; y < L.frame.height - 1e-9; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(L.frame.width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPickedBoundaryGeometry(
  ctx: CanvasRenderingContext2D,
  pick: BoundaryPick,
  view: ViewTransform,
  theme: Theme,
): void {
  const accent = ACCENT[theme];
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4 / view.scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pick.edge.a.x, pick.edge.a.y);
  ctx.lineTo(pick.edge.b.x, pick.edge.b.y);
  ctx.stroke();
  for (const p of [pick.probeA, pick.probeB]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.4 / view.scale, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  // Connector from edge midpoint to the two probe points.
  ctx.setLineDash([3 / view.scale, 3 / view.scale]);
  ctx.lineWidth = 1 / view.scale;
  ctx.beginPath();
  ctx.moveTo(pick.probeA.x, pick.probeA.y);
  ctx.lineTo(pick.probeB.x, pick.probeB.y);
  ctx.stroke();
  ctx.restore();
}

function drawHandles(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  opts: RenderOptions,
  view: ViewTransform,
  theme: Theme,
): void {
  const ink = INK[theme];
  const page = PAGE[theme];
  const accent = ACCENT[theme];
  const bbox = ringBBox(L.frame.ring);
  for (const p of L.points) {
    const selected = opts.selectedId === p.id;
    const inside = !(p.x < bbox.minX || p.x > bbox.maxX || p.y < bbox.minY || p.y > bbox.maxY);
    const piece = L.pieces.find((pc) => pc.id === p.id);
    const alive = piece !== undefined && piece.parts > 0;
    const rScreen = selected ? 9 : 6.5;
    const r = rScreen / view.scale;

    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 2 / view.scale, 0, Math.PI * 2);
    ctx.fillStyle = page;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(alive ? colorForPiece(p.id, theme) : CRITICAL, alive ? 0.95 : 0.4);
    ctx.fill();
    ctx.lineWidth = (selected ? 2.4 : 1.5) / view.scale;
    ctx.strokeStyle = selected ? accent : inside ? ink : CRITICAL;
    ctx.stroke();

    if (selected) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5 / view.scale, 0, Math.PI * 2);
      ctx.setLineDash([3 / view.scale, 3 / view.scale]);
      ctx.lineWidth = 1 / view.scale;
      ctx.strokeStyle = withAlpha(accent, 0.85);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

// ----------------------------------------------------------------------------
// Annotation pass (screen pixels)

const font = (weight: number, px: number) => `${weight} ${px}px ${FONT}`;

function haloText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { px: number; weight: number; fill: string; halo: string; align?: CanvasTextAlign },
): void {
  ctx.save();
  ctx.font = font(opts.weight, opts.px);
  ctx.textAlign = opts.align ?? 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = opts.halo;
  ctx.lineWidth = 3.2;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = opts.fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function screenPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: { px: number; weight: number; fill: string; ink: string; padX?: number; padY?: number },
): void {
  ctx.save();
  ctx.font = font(opts.weight, opts.px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + (opts.padX ?? 10);
  const h = opts.px + (opts.padY ?? 6);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, Math.min(h / 2, 9));
  ctx.fillStyle = opts.fill;
  ctx.fill();
  ctx.fillStyle = opts.ink;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function drawLabelAnnotations(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  baseline: Layout | null,
  overlay: boolean,
  view: ViewTransform,
  theme: Theme,
  selectedId: number | null,
): void {
  const ink = INK[theme];
  const halo = PAGE[theme];
  for (const piece of L.pieces) {
    const nb = baseline?.pieces.find((p) => p.id === piece.id);
    piece.labelAnchors.forEach((anchor, i) => {
      const s = toScreen(anchor, view);
      const strong = selectedId === piece.id;
      haloText(ctx, String(piece.id), s.x, s.y, {
        px: strong ? 16 : 13.5,
        weight: 700,
        fill: strong ? ink : withAlpha(ink, 0.93),
        halo,
      });
      if (piece.parts > 1) {
        screenPill(ctx, `${i + 1}/${piece.parts}`, s.x, s.y + 16, {
          px: 9,
          weight: 600,
          fill: withAlpha(PAGE[theme], 0.82),
          ink: withAlpha(ink, 0.9),
          padX: 8,
          padY: 3,
        });
      }
      if (overlay && nb) {
        const d = piece.area - nb.area;
        if (Math.abs(d) > 0.5) {
          haloText(ctx, `${d > 0 ? '+' : ''}${Math.round(d)} mm²`, s.x, s.y - 17, {
            px: 10,
            weight: 600,
            fill: d > 0 ? '#0ca30c' : '#e66767',
            halo,
          });
        }
      }
    });
    if (piece.parts === 0) {
      const site = L.points.find((p) => p.id === piece.id);
      if (site) {
        const s = toScreen(site, view);
        screenPill(ctx, `#${piece.id} · 0 面积`, s.x, s.y + 18, {
          px: 10,
          weight: 650,
          fill: CRITICAL,
          ink: '#ffffff',
          padX: 14,
          padY: 6,
        });
      }
    }
  }
}

function drawHandleAnnotations(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  opts: RenderOptions,
  view: ViewTransform,
  theme: Theme,
): void {
  const ink = INK[theme];
  const halo = PAGE[theme];
  for (const p of L.points) {
    const sel = opts.selectedId === p.id;
    if (!sel) continue;
    const s = toScreen(p, view);
    haloText(ctx, `w ${Math.round(p.weight)}`, s.x + 13, s.y - 12, {
      px: 10,
      weight: 650,
      fill: ink,
      halo,
      align: 'left',
    });
  }
  void L;
}

function drawSeamPreviewAnnotations(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  preview: Layout,
  selectedId: number,
  deltaW: number,
  view: ViewTransform,
  theme: Theme,
): void {
  const sel = L.points.find((p) => p.id === selectedId);
  if (!sel) return;
  const ink = INK[theme];
  const halo = PAGE[theme];
  void preview;
  const neighbours = new Map<number, LayoutEdge>();
  for (const e of L.edges) {
    if (e.kind !== 'shared' || e.pieceId !== selectedId || e.otherId === null) continue;
    if (!neighbours.has(e.otherId)) neighbours.set(e.otherId, e);
  }
  for (const [oid, e] of neighbours) {
    const other = L.points.find((p) => p.id === oid);
    if (!other) continue;
    const d = Math.hypot(other.x - sel.x, other.y - sel.y);
    const shift = d > 1e-9 ? deltaW / (2 * d) : 0;
    const dir = shift >= 0 ? 1 : -1;
    const lenMm = Math.max(10 / view.scale, Math.abs(shift));
    const tip = toScreen({ x: e.mid.x + e.normal.x * lenMm * dir, y: e.mid.y + e.normal.y * lenMm * dir }, view);
    haloText(ctx, `${shift >= 0 ? '+' : ''}${shift.toFixed(1)} mm → #${oid}`, tip.x, tip.y - 14, {
      px: 10,
      weight: 600,
      fill: ink,
      halo,
    });
  }
}

function drawPickedBoundaryAnnotations(
  ctx: CanvasRenderingContext2D,
  pick: BoundaryPick,
  view: ViewTransform,
  theme: Theme,
): void {
  const ink = INK[theme];
  const halo = PAGE[theme];
  for (const [p, label] of [
    [pick.probeA, 'A'],
    [pick.probeB, 'B'],
  ] as const) {
    const s = toScreen(p, view);
    haloText(ctx, label, s.x, s.y, { px: 10, weight: 700, fill: ink, halo });
  }
  void theme;
}

function drawScaleBar(ctx: CanvasRenderingContext2D, view: ViewTransform, cssH: number, theme: Theme): void {
  const candidates = [5, 10, 20, 50, 100, 200, 500, 1000];
  let chosen = 50;
  for (const c of candidates) {
    const px = c * view.scale;
    if (px >= 56 && px <= 130) {
      chosen = c;
      break;
    }
  }
  const px = chosen * view.scale;
  const x0 = 20;
  const y0 = cssH - 24;
  ctx.save();
  ctx.strokeStyle = withAlpha(INK[theme], 0.7);
  ctx.fillStyle = withAlpha(INK[theme], 0.7);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 4);
  ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + px, y0);
  ctx.moveTo(x0 + px, y0 - 4);
  ctx.lineTo(x0 + px, y0 + 4);
  ctx.stroke();
  ctx.font = font(500, 10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${chosen} mm`, x0, y0 + 7);
  ctx.restore();
}

function drawCursorTag(
  ctx: CanvasRenderingContext2D,
  cursor: Pt,
  id: number,
  tie: boolean,
  view: ViewTransform,
  theme: Theme,
  cssW: number,
): void {
  const ink = INK[theme];
  const surface = SURFACE[theme];
  const accent = ACCENT[theme];
  const label = tie ? `#${id} · 贴缝` : `#${id}`;
  ctx.save();
  ctx.font = font(600, 11);
  const w = ctx.measureText(label).width + 16;
  const h = 22;
  const x = Math.max(8, Math.min(cursor.x + 16, cssW - w - 8));
  const y = Math.max(8, cursor.y - 34);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fillStyle = withAlpha(surface, 0.96);
  ctx.fill();
  ctx.strokeStyle = tie ? accent : withAlpha(ink, 0.22);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 8, y + h / 2 + 0.5);
  ctx.restore();
  void view;
}
