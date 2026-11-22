/**
 * SVG 出图与重开。
 *
 * 导出的 SVG 既可直接在浏览器/查看器里打开（标准实线/虚线 line 元素），
 * 又在 <metadata> 内嵌一份 JSON：视图描述、折边阈值、每段的边 id / 虚实 /
 * 参数区间 / 遮挡零件 / 世界坐标端点。重开时用它完整复原，并可与实时重算结果比对。
 */

import type { HLRResult, LineSegment } from './hlr.ts';
import type { ViewDescriptor } from './view.ts';
import type { Vec3 } from './math3d.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const META_KEY = 'application/x-hlr-drawing+json';

export interface SvgOptions {
  width: number;
  height: number;
  margin: number;
  showHidden: boolean;
  strokeWidth: number;
}

export interface HlrDrawingMeta {
  format: 'hlr-drawing';
  version: 1;
  view: ViewDescriptor;
  thresholdDeg: number;
  depthEps: number;
  svg: { width: number; height: number; margin: number };
  parts: Array<{ id: string; label: string; color: number }>;
  edges: Array<{
    edgeId: string;
    partId: string;
    worldA: Vec3;
    worldB: Vec3;
    dihedralDeg: number;
  }>;
  segments: Array<{
    id: string;
    edgeId: string;
    partId: string;
    kind: 'visible' | 'hidden';
    t0: number;
    t1: number;
    occluderPartIds: string[];
    occluderTriIndices: number[];
  }>;
}

export function defaultSvgOptions(width = 900, height = 760): SvgOptions {
  return { width, height, margin: 36, showHidden: true, strokeWidth: 1.4 };
}

/** NDC [-1,1] -> 画布像素。 */
export function ndcToPixel(opts: Pick<SvgOptions, 'width' | 'height' | 'margin'>) {
  const w = opts.width - opts.margin * 2;
  const h = opts.height - opts.margin * 2;
  return (x: number, y: number): [number, number] => [
    opts.margin + ((x + 1) * 0.5) * w,
    opts.margin + ((1 - y) * 0.5) * h
  ];
}

function buildMeta(result: HLRResult, opts: SvgOptions): HlrDrawingMeta {
  return {
    format: 'hlr-drawing',
    version: 1,
    view: result.view,
    thresholdDeg: result.thresholdDeg,
    depthEps: result.depthEps,
    svg: { width: opts.width, height: opts.height, margin: opts.margin },
    parts: result.edgeRecords.length
      ? Array.from(new Set(result.edgeRecords.map((r) => r.partId))).map((id) => {
          const rec = result.edgeRecords.find((r) => r.partId === id)!;
          const part = (result as HLRResult & { partMeta?: Array<{ id: string; label: string; color: number }> }).partMeta;
          const m = part?.find((p) => p.id === id);
          return { id, label: m?.label ?? id, color: m?.color ?? 0x333333 };
        })
      : [],
    edges: result.edgeRecords.map((r) => ({
      edgeId: r.edge.id,
      partId: r.partId,
      worldA: r.worldA,
      worldB: r.worldB,
      dihedralDeg: r.edge.dihedralDeg
    })),
    segments: result.segments
      .filter((s) => opts.showHidden || s.kind === 'visible')
      .map((s) => ({
        id: s.id,
        edgeId: s.edgeId,
        partId: s.partId,
        kind: s.kind,
        t0: s.t0,
        t1: s.t1,
        occluderPartIds: s.occluderPartIds,
        occluderTriIndices: s.occluderTriIndices
      }))
  };
}

function lineStyle(kind: 'visible' | 'hidden', opts: SvgOptions): Record<string, string> {
  if (kind === 'visible') {
    return { stroke: '#111111', 'stroke-width': String(opts.strokeWidth), fill: 'none' };
  }
  return {
    stroke: '#5b7fb8',
    'stroke-width': String(Math.max(opts.strokeWidth * 0.75, 0.8)),
    'stroke-dasharray': '7 5',
    fill: 'none'
  };
}

function createLine(s: LineSegment, opts: SvgOptions): SVGLineElement {
  const toPx = ndcToPixel(opts);
  const [x0, y0] = toPx(s.x0, s.y0);
  const [x1, y1] = toPx(s.x1, s.y1);
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', x0.toFixed(3));
  el.setAttribute('y1', y0.toFixed(3));
  el.setAttribute('x2', x1.toFixed(3));
  el.setAttribute('y2', y1.toFixed(3));
  el.setAttribute('class', `hlr-seg hlr-${s.kind}`);
  el.dataset.segId = s.id;
  el.dataset.edgeId = s.edgeId;
  el.dataset.partId = s.partId;
  el.dataset.kind = s.kind;
  el.dataset.occluders = s.occluderPartIds.join(',');
  for (const [k, v] of Object.entries(lineStyle(s.kind, opts))) el.setAttribute(k, v);
  el.style.cursor = 'pointer';
  return el;
}

/** 构造可交互预览 SVG（DOM），同时把元数据挂到根节点，便于点选与导出共用。 */
export function buildSvgDom(result: HLRResult, opts: SvgOptions, partMeta?: Array<{ id: string; label: string; color: number }>): SVGSVGElement {
  const withMeta = partMeta ? ({ ...result, partMeta } as HLRResult) : result;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', String(opts.width));
  svg.setAttribute('height', String(opts.height));
  svg.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
  svg.dataset.hlrMeta = JSON.stringify(buildMeta(withMeta, opts));

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(opts.width));
  bg.setAttribute('height', String(opts.height));
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  const frame = document.createElementNS(SVG_NS, 'rect');
  frame.setAttribute('x', String(opts.margin));
  frame.setAttribute('y', String(opts.margin));
  frame.setAttribute('width', String(opts.width - opts.margin * 2));
  frame.setAttribute('height', String(opts.height - opts.margin * 2));
  frame.setAttribute('fill', 'none');
  frame.setAttribute('stroke', '#cccccc');
  frame.setAttribute('stroke-width', '1');
  svg.appendChild(frame);

  for (const s of result.segments) {
    if (!opts.showHidden && s.kind === 'hidden') continue;
    svg.appendChild(createLine(s, opts));
  }
  return svg;
}

/** 导出独立 .svg 文件文本（含 <metadata>，可被任何 SVG 查看器打开）。 */
export function serializeSvg(result: HLRResult, opts: SvgOptions, partMeta?: Array<{ id: string; label: string; color: number }>): string {
  const withMeta = partMeta ? ({ ...result, partMeta } as HLRResult) : result;
  const meta = buildMeta(withMeta, opts);
  const toPx = ndcToPixel(opts);
  const lines: string[] = [];
  for (const s of result.segments) {
    if (!opts.showHidden && s.kind === 'hidden') continue;
    const [x0, y0] = toPx(s.x0, s.y0);
    const [x1, y1] = toPx(s.x1, s.y1);
    const st = lineStyle(s.kind, opts);
    const attrs = [
      `class="hlr-seg hlr-${s.kind}"`,
      `data-seg-id="${s.id}"`,
      `data-edge-id="${s.edgeId}"`,
      `data-part-id="${s.partId}"`,
      `data-kind="${s.kind}"`,
      `data-occluders="${s.occluderPartIds.join(',')}"`,
      ...Object.entries(st).map(([k, v]) => `${k}="${v}"`)
    ].join(' ');
    lines.push(
      `  <line x1="${x0.toFixed(3)}" y1="${y0.toFixed(3)}" x2="${x1.toFixed(3)}" y2="${y1.toFixed(3)}" ${attrs}/>`
    );
  }
  const metaJson = JSON.stringify(meta)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}">
  <metadata id="hlr-meta" type="${META_KEY}">${metaJson}</metadata>
  <rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="#ffffff"/>
  <rect x="${opts.margin}" y="${opts.margin}" width="${opts.width - opts.margin * 2}" height="${opts.height - opts.margin * 2}" fill="none" stroke="#cccccc" stroke-width="1"/>
${lines.join('\n')}
</svg>
`;
}

/** 从 SVG 文本或内嵌 dataset 中解析元数据。 */
export function parseDrawingMeta(svgTextOrElement: string | SVGSVGElement): HlrDrawingMeta {
  if (typeof svgTextOrElement !== 'string') {
    const raw = svgTextOrElement.dataset.hlrMeta;
    if (!raw) throw new Error('SVG 上没有 hlr 元数据');
    return JSON.parse(raw) as HlrDrawingMeta;
  }
  const text = svgTextOrElement;
  const match = text.match(/<metadata[^>]*>([\s\S]*?)<\/metadata>/);
  if (!match) throw new Error('SVG 中没有 <metadata>，不是本工具导出的图纸');
  const json = match[1]
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .trim();
  const meta = JSON.parse(json) as HlrDrawingMeta;
  if (meta.format !== 'hlr-drawing') throw new Error('元数据格式不识别');
  return meta;
}
