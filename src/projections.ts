/**
 * projections.ts —— 平面投影。
 * - equirect：普通经纬图（等距圆柱），在反经线处显式断段；
 * - azimuthal：以指定地标为中心的方位等距投影，整张球映为圆盘，
 *   中心到任意点的距离/方位按大圆如实表达；在中心对跖点（外圆周奇点）断段。
 */
import { DEG, clamp, wrapPi, type LonLat } from './geo';

export type ProjectionId = 'equirect' | 'azimuthal';

export interface Pt {
  x: number;
  y: number;
}

export interface Projector {
  id: ProjectionId;
  project(ll: LonLat): Pt;
  /** 相邻采样点原始经度差超过 180° 时是否断段（仅等距圆柱需要） */
  splitOnLonJump: boolean;
  /** 投影区域的边界描述，用于裁剪/装饰 */
  bounds:
    | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
    | { kind: 'circle'; cx: number; cy: number; r: number };
}

const PAD = { top: 18, right: 18, bottom: 30, left: 46 };

export function createProjector(
  id: ProjectionId,
  width: number,
  height: number,
  center: LonLat,
): Projector {
  if (id === 'equirect') return createEquirect(width, height);
  return createAzimuthal(width, height, center);
}

function createEquirect(width: number, height: number): Projector {
  const availW = Math.max(10, width - PAD.left - PAD.right);
  const availH = Math.max(10, height - PAD.top - PAD.bottom);
  const scale = Math.min(availW / 360, availH / 180);
  const mapW = 360 * scale;
  const mapH = 180 * scale;
  const x0 = PAD.left + (availW - mapW) / 2;
  const y0 = PAD.top + (availH - mapH) / 2;
  return {
    id: 'equirect',
    splitOnLonJump: true,
    bounds: { kind: 'rect', x0, y0, x1: x0 + mapW, y1: y0 + mapH },
    project(ll: LonLat): Pt {
      return {
        x: x0 + ((ll.lon + 180) / 360) * mapW,
        y: y0 + ((90 - ll.lat) / 180) * mapH,
      };
    },
  };
}

function createAzimuthal(
  width: number,
  height: number,
  center: LonLat,
): Projector {
  const cx = width / 2;
  const cy = height / 2 + 4;
  const r = Math.max(20, Math.min(width - 24, height - 40) / 2);
  const scale = r / Math.PI; // c(rad) -> px

  const phi0 = center.lat * DEG;
  const lam0 = center.lon * DEG;
  const sinPhi0 = Math.sin(phi0);
  const cosPhi0 = Math.cos(phi0);

  return {
    id: 'azimuthal',
    splitOnLonJump: false,
    bounds: { kind: 'circle', cx, cy, r },
    project(ll: LonLat): Pt {
      const phi = ll.lat * DEG;
      const dLam = wrapPi(ll.lon * DEG - lam0);
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      const cosC = clamp(
        sinPhi0 * sinPhi + cosPhi0 * cosPhi * Math.cos(dLam),
        -1,
        1,
      );
      const c = Math.acos(cosC);
      const rho = c * scale;
      const sinC = Math.sin(c);
      // c≈0：就是中心；c 接近 π：中心的对跖点（方位奇点）。
      // 放宽奇点邻域，直接用 atan2 极限方位落到圆周，避免除以极小 sinC
      // 造成经纬线在边缘锯齿。
      if (c < 1e-6) return { x: cx, y: cy };
      if (Math.PI - c < 1e-3 || sinC < 1e-6) {
        const az = Math.atan2(
          cosPhi * Math.sin(dLam),
          cosPhi0 * sinPhi - sinPhi0 * cosPhi * Math.cos(dLam),
        );
        return { x: cx + r * Math.sin(az), y: cy - r * Math.cos(az) };
      }
      const xPart = (cosPhi * Math.sin(dLam)) / sinC;
      const yPart =
        (cosPhi0 * sinPhi - sinPhi0 * cosPhi * Math.cos(dLam)) / sinC;
      return {
        x: cx + rho * xPart,
        y: cy - rho * yPart,
      };
    },
  };
}

/**
 * 把经纬度折线投影并在“绘图切割处”断段。
 * 规则：
 * 1. 等距圆柱：相邻点经度跳变 > 180°（跨反经线）→ 断段，杜绝横穿全图的直线；
 * 2. 通用保险：投影像素跳变超过 plot 短边的 45%（方位投影对跖奇点）→ 断段。
 */
export function projectPath(
  lls: LonLat[],
  projector: Projector,
): Pt[][] {
  if (lls.length === 0) return [];
  const bounds = projector.bounds;
  const shortSide =
    bounds.kind === 'rect'
      ? Math.min(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
      : bounds.r * 2;
  const maxJump = shortSide * 0.45;

  const segments: Pt[][] = [];
  let current: Pt[] = [projector.project(lls[0])];

  for (let i = 1; i < lls.length; i++) {
    const prev = lls[i - 1];
    const cur = lls[i];
    const p = projector.project(cur);
    const pp = current[current.length - 1];

    let cut = false;
    if (projector.splitOnLonJump && Math.abs(cur.lon - prev.lon) > 180) {
      cut = true;
    } else if (Math.hypot(p.x - pp.x, p.y - pp.y) > maxJump) {
      cut = true;
    }

    if (cut) {
      if (current.length >= 2) segments.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

/** 生成经纬网折线（每 30° 一经/纬，回归线/极圈用虚线由视图层处理） */
export function graticuleLines(): {
  lls: LonLat[];
  kind: 'meridian' | 'parallel';
  major: boolean;
}[] {
  const lines: {
    lls: LonLat[];
    kind: 'meridian' | 'parallel';
    major: boolean;
  }[] = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const lls: LonLat[] = [];
    for (let lat = -90; lat <= 90; lat += 2) lls.push({ lon, lat });
    lines.push({ lls, kind: 'meridian', major: lon === 0 });
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const lls: LonLat[] = [];
    for (let lon = -180; lon <= 180; lon += 2) lls.push({ lon, lat });
    lines.push({ lls, kind: 'parallel', major: lat === 0 });
  }
  // 极圈，帮助展示极地航线
  for (const lat of [66.56, -66.56]) {
    const lls: LonLat[] = [];
    for (let lon = -180; lon <= 180; lon += 2) lls.push({ lon, lat });
    lines.push({ lls, kind: 'parallel', major: false });
  }
  return lines;
}
