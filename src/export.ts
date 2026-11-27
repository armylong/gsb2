/**
 * SVG and slice-outline export.
 *
 * All exported geometry stays in original world coordinates (millimetres,
 * y down) and every file uses the same `viewBox="0 0 <width> <height>"`, so a
 * pile of per-piece slices aligns with the coloured drawing when stacked.
 */

import { zipSync, strToU8 } from 'fflate';
import { polyArea } from './geometry';
import { pieceColorHex, paneStyle, textureFor } from './colors';
import type { Layout, Piece, Ring, Theme } from './types';

export interface ExportOptions {
  theme?: Theme;
  /** Paper background (print friendly) or transparent. */
  paper?: boolean;
  /** Print pane numbers in the coloured SVG. */
  labels?: boolean;
  /** Include the seam network as separate strokes. */
  seams?: boolean;
}

const fmt = (n: number): string => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};

function pathFromRings(rings: Ring[]): string {
  const parts: string[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const segs: string[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      segs.push(`${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`);
    }
    segs.push('Z');
    parts.push(segs.join(' '));
  }
  return parts.join(' ');
}

function polygonsPath(piece: Piece): string {
  return piece.polygons.map((poly) => pathFromRings(poly)).join(' ');
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paperRect(layout: Layout, theme: Theme): string {
  const bg = theme === 'dark' ? '#141413' : '#fcfcfb';
  return `  <rect x="0" y="0" width="${fmt(layout.frame.width)}" height="${fmt(layout.frame.height)}" fill="${bg}"/>\n`;
}

/**
 * Hatch patterns for panes past the eight-hue palette. Same composite rule as
 * the canvas (45° and 135°), so a sliced SVG and the coloured drawing agree.
 */
function textureDefs(layout: Layout, theme: Theme): string {
  return textureDefsFor(layout, layout.pieces.map((p) => p.id), theme);
}

function textureDefsFor(layout: Layout, idsToUse: number[], theme: Theme): string {
  const ids = layout.pieces.filter((p) => idsToUse.includes(p.id) && p.parts > 0 && textureFor(p.id) > 0);
  if (ids.length === 0) return '';
  const lines: string[] = ['  <defs>\n'];
  for (const piece of ids) {
    const style = paneStyle(piece.id, theme);
    const angle = style.texture === 1 ? 45 : 135;
    const stroke = pieceColorHex(piece.id, theme);
    lines.push(
      `    <pattern id="tex-${piece.id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">\n` +
        (style.texture === 2
          ? `      <path d="M0 0 V6 M0 3 H6" stroke="${stroke}" stroke-width="1.4" fill="none"/>\n`
          : `      <path d="M0 0 V6" stroke="${stroke}" stroke-width="1.4" fill="none"/>\n`) +
        '    </pattern>\n',
    );
  }
  lines.push('  </defs>\n');
  return lines.join('');
}

function frameOutline(layout: Layout, theme: Theme): string {
  const ink = theme === 'dark' ? '#f0efec' : '#0b0b0b';
  const d = pathFromRings([layout.frame.ring]);
  return `  <path id="frame" d="${d}" fill="none" stroke="${ink}" stroke-width="1.2" stroke-linejoin="miter"/>\n`;
}

function labelGroup(layout: Layout, theme: Theme): string {
  const ink = theme === 'dark' ? '#f0efec' : '#0b0b0b';
  const lines: string[] = [];
  lines.push(`  <g id="labels" font-family="ui-sans-serif, system-ui, sans-serif" font-size="4" text-anchor="middle" dominant-baseline="central" fill="${ink}">\n`);
  for (const piece of layout.pieces) {
    for (const anchor of piece.labelAnchors) {
      // A thin halo keeps the number legible over any glass tint.
      const p = anchor;
      lines.push(
        `    <text x="${fmt(p.x)}" y="${fmt(p.y)}" paint-order="stroke" stroke="${
          theme === 'dark' ? '#141413' : '#fcfcfb'
        }" stroke-width="1.6" stroke-linejoin="round">${piece.id}</text>\n`,
      );
    }
  }
  lines.push('  </g>\n');
  return lines.join('');
}

function seamGroup(layout: Layout, theme: Theme): string {
  const ink = theme === 'dark' ? '#0d0d0c' : '#52514e';
  const shared: string[] = [];
  const frameSeams: string[] = [];
  for (const e of layout.edges) {
    // One entry per undirected edge: keep the side with the lower id as owner.
    if (e.kind === 'shared' && e.otherId !== null && e.pieceId > e.otherId) continue;
    const line = `    <line x1="${fmt(e.a.x)}" y1="${fmt(e.a.y)}" x2="${fmt(e.b.x)}" y2="${fmt(e.b.y)}"/>\n`;
    (e.kind === 'shared' ? shared : frameSeams).push(line);
  }
  return (
    `  <g id="seams-frame" stroke="${ink}" stroke-width="1.1" stroke-linecap="square">\n` +
    frameSeams.join('') +
    '  </g>\n' +
    `  <g id="seams-shared" stroke="${ink}" stroke-width="0.55" stroke-linecap="square">\n` +
    shared.join('') +
    '  </g>\n'
  );
}

/** Full coloured drawing with numbered panes. */
export function exportColorSvg(layout: Layout, opts: ExportOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const paper = opts.paper ?? true;
  const seamGroupWanted = opts.seams ?? true;
  const labels = opts.labels ?? true;
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(layout.frame.width)}mm" height="${fmt(
      layout.frame.height,
    )}mm" viewBox="0 0 ${fmt(layout.frame.width)} ${fmt(layout.frame.height)}" version="1.1">\n`,
  );
  lines.push(
    `  <metadata>${xmlEscape(
      JSON.stringify({
        generator: 'stained-glass-voronoi',
        frameArea: layout.stats.frameArea,
        pieceAreaTotal: layout.stats.pieceAreaTotal,
        difference: layout.stats.difference,
        exact: layout.stats.exact,
        units: 'mm',
      }),
    )}</metadata>\n`,
  );
  if (paper) lines.push(paperRect(layout, theme));
  lines.push(textureDefs(layout, theme));
  lines.push(`  <g id="panes" fill-rule="evenodd">\n`);
  for (const piece of layout.pieces) {
    if (piece.parts === 0) continue;
    const fill = pieceColorHex(piece.id, theme);
    const d = polygonsPath(piece);
    const tex = textureFor(piece.id);
    lines.push(
      `    <path id="piece-${piece.id}" data-piece="${piece.id}" data-area="${fmt(
        piece.area,
      )}" data-parts="${piece.parts}" d="${d}" fill="${fill}" fill-opacity="0.82" stroke="#111110" stroke-width="0.6" stroke-linejoin="round"/>\n`,
    );
    if (tex > 0) {
      lines.push(
        `    <path data-piece="${piece.id}" d="${d}" fill="url(#tex-${piece.id})" stroke="none"/>\n`,
      );
    }
  }
  lines.push('  </g>\n');
  if (seamGroupWanted) lines.push(seamGroup(layout, theme));
  lines.push(frameOutline(layout, theme));
  if (labels) lines.push(labelGroup(layout, theme));
  lines.push('</svg>\n');
  return lines.join('');
}

/** One independently composable slice outline, aligned to the frame viewBox. */
export function exportPieceSvg(piece: Piece, layout: Layout, opts: ExportOptions = {}): string {
  const theme = opts.theme ?? 'light';
  const ink = theme === 'dark' ? '#f0efec' : '#0b0b0b';
  const fill = pieceColorHex(piece.id, theme);
  const lines: string[] = [];
  const area = piece.polygons.reduce((s, poly) => s + polyArea(poly), 0);
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>\n`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(layout.frame.width)}mm" height="${fmt(
      layout.frame.height,
    )}mm" viewBox="0 0 ${fmt(layout.frame.width)} ${fmt(layout.frame.height)}" version="1.1">\n`,
  );
  lines.push(
    `  <metadata>${xmlEscape(
      JSON.stringify({
        generator: 'stained-glass-voronoi',
        piece: piece.id,
        area,
        parts: piece.parts,
        viewBox: [0, 0, layout.frame.width, layout.frame.height],
        units: 'mm',
        note: 'coordinates are in the original frame; stack all slices to rebuild the window',
      }),
    )}</metadata>\n`,
  );
  const tex = textureFor(piece.id);
  const empty = piece.parts === 0 || piece.polygons.length === 0;
  lines.push(
    `  <path id="piece-${piece.id}" data-piece="${piece.id}" data-empty="${empty}" data-parts="${piece.parts}" d="${polygonsPath(
      piece,
    )}" fill="${fill}" fill-opacity="0.82" fill-rule="evenodd" stroke="${ink}" stroke-width="0.5" stroke-linejoin="round"/>\n`,
  );
  if (empty) {
    // Keep the file in the bundle so every printed number has a slice, but flag it.
    lines.push(`  <desc>此编号没有地盘（被邻点挤空），切片为空。</desc>\n`);
  }
  if (tex > 0 && piece.parts > 0) {
    lines.push(textureDefsFor(layout, [piece.id], theme));
    lines.push(
      `  <path data-piece="${piece.id}" d="${polygonsPath(piece)}" fill="url(#tex-${piece.id})" stroke="none"/>\n`,
    );
  }
  // A hairline frame ring in every slice makes stacking/registration visually checkable.
  lines.push(`  <path d="${pathFromRings([layout.frame.ring])}" fill="none" stroke="${ink}" stroke-opacity="0.35" stroke-width="0.25"/>\n`);
  lines.push('</svg>\n');
  return lines.join('');
}

export interface SliceManifest {
  generator: string;
  units: 'mm';
  /** Every SVG uses viewBox "0 0 <width> <height>"; stacking slices rebuilds the window. */
  viewBox: [number, number, number, number];
  frame: {
    width: number;
    height: number;
    area: number;
    ring: [number, number][];
  };
  totals: {
    pieceAreaTotal: number;
    difference: number;
    exact: boolean;
  };
  pieces: {
    id: number;
    area: number;
    /** 1, or 2 when the notch cuts this id into disjoint parts. */
    parts: number;
    polygons: number;
    color: string;
    file: string;
  }[];
}

export function buildManifest(layout: Layout, theme: Theme = 'light'): SliceManifest {
  return {
    generator: 'stained-glass-voronoi',
    units: 'mm',
    viewBox: [0, 0, layout.frame.width, layout.frame.height],
    frame: {
      width: layout.frame.width,
      height: layout.frame.height,
      area: layout.stats.frameArea,
      ring: layout.frame.ring.map((p) => [p.x, p.y] as [number, number]),
    },
    totals: {
      pieceAreaTotal: layout.stats.pieceAreaTotal,
      difference: layout.stats.difference,
      exact: layout.stats.exact,
    },
    pieces: layout.pieces.map((p) => ({
      id: p.id,
      area: p.area,
      parts: p.parts,
      polygons: p.polygons.length,
      color: pieceColorHex(p.id, theme),
      file: `slices/piece-${pad2(p.id)}.svg`,
    })),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface ZipFile {
  name: string;
  bytes: Uint8Array;
}

/** Everything needed to re-assemble the window: colour drawing, slices, manifest. */
export function buildExportFiles(layout: Layout, opts: ExportOptions = {}): ZipFile[] {
  const theme = opts.theme ?? 'light';
  const files: ZipFile[] = [];
  files.push({ name: 'window-color.svg', bytes: strToU8(exportColorSvg(layout, opts)) });
  for (const piece of layout.pieces) {
    files.push({
      name: `slices/piece-${pad2(piece.id)}.svg`,
      bytes: strToU8(exportPieceSvg(piece, layout, opts)),
    });
  }
  files.push({
    name: 'manifest.json',
    bytes: strToU8(JSON.stringify(buildManifest(layout, theme), null, 2)),
  });
  files.push({
    name: 'README.txt',
    bytes: strToU8(
      [
        '切片说明 / Slice notes',
        '',
        '所有文件使用同一坐标系：外框左上角为 (0,0)，单位 mm，y 轴向下。',
        'viewBox 统一为 0 0 <宽> <高>，因此各 slices/*.svg 与 window-color.svg 叠放在一起即按原坐标拼合。',
        'manifest.json 记录了每块编号的面积、分片数与颜色；各编号面积之和应等于 frame.area。',
        '',
        `外框面积: ${layout.stats.frameArea.toFixed(6)} mm²`,
        `分件合计: ${layout.stats.pieceAreaTotal.toFixed(6)} mm²`,
        `差值: ${layout.stats.difference.toFixed(9)} mm²`,
      ].join('\n'),
    ),
  });
  return files;
}

export function zipFiles(files: ZipFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = f.bytes;
  return zipSync(entries, { level: 6 });
}

export function buildSliceZip(layout: Layout, opts: ExportOptions = {}): Uint8Array {
  return zipFiles(buildExportFiles(layout, opts));
}

/** Download a string or bytes under `name` (browser only). */
export function downloadBlob(name: string, data: string | Uint8Array, mime: string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: mime })
      : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Verify slices + colour drawing expose the same per-piece area metadata. */
export function exportedAreas(layout: Layout): { id: number; area: number }[] {
  return layout.pieces.map((p) => ({
    id: p.id,
    area: p.polygons.reduce((s, poly) => s + polyArea(poly), 0),
  }));
}
