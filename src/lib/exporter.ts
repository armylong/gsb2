// 导出：把「当前保留数量下的一圈结果」交给后续画图流程
// PNG 用独立的离屏画布尺寸（与网页缩放、devicePixelRatio 无关）；
// SVG / JSON 是矢量与数据格式，方便后续程序读取。

import type { Vec2 } from './geometry';
import type { CircleComponent, Epicycle } from './dft';
import type { DeviationReport } from './deviation';

export interface ExportLayout {
  width: number;
  height: number;
  /** 模型坐标 -> 导出画布坐标的仿射变换（统一缩放 + 平移，保持长宽比） */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface ExportContents {
  original: Vec2[];
  rebuilt: Vec2[];
  chain: Epicycle[];
  report: DeviationReport | null;
  components: CircleComponent[];
}

export interface ExportFlags {
  original: boolean;
  rebuilt: boolean;
  chain: boolean;
  heatmap: boolean;
}

export function fitLayout(points: Vec2[], width: number, height: number, pad = 40): ExportLayout {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    width,
    height,
    scale,
    offsetX: width / 2 - cx * scale,
    offsetY: height / 2 - cy * scale,
  };
}

export const mapPoint = (layout: ExportLayout, p: Vec2): Vec2 => ({
  x: p.x * layout.scale + layout.offsetX,
  y: p.y * layout.scale + layout.offsetY,
});

export interface ExportJson {
  format: 'epicycle-trace/1';
  exportedAt: string;
  sampleCount: number;
  keptCircles: number;
  totalCircles: number;
  center: Vec2;
  components: Array<{ k: number; radius: number; phase: number; re: number; im: number }>;
  rebuiltPath: Vec2[];
  originalPath: Vec2[];
  deviation: DeviationReport['stats'] | null;
  canvas: { width: number; height: number };
}

export function buildExportJson(
  contents: ExportContents,
  allComponents: CircleComponent[],
  layout: ExportLayout,
): ExportJson {
  return {
    format: 'epicycle-trace/1',
    exportedAt: new Date().toISOString(),
    sampleCount: contents.rebuilt.length,
    keptCircles: contents.components.filter((c) => c.k !== 0).length,
    totalCircles: allComponents.filter((c) => c.k !== 0).length,
    center: (() => {
      const c0 = contents.components.find((c) => c.k === 0)!;
      return { x: c0.re, y: c0.im };
    })(),
    components: contents.components.map((c) => ({
      k: c.k, radius: c.r, phase: c.phase, re: c.re, im: c.im,
    })),
    rebuiltPath: contents.rebuilt,
    originalPath: contents.original,
    deviation: contents.report?.stats ?? null,
    canvas: { width: layout.width, height: layout.height },
  };
}

/** 矢量 SVG：圆链 + 轨迹，坐标与 PNG 导出共用同一套 layout */
export function buildSvg(contents: ExportContents, layout: ExportLayout, flags: ExportFlags): string {
  const L = layout;
  const mp = (p: Vec2) => mapPoint(L, p);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="#1a1a19"/>`);

  const pathD = (pts: Vec2[], close: boolean) => {
    if (pts.length === 0) return '';
    const head = mp(pts[0]);
    let d = `M${head.x.toFixed(2)} ${head.y.toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const q = mp(pts[i]);
      d += `L${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
    }
    return close ? `${d}Z` : d;
  };

  if (flags.original && contents.original.length) {
    parts.push(
      `<path d="${pathD(contents.original, true)}" fill="none" stroke="#3987e5" stroke-width="2" stroke-opacity="0.75" stroke-dasharray="6 5"/>`,
    );
  }
  if (flags.rebuilt && contents.rebuilt.length) {
    // 不闭合：保留最后一个采样点，绝不追加回首点的跨画布连线
    parts.push(
      `<path d="${pathD(contents.rebuilt, false)}" fill="none" stroke="#d95926" stroke-width="2.5" stroke-linejoin="round"/>`,
    );
  }
  if (flags.chain) {
    for (const c of contents.chain) {
      if (c.k === 0 || c.r === 0) continue;
      const o = mp(c.origin);
      parts.push(
        `<circle cx="${o.x.toFixed(2)}" cy="${o.y.toFixed(2)}" r="${(c.r * L.scale).toFixed(2)}" fill="none" stroke="#898781" stroke-opacity="0.55" stroke-width="1"/>`,
      );
      const tip = mp(c.tip);
      parts.push(
        `<line x1="${o.x.toFixed(2)}" y1="${o.y.toFixed(2)}" x2="${tip.x.toFixed(2)}" y2="${tip.y.toFixed(2)}" stroke="#c3c2b7" stroke-opacity="0.6" stroke-width="0.8"/>`,
      );
    }
  }
  parts.push(`</svg>`);
  return parts.join('\n');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
