/**
 * 2D 图纸视图：承载 HLR 输出的 SVG，负责点选（像素距离 -> 最近段）、
 * 虚/实线切换、重开文件的恢复与一致性校验。
 */

import type { HLRResult, LineSegment } from '../hlr/hlr.ts';
import type { HlrDrawingMeta, SvgOptions } from '../hlr/svg.ts';
import { buildSvgDom, defaultSvgOptions, parseDrawingMeta } from '../hlr/svg.ts';
import type { HighlightRequest } from '../three/viewer3d.ts';
import type { Vec3 } from '../hlr/math3d.ts';

export interface PickInfo {
  segment: LineSegment;
  worldA: Vec3;
  worldB: Vec3;
  distancePx: number;
}

export class DrawingView {
  private readonly container: HTMLElement;
  private svg: SVGSVGElement | null = null;
  private opts: SvgOptions;
  private result: HLRResult | null = null;
  private partMeta: Array<{ id: string; label: string; color: number }> = [];
  private selectedSegId: string | null = null;
  showHidden = true;

  readonly onPick: (info: PickInfo) => void;
  readonly onSelectionCleared: () => void;

  constructor(
    container: HTMLElement,
    handlers: { onPick: (info: PickInfo) => void; onSelectionCleared: () => void }
  ) {
    this.container = container;
    this.opts = defaultSvgOptions(
      Math.max(container.clientWidth - 16, 420),
      Math.max(container.clientHeight - 16, 420)
    );
    this.onPick = handlers.onPick;
    this.onSelectionCleared = handlers.onSelectionCleared;
  }

  setPartMeta(meta: Array<{ id: string; label: string; color: number }>): void {
    this.partMeta = meta;
  }

  render(result: HLRResult): void {
    this.result = result;
    this.selectedSegId = null;
    this.container.innerHTML = '';
    this.svg = buildSvgDom(result, this.opts, this.partMeta);
    this.container.appendChild(this.svg);
    this.attachPicker();
  }

  setShowHidden(show: boolean): void {
    this.showHidden = show;
    this.opts = { ...this.opts, showHidden: show };
    if (this.result) this.render(this.result);
  }

  get currentResult(): HLRResult | null {
    return this.result;
  }

  get svgOptions(): SvgOptions {
    return this.opts;
  }

  private attachPicker(): void {
    if (!this.svg) return;
    this.svg.addEventListener('click', (ev) => {
      const target = ev.target as SVGElement;
      if (!target.classList?.contains('hlr-seg')) {
        this.clearSelection();
        this.onSelectionCleared();
        return;
      }
      const segId = target.dataset.segId!;
      this.selectSegment(segId);
    });
  }

  /** 也支持在空白处按距离拾取（点击容差内的最近段）。 */
  selectSegment(segId: string): void {
    if (!this.result) return;
    const seg = this.result.segments.find((s) => s.id === segId);
    if (!seg) return;
    this.selectedSegId = segId;
    this.applySelectionStyles();
    const edgeRec = this.result.edgeRecords.find((r) => r.edge.id === seg.edgeId);
    if (!edgeRec) return;
    const req: PickInfo = {
      segment: seg,
      worldA: edgeRec.worldA,
      worldB: edgeRec.worldB,
      distancePx: 0
    };
    this.onPick(req);
  }

  private applySelectionStyles(): void {
    if (!this.svg) return;
    const lines = this.svg.querySelectorAll<SVGLineElement>('line.hlr-seg');
    lines.forEach((line) => {
      const isSel = line.dataset.segId === this.selectedSegId;
      const isSameEdge =
        this.selectedSegId && line.dataset.edgeId === this.result?.segments.find((s) => s.id === this.selectedSegId)?.edgeId;
      if (isSel) {
        line.setAttribute('stroke', '#e8521e');
        line.setAttribute('stroke-width', '3');
      } else if (isSameEdge) {
        line.setAttribute('stroke', '#f0a060');
        line.setAttribute('stroke-width', '2');
      } else {
        const kind = line.dataset.kind as 'visible' | 'hidden';
        const base = kind === 'visible'
          ? { stroke: '#111111', width: String(this.opts.strokeWidth) }
          : { stroke: '#5b7fb8', width: String(Math.max(this.opts.strokeWidth * 0.75, 0.8)) };
        line.setAttribute('stroke', base.stroke);
        line.setAttribute('stroke-width', base.width);
      }
    });
  }

  clearSelection(): void {
    this.selectedSegId = null;
    this.applySelectionStyles();
  }

  /**
   * 从导出的 SVG 文本恢复：先渲染元数据里保存的分段（保证与预览一致），
   * 再用回调拿到的实时 HLR 结果做逐段比对，任何不一致都通过返回值报告。
   * 当前 showHidden 开关同样作用于恢复后的画面。
   */
  restoreFromSvgText(
    svgText: string,
    recompute: (meta: HlrDrawingMeta) => HLRResult
  ): { meta: HlrDrawingMeta; mismatches: string[] } {
    const meta = parseDrawingMeta(svgText);
    this.opts = {
      width: meta.svg.width,
      height: meta.svg.height,
      margin: meta.svg.margin,
      showHidden: this.showHidden,
      strokeWidth: this.opts.strokeWidth
    };
    this.result = this.resultFromMeta(meta);
    this.selectedSegId = null;
    this.container.innerHTML = svgText.replace(/<\?xml[^>]*\?>\s*/, '');
    this.svg = this.container.querySelector('svg');
    if (this.svg) {
      this.svg.dataset.hlrMeta = JSON.stringify(meta);
      // 与当前虚线开关保持一致
      if (!this.showHidden) {
        this.svg.querySelectorAll('line.hlr-hidden').forEach((l) => l.remove());
      }
      this.attachPicker();
    }

    const live = recompute(meta);
    const mismatches = diffSegments(meta, live);
    return { meta, mismatches };
  }

  /** 元数据 -> 等价 HLRResult（用于点选恢复、3D 联动）。 */
  private resultFromMeta(meta: HlrDrawingMeta): HLRResult {
    const edgeMap = new Map(meta.edges.map((e) => [e.edgeId, e]));
    const segments: LineSegment[] = meta.segments.map((s, i) => {
      const e = edgeMap.get(s.edgeId)!;
      // 由世界端点 + 视图重投影得到 NDC，保证几何上与原图重合
      const { projectForMeta } = metaProjector(meta);
      const p0 = projectForMeta(e.worldA);
      const p1 = projectForMeta(e.worldB);
      const x0 = p0.x + (p1.x - p0.x) * s.t0;
      const y0 = p0.y + (p1.y - p0.y) * s.t0;
      const x1 = p0.x + (p1.x - p0.x) * s.t1;
      const y1 = p0.y + (p1.y - p0.y) * s.t1;
      return {
        id: s.id,
        edgeId: s.edgeId,
        partId: s.partId,
        partIndex: meta.parts.findIndex((p) => p.id === s.partId),
        edgeIndex: i,
        kind: s.kind,
        t0: s.t0,
        t1: s.t1,
        x0, y0, x1, y1,
        depth: (p0.depth + p1.depth) / 2,
        occluderPartIds: s.occluderPartIds,
        occluderTriIndices: s.occluderTriIndices
      };
    });
    return {
      view: meta.view,
      thresholdDeg: meta.thresholdDeg,
      depthEps: meta.depthEps,
      segments,
      edgeRecords: meta.edges.map((e) => ({
        edge: {
          id: e.edgeId, a: -1, b: -1, faces: [],
          partIndex: meta.parts.findIndex((p) => p.id === e.partId),
          dihedralDeg: e.dihedralDeg
        },
        partId: e.partId,
        worldA: e.worldA,
        worldB: e.worldB
      })),
      generatedAt: 'restored'
    };
  }
}

/** 按元数据中的视图描述投影世界点。 */
function metaProjector(meta: HlrDrawingMeta): {
  projectForMeta: (p: Vec3) => { x: number; y: number; depth: number };
} {
  const v = meta.view;
  const fx = v.target.x - v.eye.x;
  const fy = v.target.y - v.eye.y;
  const fz = v.target.z - v.eye.z;
  const fl = Math.hypot(fx, fy, fz);
  const f = { x: fx / fl, y: fy / fl, z: fz / fl };
  // right = normalize(cross(f, up))
  let rx = f.y * v.up.z - f.z * v.up.y;
  let ry = f.z * v.up.x - f.x * v.up.z;
  let rz = f.x * v.up.y - f.y * v.up.x;
  const rl = Math.hypot(rx, ry, rz);
  rx /= rl; ry /= rl; rz /= rl;
  // upT = cross(right, f)
  const ux = ry * f.z - rz * f.y;
  const uy = rz * f.x - rx * f.z;
  const uz = rx * f.y - ry * f.x;
  const halfWidth = v.halfHeight * v.aspect;
  return {
    projectForMeta(p: Vec3) {
      const dx = p.x - v.eye.x;
      const dy = p.y - v.eye.y;
      const dz = p.z - v.eye.z;
      const sx = dx * rx + dy * ry + dz * rz;
      const sy = dx * ux + dy * uy + dz * uz;
      const depth = dx * f.x + dy * f.y + dz * f.z;
      return { x: sx / halfWidth, y: sy / v.halfHeight, depth };
    }
  };
}

/** 比较导出分段与按相同视图/阈值实时重算的结果。 */
function diffSegments(meta: HlrDrawingMeta, live: HLRResult): string[] {
  const mismatches: string[] = [];
  const key = (s: { edgeId: string; kind: string; t0: number; t1: number }): string =>
    `${s.edgeId}|${s.kind}|${s.t0.toFixed(6)}|${s.t1.toFixed(6)}`;
  const eps = 1e-6;
  const close = (a: typeof meta.segments[number], b: typeof live.segments[number]): boolean =>
    a.edgeId === b.edgeId &&
    a.kind === b.kind &&
    Math.abs(a.t0 - b.t0) < eps &&
    Math.abs(a.t1 - b.t1) < eps;

  for (const s of meta.segments) {
    if (!live.segments.some((l) => close(s, l))) mismatches.push(`导出段在重算中缺失: ${key(s)}`);
  }
  for (const s of live.segments) {
    if (!meta.segments.some((m) => close(m, s))) mismatches.push(`重算出现新段: ${key(s)}`);
  }
  return mismatches;
}

export function buildHighlightRequest(info: PickInfo): HighlightRequest {
  return {
    edgeId: info.segment.edgeId,
    partId: info.segment.partId,
    worldA: info.worldA,
    worldB: info.worldB,
    occluderPartIds: info.segment.occluderPartIds
  };
}
