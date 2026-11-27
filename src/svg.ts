import { FACE_LABEL, FaceId } from './geom';
import { PaintCell } from './project';

export const SVG_SCALE = 200; // 像素 / 米
const PAD = 56; // 留给刻度尺的边距(像素)
const NUM = 4; // 坐标小数位

interface MergedStrip {
  pts: [number, number][]; // 面内二维坐标(米),4 个顶点
  src: [number, number][]; // 对应的目标图局部坐标(米)
  color: string;
}

/** 同一行内颜色相同且相邻的格子合并成一条多边形,减少 SVG 体积 */
export function mergeStrips(cells: PaintCell[]): MergedStrip[] {
  const byRow = new Map<number, PaintCell[]>();
  for (const c of cells) {
    const arr = byRow.get(c.j) ?? [];
    arr.push(c);
    byRow.set(c.j, arr);
  }
  const strips: MergedStrip[] = [];
  for (const row of byRow.values()) {
    row.sort((a, b) => a.i - b.i);
    let runStart = row[0];
    let prev = row[0];
    const flush = () => {
      strips.push({
        pts: [runStart.corners2[0], prev.corners2[1], prev.corners2[2], runStart.corners2[3]],
        src: [runStart.srcUV[0], prev.srcUV[1], prev.srcUV[2], runStart.srcUV[3]],
        color: runStart.color,
      });
    };
    for (let k = 1; k < row.length; k++) {
      const c = row[k];
      if (c.i === prev.i + 1 && c.color === runStart.color) {
        prev = c;
      } else {
        flush();
        runStart = c;
        prev = c;
      }
    }
    flush();
  }
  return strips;
}

function fmt(n: number): string {
  return n.toFixed(NUM);
}

/**
 * 导出单个面的平面 SVG:只框住实际要画的区域,四周带米制刻度尺。
 * 面内第二坐标(z 或 y)向上为正,即 SVG 里做了翻转,图上方 = 远离观察点 / 更高。
 * 每个多边形带 data-src,记录顶点在目标图上的来源坐标,供核对用。
 */
export function exportFaceSVG(face: FaceId, cells: PaintCell[]): string | null {
  const faceCells = cells.filter((c) => c.face === face);
  if (faceCells.length === 0) return null;
  const strips = mergeStrips(faceCells);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of strips) {
    for (const [x, y] of s.pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const wPx = (maxX - minX) * SVG_SCALE;
  const hPx = (maxY - minY) * SVG_SCALE;
  const W = wPx + PAD * 2;
  const H = hPx + PAD * 2;

  const sx = (x: number) => PAD + (x - minX) * SVG_SCALE;
  const sy = (y: number) => PAD + (maxY - y) * SVG_SCALE; // 翻转:值大者在上

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" ` +
      `viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" data-face="${face}" ` +
      `data-minx="${fmt(minX)}" data-maxy="${fmt(maxY)}" data-scale="${SVG_SCALE}" data-pad="${PAD}">`,
  );
  parts.push(`<desc>${FACE_LABEL[face]} 实际绘制区域,单位:米,比例 1米=${SVG_SCALE}单位</desc>`);
  parts.push(`<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="#ffffff"/>`);

  // 绘制区域
  for (const s of strips) {
    const d =
      `M ${fmt(sx(s.pts[0][0]))} ${fmt(sy(s.pts[0][1]))} ` +
      s.pts
        .slice(1)
        .map(([x, y]) => `L ${fmt(sx(x))} ${fmt(sy(y))}`)
        .join(' ') +
      ' Z';
    const src = s.src.map(([u, v]) => `${u.toFixed(6)},${v.toFixed(6)}`).join(' ');
    parts.push(`<path d="${d}" fill="${s.color}" stroke="none" data-src="${src}"/>`);
  }

  // 刻度尺:底边(x 向)与左边(第二坐标向),每 0.1m 一齿,每 0.5m 标数
  const ruler: string[] = [];
  const tickX0 = Math.ceil(minX * 10) / 10;
  for (let x = tickX0; x <= maxX + 1e-9; x += 0.1) {
    const px = sx(x);
    const major = Math.abs(x / 0.5 - Math.round(x / 0.5)) < 1e-6;
    ruler.push(`<line x1="${fmt(px)}" y1="${fmt(PAD + hPx)}" x2="${fmt(px)}" y2="${fmt(PAD + hPx + (major ? 10 : 5))}"/>`);
    if (major) {
      ruler.push(`<text x="${fmt(px)}" y="${fmt(PAD + hPx + 24)}" text-anchor="middle">${x.toFixed(1)}</text>`);
    }
  }
  const tickY0 = Math.ceil(minY * 10) / 10;
  for (let y = tickY0; y <= maxY + 1e-9; y += 0.1) {
    const py = sy(y);
    const major = Math.abs(y / 0.5 - Math.round(y / 0.5)) < 1e-6;
    ruler.push(`<line x1="${fmt(PAD - (major ? 10 : 5))}" y1="${fmt(py)}" x2="${fmt(PAD)}" y2="${fmt(py)}"/>`);
    if (major) {
      ruler.push(`<text x="${fmt(PAD - 14)}" y="${fmt(py + 3)}" text-anchor="end">${y.toFixed(1)}</text>`);
    }
  }
  parts.push(
    `<g stroke="#333" stroke-width="1" fill="none" font-family="monospace" font-size="11">` +
      `<rect x="${fmt(PAD)}" y="${fmt(PAD)}" width="${fmt(wPx)}" height="${fmt(hPx)}" fill="none"/>` +
      ruler.join('') +
      `</g>`,
  );
  parts.push(
    `<text x="${fmt(PAD)}" y="${fmt(PAD - 10)}" font-family="sans-serif" font-size="14" fill="#000">` +
      `${FACE_LABEL[face]} · 单位:米 · 范围 x[${minX.toFixed(2)}, ${maxX.toFixed(2)}] y[${minY.toFixed(2)}, ${maxY.toFixed(2)}]</text>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}
