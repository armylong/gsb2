/**
 * 光照引擎（2D 俯视图，纯计算、无 DOM 依赖，可在 Node 下单测）。
 *
 * 模型约定（自洽的 2D 辐射度，单位为相对单位）：
 *  - 灯是双向均匀线光源，辐射亮度 L_e = power * lampColor；
 *  - 墙为双面 Lambertian 漫反射体，反照率即其线性 RGB 颜色；
 *  - 墙面某面的直接照度 E = Σ L_e·cosθ·Δθ（对灯做角积分，逐子段做遮挡测试）；
 *  - 墙面反射出的辐射亮度 L_r = E·albedo/π；
 *  - 地面点（水平接收面，cosine-weighted）做 360° 角度射线采样：
 *      命中灯 → 直射 += L_e·Δθ；
 *      命中墙 → 一次反射 += L_r(该墙面)·Δθ，并按墙段累计贡献。
 *  角度射线天然处理部分遮挡：关墙、挪挡板后重算即为真实更新。
 */
import type {
  FloorAnalysis,
  HeatCell,
  HeatMap,
  IrradianceRGB,
  ProbeRay,
  QualitySpec,
  Vec2,
  WallContribution,
  World,
} from './types.js';
import {
  EPS,
  VIS_EPS,
  angleMod,
  angularSpan,
  clamp,
  isVisible,
  lerp,
  normalize,
  rgbLuma,
  sub,
  type FlatWall,
} from './geometry.js';

const CAST_EPS = 1e-7;
const TWO_PI = Math.PI * 2;

interface CastHit {
  type: 'wall' | 'lamp' | 'none';
  t: number;
  wallId?: string;
}

interface WallRuntime {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
  enabled: boolean;
  color: { r: number; g: number; b: number };
  /** 两个面的直接照度：[+法向面, -法向面] */
  ePlus: IrradianceRGB;
  eMinus: IrradianceRGB;
}

const zeroRGB = (): IrradianceRGB => ({ r: 0, g: 0, b: 0 });
const addRGB = (a: IrradianceRGB, b: IrradianceRGB, k = 1): void => {
  a.r += b.r * k;
  a.g += b.g * k;
  a.b += b.b * k;
};
const scaleRGB = (a: IrradianceRGB, k: number): IrradianceRGB => ({
  r: a.r * k,
  g: a.g * k,
  b: a.b * k,
});

export class LightEngine {
  readonly world: World;
  readonly spec: QualitySpec;
  private walls: WallRuntime[];
  private flat: FlatWall[];

  constructor(world: World, spec: QualitySpec) {
    this.world = world;
    this.spec = spec;
    this.walls = world.walls.map((w) => {
      const d = normalize(sub(w.b, w.a));
      return {
        id: w.id,
        ax: w.a.x,
        ay: w.a.y,
        bx: w.b.x,
        by: w.b.y,
        nx: -d.y,
        ny: d.x,
        enabled: w.enabled,
        color: w.color,
        ePlus: zeroRGB(),
        eMinus: zeroRGB(),
      };
    });
    this.flat = this.walls.map((w) => ({
      id: w.id,
      ax: w.ax,
      ay: w.ay,
      bx: w.bx,
      by: w.by,
      enabled: w.enabled,
    }));
    this.computeWallIrradiance();
  }

  /** 射线投射：返回最近的启用墙段或灯 */
  private cast(ox: number, oy: number, dx: number, dy: number): CastHit {
    let best = Infinity;
    let bestWall: string | undefined;
    for (const w of this.walls) {
      if (!w.enabled) continue;
      const sx = w.bx - w.ax;
      const sy = w.by - w.ay;
      const denom = dx * sy - dy * sx;
      if (Math.abs(denom) < EPS) continue;
      const oxw = w.ax - ox;
      const oyw = w.ay - oy;
      const t = (oxw * sy - oyw * sx) / denom;
      const u = (oxw * dy - oyw * dx) / denom;
      if (u >= -EPS && u <= 1 + EPS && t > CAST_EPS && t < best) {
        best = t;
        bestWall = w.id;
      }
    }
    // 灯（视为可被命中的线段）
    const la = this.world.lamp.a;
    const lb = this.world.lamp.b;
    const lampHit = this.rayVsSegment(ox, oy, dx, dy, la.x, la.y, lb.x, lb.y);
    if (lampHit !== null && lampHit < best) {
      return { type: 'lamp', t: lampHit };
    }
    if (bestWall !== undefined) return { type: 'wall', t: best, wallId: bestWall };
    return { type: 'none', t: this.roomExitDistance(ox, oy, dx, dy) };
  }

  private rayVsSegment(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number | null {
    const sx = bx - ax;
    const sy = by - ay;
    const denom = dx * sy - dy * sx;
    if (Math.abs(denom) < EPS) return null;
    const oxw = ax - ox;
    const oyw = ay - oy;
    const t = (oxw * sy - oyw * sx) / denom;
    const u = (oxw * dy - oyw * dx) / denom;
    if (u >= -EPS && u <= 1 + EPS && t > CAST_EPS) return t;
    return null;
  }

  /** 无命中时，射线到房间矩形边界的距离（仅用于可视化） */
  private roomExitDistance(ox: number, oy: number, dx: number, dy: number): number {
    const r = this.world.room;
    let t = Infinity;
    if (dx > EPS) t = Math.min(t, (r.x + r.w - ox) / dx);
    else if (dx < -EPS) t = Math.min(t, (r.x - ox) / dx);
    if (dy > EPS) t = Math.min(t, (r.y + r.h - oy) / dy);
    else if (dy < -EPS) t = Math.min(t, (r.y - oy) / dy);
    return Number.isFinite(t) ? t : 1000;
  }

  /** 逐墙计算两个面的直接照度（只来自灯；本实验只做一次反射） */
  private computeWallIrradiance(): void {
    const lamp = this.world.lamp;
    const K = this.spec.lampSamples;
    const le = scaleRGB(lamp.color, lamp.power);

    for (const w of this.walls) {
      if (!w.enabled) continue;
      const accPlus = zeroRGB();
      const accMinus = zeroRGB();
      // 墙面上取若干采样点，对灯做角积分并测试遮挡
      const P = Math.max(4, Math.round(K / 2));
      for (let j = 0; j < P; j++) {
        const t = (j + 0.5) / P;
        const p = lerp({ x: w.ax, y: w.ay }, { x: w.bx, y: w.by }, t);
        const ep = zeroRGB();
        const em = zeroRGB();
        for (let m = 0; m < K; m++) {
          const q0 = lerp(lamp.a, lamp.b, m / K);
          const q1 = lerp(lamp.a, lamp.b, (m + 1) / K);
          const mid = lerp(q0, q1, 0.5);
          if (!isVisible(p, mid, this.flat, w.id)) continue;
          const dTheta = angularSpan(p, q0, q1);
          if (dTheta < EPS) continue;
          const lDir = normalize(sub(mid, p));
          const cosPlus = lDir.x * w.nx + lDir.y * w.ny;
          if (cosPlus > 0) addRGB(ep, le, cosPlus * dTheta);
          if (cosPlus < 0) addRGB(em, le, -cosPlus * dTheta);
        }
        addRGB(accPlus, ep);
        addRGB(accMinus, em);
      }
      w.ePlus = scaleRGB(accPlus, 1 / P);
      w.eMinus = scaleRGB(accMinus, 1 / P);
    }
  }

  private wallById(id: string): WallRuntime | undefined {
    return this.walls.find((w) => w.id === id);
  }

  /**
   * 地面点完整分析：直射、一次反射、分墙段贡献，可选记录探针射线。
   * disabledIds：假设关闭的墙段（用于对比读数）。
   */
  analyzeFloor(
    pos: Vec2,
    recordRays = false,
    disabledIds: ReadonlySet<string> = new Set(),
  ): FloorAnalysis {
    const M = this.spec.floorRays;
    const dTheta = TWO_PI / M;
    const direct = zeroRGB();
    const reflected = zeroRGB();
    const lamp = this.world.lamp;
    const le = scaleRGB(lamp.color, lamp.power);

    const map = new Map<string, WallContribution>();
    const rays: ProbeRay[] = [];

    const disabled = disabledIds;
    for (let i = 0; i < M; i++) {
      const theta = (i + 0.5) * dTheta;
      const dx = Math.cos(theta);
      const dy = Math.sin(theta);
      const hit = this.castWithDisabled(pos.x, pos.y, dx, dy, disabled);

      if (recordRays) {
        rays.push({
          angle: angleMod(theta),
          kind: hit.type,
          dist: hit.t,
          wallId: hit.wallId,
        });
      }

      if (hit.type === 'lamp') {
        addRGB(direct, le, dTheta);
      } else if (hit.type === 'wall' && hit.wallId) {
        const w = this.wallById(hit.wallId);
        if (!w) continue;
        // 侧别判定（推导见下）：
        //  ePlus 存 +n 面的照度——灯位于该面一侧时，灯方向 l 满足 l·n>0。
        //  地面点若在 +n 一侧，它看到的就是 +n 面；此时射线 dir 指向墙，dir·n<0。
        //  因此 dir·n<0 → ePlus；dir·n>0 → eMinus。
        const side = dx * w.nx + dy * w.ny < 0 ? 0 : 1;
        const e = side === 0 ? w.ePlus : w.eMinus;
        // L_r = E·albedo/π，水平接收面入射照度 += L_r·Δθ
        const contrib: IrradianceRGB = {
          r: ((e.r * w.color.r) / Math.PI) * dTheta,
          g: ((e.g * w.color.g) / Math.PI) * dTheta,
          b: ((e.b * w.color.b) / Math.PI) * dTheta,
        };
        addRGB(reflected, contrib);
        let c = map.get(w.id);
        if (!c) {
          c = { wallId: w.id, angle: 0, irradiance: zeroRGB() };
          map.set(w.id, c);
        }
        c.angle += dTheta;
        addRGB(c.irradiance, contrib);
      }
    }

    const contributions = [...map.values()].sort(
      (a, b) => rgbLuma(b.irradiance) - rgbLuma(a.irradiance),
    );
    return {
      pos: { ...pos },
      direct,
      reflected,
      total: {
        r: direct.r + reflected.r,
        g: direct.g + reflected.g,
        b: direct.b + reflected.b,
      },
      contributions,
      rays,
      raysUsed: M,
    };
  }

  /** 与 cast 相同，但额外把假设关闭的墙段排除 */
  private castWithDisabled(
    ox: number,
    oy: number,
    dx: number,
    dy: number,
    disabled: ReadonlySet<string>,
  ): CastHit {
    if (disabled.size === 0) return this.cast(ox, oy, dx, dy);
    let best = Infinity;
    let bestWall: string | undefined;
    for (const w of this.walls) {
      if (!w.enabled || disabled.has(w.id)) continue;
      const sx = w.bx - w.ax;
      const sy = w.by - w.ay;
      const denom = dx * sy - dy * sx;
      if (Math.abs(denom) < EPS) continue;
      const oxw = w.ax - ox;
      const oyw = w.ay - oy;
      const t = (oxw * sy - oyw * sx) / denom;
      const u = (oxw * dy - oyw * dx) / denom;
      if (u >= -EPS && u <= 1 + EPS && t > CAST_EPS && t < best) {
        best = t;
        bestWall = w.id;
      }
    }
    const la = this.world.lamp;
    const lb = this.world.lamp.b;
    const lampHit = this.rayVsSegment(ox, oy, dx, dy, la.a.x, la.a.y, lb.x, lb.y);
    if (lampHit !== null && lampHit < best) return { type: 'lamp', t: lampHit };
    if (bestWall !== undefined) return { type: 'wall', t: best, wallId: bestWall };
    return { type: 'none', t: this.roomExitDistance(ox, oy, dx, dy) };
  }

  /** 全房间热图（直射与合计各一份） */
  computeHeatMap(): HeatMap {
    const t0 = performance.now();
    const { room } = this.world;
    const grid = this.spec.grid;
    const nx = Math.max(1, Math.round(room.w / grid));
    const ny = Math.max(1, Math.round(room.h / grid));
    const cells: HeatCell[] = [];
    const lumas: number[] = [];

    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const pos: Vec2 = {
          x: room.x + ((ix + 0.5) * room.w) / nx,
          y: room.y + ((iy + 0.5) * room.h) / ny,
        };
        const a = this.analyzeFloor(pos, false);
        cells.push({ pos, direct: a.direct, total: a.total });
        lumas.push(rgbLuma(a.total));
      }
    }
    lumas.sort((x, y) => x - y);
    const p99Luma = lumas[Math.floor(lumas.length * 0.99)] ?? 1;
    return {
      cells,
      nx,
      ny,
      grid,
      quality: this.spec.key,
      elapsedMs: performance.now() - t0,
      p99Luma: Math.max(p99Luma, EPS),
    };
  }

  /** 两档热图的一致性统计（other 格子按最近邻对齐到 ref 格子） */
  static diffStats(
    ref: HeatMap,
    other: HeatMap,
  ): { meanAbsDiff: number; maxDiff: number; meanLuma: number; count: number } {
    if (ref.cells.length < 2) {
      return { meanAbsDiff: 0, maxDiff: 0, meanLuma: 0, count: other.cells.length };
    }
    const sx = ref.cells[1].pos.x - ref.cells[0].pos.x;
    const sy = ref.cells[ref.nx].pos.y - ref.cells[0].pos.y;
    const x0 = ref.cells[0].pos.x;
    const y0 = ref.cells[0].pos.y;

    let sumAbs = 0;
    let maxDiff = 0;
    let sumLuma = 0;
    let count = 0;
    for (const c of other.cells) {
      const gx = clamp(Math.round((c.pos.x - x0) / sx - 0.5), 0, ref.nx - 1);
      const gy = clamp(Math.round((c.pos.y - y0) / sy - 0.5), 0, ref.ny - 1);
      const refCell = ref.cells[gy * ref.nx + gx];
      if (!refCell) continue;
      const d = Math.abs(rgbLuma(c.total) - rgbLuma(refCell.total));
      sumAbs += d;
      maxDiff = Math.max(maxDiff, d);
      sumLuma += rgbLuma(refCell.total);
      count += 1;
    }
    return {
      meanAbsDiff: sumAbs / (count || 1),
      maxDiff,
      meanLuma: sumLuma / (count || 1),
      count,
    };
  }
}

/** 供 UI 复用：探针射线里命中墙的颜色提示等 */
export function contributionOf(a: FloorAnalysis, wallId: string): WallContribution | undefined {
  return a.contributions.find((c) => c.wallId === wallId);
}

export { VIS_EPS };
