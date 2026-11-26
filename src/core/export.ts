/**
 * 导出内核 (纯字符串生成, 不依赖 DOM):
 * - buildPlanSVG: 带尺寸刻度/标注的俯视或侧视平面检查图
 * - buildCollisionCSV: 碰撞时间清单 (UTF-8 BOM, Excel 可直接打开)
 * - downloadText: 浏览器端触发下载
 */
import { anglesAt, deg, type Mechanism } from './kinematics';
import type { CollisionEvent } from './collision';
import {
  type Plane2D,
  type Point2D,
  type Polygon,
  boundsOfOBBs,
  computeEnvelope,
  extractContours,
  projectPoint,
  samplePartOBBs,
} from './sweep';
import { type OBB, type Vec3 } from './math3d';

export interface ExportObstacle {
  name: string;
  center: Vec3;
  size: Vec3;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function fmtT(t: number): string {
  return t.toFixed(4);
}

export interface PlanSVGInput {
  mechanism: Mechanism;
  obstacles: ExportObstacle[];
  plane: Plane2D;
  range: [number, number];
  samples?: number;
  cell?: number;
  title: string;
}

function obbProjectedPolygon(o: OBB, plane: Plane2D): Point2D[] {
  const pts: Point2D[] = [];
  for (let mask = 0; mask < 8; mask++) {
    const p: Vec3 = [...o.center] as Vec3;
    for (let i = 0; i < 3; i++) {
      const sgn = mask & (1 << i) ? 1 : -1;
      p[0] += sgn * o.half[i] * o.axes[i][0];
      p[1] += sgn * o.half[i] * o.axes[i][1];
      p[2] += sgn * o.half[i] * o.axes[i][2];
    }
    pts.push(projectPoint(p, plane));
  }
  // 凸包: 取角点中不重复的投影点按角度排序 (OBB 投影是平行四边形, 4 个点)
  const uniq = new Map<string, Point2D>();
  for (const p of pts) uniq.set(`${fmt(p.x)},${fmt(p.y)}`, p);
  const arr = [...uniq.values()];
  const cx = arr.reduce((s, p) => s + p.x, 0) / arr.length;
  const cy = arr.reduce((s, p) => s + p.y, 0) / arr.length;
  arr.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return arr;
}

function polyPoints(poly: Point2D[], sx: (n: number) => number, sy: (n: number) => number): string {
  return poly.map((p) => `${fmt(sx(p.x))},${fmt(sy(p.y))}`).join(' ');
}

/**
 * 生成平面检查图 SVG。
 * 坐标系: 世界 (mm) -> 屏幕 px, 1mm = scale px, Y 轴翻转。
 */
export function buildPlanSVG(input: PlanSVGInput): string {
  const { mechanism: m, obstacles, plane, range } = input;
  const samples = input.samples ?? 180;
  const cell = input.cell ?? 2.5;

  const sampled = samplePartOBBs(m, range, samples);
  const doorOBBs = sampled.map((s) => s.door);
  const trayOBBs = sampled.map((s) => s.tray);
  const obstacleOBBs: (OBB & { name: string })[] = obstacles.map((o) => ({
    name: o.name,
    center: [...o.center] as Vec3,
    half: [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  }));

  const allOBBs = [...doorOBBs, ...trayOBBs, ...obstacleOBBs];
  const b = boundsOfOBBs(allOBBs, plane, 20);

  const scale = 1.2;
  const pad = 90;
  const widthMM = b.maxX - b.minX;
  const heightMM = b.maxY - b.minY;
  const width = widthMM * scale + pad * 2;
  const height = heightMM * scale + pad * 2 + 60;

  // 世界 -> 屏幕
  const sx = (wx: number) => pad + (wx - b.minX) * scale;
  const sy = (wy: number) => pad + (b.maxY - wy) * scale;

  const doorRaster = computeEnvelope(doorOBBs, plane, cell, 8);
  const trayRaster = computeEnvelope(trayOBBs, plane, cell, 8);
  const doorPolys = extractContours(doorRaster);
  const trayPolys = extractContours(trayRaster);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}" font-family="Helvetica, Arial, sans-serif">`,
  );
  parts.push(
    `<defs><marker id="dimArrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#6b7280"/></marker></defs>`,
  );
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(
    `<text x="${pad}" y="34" font-size="20" font-weight="700" fill="#111">${escapeXml(input.title)}</text>`,
  );
  parts.push(
    `<text x="${pad}" y="56" font-size="12" fill="#555">视图: ${plane === 'top' ? '俯视 (X-Z 平面, 水平=X, 竖直=Z)' : '侧视 (Z-Y 平面, 水平=Z, 竖直=Y)'} · 单位 mm · 检查区间 t∈[${fmtT(range[0])}, ${fmtT(range[1])}]</text>`,
  );

  // 网格 (每 50mm 细线, 每 100mm 标注)
  const gridStep = 50;
  const startX = Math.ceil(b.minX / gridStep) * gridStep;
  const startY = Math.ceil(b.minY / gridStep) * gridStep;
  for (let gx = startX; gx <= b.maxX; gx += gridStep) {
    const major = gx % 100 === 0;
    parts.push(
      `<line x1="${fmt(sx(gx))}" y1="${fmt(sy(b.minY))}" x2="${fmt(sx(gx))}" y2="${fmt(sy(b.maxY))}" stroke="${major ? '#d9dee7' : '#eef1f5'}" stroke-width="1"/>`,
    );
    if (major) {
      parts.push(
        `<text x="${fmt(sx(gx))}" y="${fmt(sy(b.minY) + 16)}" font-size="10" fill="#888" text-anchor="middle">${gx}</text>`,
      );
    }
  }
  for (let gy = startY; gy <= b.maxY; gy += gridStep) {
    const major = gy % 100 === 0;
    parts.push(
      `<line x1="${fmt(sx(b.minX))}" y1="${fmt(sy(gy))}" x2="${fmt(sx(b.maxX))}" y2="${fmt(sy(gy))}" stroke="${major ? '#d9dee7' : '#eef1f5'}" stroke-width="1"/>`,
    );
    if (major) {
      parts.push(
        `<text x="${fmt(sx(b.minX) - 6)}" y="${fmt(sy(gy) + 4)}" font-size="10" fill="#888" text-anchor="end">${gy}</text>`,
      );
    }
  }

  // 扫掠包络
  const envelope = (polys: Polygon[], fill: string, stroke: string) => {
    for (const poly of polys) {
      parts.push(
        `<polygon points="${polyPoints(poly.points, sx, sy)}" fill="${fill}" fill-opacity="0.28" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`,
      );
    }
  };
  envelope(doorPolys, '#2f7ed8', '#1c5aa0');
  envelope(trayPolys, '#f08c2e', '#b9651a');

  // 障碍投影 (平行四边形) + 尺寸
  for (const ob of obstacleOBBs) {
    const poly = obbProjectedPolygon(ob, plane);
    parts.push(
      `<polygon points="${polyPoints(poly, sx, sy)}" fill="#9aa4b2" fill-opacity="0.35" stroke="#4b5563" stroke-width="1.5" stroke-dasharray="6 3"/>`,
    );
    const labelP = poly[0];
    parts.push(
      `<text x="${fmt(sx(labelP.x))}" y="${fmt(sy(labelP.y) - 6)}" font-size="11" fill="#374151">${escapeXml(ob.name)}</text>`,
    );
    dimensionOfObstacle(ob, plane, sx, sy, parts);
  }

  // 起止姿态轮廓
  const startDoor = obbProjectedPolygon(doorOBBs[0], plane);
  const endDoor = obbProjectedPolygon(doorOBBs[doorOBBs.length - 1], plane);
  parts.push(
    `<polygon points="${polyPoints(startDoor, sx, sy)}" fill="none" stroke="#0b3d91" stroke-width="1.2" stroke-dasharray="2 3"/>`,
  );
  parts.push(
    `<polygon points="${polyPoints(endDoor, sx, sy)}" fill="none" stroke="#0b3d91" stroke-width="1.8"/>`,
  );

  // 铰链位置标记
  const hinge2 = projectPoint(m.door.pivot, plane);
  parts.push(
    `<circle cx="${fmt(sx(hinge2.x))}" cy="${fmt(sy(hinge2.y))}" r="4" fill="#111"/>`,
  );
  parts.push(
    `<text x="${fmt(sx(hinge2.x) + 7)}" y="${fmt(sy(hinge2.y) - 7)}" font-size="10" fill="#111">铰链</text>`,
  );

  // 比例尺 (100mm)
  const legendY = height - 34;
  const barMM = 100;
  parts.push(
    `<line x1="${pad}" y1="${legendY}" x2="${fmt(pad + barMM * scale)}" y2="${legendY}" stroke="#111" stroke-width="2"/>`,
  );
  parts.push(`<line x1="${pad}" y1="${legendY - 5}" x2="${pad}" y2="${legendY + 5}" stroke="#111" stroke-width="2"/>`);
  parts.push(
    `<line x1="${fmt(pad + barMM * scale)}" y1="${legendY - 5}" x2="${fmt(pad + barMM * scale)}" y2="${legendY + 5}" stroke="#111" stroke-width="2"/>`,
  );
  parts.push(
    `<text x="${fmt(pad + (barMM * scale) / 2)}" y="${fmt(legendY - 8)}" font-size="11" fill="#111" text-anchor="middle">${barMM} mm 比例尺</text>`,
  );

  // 图例
  const lx = pad + 200;
  parts.push(`<rect x="${lx}" y="${legendY - 12}" width="14" height="14" fill="#2f7ed8" fill-opacity="0.45" stroke="#1c5aa0"/>`);
  parts.push(`<text x="${lx + 20}" y="${legendY}" font-size="11" fill="#333">门板扫掠范围</text>`);
  parts.push(`<rect x="${lx + 130}" y="${legendY - 12}" width="14" height="14" fill="#f08c2e" fill-opacity="0.45" stroke="#b9651a"/>`);
  parts.push(`<text x="${lx + 150}" y="${legendY}" font-size="11" fill="#333">托板扫掠范围</text>`);
  parts.push(`<rect x="${lx + 260}" y="${legendY - 12}" width="14" height="14" fill="#9aa4b2" fill-opacity="0.5" stroke="#4b5563" stroke-dasharray="4 2"/>`);
  parts.push(`<text x="${lx + 280}" y="${legendY}" font-size="11" fill="#333">障碍投影</text>`);

  parts.push('</svg>');
  return parts.join('\n');
}

/** 障碍在投影视图里的两个边尺寸标注 */
function dimensionOfObstacle(
  ob: OBB,
  plane: Plane2D,
  sx: (n: number) => number,
  sy: (n: number) => number,
  parts: string[],
): void {
  const dims: { from: Vec3; to: Vec3; label: string }[] = [];
  if (plane === 'top') {
    // X 向尺寸 (取 -z 边) 与 Z 向尺寸 (取 +x 边)
    const [hx, hy, hz] = ob.half;
    void hy;
    const c = ob.center;
    dims.push({
      from: [c[0] - hx, c[1], c[2] - hz - 14],
      to: [c[0] + hx, c[1], c[2] - hz - 14],
      label: `${fmt(hx * 2)}`,
    });
    dims.push({
      from: [c[0] + hx + 14, c[1], c[2] - hz],
      to: [c[0] + hx + 14, c[1], c[2] + hz],
      label: `${fmt(hz * 2)}`,
    });
  } else {
    const [, hy, hz] = ob.half;
    const c = ob.center;
    dims.push({
      from: [c[0], c[1] - hy, c[2] - hz - 14],
      to: [c[0], c[1] - hy, c[2] + hz - 14],
      label: `${fmt(hz * 2)}`,
    });
    dims.push({
      from: [c[0], c[1] - hy - 14, c[2] + hz + 14],
      to: [c[0], c[1] + hy - 14, c[2] + hz + 14],
      label: `${fmt(hy * 2)}`,
    });
  }
  for (const d of dims) {
    const a = projectPoint(d.from, plane);
    const b2 = projectPoint(d.to, plane);
    parts.push(
      `<line x1="${fmt(sx(a.x))}" y1="${fmt(sy(a.y))}" x2="${fmt(sx(b2.x))}" y2="${fmt(sy(b2.y))}" stroke="#6b7280" stroke-width="1" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>`,
    );
    parts.push(
      `<text x="${fmt((sx(a.x) + sx(b2.x)) / 2)}" y="${fmt((sy(a.y) + sy(b2.y)) / 2 - 3)}" font-size="10" fill="#6b7280" text-anchor="middle">${d.label}</text>`,
    );
  }
}

export interface CSVInput {
  events: CollisionEvent[];
  mechanism: Mechanism;
  range: [number, number];
}

/** 碰撞时间清单; 时刻为归一化 t, 同时给出对应的门板/托板角度, 可据此回到同一姿态 */
export function buildCollisionCSV(input: CSVInput): string {
  const { events, mechanism: m, range } = input;
  const header = [
    '序号',
    '障碍',
    '零件',
    '类型',
    '首次接触t',
    '分开t',
    '最大侵入mm',
    '最大侵入时刻t',
    '接触时门角°',
    '接触时托板角°',
    '障碍面/边',
    '零件面/边',
  ];
  const rows: string[][] = [header];
  events.forEach((e, i) => {
    const a = anglesAt(m, e.enterT);
    rows.push([
      String(i + 1),
      e.obstacleName,
      e.part === 'door' ? '门板' : '托板',
      e.kind === 'grazing' ? '贴边' : '进入障碍',
      fmtT(e.enterT),
      fmtT(e.exitT),
      fmt(e.maxDepth),
      fmtT(e.maxDepthT),
      fmt(deg(a.doorAngle)),
      fmt(deg(a.trayAngle)),
      e.enterLabel.obstacleFace,
      e.enterLabel.partSide,
    ]);
  });
  const meta = [
    `# 检查区间 t ∈ [${fmtT(range[0])}, ${fmtT(range[1])}]`,
    `# 门角范围 ${fmt(deg(m.door.angleRange[0]))}° → ${fmt(deg(m.door.angleRange[1]))}°`,
    `# 托板角范围 ${fmt(deg(m.tray.angleRange[0]))}° → ${fmt(deg(m.tray.angleRange[1]))}°`,
    `# 转动顺序 ${m.sequence}`,
  ];
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return '﻿' + meta.join('\r\n') + '\r\n' + body + '\r\n';
}

function csvCell(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
