/**
 * Demo area audit — run with `npm run demo:areas`.
 *
 * Prints, for each built-in demo, the frame area, the summed pane areas, the
 * residual, and every per-id area, so the three demos can be checked without
 * opening a browser.
 */

import { DEMOS, cloneDemo } from '../src/demos';
import { computeLayout } from '../src/layout';
import { polyArea } from '../src/geometry';
import { buildManifest } from '../src/export';

let failures = 0;

for (const demo of DEMOS) {
  const { frame, points } = cloneDemo(demo);
  const layout = computeLayout(frame, points);
  const manifest = buildManifest(layout);
  const sliceSum = manifest.pieces.reduce((s, p) => s + p.area, 0);

  console.log(`\n=== ${demo.name} (${demo.id}) ===`);
  console.log(`外框外轮廓点数 ${frame.ring.length}，${overflow(demo.tagline)}`);
  console.log(
    `外框面积 ${layout.stats.frameArea.toFixed(6)} mm² | 点权和 ${layout.stats.pieceAreaTotal.toFixed(
      6,
    )} mm² | 残差 ${layout.stats.difference.toExponential(3)} mm²`,
  );
  console.log(`分件 ${layout.stats.pieceCount} 个，切片 ${layout.stats.partCount} 片，空编号 ${layout.stats.emptyPieceIds.join(',') || '无'}`);

  const ids = layout.pieces.map((p) => p.id);
  const widths = Math.max(...ids.map((i) => String(i).length), 2);
  for (const piece of layout.pieces) {
    const perPoly = piece.polygons.map((poly) => polyArea(poly).toFixed(3)).join(' + ');
    console.log(
      `  #${String(piece.id).padEnd(widths)}  ${piece.area.toFixed(3).padStart(11)} mm²  ` +
        `片数 ${piece.parts}  ${piece.parts > 1 ? '(' + perPoly + ')' : ''}`.padEnd(62) +
        (piece.parts === 0 ? '  ← 无地盘' : ''),
    );
  }

  const ok = layout.stats.exact && Math.abs(sliceSum - layout.stats.frameArea) < 1e-6;
  console.log(`  切片面积合计 ${sliceSum.toFixed(6)} mm² → ${ok ? '✓ 与外框一致' : '✗ 不一致'}`);
  if (!ok) failures++;

  for (const d of layout.diagnostics) {
    console.log(`  [${d.severity}] ${d.code}: ${d.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 个演示面积核对失败`);
  process.exit(1);
}
console.log('\n全部演示面积核对通过。');

function overflow(s: string): string {
  return s.length > 70 ? s.slice(0, 68) + '…' : s;
}
